import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools";
import {
  browserReadPublisherLock,
  CapturedReadNotRetainedError,
  createReadState,
} from "./read-state";
import { effectiveFrontier, overrideActive } from "./read-state-model";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import { keypair, scriptedTransport } from "./testing";
import { createRelayReader } from "./reader";
import { eventDto, type RelayEvent } from "./events";
import { READ_RESERVE_KEYS, retainRead } from "./read-state-retention";
// Test the real host codec with ephemeral identities, never a bypass signer.
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node-only host module
} from "../../../browser-host/read-state.mjs";
import {
  ReadStateTimestampRejected,
  READ_STATE_TIMESTAMP_REFUSAL,
  READ_SNAPSHOT_BYTES,
  READ_SNAPSHOT_EVENTS,
  type ReadStateSigning,
} from "./read-state-host";
import { acceptReadStatePublish } from "./transport";
import vectors from "../../../tests/fixtures/read-state-vectors.json";

const owners: ReturnType<typeof createReadState>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture(now = 100) {
  const key = keypair();
  let journal: ReadJournal | undefined;
  const storage: Required<ReadStateStorage> = {
    update: vi.fn(async (change) => {
      journal = readJournal(change(journal), key.pubkey);
      return journal;
    }),
    read: vi.fn(async () => journal && readJournal(journal, key.pubkey)),
    capture: vi.fn(async () => journal && readJournal(journal, key.pubkey)),
    close: vi.fn(),
  };
  let remote: RelayEvent[] = [];
  const host = {
    decode: vi.fn(async (events: readonly RelayEvent[]) =>
      decodeReadState(events, key.secret),
    ),
    sign: vi.fn(async (intent: ReadStateSigning) =>
      signReadState(intent, key.secret, now),
    ),
    // A relay keeps the newest event at each coordinate.
    publish: vi.fn(async (event: RelayEvent) => {
      const d = (item: RelayEvent) => item.tags.find(([n]) => n === "d")?.[1];
      remote = [...remote.filter((item) => d(item) !== d(event)), event];
    }),
  };
  const reader = { read: vi.fn(async () => remote) };
  const options = {
    viewer: key.pubkey,
    host,
    reader,
    storage,
    lock: async (_signal: AbortSignal, work: () => Promise<void>) => work(),
    now: () => now,
    debounceMs: 60000,
  };
  const make = (
    overrides: Partial<Parameters<typeof createReadState>[0]> = {},
  ) => {
    const owner = createReadState({ ...options, ...overrides });
    owners.push(owner);
    return owner;
  };
  return {
    key,
    host,
    reader,
    storage,
    make,
    /** Every context the relay holds across this device's blobs. */
    published: (): Record<string, number> =>
      Object.assign(
        {},
        ...decodeReadState(remote, key.secret).map(
          (item: { blob: { contexts: Record<string, number> } }) =>
            item.blob.contexts,
        ),
      ),
    /** This device's own published contexts, by slot. */
    own: (): Record<string, Record<string, number>> => {
      const d = (item: RelayEvent) => item.tags.find(([n]) => n === "d")?.[1];
      const slots = [journal?.slot, ...(journal?.spill ?? [])];
      return Object.fromEntries(
        remote
          .filter((item) => slots.includes(d(item)?.slice(11)))
          .map((item) => [
            d(item)?.slice(11),
            decodeReadState([item], key.secret)[0].blob.contexts,
          ]),
      );
    },
    addRemote: (event: RelayEvent) => {
      remote = [...remote, event];
    },
    remoteEvents: () => remote,
    setNow: (value: number) => {
      now = value;
    },
    journal: () => journal,
    setJournal: (value: ReadJournal | undefined) => {
      journal = value;
    },
  };
}
function peerUnreadMarker(
  f: ReturnType<typeof fixture>,
  key: string,
  baseline = 0,
  {
    set = 1,
    clear = 0,
    createdAt = 100,
    slot = "b".repeat(32),
    clientId = "peer",
  } = {},
) {
  return signReadState(
    {
      slot,
      createdAt,
      blob: {
        v: 1,
        client_id: clientId,
        contexts: {
          [`ov_s:${key}`]: set,
          [`ov_c:${key}`]: clear,
          [`ov_b:${key}`]: baseline,
        },
      },
    },
    f.key.secret,
    createdAt,
  );
}
/** Holds one real storage boundary; all later writes still use the shared journal. */
function holdUpdate(f: ReturnType<typeof fixture>, afterCommit = false) {
  let failAfterCallback: boolean | undefined;
  let release = () => {};
  let signal = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const update = vi.mocked(f.storage.update).getMockImplementation();
  if (!update) throw new Error("Missing fixture storage");
  vi.mocked(f.storage.update).mockImplementationOnce(async (change) => {
    const saved = afterCommit ? await update(change) : undefined;
    signal();
    await hold;
    if (failAfterCallback !== undefined) {
      if (failAfterCallback) change(f.journal());
      throw new Error("disk full");
    }
    return saved ?? update(change);
  });
  return {
    started,
    release,
    fail: (after: boolean) => {
      failAfterCallback = after;
    },
  };
}
describe("durable read-state owner", () => {
  it.each(
    ["room", "thread:root", "msg:reply"].flatMap((key) =>
      [false, true].map((intervening) => ({ key, intervening })),
    ),
  )(
    "older queued saves preserve intervening intent: $key ($intervening)",
    async ({ key, intervening }) => {
      const f = fixture();
      const owner = f.make();
      const second = f.make();
      await Promise.all([owner.ready, second.ready]);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enqueue = async (save: () => ReturnType<typeof owner.read>) => {
        await held;
        return save();
      };
      const marks = [
        owner.markLocalUnread(key, () => true, enqueue),
        owner.markLocalUnread(key, () => true, enqueue),
      ];
      const fence = owner.captureLocalUnread([key]);
      try {
        if (intervening) await second.markLocalUnread(key, () => true);
        release();
        await Promise.all(marks);
        const saved = f.journal();
        const read = owner.read(
          "room",
          20,
          () => true,
          true,
          [key],
          undefined,
          fence,
        );
        if (intervening) {
          await expect(read).rejects.toThrow("Reading observation expired");
          expect(f.journal()).toEqual(saved);
        } else {
          await expect(read).resolves.toMatchObject({ durability: "saved" });
          expect(f.journal()?.localUnread[key]).toBeUndefined();
          expect(f.journal()?.state.frontiers.room).toBe(20);
        }
      } finally {
        release();
        await Promise.allSettled(marks);
      }
    },
  );

  it("a failed older local mark cannot authorize a newer window's revision", async () => {
    const f = fixture();
    const owner = f.make();
    const second = f.make();
    await Promise.all([owner.ready, second.ready]);
    const heldMark = holdUpdate(f);
    const mark = expect(
      owner.markLocalUnread("room", () => true),
    ).rejects.toThrow("disk full");
    await heldMark.started;
    const fence = owner.captureLocalUnread(["room"]);
    const heldRead = holdUpdate(f);
    const read = expect(
      owner.read("room", 20, () => true, true, ["room"], undefined, fence),
    ).rejects.toThrow();
    try {
      // Exercise a failed callback that calculated a revision but never saved it.
      heldMark.fail(true);
      heldMark.release();
      await mark;
      await heldRead.started;
      await second.markLocalUnread("room", () => true);
      const saved = f.journal();
      heldRead.release();
      await read;
      expect(f.journal()).toEqual(saved);
      expect(f.journal()?.state.frontiers).toEqual({});
    } finally {
      heldMark.release();
      heldRead.release();
    }
  });

  it("saves intent and exact signed event before publishing, then confirms the coordinate", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const publish = f.host.publish.getMockImplementation();
    if (!publish) throw new Error("Missing fixture publisher");
    f.host.publish.mockImplementation(async (event) => {
      expect(f.journal()?.state.frontiers.room).toBe(12);
      expect(f.journal()?.pending?.event.id).toBe(event.id);
      await publish(event);
    });
    const result = await owner.read("room", 12, () => true);
    expect(result).toMatchObject({ durability: "saved", sync: "pending" });
    await owner.flush();
    expect(owner.snapshot().status).toBe("reconciled");
    expect(f.journal()?.pending).toBeUndefined();
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("does not sign/publish after a durability failure", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.read("room", 12, () => true)).rejects.toThrow(
      "disk full",
    );
    expect(owner.state().frontiers.room).toBeUndefined();
    expect(f.host.sign).not.toHaveBeenCalled();
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it("restores an unknown publish and retries exactly the same signed bytes before newer intent", async () => {
    const f = fixture();
    const first = f.make();
    await first.ready;
    await first.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await first.flush();
    const unknown = f.journal()?.pending?.event;
    expect(unknown).toBeDefined();
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read("room", 13, () => true);
    await second.flush();
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(unknown);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(ownerStatus(second)).toBe("reconciled");
    expect(f.journal()?.lastCreatedAt).toBe(101);
  });
  it.each(
    [900, 901].flatMap((elapsed) =>
      [false, true].flatMap((originalStored) =>
        [false, true].map((newerIntent) => ({
          elapsed,
          originalStored,
          newerIntent,
        })),
      ),
    ),
  )(
    "recovers after $elapsed seconds (original stored: $originalStored, newer intent: $newerIntent)",
    async ({ elapsed, originalStored, newerIntent }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let now = 100;
      f.host.sign.mockImplementation(async (intent) =>
        signReadState(intent, f.key.secret, now),
      );
      const store = f.host.publish.getMockImplementation();
      if (!store) throw new Error("Missing fixture publisher");
      f.host.publish.mockImplementation(async (event) => {
        // Buzz relay ingest checks ±900 seconds before storing the event.
        // Match the browser broker's current proven-rejection response shape;
        // use the real response parser rather than guessing its error type.
        if (Math.abs(event.created_at - now) > 900) {
          await acceptReadStatePublish(
            Response.json(
              {
                error: READ_STATE_TIMESTAMP_REFUSAL,
                sent: false,
              },
              { status: 503 },
            ),
            event.id,
          );
          throw new Error("Timestamp refusal unexpectedly accepted");
        }
        await store(event);
      });
      f.host.publish.mockImplementationOnce(async (event) => {
        expect(f.journal()?.pending?.event).toEqual(event);
        if (originalStored) await store(event);
        throw new Error("response lost");
      });

      const first = f.make({ now: () => now });
      await first.ready;
      await first.read("room", 12, () => true);
      await first.flush();
      const saved = f.journal();
      expect(saved?.pending?.event.created_at).toBe(100);
      expect(saved?.acceptedRevision).toBe(0);
      expect(first.snapshot()).toMatchObject({
        status: "error",
        error: "response lost",
      });
      first.dispose();
      // Restart from serialized, validated storage, not an owner's cached state.
      f.setJournal(
        readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
      );
      now += elapsed;
      const second = f.make({ now: () => now });
      await second.ready;
      if (newerIntent) await second.read("room", 13, () => true);
      // Include marker refresh as well as explicit retry, like Retry sync.
      await second.refresh();
      await second.flush();
      await second.flush();

      const remote = await f.reader.read();
      const observed = decodeReadState(remote, f.key.secret)[0]?.blob;
      const latest = newerIntent ? 13 : 12;
      const revision = newerIntent ? 2 : 1;
      expect({
        status: second.snapshot().status,
        pending: f.journal()?.pending?.event.id,
        localFrontier: second.state().frontiers.room,
        remoteFrontier: observed?.contexts.room,
        revision: f.journal()?.revision,
        acceptedRevision: f.journal()?.acceptedRevision,
      }).toEqual({
        status: "reconciled",
        pending: undefined,
        localFrontier: latest,
        remoteFrontier: latest,
        revision,
        acceptedRevision: revision,
      });
    },
  );
  it.each(["readback", "decode", "storage", "sign", "replacement-save"])(
    "preserves pending and newer intent when expired recovery fails at %s",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let now = 100;
      f.host.sign.mockImplementation(async (intent) =>
        signReadState(intent, f.key.secret, now),
      );
      const owner = f.make({ now: () => now });
      await owner.ready;
      await owner.read("room", 12, () => true);
      f.host.publish.mockRejectedValueOnce(new Error("response lost"));
      await owner.flush();
      const pending = f.journal()?.pending;
      if (!pending) throw new Error("Missing pending fixture");
      now = 1001;
      await owner.read("room", 13, () => true);
      await owner.markLocalUnread("other", () => true);
      f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
      const error = new Error(`failed ${failure}`);
      if (failure === "readback") f.reader.read.mockRejectedValueOnce(error);
      if (failure === "decode") f.host.decode.mockRejectedValueOnce(error);
      if (failure === "sign") f.host.sign.mockRejectedValueOnce(error);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      if (!update) throw new Error("Missing fixture storage");
      if (failure === "storage" || failure === "replacement-save")
        vi.mocked(f.storage.update).mockImplementation(async (change) =>
          update((current) => {
            const next = change(current);
            // Flush first reloads unchanged storage, then readback saves, then
            // the replacement save changes the event ID. Fail inside acceptance.
            if (
              failure === "storage"
                ? next !== current
                : next.pending?.event.id !== pending.event.id
            )
              throw error;
            return next;
          }),
        );
      await owner.flush();
      expect(owner.snapshot()).toMatchObject({
        status: "error",
        error: error.message,
      });
      expect(f.journal()?.pending).toEqual(pending);
      expect(f.journal()?.acceptedRevision).toBe(0);
      expect(owner.state().frontiers.room).toBe(13);
      expect(owner.localUnread("other")).toBeDefined();
      expect(f.host.publish).toHaveBeenCalledTimes(2);
      vi.mocked(f.storage.update).mockImplementation(update);
      f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
      await owner.flush();
      expect(owner.snapshot().status).toBe("reconciled");
      expect(owner.state().frontiers.room).toBe(13);
      expect(owner.localUnread("other")).toBeDefined();
    },
  );
  it.each([
    { now: 1001, error: new Error("outcome unknown") },
    { now: 1001, error: new Error("rate-limited: quota exceeded") },
    { now: 50, error: new ReadStateTimestampRejected() },
    { now: 160, error: new ReadStateTimestampRejected() },
  ])(
    "does not renew unrelated failures or clock-skewed state: $now $error",
    async ({ now, error }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let time = 100;
      const owner = f.make({ now: () => time });
      await owner.ready;
      await owner.read("room", 12, () => true);
      f.host.publish.mockRejectedValueOnce(new Error("response lost"));
      await owner.flush();
      const pending = f.journal()?.pending;
      time = now;
      f.host.publish.mockRejectedValue(error);
      await owner.flush();
      await owner.flush();
      expect(f.journal()?.pending).toEqual(pending);
      expect(f.host.sign).toHaveBeenCalledTimes(1);
      expect(
        f.host.publish.mock.calls.slice(1).map(([event]) => event),
      ).toEqual([pending?.event, pending?.event]);
    },
  );
  it("stops after one replacement if the relay still refuses its timestamp", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    f.host.sign.mockImplementation(async (intent) =>
      signReadState(intent, f.key.secret, now),
    );
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    now = 1001;
    f.host.publish.mockRejectedValue(new ReadStateTimestampRejected());
    await owner.flush();
    expect(f.host.sign).toHaveBeenCalledTimes(2);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(f.journal()?.pending?.event.created_at).toBe(1001);
    expect(f.journal()?.acceptedRevision).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
  });
  it("merges peer intent saved during expired readback and keeps local-only data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    f.host.sign.mockImplementation(async (intent) =>
      signReadState(intent, f.key.secret, now),
    );
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const pending = f.journal()?.pending;
    const peer = f.make({ now: () => now });
    await peer.ready;
    now = 1001;
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.reader.read.mockImplementationOnce(async () => {
      began();
      await gate;
      return [];
    });
    const flush = owner.flush();
    try {
      await started;
      await peer.read("peer", 20, () => true);
      await peer.markLocalUnread("manual", () => true);
      const saved = f.journal();
      if (!saved) throw new Error("Missing fixture journal");
      f.setJournal({ ...saved, reserve: { archived: 8 } });
      expect(f.journal()?.pending).toEqual(pending);
    } finally {
      release();
    }
    await flush;
    expect(owner.snapshot().status).toBe("reconciled");
    expect(owner.state().frontiers).toMatchObject({
      room: 12,
      peer: 20,
      archived: 8,
    });
    expect(owner.localUnread("manual")).toBeDefined();
    expect(f.journal()?.acceptedRevision).toBe(f.journal()?.revision);
    expect(f.host.sign).toHaveBeenCalledTimes(2);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
  });
  it("blocks expired recovery on a conflicting slot client", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const saved = f.journal();
    if (!saved) throw new Error("Missing fixture journal");
    now = 1001;
    const conflict = eventDto(
      signReadState(
        {
          slot: saved.slot,
          createdAt: now,
          blob: { v: 1, client_id: "another-client", contexts: { room: 13 } },
        },
        f.key.secret,
        now,
      ),
    );
    f.reader.read.mockResolvedValue([conflict]);
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    await owner.flush();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("slot conflict"),
    });
    expect(f.journal()?.pending).toEqual(saved.pending);
    expect(f.journal()?.acceptedRevision).toBe(0);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
  });
  it("does not replace expired pending bytes after disposal during readback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const pending = f.journal()?.pending;
    now = 1001;
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    f.reader.read.mockImplementationOnce(async () => {
      owner.dispose();
      return [];
    });
    await owner.flush();
    expect(f.journal()?.pending).toEqual(pending);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
  });
  it("retains accepted-but-unobserved identity and surfaces the gap", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    f.host.publish.mockImplementation(async () => {});
    await owner.read("room", 12, () => true);
    await owner.flush();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("observation"),
    });
    expect(f.journal()?.pending).toBeDefined();
  });
  it("fences canceled readings at transaction acceptance and never lets hydration erase later intent", async () => {
    const f = fixture();
    f.setJournal({
      ...newReadJournal(),
      state: { frontiers: { old: 20 }, overrides: {} },
    });
    const owner = f.make();
    const result = owner.read("room", 12, () => true);
    await result;
    expect(owner.state().frontiers).toEqual({ old: 20, room: 12 });
    await expect(owner.read("room", 99, () => false)).rejects.toThrow(
      "expired",
    );
    expect(owner.state().frontiers.room).toBe(12);
  });
  it("a quiet save in one window leaves another window's intent revision", async () => {
    const f = fixture();
    const options = { broadcastName: `read-quiet:${crypto.randomUUID()}` };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.ready, b.ready]);
    await b.read("room", 5, () => true);
    const before = b.intentRevision();
    await a.readMessages(
      [{ key: "seen:room", timestamp: 12, channelId: "room" }],
      undefined,
      () => true,
      true,
    );
    // Real BroadcastChannel delivery to the other window.
    await expect.poll(() => b.state().frontiers["seen:room"]).toBe(12);
    expect(b.revision()).toBe(before + 1);
    expect(b.intentRevision()).toBe(before);
    expect(f.journal()?.quiet).toBe(1);
  });
  it("merges concurrent local windows against the latest transactional journal", async () => {
    const f = fixture();
    const a = f.make(),
      b = f.make();
    await Promise.all([a.ready, b.ready]);
    await Promise.all([a.read("a", 2, () => true), b.read("b", 3, () => true)]);
    expect(f.journal()?.state.frontiers).toEqual({ a: 2, b: 3 });
  });
  it.each(
    ["refresh", "sibling"].flatMap((source) =>
      [
        "advancing",
        "stale",
        "cleared",
        "nonadvancing",
        "expired",
        "failed",
      ].map((outcome) => ({ source, outcome })),
    ),
  )(
    "settles a $source-only marker arriving after read-start capture ($outcome)",
    async ({ source, outcome }) => {
      const f = fixture();
      const key = `msg:${"a".repeat(64)}`;
      f.setJournal({
        ...newReadJournal(),
        state: {
          frontiers:
            outcome === "stale"
              ? { room: 9 }
              : outcome === "nonadvancing"
                ? { [key]: 11 }
                : {},
          overrides: {},
        },
      });
      const owner = f.make(),
        sibling = f.make();
      await Promise.all([owner.ready, sibling.ready]);
      const baseline =
        outcome === "stale" ? 5 : outcome === "nonadvancing" ? 11 : 0;
      const marker = peerUnreadMarker(f, key, baseline, {
        clear: outcome === "cleared" ? 2 : 0,
      });
      let release = (_events: RelayEvent[]) => {};
      let started = () => {};
      const response = new Promise<RelayEvent[]>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.reader.read.mockImplementationOnce(() => {
        started();
        return response;
      });
      const refresh = owner.refresh();
      await requested;
      const reading = owner.read(
        key,
        11,
        () => outcome !== "expired",
        false,
        undefined,
        (state) => effectiveFrontier(state, key, "room"),
      );
      const result =
        outcome === "expired" || outcome === "failed"
          ? expect(reading).rejects.toThrow(
              outcome === "expired" ? "expired" : "disk full",
            )
          : reading;
      if (outcome === "failed") {
        const update = vi.mocked(f.storage.update).getMockImplementation();
        if (!update) throw new Error("Missing fixture storage");
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (next.state.frontiers[key] === 11) throw new Error("disk full");
          return update(() => next);
        });
      }
      try {
        if (source === "sibling") {
          sibling.accept([marker]);
          await sibling.learnHomes({});
        }
        release(source === "refresh" ? [marker] : []);
        await refresh;
        await result;
      } finally {
        release([]);
      }
      const saved = f.journal();
      if (!saved) throw new Error("Missing saved read state");
      expect(saved?.state.frontiers[key]).toBe(
        outcome === "expired" || outcome === "failed" ? undefined : 11,
      );
      expect(saved?.state.overrides[key]?.baseline).toBe(
        outcome === "advancing" ? 11 : baseline,
      );
      expect(
        overrideActive(
          saved.state.overrides[key],
          effectiveFrontier(saved.state, key, "room"),
        ),
      ).toBe(!["stale", "cleared"].includes(outcome));
      expect(saved?.peerOverlaps ?? []).toEqual([]);
      if (outcome === "advancing") {
        owner.dispose();
        const restarted = f.make();
        await restarted.ready;
        f.addRemote(marker);
        await restarted.refresh();
        expect(restarted.state().overrides[key]?.baseline).toBe(11);
        await restarted.read(key, 12, () => true);
        await restarted.refresh();
        expect(
          overrideActive(
            restarted.state().overrides[key],
            restarted.state().frontiers[key],
          ),
        ).toBe(false);
        expect(restarted.state().overrides[key]?.baseline).toBe(11);
      }
    },
  );
  it.each([
    ...[false, true].flatMap((beforeCapture) =>
      [false, true].map((restart) => ({
        beforeCapture,
        restart,
        outcome: "advancing",
      })),
    ),
    ...["stale", "cleared", "nonadvancing", "expired", "failed"].map(
      (outcome) => ({
        beforeCapture: false,
        restart: true,
        outcome,
      }),
    ),
  ])(
    "settles sibling pending ingestion relative to capture (before: $beforeCapture, restart: $restart, $outcome)",
    async ({ beforeCapture, restart, outcome }) => {
      const f = fixture();
      const key = `msg:${"a".repeat(64)}`;
      if (["stale", "nonadvancing"].includes(outcome))
        f.setJournal({
          ...newReadJournal(),
          state: {
            frontiers: { [key]: outcome === "stale" ? 9 : 11 },
            overrides: {},
          },
        });
      const owner = f.make();
      let sibling = f.make();
      await Promise.all([owner.ready, sibling.ready]);
      const baseline = outcome === "nonadvancing" ? 11 : 0;
      const expectedBaseline =
        outcome === "advancing" && !beforeCapture ? 11 : baseline;
      const marker = peerUnreadMarker(f, key, baseline);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      if (!update) throw new Error("Missing fixture storage");
      let failed = false;
      vi.mocked(f.storage.update).mockImplementation(async (change) => {
        const next = change(f.journal());
        if (!failed && next.state.overrides[key]) {
          failed = true;
          throw new Error("disk full");
        }
        return update(() => next);
      });
      const checkpoint = async () => {
        sibling.accept([marker]);
        await sibling.learnHomes({});
        expect(sibling.owed()).toBe(true);
        expect(f.journal()?.state.overrides[key]).toBeUndefined();
        expect(f.journal()?.peerOverlaps?.[0]?.baseline).toBe(baseline);
      };
      if (beforeCapture) await checkpoint();
      const held = holdUpdate(f);
      const reading = owner.read(key, 11, () => outcome !== "expired");
      const result = ["expired", "failed"].includes(outcome)
        ? expect(reading).rejects.toThrow(
            outcome === "expired" ? "expired" : "disk full",
          )
        : reading;
      try {
        await held.started;
        if (!beforeCapture) await checkpoint();
        if (outcome === "cleared")
          await f.storage.update((current) => ({
            ...(current ?? newReadJournal()),
            state: {
              frontiers: {},
              overrides: { [key]: { set: 1, clear: 1, baseline: 0 } },
            },
          }));
        if (outcome === "failed") held.fail(true);
        held.release();
        await result;
      } finally {
        held.release();
      }
      expect(f.journal()?.peerOverlaps?.[0]?.baseline).toBe(expectedBaseline);
      if (restart) {
        sibling.dispose();
        sibling = f.make();
        await sibling.ready;
      }
      f.addRemote(marker);
      await sibling.refresh();
      expect(f.journal()?.peerOverlaps).toBeUndefined();
      expect(f.journal()?.state.frontiers[key]).toBe(
        ["expired", "failed"].includes(outcome) ? undefined : 11,
      );
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(
        expectedBaseline,
      );
      expect(
        overrideActive(
          sibling.state().overrides[key],
          sibling.state().frontiers[key],
        ),
      ).toBe(
        outcome === "advancing"
          ? !beforeCapture
          : ["nonadvancing", "expired", "failed"].includes(outcome),
      );
      await sibling.read(key, 12, () => true);
      await sibling.refresh();
      expect(
        overrideActive(
          sibling.state().overrides[key],
          sibling.state().frontiers[key],
        ),
      ).toBe(false);
    },
  );
  it.each(["message", "channel", "thread"] as const)(
    "does not resurrect peer unread behind the transaction-current %s frontier",
    async (scope) => {
      const f = fixture();
      const key = `msg:${"a".repeat(64)}`;
      const rootId = "b".repeat(64);
      const inherited =
        scope === "message"
          ? key
          : scope === "channel"
            ? "room"
            : `thread:${rootId}`;
      const owner = f.make();
      await owner.ready;
      const held = holdUpdate(f);
      const marker = peerUnreadMarker(f, key, 5);
      const automaticRead = owner.read(
        key,
        11,
        () => true,
        false,
        undefined,
        (state) => effectiveFrontier(state, key, "room", rootId),
      );
      try {
        await held.started;
        // Another window advances inheritance after invocation, before serialization.
        await f.storage.update((current) => ({
          ...(current ?? newReadJournal()),
          state: { frontiers: { [inherited]: 9 }, overrides: {} },
        }));
        owner.accept([marker]);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await owner.refresh();
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(5);
      expect(
        overrideActive(
          owner.state().overrides[key],
          effectiveFrontier(owner.state(), key, "room", rootId),
        ),
      ).toBe(false);
    },
  );
  it.each([
    "failed-before",
    "failed-after",
    "expired",
    "nonadvancing",
  ] as const)(
    "does not promote an effective peer unread for a %s automatic observation",
    async (outcome) => {
      const f = fixture();
      const key = `msg:${"a".repeat(64)}`;
      if (outcome === "nonadvancing")
        f.setJournal({
          ...newReadJournal(),
          state: { frontiers: { [key]: 11 }, overrides: {} },
        });
      const owner = f.make();
      await owner.ready;
      const held = holdUpdate(f);
      const marker = peerUnreadMarker(
        f,
        key,
        outcome === "nonadvancing" ? 11 : 0,
      );
      const automaticRead = owner.read(key, 11, () => outcome !== "expired");
      const result =
        outcome.startsWith("failed") || outcome === "expired"
          ? expect(automaticRead).rejects.toThrow(
              outcome === "expired" ? "expired" : "disk full",
            )
          : automaticRead;
      try {
        await held.started;
        if (outcome.startsWith("failed")) {
          held.fail(outcome === "failed-after");
        }
        owner.accept([marker]);
        held.release();
        await result;
      } finally {
        held.release();
      }
      await owner.refresh();
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(
        outcome === "nonadvancing" ? 11 : 0,
      );
      expect(
        overrideActive(
          owner.state().overrides[key],
          owner.state().frontiers[key],
        ),
      ).toBe(true);
    },
  );
  it.each(["rejected", "expired", "disposed"] as const)(
    "does not save or promote an observation when its capture is %s",
    async (outcome) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const snapshot = structuredClone(f.journal());
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(f.storage.capture).mockImplementationOnce(async () => {
        await gate;
        if (outcome === "rejected") throw new Error("capture unavailable");
        return snapshot;
      });
      let valid = true;
      const reading = owner.read(key, 11, () => valid);
      const result = expect(reading).rejects.toThrow(
        outcome === "rejected"
          ? "capture unavailable"
          : outcome === "expired"
            ? "expired"
            : "closed",
      );
      try {
        owner.accept([peerUnreadMarker(f, key)]);
        if (outcome === "disposed") owner.dispose();
        if (outcome === "expired") valid = false;
        release();
        await result;
      } finally {
        release();
      }
      const live = outcome === "disposed" ? f.make() : owner;
      await live.ready;
      await live.refresh();
      // Replay is explicit after disposal; no old pending attempt may lift it.
      live.accept([peerUnreadMarker(f, key)]);
      await live.learnHomes({});
      expect(f.journal()?.state.frontiers[key]).toBeUndefined();
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(0);
      expect(f.journal()?.peerOverlaps ?? []).toEqual([]);
    },
  );
  it("does not lift peer unread for an automatic read started after marker acceptance", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    let release = () => {};
    let started = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const update = vi.mocked(f.storage.update).getMockImplementation();
    if (!update) throw new Error("Missing fixture storage");
    vi.mocked(f.storage.update).mockImplementationOnce(async (change) => {
      started();
      await hold;
      return update(change);
    });
    const busy = owner.read("other", 1, () => true);
    const id = "c".repeat(64);
    const key = `msg:${id}`;
    const marker = peerUnreadMarker(f, key);
    try {
      await saving;
      owner.accept([marker]);
      const automaticRead = owner.read(key, 11, () => true);
      release();
      await busy;
      await automaticRead;
    } finally {
      release();
    }
    await expect
      .poll(() => f.journal()?.state.overrides[key]?.baseline)
      .toBe(0);
    expect(
      overrideActive(
        owner.state().overrides[key],
        owner.state().frontiers[key],
      ),
    ).toBe(false);
    expect(owner.state().frontiers[key]).toBe(11);
  });
  it.each([
    {
      kind: "observed register carried to another coordinate and client",
      slot: "c".repeat(32),
      createdAt: 100,
      clear: 0,
      active: false,
      restored: false,
    },
    {
      kind: "same coordinate replay",
      slot: "b".repeat(32),
      createdAt: 100,
      clear: 0,
      active: false,
      restored: false,
    },
    {
      kind: "same coordinate newer envelope",
      slot: "b".repeat(32),
      createdAt: 101,
      clear: 0,
      active: false,
      restored: false,
    },
    {
      kind: "carried register with a clear",
      slot: "c".repeat(32),
      createdAt: 100,
      clear: 1,
      active: false,
      restored: false,
    },
    {
      kind: "carried register after restart",
      slot: "c".repeat(32),
      createdAt: 100,
      clear: 0,
      active: false,
      restored: true,
    },
    {
      kind: "carried register already observed above restored fence",
      slot: "c".repeat(32),
      createdAt: 101,
      set: 2,
      knownSet: 2,
      clear: 0,
      active: false,
      restored: true,
    },
    {
      kind: "newer set from another coordinate",
      slot: "c".repeat(32),
      createdAt: 101,
      set: 2,
      clear: 0,
      active: true,
      restored: false,
    },
    {
      kind: "newer set after restart",
      slot: "c".repeat(32),
      createdAt: 101,
      set: 2,
      clear: 0,
      active: true,
      restored: true,
    },
    {
      kind: "newer set on an observed coordinate",
      slot: "b".repeat(32),
      createdAt: 101,
      set: 2,
      clear: 0,
      active: true,
      restored: false,
    },
    {
      kind: "previously omitted peer replay",
      slot: "c".repeat(32),
      createdAt: 102,
      clear: 0,
      active: false,
      restored: false,
      replaced: "omitted",
    },
    {
      kind: "previously lowered peer replay",
      slot: "c".repeat(32),
      createdAt: 102,
      set: 2,
      knownSet: 2,
      clear: 0,
      active: false,
      restored: false,
      replaced: "lowered",
    },
  ])(
    "consumes observed registers but preserves newer sets during an automatic read: $kind",
    async ({
      slot,
      createdAt,
      set = 1,
      knownSet = 1,
      clear,
      active,
      restored,
      replaced,
    }) => {
      const f = fixture();
      let owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const known = peerUnreadMarker(f, key, 0, { set: knownSet });
      const marker =
        slot === "b".repeat(32) && createdAt === 100
          ? known
          : peerUnreadMarker(f, key, 0, {
              slot,
              createdAt,
              set,
              clear,
              clientId: slot === "b".repeat(32) ? "peer" : "other-peer",
            });
      if (restored) {
        owner.accept([
          set === 1
            ? marker
            : peerUnreadMarker(f, key, 0, { slot, clientId: "other-peer" }),
        ]);
        await owner.learnHomes({});
        owner.dispose();
        f.setJournal(JSON.parse(JSON.stringify(f.journal())));
        owner = f.make();
        await owner.ready;
      }
      if (replaced) {
        owner.accept([
          peerUnreadMarker(f, key, 0, { slot, set, clientId: "other-peer" }),
        ]);
        await owner.learnHomes({});
        owner.accept([
          replaced === "lowered"
            ? peerUnreadMarker(f, key, 0, {
                slot,
                set: 1,
                createdAt: 101,
                clientId: "other-peer",
              })
            : signReadState(
                {
                  slot,
                  createdAt: 101,
                  blob: {
                    v: 1,
                    client_id: "other-peer",
                    contexts: { room: 1 },
                  },
                },
                f.key.secret,
                101,
              ),
        ]);
        await owner.learnHomes({});
      }
      owner.accept([known]);
      await owner.learnHomes({});
      const held = holdUpdate(f);
      const reading = owner.read(key, 11, () => true);
      try {
        await held.started;
        owner.accept([marker]);
        held.release();
        await reading;
      } finally {
        held.release();
      }
      await owner.learnHomes({});
      expect(owner.state().frontiers[key]).toBe(11);
      expect(owner.state().overrides[key]?.baseline).toBe(active ? 11 : 0);
      expect(
        overrideActive(
          owner.state().overrides[key],
          owner.state().frontiers[key],
        ),
      ).toBe(active);
    },
  );
  it.each([
    { failure: "storage", restart: false },
    { failure: "storage", restart: true },
    { failure: "cancelled", restart: false },
    { failure: "cancelled", restart: true },
  ])(
    "recovers a committed overlap checkpoint after $failure ingest (restart: $restart)",
    async ({ failure, restart }) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      f.addRemote(marker);
      const held = holdUpdate(f);
      const automaticRead = owner.read(key, 11, () => true);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      if (!update) throw new Error("Missing fixture storage");
      let failed = false;
      try {
        await held.started;
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (!failed && next.state.overrides[key]) {
            failed = true;
            if (failure === "storage") throw new Error("disk full");
            owner.stale();
            return update(change);
          }
          return update(() => next);
        });
        owner.accept([marker]);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await owner.learnHomes({});
      expect(owner.owed()).toBe(true);
      expect(f.journal()?.state.overrides[key]).toBeUndefined();
      const checkpoint = f.journal()?.peerOverlaps;
      const other = f.make();
      await other.ready;
      await other.read("unrelated", 7, () => true);
      await other.markLocalUnread("manual", () => true);
      const preservedCheckpoint = f.journal()?.peerOverlaps;
      other.dispose();
      let recovered = owner;
      if (restart) {
        owner.dispose();
        f.setJournal(
          readJournal(JSON.parse(JSON.stringify(f.journal())), f.key.pubkey),
        );
        recovered = f.make();
        await recovered.ready;
      }
      await recovered.refresh();
      expect(
        overrideActive(
          recovered.state().overrides[key],
          recovered.state().frontiers[key],
        ),
      ).toBe(true);
      expect(preservedCheckpoint).toEqual(checkpoint);
      expect(checkpoint).toEqual([
        {
          coordinate: `read-state:${"b".repeat(32)}`,
          key,
          set: 1,
          baseline: 11,
          version: { id: marker.id, created_at: marker.created_at },
        },
      ]);
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(11);
      expect(f.journal()?.peerOverlaps).toBeUndefined();
      expect(recovered.owed()).toBe(false);
    },
  );
  it.each([
    { reloaded: false, failedIngest: false },
    { reloaded: false, failedIngest: true },
    { reloaded: true, failedIngest: false },
    { reloaded: true, failedIngest: true },
  ])(
    "a live window does not recapture committed peer generations (reloaded: $reloaded, failed ingest: $failedIngest)",
    async ({ reloaded, failedIngest }) => {
      const f = fixture();
      const options = {
        broadcastName: reloaded
          ? `read-checkpoint:${crypto.randomUUID()}`
          : undefined,
      };
      const a = f.make(options),
        b = f.make(options);
      await Promise.all([a.ready, b.ready]);
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      const read = vi.mocked(f.storage.read).getMockImplementation();
      if (!update || !read) throw new Error("Missing fixture storage");
      let loaded = () => {};
      const checkpointLoaded = new Promise<void>((resolve) => {
        loaded = resolve;
      });
      vi.mocked(f.storage.read).mockImplementation(async () => {
        const saved = await read();
        if (saved?.peerOverlaps?.length || saved?.state.overrides[key])
          loaded();
        return saved;
      });
      let failed = false;
      vi.mocked(f.storage.update).mockImplementation(async (change) => {
        const next = change(f.journal());
        if (failedIngest && !failed && next.state.overrides[key]) {
          failed = true;
          throw new Error("disk full");
        }
        return update(() => next);
      });
      a.accept([marker]);
      await a.learnHomes({});
      if (reloaded) {
        await checkpointLoaded;
        await b.learnHomes({});
      }
      const held = holdUpdate(f);
      const reading = b.read(key, 11, () => true);
      try {
        await held.started;
        b.accept([marker]);
        held.release();
        await reading;
      } finally {
        held.release();
      }
      await b.learnHomes({});
      expect(
        overrideActive(b.state().overrides[key], b.state().frontiers[key]),
      ).toBe(false);
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(0);
      expect(f.journal()?.peerOverlaps).toBeUndefined();
    },
  );
  it.each([1, 2])(
    "back-to-back peer revisions remain healthy (successor set: %s)",
    async (set) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      await owner.refresh();
      const key = `msg:${"a".repeat(64)}`;
      owner.accept([peerUnreadMarker(f, key)]);
      owner.accept([peerUnreadMarker(f, key, 0, { set, createdAt: 101 })]);
      await owner.learnHomes({});
      expect(owner.state().overrides[key]).toEqual({
        set,
        clear: 0,
        baseline: 0,
      });
      expect(owner.owed()).toBe(false);
      expect(owner.snapshot().status).not.toBe("error");
      expect(owner.snapshot().completeness).not.toBe("unknown");
      expect(f.journal()?.peerOverlaps).toBeUndefined();
    },
  );
  it.each([1, 2])(
    "revisions dominated by a sibling checkpoint remain healthy (successor set: %s)",
    async (set) => {
      const f = fixture();
      const a = f.make(),
        b = f.make();
      await Promise.all([a.ready, b.ready]);
      await a.refresh();
      const key = `msg:${"a".repeat(64)}`;
      const earlier = peerUnreadMarker(f, key);
      const later = peerUnreadMarker(f, key, 0, { set, createdAt: 101 });
      const held = holdUpdate(f, true);
      b.accept([later]);
      try {
        await held.started;
        a.accept([earlier]);
        await a.learnHomes({});
        expect(a.state().overrides[key]).toBeUndefined();
        expect(f.journal()?.peerOverlaps).toContainEqual({
          coordinate: `read-state:${"b".repeat(32)}`,
          key,
          set,
          baseline: 0,
          version: { id: later.id, created_at: later.created_at },
        });
        expect(a.owed()).toBe(false);
        expect(a.snapshot()).toMatchObject({
          status: "reconciled",
          completeness: "bounded",
        });
        a.accept([later]);
        await a.learnHomes({});
        expect(a.state().overrides[key]).toEqual({
          set,
          clear: 0,
          baseline: 0,
        });
        expect(a.owed()).toBe(false);
        expect(a.snapshot()).toMatchObject({
          status: "reconciled",
          completeness: "bounded",
        });
        expect(f.journal()?.peerOverlaps).toBeUndefined();
      } finally {
        held.release();
        await b.learnHomes({});
      }
      expect(b.owed()).toBe(false);
    },
  );
  it.each([
    { source: "accept", compact: true, checkpoints: 2 },
    { source: "accept", compact: false, checkpoints: 1 },
    { source: "refresh", compact: true, checkpoints: 1 },
    { source: "refresh", compact: false, checkpoints: 1 },
  ])(
    "a newer checkpoint fences stale marker replay after restart ($source, compact: $compact)",
    async ({ source, compact, checkpoints }) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      const cleared = compact ? 2 : 1;
      const clear = signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 101,
          blob: {
            v: 1,
            client_id: "peer",
            contexts: compact
              ? { [`ov_c:${key}`]: cleared }
              : {
                  [`ov_s:${key}`]: 1,
                  [`ov_c:${key}`]: cleared,
                  [`ov_b:${key}`]: 0,
                },
          },
        },
        f.key.secret,
        101,
      );
      const held = holdUpdate(f);
      const automaticRead = owner.read(key, 11, () => true);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      if (!update) throw new Error("Missing fixture storage");
      try {
        await held.started;
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (next.state.overrides[key]) throw new Error("disk full");
          return update(() => next);
        });
        owner.accept([marker]);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await owner.learnHomes({});
      expect(f.journal()?.peerOverlaps?.[0]?.baseline).toBe(11);
      if (source === "accept") {
        owner.accept([clear]);
        await owner.learnHomes({});
      } else {
        f.addRemote(clear);
        await owner.refresh();
      }
      expect(f.journal()?.peerOverlaps).toHaveLength(checkpoints);
      owner.dispose();
      vi.mocked(f.storage.update).mockImplementation(update);
      const restarted = f.make();
      await restarted.ready;
      restarted.accept([marker]);
      await restarted.learnHomes({});
      expect(
        overrideActive(
          restarted.state().overrides[key],
          restarted.state().frontiers[key],
        ),
      ).toBe(false);
      expect(restarted.owed()).toBe(false);
      f.addRemote(clear);
      await restarted.refresh();
      expect(f.journal()?.state.overrides[key]?.clear).toBe(cleared);
      expect(f.journal()?.peerOverlaps).toBeUndefined();
      expect(restarted.owed()).toBe(false);
    },
  );
  it.each([false, true])(
    "preserves valid overlapping coordinates without a recovery capacity regression (reading: %s)",
    async (reading) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const firstKey = `msg:${"0".repeat(64)}`;
      const keys = Array.from(
        { length: 40 },
        (_, n) => `msg:${n.toString(16).padStart(64, "0")}`,
      );
      const contexts = Object.fromEntries(
        keys.flatMap((key) => [
          [`ov_s:${key}`, 1],
          [`ov_c:${key}`, 0],
          [`ov_b:${key}`, 0],
        ]),
      );
      const markers = Array.from({ length: 64 }, (_, n) =>
        signReadState(
          {
            slot: n.toString(16).padStart(32, "0"),
            createdAt: 100,
            blob: { v: 1, client_id: `peer-${n}`, contexts },
          },
          f.key.secret,
          100,
        ),
      );
      expect(
        new TextEncoder().encode(JSON.stringify(markers)).byteLength,
      ).toBeLessThan(READ_SNAPSHOT_BYTES);
      if (reading) {
        const held = holdUpdate(f);
        const read = owner.read(firstKey, 11, () => true);
        try {
          await held.started;
          owner.accept(markers);
          held.release();
          await read;
        } finally {
          held.release();
        }
      } else owner.accept(markers);
      await owner.learnHomes({});
      expect(owner.snapshot().error).toBeUndefined();
      expect(Object.keys(owner.state().overrides)).toEqual(keys);
      expect(
        overrideActive(
          owner.state().overrides[firstKey],
          owner.state().frontiers[firstKey],
        ),
      ).toBe(true);
      expect(f.journal()?.peerOverlaps).toBeUndefined();
    },
  );
  it("does not claim durable overlap when the first checkpoint write fails", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = `msg:${"a".repeat(64)}`;
    const marker = peerUnreadMarker(f, key);
    f.addRemote(marker);
    const held = holdUpdate(f);
    const automaticRead = owner.read(key, 11, () => true);
    try {
      await held.started;
      vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
      owner.accept([marker]);
      held.release();
      await automaticRead;
    } finally {
      held.release();
    }
    await owner.learnHomes({});
    expect(owner.owed()).toBe(true);
    expect(f.journal()?.peerOverlaps).toBeUndefined();
    expect(f.journal()?.state.frontiers[key]).toBe(11);
    owner.dispose();
    const restarted = f.make();
    await restarted.ready;
    await restarted.refresh();
    expect(f.journal()?.state.overrides[key]?.baseline).toBe(0);
    expect(
      overrideActive(
        restarted.state().overrides[key],
        restarted.state().frontiers[key],
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "keeps peer unread when both windows ingest it %s after the automatic commit, including restart",
    async (afterCommit) => {
      const f = fixture();
      const options = { broadcastName: `read-unread:${crypto.randomUUID()}` };
      const a = f.make(options),
        b = f.make(options);
      await Promise.all([a.ready, b.ready]);
      const id = "a".repeat(64);
      const key = `msg:${id}`;
      const held = holdUpdate(f, afterCommit);
      const marker = peerUnreadMarker(f, key);
      f.addRemote(marker);
      const automaticRead = a.read(key, 11, () => true);
      try {
        await held.started;
        a.accept([marker]);
        b.accept([marker]);
        await expect.poll(() => f.journal()?.state.overrides[key]?.set).toBe(1);
        expect(f.journal()?.state.overrides[key]?.baseline).toBe(0);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await expect
        .poll(() => f.journal()?.state.overrides[key]?.baseline)
        .toBe(11);
      await expect
        .poll(() =>
          overrideActive(b.state().overrides[key], b.state().frontiers[key]),
        )
        .toBe(true);
      expect(f.journal()?.state.overrides[key]).toEqual({
        set: 1,
        clear: 0,
        baseline: 11,
      });
      expect(
        decodeReadState([marker], f.key.secret)[0]?.blob.contexts[
          `ov_b:${key}`
        ],
      ).toBe(0);
      a.accept([marker]);
      await expect
        .poll(() => f.journal()?.state.overrides[key]?.baseline)
        .toBe(11);

      const saved = f.journal();
      if (!saved) throw new Error("Missing saved read state");
      a.dispose();
      b.dispose();
      f.setJournal(
        readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
      );
      const restarted = f.make();
      await restarted.ready;
      restarted.accept([marker]);
      await expect
        .poll(() => f.journal()?.state.overrides[key]?.baseline)
        .toBe(11);
      expect(
        overrideActive(
          restarted.state().overrides[key],
          restarted.state().frontiers[key],
        ),
      ).toBe(true);
      expect(restarted.state().frontiers[key]).toBe(11);
      await restarted.flush();
      expect(f.own()).toEqual({});
      expect(f.remoteEvents()).toContainEqual(marker);
      const explicitRead = true;
      await restarted.read(key, 12, () => true, explicitRead);
      expect(
        overrideActive(
          restarted.state().overrides[key],
          restarted.state().frontiers[key],
        ),
      ).toBe(false);
    },
  );
  it.each([
    { failure: "storage", laterRead: false },
    { failure: "cancelled", laterRead: false },
    { failure: "decode", laterRead: false },
    { failure: "decode", laterRead: true },
  ] as const)(
    "retains first-arrival correlation through $failure and refresh (later read: $laterRead)",
    async ({ failure, laterRead }) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      f.addRemote(marker);
      const held = holdUpdate(f);
      const automaticRead = owner.read(key, 11, () => true);
      try {
        await held.started;
        if (failure === "storage")
          vi.mocked(f.storage.update).mockRejectedValueOnce(
            new Error("disk full"),
          );
        if (failure === "decode")
          f.host.decode.mockRejectedValueOnce(new Error("decode unavailable"));
        owner.accept([marker]);
        if (failure === "cancelled") owner.stale();
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      // Queue a no-op owner operation as the completion barrier for the failed accept.
      await owner.learnHomes({});
      expect(f.journal()?.state.overrides[key]).toBeUndefined();
      expect(owner.owed()).toBe(true);
      if (laterRead) await owner.read(key, 12, () => true);
      await owner.refresh();
      expect(
        overrideActive(
          owner.state().overrides[key],
          owner.state().frontiers[key],
        ),
      ).toBe(!laterRead);
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(11);
      expect(owner.state().frontiers[key]).toBe(laterRead ? 12 : 11);
      expect(owner.owed()).toBe(false);
    },
  );
  it.each([false, true])(
    "a valid replacement recovers from a superseded undecodable marker (failed save: %s)",
    async (failedSave) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const marker = peerUnreadMarker(f, "room");
      const invalid = eventDto(
        finalizeEvent(
          {
            kind: marker.kind,
            created_at: marker.created_at,
            tags: marker.tags,
            content: "not an encrypted read-state blob",
          },
          f.key.secret,
        ),
      );
      owner.accept([invalid]);
      await owner.learnHomes({});
      expect(owner.owed()).toBe(true);
      const replacement = signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 101,
          blob: { v: 1, client_id: "peer", contexts: { room: 12 } },
        },
        f.key.secret,
        101,
      );
      f.addRemote(replacement);
      if (failedSave) {
        const update = vi.mocked(f.storage.update).getMockImplementation();
        if (!update) throw new Error("Missing fixture storage");
        let failed = false;
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (!failed && next.state.frontiers.room === 12) {
            failed = true;
            throw new Error("disk full");
          }
          return update(() => next);
        });
      }
      owner.accept([replacement]);
      await owner.learnHomes({});
      if (failedSave) {
        expect(owner.state().frontiers.room).toBeUndefined();
        expect(owner.owed()).toBe(true);
      } else {
        expect(owner.state().frontiers.room).toBe(12);
      }
      await owner.refresh();
      expect(owner.state().frontiers.room).toBe(12);
      expect(f.journal()?.state.frontiers.room).toBe(12);
      expect(owner.owed()).toBe(false);
    },
  );
  it.each([
    { kind: "same marker", set: 1, clear: 0, baseline: 11, active: true },
    { kind: "newer set", set: 2, clear: 0, baseline: 0, active: false },
    { kind: "clear", set: 1, clear: 1, baseline: 0, active: false },
    { kind: "later read", set: 1, clear: 0, baseline: 11, active: false },
  ])(
    "restart correlates only the original marker generation: $kind",
    async ({ kind, set, clear, baseline, active }) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      const held = holdUpdate(f);
      const automaticRead = owner.read(key, 11, () => true);
      try {
        await held.started;
        const update = vi.mocked(f.storage.update).getMockImplementation();
        if (!update) throw new Error("Missing fixture storage");
        let failed = false;
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (!failed && next.state.overrides[key]) {
            failed = true;
            throw new Error("disk full");
          }
          return update(() => next);
        });
        owner.accept([marker]);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await owner.learnHomes({});
      expect(owner.owed()).toBe(true);
      owner.dispose();
      const restarted = f.make();
      await restarted.ready;
      if (kind === "later read")
        await restarted.read(key, 12, () => true, true);
      f.addRemote(peerUnreadMarker(f, key, 0, { set, clear, createdAt: 101 }));
      await restarted.refresh();
      expect(f.journal()?.state.overrides[key]).toEqual({
        set,
        clear,
        baseline,
      });
      expect(
        overrideActive(
          restarted.state().overrides[key],
          restarted.state().frontiers[key],
        ),
      ).toBe(active);
      expect(restarted.owed()).toBe(false);
      expect(f.journal()?.peerOverlaps).toBeUndefined();
    },
  );
  it.each(
    [
      { kind: "duplicate", createdAt: 100, set: 1, baseline: 0, active: false },
      {
        kind: "same generation",
        createdAt: 101,
        set: 1,
        baseline: 0,
        active: false,
      },
      {
        kind: "new generation",
        createdAt: 101,
        set: 2,
        baseline: 11,
        active: true,
      },
    ].flatMap((value) => [
      { ...value, checkpointed: false },
      { ...value, checkpointed: true },
    ]),
  )(
    "a failed first arrival cannot recapture a later read: $kind (checkpointed restart: $checkpointed)",
    async ({ createdAt, set, baseline, active, checkpointed }) => {
      const f = fixture();
      let owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const marker = peerUnreadMarker(f, key);
      if (checkpointed) {
        const update = vi.mocked(f.storage.update).getMockImplementation();
        if (!update) throw new Error("Missing fixture storage");
        let failed = false;
        vi.mocked(f.storage.update).mockImplementation(async (change) => {
          const next = change(f.journal());
          if (!failed && next.state.overrides[key]) {
            failed = true;
            throw new Error("disk full");
          }
          return update(() => next);
        });
      } else
        f.host.decode.mockRejectedValueOnce(new Error("decode unavailable"));
      owner.accept([marker]);
      await owner.learnHomes({});
      expect(owner.owed()).toBe(true);
      if (checkpointed) {
        expect(f.journal()?.peerOverlaps?.[0]?.baseline).toBe(0);
        owner.dispose();
        owner = f.make();
        await owner.ready;
      }
      const held = holdUpdate(f);
      const automaticRead = owner.read(key, 11, () => true);
      try {
        await held.started;
        owner.accept([
          createdAt === 100
            ? marker
            : peerUnreadMarker(f, key, 0, { createdAt, set }),
        ]);
        held.release();
        await automaticRead;
      } finally {
        held.release();
      }
      await owner.learnHomes({});
      expect(f.journal()?.state.overrides[key]?.baseline).toBe(baseline);
      expect(
        overrideActive(
          owner.state().overrides[key],
          owner.state().frontiers[key],
        ),
      ).toBe(active);
    },
  );
  it("does not recapture a queued read under a newer envelope after first arrival commits", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = `msg:${"a".repeat(64)}`;
    const held = holdUpdate(f);
    owner.accept([peerUnreadMarker(f, key)]);
    try {
      await held.started;
      const automaticRead = owner.read(key, 11, () => true);
      owner.accept([peerUnreadMarker(f, key, 0, { createdAt: 101 })]);
      held.release();
      await automaticRead;
    } finally {
      held.release();
    }
    await owner.learnHomes({});
    expect(f.journal()?.state.overrides[key]?.baseline).toBe(0);
    expect(
      overrideActive(
        owner.state().overrides[key],
        owner.state().frontiers[key],
      ),
    ).toBe(false);
  });
  it("a surviving window publishes broadcast intent and reports pending until readback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-handoff:${crypto.randomUUID()}`,
      debounceMs: 100,
      lock: browserReadPublisherLock(`read-handoff:${crypto.randomUUID()}`),
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    expect(b.snapshot().status).toBe("reconciled");
    await a.read("room", 12, () => true);
    // Real BroadcastChannel delivery, but a deterministic publisher clock.
    await expect.poll(() => b.state().frontiers.room).toBe(12);
    a.dispose();
    expect(b.snapshot().status).toBe("pending");
    expect(f.host.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await expect.poll(() => b.snapshot().status).toBe("reconciled");
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    expect(f.journal()).toMatchObject({ revision: 1, acceptedRevision: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("broadcast publishers serialize and a peer observes readback without duplicate signing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-both:${crypto.randomUUID()}`,
      debounceMs: 100,
      lock: browserReadPublisherLock(`read-both:${crypto.randomUUID()}`),
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await a.read("room", 12, () => true);
    await expect.poll(() => b.snapshot().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    await expect
      .poll(() => [a.snapshot().status, b.snapshot().status])
      .toEqual(["reconciled", "reconciled"]);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("a peer refresh loads the saved journal without writing it back", async () => {
    const f = fixture();
    const options = { broadcastName: `read-load:${crypto.randomUUID()}` };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.ready, b.ready]);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    await a.read("room", 12, () => true);
    await expect.poll(() => b.revision()).toBe(1);
    expect(b.state().frontiers.room).toBe(12);
    expect(f.storage.update).toHaveBeenCalledTimes(updates + 1);
  });
  it("a peer refresh saves a new journal only when none is stored", async () => {
    const f = fixture();
    const options = { broadcastName: `read-missing:${crypto.randomUUID()}` };
    const owner = f.make(options);
    await owner.ready;
    const slot = f.journal()?.slot;
    f.setJournal(undefined);
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect.poll(() => f.journal()).toBeDefined();
    expect(f.journal()?.slot).not.toBe(slot);
    expect(owner.snapshot().error).toBeUndefined();
  });
  it("a peer refresh reports corrupt saved state without replacing it", async () => {
    const f = fixture();
    const options = { broadcastName: `read-corrupt:${crypto.randomUUID()}` };
    const owner = f.make(options);
    await owner.ready;
    const corrupt = {
      ...newReadJournal(),
      state: { frontiers: { room: -1 }, overrides: {} },
    };
    f.setJournal(corrupt);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect.poll(() => owner.snapshot().status).toBe("error");
    expect(f.journal()).toBe(corrupt);
    expect(f.storage.update).toHaveBeenCalledTimes(updates);
  });
  it("a late peer load cannot restore a purge, replace later intent or apply after disposal", async () => {
    const f = fixture();
    const options = { broadcastName: `read-late:${crypto.randomUUID()}` };
    const load = vi.fn(() => f.storage.read());
    const a = f.make(options),
      b = f.make({ ...options, storage: { ...f.storage, read: load } });
    await Promise.all([a.ready, b.ready]);
    const hold = () => {
      let release = () => {};
      let started = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      load.mockImplementationOnce(async () => {
        const loaded = await f.storage.read();
        started();
        await held;
        return loaded;
      });
      return { release, reading };
    };
    let held = hold();
    await a.read("a", 1, () => true);
    await held.reading;
    const local = b.read("b", 2, () => true);
    await a.read("c", 3, () => true);
    held.release();
    await local;
    await expect.poll(() => [a.revision(), b.revision()]).toEqual([3, 3]);
    expect(b.state().frontiers).toEqual({ a: 1, b: 2, c: 3 });
    expect(f.journal()).toMatchObject({
      revision: 3,
      state: { frontiers: { a: 1, b: 2, c: 3 } },
    });

    held = hold();
    await a.read("d", 4, () => true);
    await held.reading;
    f.setJournal(undefined);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    held.release();
    await expect.poll(() => b.revision()).toBe(4);
    expect(f.journal()).toBeUndefined();
    expect(f.storage.update).toHaveBeenCalledTimes(updates);

    f.setJournal({ ...newReadJournal(), revision: 9, acceptedRevision: 9 });
    held = hold();
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await held.reading;
    b.dispose();
    held.release();
    await expect.poll(() => a.revision()).toBe(9);
    expect(b.revision()).toBe(4);
    expect(f.storage.update).toHaveBeenCalledTimes(updates);
  });
  it("broadcast handoff retries saved bytes and no-op broadcasts preserve a failed outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-retry:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await a.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await a.flush();
    const pending = f.journal()?.pending?.event;
    expect(pending).toBeDefined();
    await expect.poll(() => b.state().frontiers.room).toBe(12);
    a.dispose();
    f.host.publish.mockRejectedValueOnce(new Error("still offline"));
    await vi.advanceTimersByTimeAsync(100);
    await expect.poll(() => b.snapshot().status).toBe("error");
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(pending);
    const notify = new BroadcastChannel(options.broadcastName);
    const loads = vi.mocked(f.storage.read).mock.calls.length;
    notify.postMessage("changed");
    notify.close();
    await expect
      .poll(() => vi.mocked(f.storage.read).mock.calls.length)
      .toBeGreaterThan(loads);
    expect(b.snapshot()).toMatchObject({
      status: "error",
      error: "still offline",
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
    await b.flush();
    expect(f.host.publish.mock.calls[2]?.[0]).toEqual(pending);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(b.snapshot().status).toBe("reconciled");
  });
  it.each([true, false])(
    "drains peer intent arriving during publication after the originating window closes (broadcast: %s)",
    async (broadcast) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      const options = {
        broadcastName: broadcast
          ? `read-inflight:${crypto.randomUUID()}`
          : undefined,
        debounceMs: 100,
      };
      const a = f.make(options),
        b = f.make(options);
      await Promise.all([a.refresh(), b.refresh()]);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const publish = f.host.publish.getMockImplementation();
      if (!publish) throw new Error("Missing publisher");
      f.host.publish.mockImplementationOnce(async (event) => {
        await held;
        await publish(event);
      });
      await b.read("first", 11, () => true);
      const first = b.flush();
      await expect.poll(() => f.host.publish.mock.calls.length).toBe(1);
      await a.read("second", 12, () => true);
      a.dispose();
      release();
      await first;
      expect(f.journal()).toMatchObject({ revision: 2, acceptedRevision: 1 });
      await vi.advanceTimersByTimeAsync(400);
      await expect.poll(() => f.journal()?.acceptedRevision).toBe(2);
      expect(b.snapshot().status).toBe("reconciled");
      expect(f.host.publish).toHaveBeenCalledTimes(2);
    },
  );
  it("a failed lock attempt remains an error without automatic retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const lock = vi.fn(async () => {
      throw new Error("lock unavailable");
    });
    const owner = f.make({ lock, debounceMs: 100 });
    await owner.ready;
    await owner.read("room", 12, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: "lock unavailable",
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it("successful peer readback clears the other window's failed publication status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-recovery:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await b.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await b.flush();
    expect(b.snapshot().status).toBe("error");
    const pending = f.journal()?.pending?.event;
    await a.flush();
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(pending);
    await expect.poll(() => b.snapshot().status).toBe("reconciled");
    expect(b.snapshot().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
  });
  it("peer publication recovery does not clear a subsequent marker-load error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-load-error:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await b.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await b.flush();
    f.reader.read.mockRejectedValueOnce(new Error("marker load failed"));
    await b.refresh();
    expect(b.snapshot().error).toBe("marker load failed");
    await a.flush();
    const loads = vi.mocked(f.storage.read).mock.calls.length;
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect
      .poll(() => vi.mocked(f.storage.read).mock.calls.length)
      .toBeGreaterThan(loads);
    expect(b.snapshot()).toMatchObject({
      status: "error",
      error: "marker load failed",
    });
    expect(f.journal()).toMatchObject({ revision: 1, acceptedRevision: 1 });
  });
  it("preserves local-only manual intent without lowering frontiers or scheduling a publish", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.read("room", 12, () => true);
    await owner.flush();
    const result = await owner.markLocalUnread("room", () => true);
    expect(result.sync).toBe("local-only");
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("msg:one", 13, () => true);
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("room", 12, () => true, true);
    expect(owner.localUnread("room")).toBeUndefined();
  });
  it("keeps an evicted message receipt locally and never publishes message marks", async () => {
    const f = fixture();
    const owner = f.make();
    const old = `msg:${"a".repeat(64)}`;
    await owner.ready;
    await owner.read(old, 1, () => true);
    await owner.readMessages(
      Array.from({ length: 1600 }, (_, n) => ({
        key: `msg:${n.toString(16).padStart(64, "0")}`,
        timestamp: 10 + n,
        channelId: "elsewhere",
      })),
      undefined,
      () => true,
    );
    expect(f.journal()?.state.frontiers[old]).toBeUndefined();
    expect(owner.state().frontiers[old]).toBe(1);
    await owner.flush();
    expect(owner.snapshot().status).toBe("reconciled");
    expect(f.host.publish).not.toHaveBeenCalled();
    owner.dispose();
    const restarted = f.make();
    await restarted.ready;
    expect(restarted.state().frontiers[old]).toBe(1);
    expect(restarted.state().frontiers["msg:unseen"]).toBeUndefined();
  });
  it("raises a local floor over marks the reserve drops, keeps it after restart and never publishes it", async () => {
    const f = fixture();
    const owner = f.make();
    const old = `msg:${"a".repeat(64)}`;
    await owner.ready;
    await owner.read(old, 1, () => true);
    const marks = Array.from({ length: 7000 }, (_, n) => ({
      key: `msg:${n.toString(16).padStart(64, "0")}`,
      timestamp: 10 + n,
      channelId: "elsewhere",
    }));
    await owner.readMessages(marks, undefined, () => true);
    const floor = owner.floor();
    expect(floor).toBeGreaterThan(10);
    expect(owner.state().frontiers[old]).toBeUndefined();
    for (const { key, timestamp } of [{ key: old, timestamp: 1 }, ...marks])
      expect(
        (owner.state().frontiers[key] ?? -1) >= timestamp || timestamp <= floor,
      ).toBe(true);
    expect(owner.state().frontiers[marks.at(-1)?.key ?? ""]).toBe(7009);
    // A channel mark below the local floor still publishes: publication keeps
    // only the retention window.
    await owner.read("room", 5, () => true);
    expect(owner.state().frontiers.room).toBe(5);
    await owner.flush();
    expect(f.published()).toEqual({ room: 5 });
    owner.dispose();
    const restarted = f.make();
    await restarted.ready;
    expect(restarted.floor()).toBe(floor);
  });
  it("rejects a captured reply when retention drops its mark despite a retained thread frontier", async () => {
    const f = fixture();
    const rootId = (READ_RESERVE_KEYS - 1).toString(16).padStart(64, "0");
    const selectedKey = `msg:${"e".repeat(64)}`;
    const selectedAt = 6000;
    const overrideKey = "manual";
    const override = { [overrideKey]: { set: 2, clear: 0, baseline: 0 } };
    const journal = newReadJournal();
    let channels: Record<string, number> = {};
    for (let n = 0; n < 1000; n++) {
      const key = `c${n}`.padEnd(128, "x");
      try {
        channels = retainRead(
          [{ frontiers: { ...channels, [key]: 100 }, overrides: override }],
          {},
          journal.clientId,
        ).state.frontiers;
      } catch {
        break;
      }
    }
    const reserve = Object.fromEntries(
      Array.from({ length: READ_RESERVE_KEYS }, (_, n) => [
        `thread:${n.toString(16).padStart(64, "0")}`,
        n === READ_RESERVE_KEYS - 1 ? selectedAt : 100 + n,
      ]),
    );
    f.setJournal({
      ...journal,
      revision: 1,
      state: {
        frontiers: channels,
        overrides: override,
      },
      localUnread: { [selectedKey]: 1 },
      reserve,
    });
    const owner = f.make();
    await owner.ready;
    const before = f.journal();

    await expect(
      owner.readMessages(
        [
          {
            key: selectedKey,
            timestamp: selectedAt,
            channelId: "target-room",
            rootId,
          },
        ],
        undefined,
        () => true,
        false,
        undefined,
        [selectedKey],
        { preserveCapturedSet: true },
      ),
    ).rejects.toBeInstanceOf(CapturedReadNotRetainedError);

    expect(f.journal()).toEqual(before);
    expect(owner.floor()).toBe(0);
    expect(owner.state().frontiers[selectedKey]).toBeUndefined();
    expect(
      effectiveFrontier(owner.state(), selectedKey, "target-room"),
    ).toBeUndefined();
    expect(owner.localUnread(selectedKey)).toBe(1);

    owner.dispose();
    const reloaded = f.make();
    await reloaded.ready;
    expect(reloaded.localUnread(selectedKey)).toBe(1);
    expect(reloaded.state().frontiers[selectedKey]).toBeUndefined();
    expect(
      effectiveFrontier(reloaded.state(), selectedKey, "target-room"),
    ).toBeUndefined();
  });
  it("preserves the reserve through remote replay, local unread and concurrent mutations", async () => {
    const f = fixture();
    f.setJournal({ ...newReadJournal(), reserve: { "msg:old": 20 } });
    const options = { broadcastName: `read-reserve:${crypto.randomUUID()}` };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.ready, b.ready]);
    await a.markLocalUnread("msg:old", () => true);
    const peer = signReadState(
      {
        slot: "b".repeat(32),
        createdAt: 90,
        blob: { v: 1, client_id: "peer", contexts: { "msg:old": 5 } },
      },
      f.key.secret,
      100,
    );
    f.reader.read.mockResolvedValueOnce([peer]);
    await a.refresh();
    expect(a.state().frontiers["msg:old"]).toBe(20);
    expect(a.localUnread("msg:old")).toBeGreaterThan(0);
    expect(f.journal()?.reserve?.["msg:old"]).toBeUndefined();
    await Promise.all([
      a.read("msg:a", 25, () => true),
      b.read("msg:b", 30, () => true),
    ]);
    await expect
      .poll(() => a.state().frontiers)
      .toEqual({ "msg:old": 20, "msg:a": 25, "msg:b": 30 });
    await expect.poll(() => b.state().frontiers).toEqual(a.state().frontiers);
    await b.read("msg:old", 10, () => true, true);
    expect(b.localUnread("msg:old")).toBeUndefined();
    expect(b.state().frontiers["msg:old"]).toBe(20);
  });
  it("does not lose archived intent when a save fails and can clear it on a read-only host", async () => {
    const f = fixture();
    f.setJournal({ ...newReadJournal(), reserve: { "msg:old": 20 } });
    const owner = f.make();
    await owner.ready;
    const saved = f.journal();
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.read("msg:old", 30, () => true)).rejects.toThrow(
      "disk full",
    );
    expect(f.journal()).toBe(saved);
    expect(owner.state().frontiers["msg:old"]).toBe(20);
    owner.dispose();
    const readOnly = f.make({ lock: undefined });
    await readOnly.ready;
    await readOnly.markLocalUnread("msg:old", () => true);
    await readOnly.readMessages(
      [{ key: "msg:old", timestamp: 20, channelId: "room" }],
      undefined,
      () => true,
    );
    expect(readOnly.localUnread("msg:old")).toBeUndefined();
    expect(f.journal()?.reserve).toEqual({ "msg:old": 20 });
    expect(f.host.sign).not.toHaveBeenCalled();
  });
  it("validates optional reserve data without replacing corrupt saved intent", () => {
    const f = fixture();
    expect(
      readJournal({ ...newReadJournal(), floor: 7 }, f.key.pubkey).floor,
    ).toBe(7);
    for (const floor of [-1, 1.5, "7"])
      expect(() =>
        readJournal({ ...newReadJournal(), floor }, f.key.pubkey),
      ).toThrow("floor");
    expect(readJournal(newReadJournal(), f.key.pubkey).reserve).toEqual({});
    for (const reserve of [
      [],
      { "msg:bad": -1 },
      { "": 1 },
      { ["x".repeat(257)]: 1 },
      Object.fromEntries(
        Array.from({ length: 5001 }, (_, n) => [`msg:${n}`, 1]),
      ),
      Object.fromEntries(
        Array.from({ length: 3000 }, (_, n) => [
          String(n).padStart(240, "x"),
          1,
        ]),
      ),
    ])
      expect(() =>
        readJournal({ ...newReadJournal(), reserve }, f.key.pubkey),
      ).toThrow("reserve");
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          state: { frontiers: { room: 1 }, overrides: {} },
          reserve: { room: 2 },
        },
        f.key.pubkey,
      ),
    ).toThrow("reserve");
  });
  it("publishes every frontier across further blobs, rewriting only changed ones", async () => {
    const f = fixture(),
      first = f.make();
    await first.ready;
    const id = (n: number) => `thread:${n.toString(16).padStart(64, "0")}`;
    await first.readMessages(
      Array.from({ length: 1600 }, (_, n) => ({
        key: id(n),
        timestamp: 50 + n,
        channelId: "room",
      })),
      undefined,
      () => true,
    );
    await first.read(`msg:${"a".repeat(64)}`, 60, () => true);
    await first.flush();
    expect(first.snapshot().status).toBe("reconciled");
    const blobs = f.host.publish.mock.calls.length;
    expect(blobs).toBeGreaterThan(1);
    // Full-state readers reject duplicate coordinates, so each blob is distinct.
    const coordinates = f.host.publish.mock.calls.map(
      ([event]) => event.tags.find(([name]) => name === "d")?.[1],
    );
    expect(new Set(coordinates).size).toBe(blobs);
    for (const [event] of f.host.publish.mock.calls) {
      const blob = decodeReadState([event], f.key.secret)[0].blob;
      expect(
        new TextEncoder().encode(JSON.stringify(blob)).length,
      ).toBeLessThanOrEqual(40 * 1024);
    }
    const published = f.published();
    for (let n = 0; n < 1600; n++) expect(published[id(n)]).toBe(50 + n);
    expect(Object.keys(published).some((key) => key.startsWith("msg:"))).toBe(
      false,
    );
    expect(f.journal()?.spill).toHaveLength(blobs - 1);
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read(id(1599), 5000, () => true);
    await second.flush();
    expect(second.snapshot().status).toBe("reconciled");
    expect(f.host.publish).toHaveBeenCalledTimes(blobs + 1);
    expect(f.published()[id(1599)]).toBe(5000);
    expect(f.published()[id(0)]).toBe(50);
  }, 15000);
  it("a fresh read stays read, locally and published, when a peer's thread mark covers it", async () => {
    const hex = (prefix: string, n: number) =>
      `${prefix}${n.toString(16).padStart(64, "0")}`;
    const root = "9".repeat(64);
    const read = `thread-activity:${root}`,
      cover = `thread:${root}`;
    // Review fixtures: 500 message marks overflow locally; 200 fit locally
    // but overflow the smaller published blob.
    for (const messages of [500, 200]) {
      const f = fixture();
      const frontiers: Record<string, number> = {};
      for (let n = 0; n < 295; n++) frontiers[crypto.randomUUID()] = 10;
      for (let n = 0; n < 458; n++) frontiers[hex("thread:", n)] = 100 + n;
      for (let n = 0; n < messages; n++) frontiers[hex("msg:", n)] = 10;
      f.setJournal({
        ...newReadJournal(),
        state: { frontiers, overrides: {} },
      });
      const owner = f.make();
      owner.setCoverage({
        covered: (key, frontier) =>
          key === read && (frontier(cover) ?? -1) >= (frontier(read) ?? 0)
            ? cover
            : undefined,
        home: () => undefined,
      });
      await owner.ready;
      await owner.read(read, 50, () => true);
      // A peer's blob: 401 thread marks this device never used. The one that
      // covers the read is older than the rest, so it ranks last among them.
      const contexts: Record<string, number> = { [cover]: 50 };
      for (let n = 0; n < 400; n++)
        contexts[hex("thread:", 5000 + n)] = 100 + n;
      const peer = await signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 90,
          blob: { v: 1, client_id: "peer", contexts },
        },
        f.key.secret,
        100,
      );
      f.reader.read.mockResolvedValueOnce([peer]);
      await owner.refresh();
      const stillRead = (marks: Readonly<Record<string, number>>) =>
        (marks[read] ?? 0) >= 50 || (marks[cover] ?? 0) >= 50;
      expect(stillRead(f.journal()?.state.frontiers ?? {})).toBe(true);
      await owner.flush();
      expect(stillRead(f.published())).toBe(true);
    }
  }, 15000);
  it("keeps saved mark channels only for messages a kept mark names", () => {
    const f = fixture();
    const id = "a".repeat(64);
    const saved = readJournal(
      {
        ...newReadJournal(),
        state: { frontiers: { [`msg:${id}`]: 10 }, overrides: {} },
        reserve: { [`thread-activity:${"b".repeat(64)}`]: 9 },
        homes: {
          [id]: "room",
          ["b".repeat(64)]: "side",
          ["c".repeat(64)]: "gone",
        },
      },
      f.key.pubkey,
    );
    expect(saved.homes).toEqual({ [id]: "room", ["b".repeat(64)]: "side" });
    expect(() =>
      readJournal({ ...newReadJournal(), homes: { [id]: 5 } }, f.key.pubkey),
    ).toThrow("mark channels");
  });
  it.each([1, 5001])(
    "loads old journals and round-trips valid overlap metadata (%i records)",
    (count) => {
      const f = fixture();
      const old = readJournal(newReadJournal(), f.key.pubkey);
      expect(old.peerOverlaps).toBeUndefined();
      const item = {
        coordinate: `read-state:${"b".repeat(32)}`,
        key: `msg:${"a".repeat(64)}`,
        set: 1,
        baseline: 11,
        version: { id: "c".repeat(64), created_at: 100 },
      };
      const entries = Array.from({ length: count }, (_, set) => ({
        ...item,
        set,
      }));
      const raw = {
        ...old,
        peerOverlaps: entries.map((entry) => ({ ...entry, ignored: true })),
      };
      const saved = readJournal(raw, f.key.pubkey);
      expect(saved.peerOverlaps).toEqual(entries);
      raw.peerOverlaps.forEach((item) => {
        item.baseline = 99;
      });
      expect(saved.peerOverlaps?.[0]?.baseline).toBe(11);
      expect(
        readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
      ).toEqual(saved);
    },
  );
  it.each([
    { coordinate: "read-state:not-a-slot" },
    { key: "room" },
    { key: "msg:" },
    { key: `msg:${"é".repeat(127)}` },
    { set: -1 },
    { set: 1.5 },
    { baseline: 0x100000000 },
    { version: { id: "bad", created_at: 100 } },
    { version: { id: "c".repeat(64), created_at: -1 } },
  ])("rejects corrupt pending overlap entries: %j", (patch) => {
    const f = fixture();
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          peerOverlaps: [
            {
              coordinate: `read-state:${"b".repeat(32)}`,
              key: `msg:${"a".repeat(64)}`,
              set: 1,
              baseline: 11,
              version: { id: "c".repeat(64), created_at: 100 },
              ...patch,
            },
          ],
        },
        f.key.pubkey,
      ),
    ).toThrow("read overlap");
  });
  it("rejects duplicate and non-array recovery metadata instead of dropping intent", () => {
    const f = fixture();
    const item = {
      coordinate: `read-state:${"b".repeat(32)}`,
      key: `msg:${"a".repeat(64)}`,
      set: 1,
      baseline: 11,
      version: { id: "c".repeat(64), created_at: 100 },
    };
    for (const peerOverlaps of [{}, [item, item]])
      expect(() =>
        readJournal({ ...newReadJournal(), peerOverlaps }, f.key.pubkey),
      ).toThrow();
  });
  it("rejects saved corruption and changed signatures without overwriting it", () => {
    const f = fixture();
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          state: { frontiers: { room: -1 }, overrides: {} },
        },
        f.key.pubkey,
      ),
    ).toThrow();
    const event = eventDto(
      signReadState(
        {
          slot: "a".repeat(32),
          createdAt: 100,
          blob: { v: 1, client_id: "x", contexts: {} },
        },
        f.key.secret,
        100,
      ),
    );
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          lastCreatedAt: 100,
          pending: { event, revision: 0 },
        },
        f.key.pubkey,
      ),
    ).toThrow("identity");
  });
});
const ownerStatus = (owner: ReturnType<typeof createReadState>) =>
  owner.snapshot().status;

it.each([false, true])(
  "initial marker discovery is foreground and shares active work (snapshot=%s)",
  async (snapshot) => {
    const f = fixture();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async (..._args: unknown[]) => {
      await held;
      return [];
    });
    const owner = f.make({
      host: {
        ...f.host,
        ...(snapshot ? { communityId: "test-community" } : {}),
      },
      reader: { read, ...(snapshot ? { readStateSnapshot: read } : {}) },
    });
    const first = owner.ensure();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    let finished = false;
    const second = owner.ensure().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(read.mock.calls[0]?.[snapshot ? 0 : 1]).toMatchObject({
      priority: "foreground",
    });
    release();
    await Promise.all([first, second]);
    await owner.refresh();
    expect(read.mock.calls[1]?.[snapshot ? 0 : 1]).toMatchObject({
      priority: "background",
    });
  },
);

/** The owner half of the shared NIP-RS vectors (pure halves live in
 * read-state-vectors.test.ts). */
describe("NIP-RS shared vectors: owner", () => {
  const T = vectors.now;
  const peer = (
    secret: Uint8Array,
    contexts: Record<string, number>,
    createdAt = T,
  ) =>
    signReadState(
      {
        slot: "f".repeat(32),
        createdAt,
        blob: { v: 1, client_id: "peer", contexts },
      },
      secret,
      createdAt,
    );
  const merged = (owned: Record<string, Record<string, number>>) =>
    Object.assign({}, ...Object.values(owned));
  const thread = (n: number) => `thread:${n.toString(16).padStart(64, "0")}`;
  const many = (count: number, at: (n: number) => number, from = 0) =>
    Array.from({ length: count }, (_, n) => ({
      key: thread(from + n),
      timestamp: at(from + n),
      channelId: "room",
    }));

  it.each(vectors.ownership)("ownership $id", async (v) => {
    const f = fixture(T);
    const owner = f.make();
    await owner.ready;
    for (const [key, at] of Object.entries(v.local))
      await owner.read(key, at, () => true);
    await owner.flush();
    for (const contexts of v.remote)
      await f.host.publish(peer(f.key.secret, contexts));
    await owner.refresh();
    for (const [key, at] of Object.entries(v.localAdvance ?? {}))
      await owner.read(key, at, () => true);
    await owner.flush();
    expect(owner.state().frontiers).toEqual(v.expectedMerged);
    expect(merged(f.own())).toEqual(v.expectedPublished);
  });
  it.each(vectors.pruning)("pruning $id", async (v) => {
    const f = fixture(T);
    const owner = f.make();
    await owner.ready;
    for (const [key, at] of Object.entries(v.frontiers))
      await owner.read(key, at, () => true);
    await owner.flush();
    const published = merged(f.own());
    for (const key of v.expectedRequiredKeys)
      expect(published).toHaveProperty(key);
    for (const key of v.expectedAbsentKeys)
      expect(published).not.toHaveProperty(key);
  });
  it.each(vectors.writePolicy)("writePolicy $id", async (v) => {
    const f = fixture(T);
    const owner = f.make();
    await owner.ready;
    for (const [key, at] of Object.entries(v.localObserved))
      await owner.read(key, at, () => true);
    await owner.flush();
    expect(merged(f.own())).toEqual(v.expectedPublished);
  });
  it("lifecycle partial-publish-restart", async () => {
    const f = fixture(T);
    const first = f.make();
    await first.ready;
    await first.readMessages(
      many(600, (n) => T - n),
      undefined,
      () => true,
    );
    const publish = f.host.publish.getMockImplementation();
    f.host.publish.mockImplementationOnce(async (event) => publish?.(event));
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await first.flush();
    const unknown = f.journal()?.pending?.event;
    expect(unknown).toBeDefined();
    expect(Object.keys(f.own())).toHaveLength(1);
    // Accepting the first coordinate does not acknowledge the revision.
    expect(f.journal()?.acceptedRevision).toBeLessThan(
      f.journal()?.revision ?? 0,
    );
    first.dispose();
    const second = f.make();
    await second.ready;
    for (let n = 0; n < 600; n++)
      expect(second.state().frontiers[thread(n)]).toBe(T - n);
    await second.flush();
    expect(f.host.publish.mock.calls[2]?.[0]).toEqual(unknown);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(ownerStatus(second)).toBe("reconciled");
    const published = merged(f.own());
    for (let n = 0; n < 600; n++) expect(published[thread(n)]).toBe(T - n);
  }, 15000);
  it("lifecycle shrink-and-slot-reuse", async () => {
    const f = fixture(T);
    const first = f.make();
    await first.ready;
    // Some of the first blob's keys stay fresh; all of the second's fall
    // below the floor.
    const old = T - vectors.retentionSeconds + 60;
    await first.readMessages(
      many(600, (n) => (n < 400 ? T : old)),
      undefined,
      () => true,
    );
    await first.flush();
    const slots = [f.journal()?.slot, ...(f.journal()?.spill ?? [])];
    expect(slots).toHaveLength(2);
    const second = f.own()[slots[1] ?? ""];
    first.dispose();
    const later = T + 120;
    f.setNow(later);
    const owner = f.make();
    await owner.ready;
    await owner.read("room", later, () => true);
    await owner.flush();
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    // The inert old blob is left alone, not retired: another device may
    // still hold nothing newer for its keys.
    expect(f.own()[slots[1] ?? ""]).toEqual(second);
    await owner.readMessages(
      many(200, () => later, 600),
      undefined,
      () => true,
    );
    await owner.flush();
    expect([f.journal()?.slot, ...(f.journal()?.spill ?? [])]).toEqual(slots);
    expect(Object.keys(f.own()).sort()).toEqual([...slots].sort());
    expect(f.own()[slots[1] ?? ""]?.[thread(799)]).toBe(later);
    expect(ownerStatus(owner)).toBe("reconciled");
  }, 15000);
  it("lifecycle old-event-new-frontier", async () => {
    const v = vectors.lifecycle.find(
      ({ id }) => id === "old-event-new-frontier",
    );
    const f = fixture(T);
    await f.host.publish(
      peer(
        f.key.secret,
        { ...v?.frontiers, "ov_c:side": 7 },
        v?.eventCreatedAt,
      ),
    );
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    expect(owner.state().frontiers).toEqual(v?.frontiers);
    expect(owner.state().overrides.side).toBeDefined();
    // Full-state loads never use `since`: an old carrier is still current.
    for (const [filters] of f.reader.read.mock.calls as unknown as [
      Record<string, unknown>[],
    ][])
      for (const filter of filters) expect(filter).not.toHaveProperty("since");
  });
});

describe("publication fences", () => {
  const T = 1800000000;
  const thread = (n: number) => `thread:${n.toString(16).padStart(64, "0")}`;
  /** Another device's coordinate, opaque to this one (decode is stubbed). */
  const foreignAt = (pubkey: string, n: number, content = ""): RelayEvent => {
    const id = n.toString(16).padStart(32, "0");
    return {
      id: id.padStart(64, "0"),
      pubkey,
      kind: 30078,
      created_at: T,
      tags: [
        ["d", `read-state:${id}`],
        ["t", "read-state"],
      ],
      content: `peer:${content}`,
      sig: "0".repeat(128),
    } as RelayEvent;
  };
  const foreign = (pubkey: string, count: number) =>
    Array.from({ length: count }, (_, n) => foreignAt(pubkey, n));
  /** A complete-snapshot owner over a relay already holding `peers`. */
  function snapshotted(f: ReturnType<typeof fixture>, peers: RelayEvent[]) {
    const decode = f.host.decode.getMockImplementation();
    f.host.decode.mockImplementation(async (events) =>
      (
        await Promise.all(
          events.map(async (event) =>
            event.content.startsWith("peer:")
              ? [
                  {
                    eventId: event.id,
                    blob: { v: 1, client_id: "peer", contexts: {} },
                  },
                ]
              : ((await decode?.([event])) ?? []),
          ),
        )
      ).flat(),
    );
    for (const peer of peers) void f.host.publish(peer);
    f.host.publish.mockClear();
    return (overrides: Parameters<typeof f.make>[0] = {}) =>
      f.make({
        host: { ...f.host, communityId: "test-community" },
        reader: { ...f.reader, readStateSnapshot: () => f.reader.read() },
        ...overrides,
      });
  }

  it("acknowledges only the revision a plan was packed from", async () => {
    const f = fixture(T);
    const owner = f.make();
    await owner.ready;
    await owner.readMessages(
      Array.from({ length: 600 }, (_, n) => ({
        key: thread(n),
        timestamp: T,
        channelId: "room",
      })),
      undefined,
      () => true,
    );
    // Another window commits a newer frontier while new slots are being owned.
    const update = vi.mocked(f.storage.update).getMockImplementation();
    const other = thread(9999);
    let raced = false;
    vi.mocked(f.storage.update).mockImplementation(async (change) => {
      const current = f.journal();
      if (
        !raced &&
        current &&
        (change(current).spill?.length ?? 0) > (current.spill?.length ?? 0)
      ) {
        raced = true;
        f.setJournal({
          ...current,
          revision: current.revision + 1,
          own: { ...current.own, [other]: T },
          state: {
            ...current.state,
            frontiers: { ...current.state.frontiers, [other]: T },
          },
        });
      }
      if (!update) throw new Error("Missing fixture storage");
      return update(change);
    });
    await owner.flush();
    expect(raced).toBe(true);
    expect(f.published()[other]).toBeUndefined();
    expect(f.journal()?.acceptedRevision).toBeLessThan(
      f.journal()?.revision ?? 0,
    );
    expect(ownerStatus(owner)).toBe("pending");
    await owner.flush();
    expect(f.published()[other]).toBe(T);
    expect(f.journal()?.acceptedRevision).toBe(f.journal()?.revision);
    expect(ownerStatus(owner)).toBe("reconciled");
  }, 15000);

  it.each([
    ["events", 0],
    ["events", 1],
    ["bytes", 0],
    ["bytes", 1],
  ] as const)(
    "replays a pending event only within snapshot capacity (%s, over by %i)",
    async (limit, over) => {
      const f = fixture(T);
      // The original packet never arrived; its exact bytes stay pending.
      const first = f.make();
      await first.ready;
      await first.read("room", T, () => true);
      f.host.publish.mockRejectedValueOnce(new Error("packet never arrived"));
      await first.flush();
      const pending = f.journal()?.pending?.event;
      if (!pending) throw new Error("Missing pending event");
      first.dispose();
      // Fill the relay so the replay lands exactly at, or one past, a limit.
      const size = (event: RelayEvent) =>
        new TextEncoder().encode(JSON.stringify(event)).byteLength;
      const a = foreignAt(f.key.pubkey, 0);
      const b = foreignAt(f.key.pubkey, 1);
      const pad =
        READ_SNAPSHOT_BYTES +
        over -
        (2 + 2 + size(a) + size(b) + size(pending));
      const peers =
        limit === "events"
          ? foreign(f.key.pubkey, READ_SNAPSHOT_EVENTS - 1 + over)
          : [foreignAt(f.key.pubkey, 0, "x".repeat(pad)), b];
      const owner = snapshotted(f, peers)();
      await owner.ready;
      await owner.refresh();
      await owner.flush();
      if (over) {
        expect(f.host.publish).not.toHaveBeenCalled();
        expect(f.journal()?.pending?.event).toEqual(pending);
        expect(owner.snapshot().error).toContain("capacity reached");
      } else {
        expect(f.host.publish).toHaveBeenCalledTimes(1);
        expect(f.host.publish.mock.calls[0]?.[0]).toEqual(pending);
        expect(owner.snapshot()).toMatchObject({
          status: "reconciled",
          error: undefined,
        });
      }
    },
    30000,
  );

  it("recovers its own slots' newer values after a restored or cloned journal", async () => {
    const f = fixture(T);
    const first = f.make();
    await first.ready;
    await first.read("room-a", T - 500, () => true);
    await first.flush();
    const backup = f.journal();
    await first.read("room-a", T - 100, () => true);
    await first.flush();
    first.dispose();
    // The restored journal is behind what its own slot already carries.
    f.setJournal(backup);
    const restored = f.make();
    await restored.ready;
    await restored.read("room-b", T - 50, () => true);
    await restored.flush();
    expect(ownerStatus(restored)).toBe("reconciled");
    expect(f.published()).toEqual({ "room-a": T - 100, "room-b": T - 50 });
    expect(f.journal()?.own).toEqual({ "room-a": T - 100, "room-b": T - 50 });
  });

  it("sends nothing when the first blob would exceed the snapshot before a later one shrinks it", async () => {
    const W = vectors.retentionSeconds;
    const size = (event: RelayEvent) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength;
    const keys = (from: number, count: number, at: number) =>
      Array.from({ length: count }, (_, n) => ({
        key: thread(from + n),
        timestamp: at,
        channelId: "room",
      }));
    // Blob A expires and keeps one key; then A grows while B, which goes
    // last because it drops expired keys, shrinks by more than A grows.
    async function run(pad?: (a: number, b: number) => number) {
      const f = fixture(T);
      const first = f.make();
      await first.ready;
      await first.readMessages(
        [...keys(0, 400, T - W + 60), ...keys(400, 199, T - W + 500)],
        undefined,
        () => true,
      );
      await first.read(thread(599), T, () => true);
      await first.flush();
      f.setNow(T + 90);
      await first.read(thread(1000), T + 90, () => true);
      await first.flush();
      first.dispose();
      const [a, b] = (await f.reader.read()).map(size) as [number, number];
      f.setNow(T + 600);
      const extra = pad?.(a, b);
      const owner = snapshotted(
        f,
        extra === undefined
          ? []
          : [foreignAt(f.key.pubkey, 0, "x".repeat(extra))],
      )();
      await owner.ready;
      await owner.readMessages(keys(2000, 150, T + 600), undefined, () => true);
      await owner.read(thread(599), T + 600, () => true);
      await owner.flush();
      return { f, owner, a, b };
    }
    const free = await run();
    const [grown, shrunk] = free.f.host.publish.mock.calls
      .slice(-2)
      .map(([event]) => size(event)) as [number, number];
    const growth = grown - free.a;
    expect(growth).toBeGreaterThan(0);
    expect(free.b - shrunk).toBeGreaterThan(growth);
    // The final map fits; the snapshot after A alone is one byte over.
    const over = await run(
      (a, b) =>
        READ_SNAPSHOT_BYTES +
        1 -
        (2 + 2 + a + growth + b + size(foreignAt(free.f.key.pubkey, 0))),
    );
    expect(over.f.host.publish).not.toHaveBeenCalled();
    expect(over.owner.snapshot().error).toContain("capacity reached");
  }, 30000);

  it("counts coordinates observed live after the snapshot", async () => {
    const f = fixture(T);
    const owner = snapshotted(
      f,
      foreign(f.key.pubkey, READ_SNAPSHOT_EVENTS - 1),
    )();
    await owner.ready;
    await owner.refresh();
    const late = foreignAt(f.key.pubkey, READ_SNAPSHOT_EVENTS - 1);
    void f.host.publish(late);
    f.host.publish.mockClear();
    owner.accept([late]);
    await owner.read("room", T, () => true);
    await owner.flush();
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(owner.snapshot().error).toContain("capacity reached");
  }, 30000);

  it("takes a complete snapshot before the first send, and again after a gap", async () => {
    const f = fixture(T);
    const full = snapshotted(f, foreign(f.key.pubkey, READ_SNAPSHOT_EVENTS))();
    await full.ready;
    await full.read("room", T, () => true);
    // No refresh: flush itself must fetch the basis that refuses this send.
    await full.flush();
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(full.snapshot().error).toContain("capacity reached");
    full.dispose();

    const g = fixture(T);
    const snapshots = vi.fn(() => g.reader.read());
    const owner = snapshotted(
      g,
      [],
    )({
      reader: { ...g.reader, readStateSnapshot: snapshots },
    });
    await owner.ready;
    await owner.read("room", T, () => true);
    await owner.flush();
    await owner.read("room", T + 1, () => true);
    await owner.flush();
    expect(g.host.publish).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveBeenCalledTimes(1);
    // A gap invalidates the basis; the next send takes a fresh snapshot.
    owner.stale();
    await owner.read("room", T + 2, () => true);
    await owner.flush();
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(g.host.publish).toHaveBeenCalledTimes(3);
    expect(ownerStatus(owner)).toBe("reconciled");
  }, 30000);

  it("lets a slow complete snapshot finish on refresh and before a send", async () => {
    vi.useFakeTimers();
    // Node's native AbortSignal timer is not driven by Vitest's clock.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
    const f = fixture(T);
    // The real reader, with a snapshot that takes longer than its ordinary
    // ten-second deadline to download.
    const snapshots = vi.fn(
      (signal: AbortSignal) =>
        new Promise<RelayEvent[]>((resolve, reject) => {
          const timer = setTimeout(
            () => void f.reader.read().then(resolve),
            25_000,
          );
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
    );
    const relay = createRelayReader({
      ...scriptedTransport(f.key.pubkey, "relay").transport,
      query: async () => f.reader.read(),
      readStateSnapshot: snapshots,
    });
    // A publisher lock that holds the flush until the test opens it.
    let entered!: () => void;
    let open!: () => void;
    const entry = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    const owner = snapshotted(
      f,
      [],
    )({
      reader: relay.reader,
      lock: async (_signal, work) => {
        entered();
        await gate;
        return work();
      },
    });
    await owner.ready;
    const refreshed = owner.refresh();
    await vi.advanceTimersByTimeAsync(25_000);
    await refreshed;
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: "snapshot",
    });
    // A gap while the send waits for the lock drops the capacity basis it
    // started with, so it reads a snapshot first.
    await owner.read("room", T, () => true);
    const flushed = owner.flush();
    await entry;
    owner.stale();
    open();
    await vi.advanceTimersByTimeAsync(25_000);
    await flushed;
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(f.host.publish).toHaveBeenCalledOnce();
    expect(ownerStatus(owner)).toBe("reconciled");
    relay.dispose();
    timeout.mockRestore();
  });

  it("refuses a send whose basis a gap dropped while signing or saving", async () => {
    for (const gapIn of ["sign", "save"] as const) {
      const f = fixture(T);
      const snapshots = vi.fn(() => f.reader.read());
      let gaps = 1;
      const gap = () => gaps-- > 0 && owner.stale();
      const owner = snapshotted(
        f,
        [],
      )({
        host: {
          ...f.host,
          communityId: "test-community",
          sign: async (intent: ReadStateSigning) => {
            const event = await f.host.sign(intent);
            if (gapIn === "sign") gap();
            return event;
          },
        },
        reader: { ...f.reader, readStateSnapshot: snapshots },
        storage: {
          ...f.storage,
          update: async (change) => {
            const saved = await f.storage.update(change);
            if (gapIn === "save" && saved.pending) gap();
            return saved;
          },
        },
      });
      await owner.ready;
      await owner.read("room", T, () => true);
      await owner.flush();
      expect(f.host.publish, gapIn).not.toHaveBeenCalled();
      expect(owner.snapshot().error, gapIn).toContain("capacity basis lost");
      expect(!!f.journal()?.pending, gapIn).toBe(gapIn === "save");
      // The retained intent goes out only on a fresh complete snapshot.
      await owner.flush();
      expect(snapshots, gapIn).toHaveBeenCalledTimes(2);
      expect(f.host.publish, gapIn).toHaveBeenCalledTimes(1);
      expect(ownerStatus(owner), gapIn).toBe("reconciled");
      owner.dispose();
    }
  }, 30000);
});

/** A marker another device of the same viewer published for "room". */
async function otherDeviceMarker(f: ReturnType<typeof fixture>) {
  let other: ReadJournal | undefined;
  // Its own reads are not the owner's under test.
  const device = f.make({
    reader: { read: vi.fn(async () => []) },
    storage: {
      capture: async () => structuredClone(other),
      update: async (change) => {
        other = readJournal(change(other), f.key.pubkey);
        return other;
      },
      close() {},
    },
  });
  await device.ready;
  await device.read("room", 12, () => true);
  await device.flush();
  const marker = f.host.publish.mock.calls.at(-1)?.[0];
  if (!marker) throw new Error("Missing other device's marker");
  return marker;
}
describe("resume after a continuous membership replay", () => {
  it("restores the interrupted state from the replayed markers without reading the snapshot again", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: "bounded",
    });
    const reads = f.reader.read.mock.calls.length;
    owner.stale();
    expect(owner.snapshot()).toMatchObject({
      status: "stale",
      completeness: "unknown",
    });
    // Another device reads "room" during the outage, and the replay feeds
    // its marker through `accept`, as live traffic does.
    owner.accept([await otherDeviceMarker(f)]);
    await owner.resume();
    expect(f.reader.read.mock.calls.length).toBe(reads);
    expect(owner.state().frontiers.room).toBe(12);
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: "bounded",
    });
  });

  it("reads the snapshot again when nothing was loaded, or a failure followed the drop", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const marker = await otherDeviceMarker(f);
    // Never loaded before the drop.
    owner.stale();
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(1);
    expect(owner.snapshot().status).toBe("reconciled");
    // A replayed marker that cannot be decoded is a failure since the drop.
    owner.stale();
    f.host.decode.mockRejectedValueOnce(new Error("undecodable"));
    owner.accept([marker]);
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(2);
    expect(owner.snapshot().status).toBe("reconciled");
  });

  it("owes a snapshot read after a drop or a marker that failed to apply, until a read or resume succeeds", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    expect(owner.owed()).toBe(false);
    const marker = await otherDeviceMarker(f);
    // A live marker that cannot be decoded.
    f.host.decode.mockRejectedValueOnce(new Error("undecodable"));
    owner.accept([marker]);
    await vi.waitFor(() => expect(owner.snapshot().status).toBe("error"));
    expect(owner.owed()).toBe(true);
    await owner.refresh();
    expect(owner.owed()).toBe(false);
    // A drop owes it; a resume from a continuous replay pays it.
    owner.stale();
    expect(owner.owed()).toBe(true);
    await owner.resume();
    expect(owner.owed()).toBe(false);
    expect(f.reader.read).toHaveBeenCalledTimes(2);
  });

  it("reads the snapshot again when a drop cancelled a live marker still being ingested", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    const marker = await otherDeviceMarker(f);
    // The marker arrives live and is still decoding when the stream drops.
    let release!: () => void;
    const decode = f.host.decode.getMockImplementation();
    if (!decode) throw new Error("Missing fixture decoder");
    f.host.decode.mockImplementationOnce(async (events) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return decode(events);
    });
    owner.accept([marker]);
    await vi.waitFor(() => expect(release).toBeDefined());
    owner.stale();
    release();
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(2);
    expect(owner.state().frontiers.room).toBe(12);
    expect(owner.snapshot().status).toBe("reconciled");
  });
});
