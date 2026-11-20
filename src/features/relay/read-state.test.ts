import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools";
import {
  browserReadPublisherLock,
  CapturedReadNotRetainedError,
  createReadState,
} from "./read-state";
import { effectiveFrontier, READ_RETENTION_SECONDS } from "./read-state-model";
import {
  newReadJournal,
  READ_LOCAL_UNREAD_KEYS,
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
    /** This device's own version-2 unread contexts, if published. */
    unread: (): Record<string, number> | undefined => {
      const d = (item: RelayEvent) => item.tags.find(([n]) => n === "d")?.[1];
      const at = `read-state-unread-v2:${journal?.unread?.slot}`;
      const event = remote.find((item) => d(item) === at);
      return event && decodeReadState([event], key.secret)[0].blob.contexts;
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
    createdAt = 100,
    set = createdAt,
    clear = 0,
    slot = "b".repeat(32),
    clientId = "peer",
  }: {
    createdAt?: number;
    set?: number;
    clear?: number;
    slot?: string;
    clientId?: string;
  } = {},
) {
  return signReadState(
    {
      slot,
      createdAt,
      blob: {
        v: 2,
        client_id: clientId,
        contexts: {
          [key]: 0,
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
        const read = owner.read("room", 20, () => true, true, [key], fence);
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
      owner.read("room", 20, () => true, true, ["room"], fence),
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
  it("captured Undo survives the publication debounce when only local receipts changed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:selected";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    await vi.advanceTimersByTimeAsync(60000);
    await result.undo();
    expect(owner.state().frontiers[key]).toBeUndefined();
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(result.sync).toBe("local-only");
    expect(owner.snapshot().status).toBe("local");
  });
  it("captured local receipts preserve earlier pending publication work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.read("room", 20, () => true);
    const beforeCaptured = owner.state();
    const result = await owner.readMessages(
      [{ key: "msg:selected", timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set(["msg:selected"]), valid: () => true },
      },
    );
    assert(result.undo);
    expect(result.sync).toBe("local-only");
    expect(owner.snapshot().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(60000);
    await owner.flush();
    expect(f.published()).toEqual({ room: 20 });
    await result.undo();
    expect(owner.state()).toEqual(beforeCaptured);
    expect(f.published()).toEqual({ room: 20 });
  });
  it("captured Undo preserves an unrelated retention floor while its inverse entries remain retained", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const capturedKey = "msg:captured";
    const captured = await owner.readMessages(
      [{ key: capturedKey, timestamp: 8000, channelId: "room-a" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([capturedKey]), valid: () => true },
      },
    );
    assert(captured.undo);

    const later = Array.from({ length: 7000 }, (_, index) => ({
      key: `msg:other-${index.toString(16).padStart(64, "0")}`,
      timestamp: index + 10,
      channelId: "room-b",
    }));
    await owner.readMessages(later, undefined, () => true);
    const floor = owner.floor();
    expect(floor).toBeGreaterThan(10);
    expect(floor).toBeLessThan(8000);
    expect(owner.state().frontiers[capturedKey]).toBe(8000);
    const otherKey = later.at(-1)?.key ?? "";
    expect(owner.state().frontiers[otherKey]).toBe(7009);

    await captured.undo();
    expect(owner.floor()).toBe(floor);
    expect(owner.state().frontiers[capturedKey]).toBeUndefined();
    expect(owner.state().frontiers[otherKey]).toBe(7009);
  });
  it("expires captured Undo when retention relocates its receipt to the reserve", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = `msg:${"f".repeat(64)}`;
    const captured = await owner.readMessages(
      [{ key, timestamp: 8000, channelId: "room-a" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(captured.undo);
    await owner.readMessages(
      Array.from({ length: 7000 }, (_, index) => ({
        key: `msg:${index.toString(16).padStart(64, "0")}`,
        timestamp: index + 10,
        channelId: "room-b",
      })),
      undefined,
      () => true,
    );
    expect(owner.floor()).toBeLessThan(8000);
    expect(f.journal()?.state.frontiers[key]).toBeUndefined();
    expect(f.journal()?.reserve?.[key]).toBe(8000);
    const retained = f.journal();
    await expect(captured.undo()).rejects.toThrow(
      "Reading observation expired",
    );
    expect(f.journal()).toEqual(retained);
  });
  it("expires captured Undo when a later retention floor crosses its timestamp", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:selected";
    const captured = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room-a" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(captured.undo);
    const afterRead = f.journal();
    assert(afterRead);
    expect(afterRead.floor ?? 0).toBeLessThan(30);

    const unrelated = Array.from({ length: 7000 }, (_, index) => ({
      key: `msg:other-${index.toString(16).padStart(64, "0")}`,
      timestamp: index + 10,
      channelId: "room-b",
    }));
    await owner.readMessages(unrelated, undefined, () => true);
    expect(owner.floor()).toBeGreaterThan(30);
    // Retention has made the selected timestamp read independently of its
    // receipt; Undo must not report success while that read-through remains.
    expect(owner.state().frontiers[key]).toBe(30);
    const afterRetention = f.journal();
    assert(afterRetention);
    await expect(captured.undo()).rejects.toThrow(
      "Reading observation expired",
    );
    expect(f.journal()).toEqual(afterRetention);
    expect(owner.state().frontiers[key]).toBe(30);
  });
  it.each(["forward", "reverse"] as const)(
    "captured reads on separate channels remain independently undoable (%s)",
    async (order) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const capture = (key: string, timestamp: number, channelId: string) =>
        owner.readMessages(
          [{ key, timestamp, channelId }],
          undefined,
          () => true,
          false,
          undefined,
          [],
          {
            preserveCapturedSet: true,
            undo: { keys: new Set([key]), valid: () => true },
          },
        );
      const a = await capture("msg:a", 30, "room-a");
      const b = await capture("msg:b", 40, "room-b");
      const undoA = a.undo;
      const undoB = b.undo;
      assert(undoA);
      assert(undoB);
      expect(owner.state().frontiers).toMatchObject({
        "msg:a": 30,
        "msg:b": 40,
      });

      const firstKey = order === "forward" ? "msg:a" : "msg:b";
      const secondKey = order === "forward" ? "msg:b" : "msg:a";
      const secondFrontier = order === "forward" ? 40 : 30;
      const firstUndo = order === "forward" ? undoA : undoB;
      const secondUndo = order === "forward" ? undoB : undoA;
      await firstUndo();
      expect(owner.state().frontiers[firstKey]).toBeUndefined();
      expect(owner.state().frontiers[secondKey]).toBe(secondFrontier);

      const afterFirst = f.journal();
      await expect(firstUndo()).rejects.toThrow("Reading observation expired");
      expect(f.journal()).toEqual(afterFirst);

      await secondUndo();
      expect(owner.state().frontiers[firstKey]).toBeUndefined();
      expect(owner.state().frontiers[secondKey]).toBeUndefined();
    },
  );
  it("rejects superseded overlapping captured reads and consumes Undo once", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const capture = (timestamp: number) =>
      owner.readMessages(
        [{ key: "msg:overlap", timestamp, channelId: "room" }],
        undefined,
        () => true,
        false,
        undefined,
        [],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set(["msg:overlap"]), valid: () => true },
        },
      );
    const earlier = await capture(30);
    const later = await capture(40);
    assert(earlier.undo);
    assert(later.undo);

    const afterLaterRead = f.journal();
    await expect(earlier.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterLaterRead);
    await later.undo();
    expect(owner.state().frontiers["msg:overlap"]).toBe(30);

    const afterUndo = f.journal();
    await expect(later.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterUndo);
    expect(owner.state().frontiers["msg:overlap"]).toBe(30);
  });
  it.each(["action validity", "journal slot replacement"] as const)(
    "captured Undo expires on %s without changing saved state",
    async (replacement) => {
      const f = fixture();
      let actionValid = true;
      const owner = f.make();
      await owner.ready;
      const key = "msg:guarded";
      const result = await owner.readMessages(
        [{ key, timestamp: 30, channelId: "room" }],
        undefined,
        () => actionValid,
        false,
        undefined,
        [],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set([key]), valid: () => actionValid },
        },
      );
      assert(result.undo);
      if (replacement === "action validity") actionValid = false;
      else {
        const current = f.journal();
        assert(current);
        f.setJournal({ ...current, slot: "c".repeat(32) });
      }
      const afterReplacement = f.journal();

      await expect(result.undo()).rejects.toThrow(
        "Reading observation expired",
      );
      expect(f.journal()).toEqual(afterReplacement);
      expect(owner.state().frontiers[key]).toBe(30);
    },
  );
  it("keeps captured Undo retryable when its atomic journal write fails", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:atomic";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    const actionId = f.journal()?.capturedUndoVersions?.[key];
    assert(actionId);
    const beforeFailure = f.journal();
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));

    await expect(result.undo()).rejects.toThrow("disk full");
    expect(f.journal()).toEqual(beforeFailure);
    expect(f.journal()?.capturedUndoVersions?.[key]).toBe(actionId);
    expect(owner.state().frontiers[key]).toBe(30);

    await result.undo();
    expect(owner.state().frontiers[key]).toBeUndefined();
    expect(f.journal()?.capturedUndoVersions?.[key]).toBeUndefined();
  });
  it("keeps earlier Undo when bounded key ownership cannot track another action", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:captured";
    const first = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room-a" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(first.undo);
    const actionId = f.journal()?.capturedUndoVersions?.[key];
    assert(actionId);
    const current = f.journal();
    assert(current);
    f.setJournal({
      ...current,
      capturedUndoVersions: Object.fromEntries([
        [key, actionId],
        ...Array.from({ length: READ_LOCAL_UNREAD_KEYS - 1 }, (_, index) => [
          `msg:retained-${index}`,
          "b".repeat(32),
        ]),
      ]),
    });

    const later = await owner.readMessages(
      [{ key: "msg:later", timestamp: 40, channelId: "room-b" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set(["msg:later"]), valid: () => true },
      },
    );
    expect(later.undo).toBeUndefined();
    expect(f.journal()?.capturedUndoVersions?.[key]).toBe(actionId);
    await first.undo();
    expect(owner.state().frontiers).toMatchObject({ "msg:later": 40 });
    expect(owner.state().frontiers[key]).toBeUndefined();
  });
  it("another shared-storage owner's startup expires captured Undo without changing revision", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:selected";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    const revision = f.journal()?.revision;
    const epoch = f.journal()?.capturedReadUndo;
    const other = f.make();
    await other.ready;
    expect(f.journal()?.revision).toBe(revision);
    expect(f.journal()?.capturedReadUndo).not.toBe(epoch);
    const afterStartup = f.journal();
    await expect(result.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterStartup);
    expect(other.state().frontiers[key]).toBe(30);

    const subsequent = await owner.readMessages(
      [{ key: "msg:subsequent", timestamp: 31, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set(["msg:subsequent"]), valid: () => true },
      },
    );
    assert(subsequent.undo);
    await subsequent.undo();
    expect(owner.state().frontiers[key]).toBe(30);
    expect(owner.state().frontiers["msg:subsequent"]).toBeUndefined();
  });
  it("another shared-storage owner's mark-then-clear expires overlapping captured Undo", async () => {
    const f = fixture();
    const owner = f.make();
    const other = f.make();
    await Promise.all([owner.ready, other.ready]);
    const key = "msg:selected";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);

    await other.markLocalUnread(key, () => true);
    expect(other.localUnread(key)).toBeGreaterThan(0);
    await other.clearLocalUnread(key, [key], () => true);
    expect(other.localUnread(key)).toBeUndefined();
    const afterIntent = f.journal();

    await expect(result.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterIntent);
    expect(owner.state().frontiers[key]).toBe(30);
  });
  it("bounds local unread intent history and expires handles when it prunes", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const key = "msg:selected";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    const before = f.journal();
    assert(before);
    f.setJournal({
      ...before,
      localUnreadIntent: Object.fromEntries(
        Array.from({ length: READ_LOCAL_UNREAD_KEYS }, (_, index) => [
          `msg:old-${index}`,
          before.revision,
        ]),
      ),
    });

    await owner.markLocalUnread("msg:new", () => true);
    const afterPrune = f.journal();
    assert(afterPrune);
    expect(Object.keys(afterPrune.localUnreadIntent ?? {})).toHaveLength(
      READ_LOCAL_UNREAD_KEYS,
    );
    expect(afterPrune.capturedReadUndo).not.toBe(before.capturedReadUndo);
    await expect(result.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterPrune);
  });
  it.each(["identical", "older", "newer-unrelated", "newer-selected"] as const)(
    "scopes captured Undo to changed peer receipts (%s)",
    async (replay) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const otherKey = `msg:${"c".repeat(64)}`;
      const receipt = (createdAt: number, extra: Record<string, number> = {}) =>
        signReadState(
          {
            slot: "b".repeat(32),
            createdAt,
            blob: {
              v: 1,
              client_id: "peer",
              contexts: { [key]: 30, ...extra },
            },
          },
          f.key.secret,
          100,
        );
      const admitted = receipt(90);
      f.addRemote(admitted);
      await owner.refresh();
      await owner.markLocalUnread(key, () => true);
      const captured = await owner.readMessages(
        [{ key, timestamp: 30, channelId: "room" }],
        undefined,
        () => true,
        false,
        undefined,
        [key],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set([key]), valid: () => true },
        },
      );
      assert(captured.undo);
      expect(owner.localUnread(key)).toBeUndefined();
      const next =
        replay === "identical"
          ? admitted
          : replay === "older"
            ? receipt(80)
            : receipt(95, {
                [replay === "newer-selected" ? key : otherKey]: 35,
              });
      f.reader.read.mockResolvedValueOnce([next]);
      await owner.refresh();
      expect(owner.snapshot().status).not.toBe("error");

      if (replay === "newer-selected") {
        const afterPeerRead = f.journal();
        await expect(captured.undo()).rejects.toThrow(
          "Reading observation expired",
        );
        expect(f.journal()).toEqual(afterPeerRead);
        expect(owner.localUnread(key)).toBeUndefined();
        expect(owner.state().frontiers[key]).toBe(35);
      } else {
        await captured.undo();
        expect(owner.localUnread(key)).toBeDefined();
        expect(owner.state().frontiers[key]).toBe(30);
        if (replay === "newer-unrelated")
          expect(owner.state().frontiers[otherKey]).toBe(35);
      }
    },
  );
  it.each([
    { captureFloor: 29, undoFloor: 29, expires: false },
    { captureFloor: 29, undoFloor: 30, expires: true },
    { captureFloor: 30, undoFloor: 31, expires: false },
  ])(
    "captured Undo honors the time-based floor ($captureFloor -> $undoFloor)",
    async ({ captureFloor, undoFloor, expires }) => {
      const f = fixture(READ_RETENTION_SECONDS + captureFloor);
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      await owner.markLocalUnread(key, () => true);
      const captured = await owner.readMessages(
        [{ key, timestamp: 30, channelId: "room" }],
        undefined,
        () => true,
        false,
        undefined,
        [key],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set([key]), valid: () => true },
        },
      );
      assert(captured.undo);
      const afterRead = f.journal();
      f.setNow(READ_RETENTION_SECONDS + undoFloor);
      expect(owner.floor()).toBe(undoFloor);
      if (expires) {
        await expect(captured.undo()).rejects.toThrow(
          "Reading observation expired",
        );
        expect(f.journal()).toEqual(afterRead);
      } else {
        await captured.undo();
        expect(owner.localUnread(key)).toBeDefined();
      }
    },
  );
  it("expires an inverse that no longer fits the reserve without reporting a storage failure", async () => {
    const f = fixture();
    const key = `msg:${"a".repeat(64)}`;
    f.setJournal({ ...newReadJournal(), reserve: { [key]: 30 } });
    const owner = f.make();
    await owner.ready;
    const captured = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(captured.undo);
    expect(f.journal()?.reserve?.[key]).toBeUndefined();
    // A concurrent valid checkpoint can fill the space that promotion freed.
    await f.storage.update((current) => {
      assert(current);
      return {
        ...current,
        reserve: Object.fromEntries(
          Array.from({ length: READ_RESERVE_KEYS }, (_, index) => [
            `msg:${index.toString(16).padStart(64, "0")}`,
            40,
          ]),
        ),
      };
    });
    const afterRetention = f.journal();
    await expect(captured.undo()).rejects.toThrow(
      "Reading observation expired",
    );
    expect(f.journal()).toEqual(afterRetention);
    expect(owner.snapshot().status).not.toBe("error");
  });
  it("captured Undo restores receipt retention and expires on equal-valued peer ingest without a new revision", async () => {
    const f = fixture();
    const key = "msg:selected";
    f.setJournal({ ...newReadJournal(), reserve: { "msg:old": 20 }, floor: 3 });
    const owner = f.make();
    await owner.ready;
    const before = owner.state();
    const capture = () =>
      owner.readMessages(
        [{ key, timestamp: 30, channelId: "room" }],
        undefined,
        () => true,
        false,
        undefined,
        [key],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set([key]), valid: () => true },
        },
      );
    const result = await capture();
    assert(result.undo);
    await result.undo();
    expect(owner.state()).toEqual(before);
    expect(owner.floor()).toBe(3);
    expect(owner.localUnread(key)).toBeUndefined();

    const newer = await capture();
    assert(newer.undo);
    const revision = f.journal()?.revision;
    // A legacy peer can affirm the exact same msg receipt without changing revision.
    f.addRemote(
      signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 90,
          blob: { v: 1, client_id: "peer", contexts: { [key]: 30 } },
        },
        f.key.secret,
        100,
      ),
    );
    await owner.refresh();
    expect(f.journal()?.revision).toBe(revision);
    const afterIngest = f.journal();
    await expect(newer.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterIngest);
    expect(owner.state().frontiers[key]).toBe(30);
  });
  it("does not undo an equal-valued peer receipt saved by another shared-storage owner", async () => {
    const f = fixture();
    const options = { broadcastName: `read-equal-peer:${crypto.randomUUID()}` };
    const owner = f.make(options);
    const peer = f.make(options);
    await Promise.all([owner.ready, peer.ready]);
    const key = "msg:selected";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room" }],
      undefined,
      () => true,
      false,
      undefined,
      [key],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    const revision = f.journal()?.revision;
    f.addRemote(
      signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 90,
          blob: { v: 1, client_id: "peer", contexts: { [key]: 30 } },
        },
        f.key.secret,
        100,
      ),
    );
    await peer.refresh();
    expect(f.journal()?.revision).toBe(revision);
    const afterPeerRead = f.journal();
    expect(afterPeerRead?.state.frontiers[key]).toBe(30);

    await expect(result.undo()).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(afterPeerRead);
    expect(owner.state().frontiers[key]).toBe(30);
  });
  it("keeps captured Undo when another owner ingests an unrelated message receipt", async () => {
    const f = fixture();
    const options = {
      broadcastName: `read-unrelated-peer:${crypto.randomUUID()}`,
    };
    const owner = f.make(options);
    const peer = f.make(options);
    await Promise.all([owner.ready, peer.ready]);
    const key = "msg:selected";
    const otherKey = "msg:other";
    const result = await owner.readMessages(
      [{ key, timestamp: 30, channelId: "room-a" }],
      undefined,
      () => true,
      false,
      undefined,
      [key],
      {
        preserveCapturedSet: true,
        undo: { keys: new Set([key]), valid: () => true },
      },
    );
    assert(result.undo);
    f.addRemote(
      signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 90,
          blob: { v: 1, client_id: "peer", contexts: { [otherKey]: 40 } },
        },
        f.key.secret,
        100,
      ),
    );
    await peer.refresh();
    expect(f.journal()?.capturedUndoVersions?.[key]).toBeDefined();
    await result.undo();
    expect(owner.state().frontiers).toMatchObject({ [otherKey]: 40 });
    expect(owner.state().frontiers[key]).toBeUndefined();
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
  it.each([undefined, "a".repeat(32)])(
    "round-trips journals with an optional captured Undo token (%s)",
    (capturedReadUndo) => {
      const f = fixture();
      const saved = readJournal(
        { ...newReadJournal(), capturedReadUndo },
        f.key.pubkey,
      );
      expect(saved.capturedReadUndo).toBe(capturedReadUndo);
      expect(
        readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
      ).toEqual(saved);
    },
  );
  it.each([null, "", "not-a-slot", 42])(
    "rejects a malformed captured Undo token (%s)",
    (capturedReadUndo) => {
      const f = fixture();
      expect(() =>
        readJournal({ ...newReadJournal(), capturedReadUndo }, f.key.pubkey),
      ).toThrow("Invalid saved read state");
    },
  );
  it("reads legacy journals and bounds captured Undo key ownership", () => {
    const f = fixture();
    expect(
      readJournal(newReadJournal(), f.key.pubkey).capturedUndoVersions,
    ).toBeUndefined();
    const versions = { "msg:selected": "a".repeat(32) };
    const saved = readJournal(
      { ...newReadJournal(), capturedUndoVersions: versions },
      f.key.pubkey,
    );
    expect(saved.capturedUndoVersions).toEqual(versions);
    expect(
      readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
    ).toEqual(saved);
    expect(() =>
      readJournal(
        { ...newReadJournal(), capturedUndoVersions: { "msg:selected": "x" } },
        f.key.pubkey,
      ),
    ).toThrow("Invalid saved read state");
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          capturedUndoVersions: Object.fromEntries(
            Array.from({ length: READ_LOCAL_UNREAD_KEYS + 1 }, (_, index) => [
              `msg:key-${index}`,
              "b".repeat(32),
            ]),
          ),
        },
        f.key.pubkey,
      ),
    ).toThrow("Invalid saved read state");
  });
  it.each([false, true])(
    "expires captured Undo after a legacy writer drops action metadata (epoch retained: %s)",
    async (keepEpoch) => {
      const f = fixture();
      const owner = f.make();
      await owner.ready;
      const key = `msg:${"a".repeat(64)}`;
      const captured = await owner.readMessages(
        [{ key, timestamp: 30, channelId: "room" }],
        undefined,
        () => true,
        false,
        undefined,
        [],
        {
          preserveCapturedSet: true,
          undo: { keys: new Set([key]), valid: () => true },
        },
      );
      assert(captured.undo);
      const saved = f.journal();
      assert(saved);
      const {
        localUnreadIntent: _intent,
        capturedUndoVersions: _versions,
        capturedReadUndo: epoch,
        ...legacy
      } = saved;
      f.setJournal(
        readJournal(
          { ...legacy, ...(keepEpoch && { capturedReadUndo: epoch }) },
          f.key.pubkey,
        ),
      );
      const afterLegacyWrite = f.journal();
      await expect(captured.undo()).rejects.toThrow(
        "Reading observation expired",
      );
      expect(f.journal()).toEqual(afterLegacyWrite);
    },
  );
  it("loads legacy journals and round-trips validated local unread intent revisions", async () => {
    const f = fixture();
    const { localUnreadIntent: _intentHistory, ...journal } = newReadJournal();
    const legacy = { ...journal, capturedReadUndo: "a".repeat(32) };
    const loadedLegacy = readJournal(
      {
        ...legacy,
        revision: 1,
        acceptedRevision: 1,
        localUnread: { "msg:legacy": 1 },
      },
      f.key.pubkey,
    );
    expect(loadedLegacy.localUnreadIntent).toBeUndefined();
    f.setJournal(loadedLegacy);
    const owner = f.make();
    await owner.ready;
    expect(owner.localUnread("msg:legacy")).toBe(1);
    expect(f.journal()?.localUnreadIntent).toEqual({});
    expect(f.journal()?.capturedReadUndo).not.toBe(legacy.capturedReadUndo);

    const saved = readJournal(
      {
        ...newReadJournal(),
        revision: 2,
        localUnreadIntent: { "msg:legacy": 2 },
      },
      f.key.pubkey,
    );
    expect(saved.localUnreadIntent).toEqual({ "msg:legacy": 2 });
    expect(
      readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
    ).toEqual(saved);
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          revision: 1,
          localUnreadIntent: { "msg:future": 2 },
        },
        f.key.pubkey,
      ),
    ).toThrow("intent revisions");
  });
  it("loads journals that still carry retired peer overlap metadata", () => {
    const f = fixture();
    const saved = readJournal(
      { ...newReadJournal(), peerOverlaps: [{ ignored: true }] },
      f.key.pubkey,
    );
    expect(saved).not.toHaveProperty("peerOverlaps");
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
    // A version-1 group is never imported (version-2 unread state only).
    expect(owner.state().overrides.side).toBeUndefined();
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

  it("a stale echo never shrinks a coordinate's counted size", async () => {
    const f = fixture(T);
    const half = 4 * 1024 * 1024;
    const large = {
      ...foreignAt(f.key.pubkey, 0, "x".repeat(half)),
      created_at: T + 1,
    };
    const filler = foreignAt(f.key.pubkey, 1, "x".repeat(half - 3000));
    const owner = snapshotted(f, [large, filler])();
    await owner.ready;
    await owner.refresh();
    // An older, smaller version of the same coordinate arrives late.
    owner.observeSize({ ...foreignAt(f.key.pubkey, 0), id: "f".repeat(64) });
    expect(() =>
      owner.admit([foreignAt(f.key.pubkey, 2, "x".repeat(4000))]),
    ).toThrow("capacity reached");
  }, 30000);

  it("a snapshot installed after a newer observation keeps the newer size", async () => {
    const f = fixture(T);
    const half = 4 * 1024 * 1024;
    const filler = foreignAt(f.key.pubkey, 1, "x".repeat(half - 3000));
    const owner = snapshotted(f, [foreignAt(f.key.pubkey, 0), filler])();
    await owner.ready;
    await owner.refresh();
    // A larger, newer version arrives live while the next snapshot's cut
    // still holds the small one.
    owner.observeSize({
      ...foreignAt(f.key.pubkey, 0, "x".repeat(half)),
      id: "e".repeat(64),
      created_at: T + 1,
    });
    await owner.refresh();
    expect(() =>
      owner.admit([foreignAt(f.key.pubkey, 2, "x".repeat(4000))]),
    ).toThrow("capacity reached");
  }, 30000);

  it("a larger follow observed during a recovery fetch after a gap keeps its size", async () => {
    const f = fixture(T);
    const half = 4 * 1024 * 1024;
    const filler = foreignAt(f.key.pubkey, 1, "x".repeat(half - 3000));
    const small = foreignAt(f.key.pubkey, 0);
    const cut = [small, filler];
    let held = false;
    let release!: () => void;
    const fetched = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    const owner = snapshotted(f, [small, filler])({
      reader: {
        ...f.reader,
        async readStateSnapshot() {
          const events = [...cut];
          if (held) {
            started();
            await fetched;
          }
          return events;
        },
      },
    });
    await owner.ready;
    await owner.refresh();
    // A gap clears the basis; the recovery response is cut before F2.
    owner.stale();
    held = true;
    const recovery = owner.refresh();
    await fetching;
    owner.observeSize({
      ...foreignAt(f.key.pubkey, 0, "x".repeat(half)),
      id: "e".repeat(64),
      created_at: T + 1,
    });
    release();
    await recovery;
    expect(() =>
      owner.admit([foreignAt(f.key.pubkey, 2, "x".repeat(4000))]),
    ).toThrow("capacity reached");
  }, 30000);

  it("an overfull merged override union still publishes frontiers and fails override actions", async () => {
    const f = fixture(T);
    // Peer groups whose union cannot fit one primary blob.
    const markers = Array.from({ length: 150 }, (_, n) =>
      peerUnreadMarker(f, `c${n}`.padEnd(120, "x"), 0, {
        slot: n.toString(16).padStart(32, "b"),
        createdAt: T,
      }),
    );
    const owner = snapshotted(f, markers)();
    await owner.ready;
    await owner.refresh();
    await owner.read("room", T, () => true);
    await owner.flush();
    expect(ownerStatus(owner)).toBe("reconciled");
    const [primary] = Object.values(f.own());
    expect(primary?.room).toBe(T);
    // Version 1 never carries groups; version 2 keeps the last published
    // groups (none), never a truncated merged set.
    expect(
      Object.keys(primary ?? {}).some((key) => key.startsWith("ov_")),
    ).toBe(false);
    expect(f.unread()).toBeUndefined();
    await expect(owner.markLocalUnread("other", () => true)).rejects.toThrow(
      "capacity reached",
    );
  }, 30000);

  it("an overfull primary reports a clear it cannot carry, while the read still saves", async () => {
    const f = fixture(T);
    const make = snapshotted(f, []);
    let owner = make();
    await owner.ready;
    await owner.refresh();
    // A second tab, never told about the first tab's saves.
    const other = make();
    await other.ready;
    await owner.read("room", T - 10, () => true);
    expect((await owner.markLocalUnread("room", () => true)).sync).toBe(
      "pending",
    );
    await owner.flush();
    const live = () => f.unread()?.["ov_s:room"];
    expect(live()).toBeDefined();
    // Peer groups now overfill the primary.
    for (let n = 0; n < 150; n++)
      f.addRemote(
        peerUnreadMarker(f, `c${n}`.padEnd(120, "x"), 0, {
          slot: n.toString(16).padStart(32, "b"),
          createdAt: T,
        }),
      );
    await owner.refresh();
    // Reaching the bottom with nothing new: the read saves, and only the
    // clear would end the group.
    await owner.read("room", T - 10, () => true, true);
    expect(owner.state().frontiers.room).toBe(T - 10);
    await owner.flush();
    expect(live()).toBeDefined();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: "Channel mark read cannot be synchronized",
    });
    // An unrelated read leaves the notice up while the clear still fails.
    await owner.read("elsewhere", T - 10, () => true);
    await owner.flush();
    expect(owner.snapshot().error).toBe(
      "Channel mark read cannot be synchronized",
    );
    // An unrelated read in the other tab keeps the shared warning.
    await other.read("third", T - 10, () => true);
    other.dispose();
    // The refused clear is not retried, but its notice survives a reload.
    const sends = f.host.publish.mock.calls.length;
    owner.dispose();
    owner = make();
    await owner.ready;
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: "Channel mark read cannot be synchronized",
    });
    expect(owner.state().overrides.room?.clear).toBe(0);
    await owner.read("elsewhere", T - 9, () => true);
    expect(owner.snapshot().error).toBe(
      "Channel mark read cannot be synchronized",
    );
    expect(f.host.publish.mock.calls.length).toBe(sends);
    // Peers clear their groups and this mark: the failed clear no longer
    // needs syncing, so the notice goes.
    for (let n = 0; n < 150; n++)
      f.addRemote(
        peerUnreadMarker(f, `c${n}`.padEnd(120, "x"), 0, {
          slot: n.toString(16).padStart(32, "b"),
          createdAt: T + 1,
          set: T,
          clear: T + 1,
        }),
      );
    f.addRemote(
      peerUnreadMarker(f, "room", 0, {
        slot: "f".repeat(32),
        clientId: "clearer",
        createdAt: T + 1,
        set: T,
        clear: T + 1,
      }),
    );
    await owner.refresh();
    await owner.flush();
    expect(owner.snapshot().error).toBeUndefined();
  }, 30000);

  it("publishes every channel group with its merged stored frontier, own or not", async () => {
    const old = T - 31 * 24 * 60 * 60;
    const cases = [
      { key: "fresh", frontier: 0 },
      { key: "peer", peers: true, frontier: T - 100 },
      {
        key: "stale",
        setup: async (owner: ReturnType<ReturnType<typeof snapshotted>>) =>
          owner.read("stale", old, () => true),
        frontier: old,
      },
    ];
    for (const { key, setup, peers, frontier } of cases) {
      const f = fixture(T);
      const peer = peers
        ? [
            await signReadState(
              {
                slot: "b".repeat(32),
                createdAt: T,
                blob: { v: 1, client_id: "peer", contexts: { peer: T - 100 } },
              },
              f.key.secret,
              T,
            ),
          ]
        : [];
      const owner = snapshotted(f, peer)();
      await owner.ready;
      await owner.refresh();
      await setup?.(owner);
      await owner.markLocalUnread(key, () => true);
      await owner.flush();
      expect(ownerStatus(owner)).toBe("reconciled");
      // The final signed plaintext of this device's version-2 record.
      expect(f.unread()).toEqual({
        [key]: frontier,
        [`ov_s:${key}`]: T,
        [`ov_c:${key}`]: 0,
        [`ov_b:${key}`]: frontier,
      });
    }
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

describe("expiring unread (version 2)", () => {
  const T = 1800000000;
  const H = 30 * 24 * 60 * 60;
  const complete = (
    f: ReturnType<typeof fixture>,
    overrides: Parameters<typeof f.make>[0] = {},
  ) =>
    f.make({
      host: { ...f.host, communityId: "test-community" },
      reader: { ...f.reader, readStateSnapshot: () => f.reader.read() },
      ...overrides,
    });
  async function started(f: ReturnType<typeof fixture>) {
    const owner = complete(f);
    await owner.ready;
    await owner.refresh();
    return owner;
  }
  const active = (owner: ReturnType<typeof createReadState>, key = "room") => {
    const group = owner.state().overrides[key];
    return !!group && group.set > group.clear;
  };
  const held = (f: ReturnType<typeof fixture>) =>
    f.journal()?.unread?.held ?? {};

  it("stamps a mark with now, publishes it in its own record, and expires it one second past the lifetime", async () => {
    const f = fixture(T);
    const owner = await started(f);
    await owner.markLocalUnread("room", () => true);
    await owner.flush();
    expect(f.unread()).toEqual({
      room: 0,
      "ov_s:room": T,
      "ov_c:room": 0,
      "ov_b:room": 0,
    });
    // Version 1 carries only read positions.
    for (const contexts of Object.values(f.own()))
      expect(Object.keys(contexts).some((k) => k.startsWith("ov_"))).toBe(
        false,
      );
    f.setNow(T + H);
    await owner.upkeep();
    expect(active(owner)).toBe(true);
    f.setNow(T + H + 1);
    await owner.upkeep();
    expect(active(owner)).toBe(false);
    // Saved: the durable watermark moved with expiry.
    expect(f.journal()?.unread?.watermark).toBe(T + H + 1);
    expect(f.journal()?.state.overrides.room).toEqual({
      set: 0,
      clear: T,
      baseline: 0,
    });
  });

  it("a captured read fence refuses a synced mark unread another window saved after the cut", async () => {
    const f = fixture(T);
    const owner = await started(f);
    const second = await started(f);
    const fence = owner.captureLocalUnread(["room"]);
    await second.markLocalUnread("room", () => true);
    const saved = f.journal();
    expect(saved?.state.overrides.room?.set).toBe(T);
    f.setNow(T + 1);
    await expect(
      owner.read("room", T + 1, () => true, true, ["room"], fence),
    ).rejects.toThrow("Reading observation expired");
    expect(f.journal()).toEqual(saved);
    // A cut taken after the mark lets the same read through.
    const later = owner.captureLocalUnread(["room"]);
    await expect(
      owner.read("room", T + 1, () => true, true, ["room"], later),
    ).resolves.toMatchObject({ durability: "saved" });
  });

  it("keeps a tombstone through the discard guard and drops it one second later, across restarts", async () => {
    const f = fixture(T);
    let owner = await started(f);
    await owner.markLocalUnread("room", () => true);
    f.setNow(T + 1);
    await owner.read("room", T + 1, () => true, true);
    // Read past its baseline: dead at K = max(S, C), with no new stamp.
    expect(f.journal()?.state.overrides.room).toEqual({
      set: 0,
      clear: T,
      baseline: 0,
    });
    owner.dispose();
    f.setNow(T + H + 600);
    owner = complete(f);
    await owner.ready;
    expect(f.journal()?.state.overrides.room).toBeDefined();
    owner.dispose();
    f.setNow(T + H + 601);
    owner = complete(f);
    await owner.ready;
    expect(f.journal()?.state.overrides.room).toBeUndefined();
  });

  it("refuses a stamp more than 60 s ahead and holds back a group more than 660 s ahead", async () => {
    const f = fixture(T);
    f.addRemote(
      await peerUnreadMarker(f, "ahead", 0, {
        createdAt: T,
        clear: T + 60,
        set: 0,
      }),
    );
    f.addRemote(
      await peerUnreadMarker(f, "far", 0, {
        createdAt: T,
        set: T + 661,
        slot: "c".repeat(32),
        clientId: "far",
      }),
    );
    const owner = await started(f);
    // Merged at 60 s ahead: a mark would need a stamp past now + 60.
    expect(owner.state().overrides.ahead?.clear).toBe(T + 60);
    // Held back, and never merged or shown while held.
    expect(owner.state().overrides.far).toBeUndefined();
    expect(held(f).far).toEqual([[T + 661, 0, 0, 0]]);
    // While held, a new mark stays on this device.
    await owner.markLocalUnread("room", () => true);
    expect(owner.state().overrides.room).toBeUndefined();
    // The clock catches up: the group merges, and marks work again.
    f.setNow(T + 1);
    await owner.upkeep();
    expect(held(f)).toEqual({});
    expect(active(owner, "far")).toBe(true);
    await owner.markLocalUnread("room", () => true);
    expect(active(owner)).toBe(true);
  });

  it.each(
    (["upkeep", "a live ingest", "learnHomes"] as const).flatMap((by) =>
      [false, true].map((pending) => ({ by, pending })),
    ),
  )(
    "a group released by $by wakes exactly one send (failed pending send: $pending)",
    async ({ by, pending }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture(T);
      const owner = complete(f, { debounceMs: 10 });
      await owner.ready;
      await owner.refresh();
      const v2 = () =>
        f.host.publish.mock.calls
          .map(([event]) => event)
          .filter((event) =>
            event.tags.some(
              ([n, v]) => n === "t" && v === "read-state-unread-v2",
            ),
          );
      let original: RelayEvent | undefined;
      if (pending) {
        // The send's outcome is unknown, so its exact bytes stay pending.
        f.host.publish.mockRejectedValueOnce(new Error("response lost"));
        await owner.markLocalUnread("room", () => true);
        await owner.flush();
        original = f.journal()?.pending?.event;
        expect(original).toBeDefined();
        expect(v2()).toHaveLength(1);
      }
      f.addRemote(
        await peerUnreadMarker(f, "far", 0, {
          createdAt: T,
          set: T + 661,
          slot: "c".repeat(32),
          clientId: "far",
        }),
      );
      await owner.refresh();
      await owner.flush();
      expect(held(f).far).toHaveLength(1);
      // A held group refuses the send, including the pending retry.
      expect(v2()).toHaveLength(pending ? 1 : 0);
      const revision = f.journal()?.revision ?? 0;
      f.setNow(T + 1);
      // Whichever save settles the release first; upkeep then finds nothing.
      if (by === "upkeep") await owner.upkeep();
      else if (by === "learnHomes") await owner.learnHomes({});
      else
        owner.accept([
          await signReadState(
            {
              slot: "d".repeat(32),
              createdAt: T + 1,
              blob: { v: 1, client_id: "x", contexts: { unrelated: T } },
            },
            f.key.secret,
            T + 1,
          ),
        ]);
      // Queued behind the ingest, as the timer's upkeep would be.
      await owner.upkeep();
      expect(held(f)).toEqual({});
      expect(f.journal()?.revision).toBe(revision + 1);
      const bytes = (event?: RelayEvent) => JSON.stringify(event);
      if (original)
        expect(bytes(f.journal()?.pending?.event)).toBe(bytes(original));
      // No explicit flush: the release itself starts the send.
      await vi.advanceTimersByTimeAsync(10);
      const sends = v2();
      if (original) {
        // The original bytes go out once more, then one newer envelope.
        expect(sends).toHaveLength(3);
        expect(bytes(sends[1])).toBe(bytes(original));
        expect(sends[2]?.id).not.toBe(original.id);
      } else expect(sends).toHaveLength(1);
      // The pending mark keeps its stamp; the released group joins it.
      expect(f.unread()).toMatchObject({
        ...(pending && { "ov_s:room": T }),
        far: 0,
        "ov_s:far": T + 661,
        "ov_c:far": 0,
        "ov_b:far": 0,
      });
      expect(f.journal()?.pending).toBeUndefined();
      // Nothing more across further debounce intervals and another upkeep.
      await vi.advanceTimersByTimeAsync(70);
      await owner.upkeep();
      await vi.advanceTimersByTimeAsync(70);
      expect(v2()).toHaveLength(sends.length);
    },
  );

  it("a held group from a repeated delivery is kept once", async () => {
    const f = fixture(T);
    const far = await peerUnreadMarker(f, "far", 0, {
      createdAt: T,
      set: T + 700,
    });
    f.addRemote(far);
    const owner = await started(f);
    owner.accept([far]);
    await owner.refresh();
    expect(held(f).far).toHaveLength(1);
  });

  it("a held group re-delivered after a local read keeps one group with the larger frontier", async () => {
    const f = fixture(T);
    const far = await peerUnreadMarker(f, "far", 0, {
      createdAt: T,
      set: T + 700,
    });
    f.addRemote(far);
    const owner = await started(f);
    expect(held(f).far).toHaveLength(1);
    for (let i = 1; i <= 10; i++) {
      await owner.read("far", 100 + i, () => true);
      owner.accept([far]);
      await owner.refresh();
    }
    expect(held(f).far).toHaveLength(1);
    expect(held(f).far?.[0]?.[3]).toBe(110);
  });

  it("a held incoming group gets the incoming cutoff, not the local discard guard", async () => {
    const f = fixture(T);
    f.addRemote(
      await peerUnreadMarker(f, "far", 5, { createdAt: T, set: T + 700 }),
    );
    const owner = await started(f);
    expect(held(f).far).toHaveLength(1);
    // Past the lifetime but inside the guard a local tombstone would get.
    f.setNow(T + 700 + H + 300);
    await owner.upkeep();
    expect(held(f)).toEqual({});
    expect(f.journal()?.state.overrides.far).toBeUndefined();
  });

  it("a held group keeps its old read position across a restart", async () => {
    const f = fixture(T);
    const old = T - 40 * 24 * 60 * 60;
    f.addRemote(
      await signReadState(
        {
          slot: "b".repeat(32),
          createdAt: T,
          blob: {
            v: 2,
            client_id: "peer",
            contexts: {
              far: old,
              "ov_s:far": T + 700,
              "ov_c:far": 0,
              "ov_b:far": old - 10,
            },
          },
        },
        f.key.secret,
        T,
      ),
    );
    let owner = await started(f);
    expect(held(f).far).toEqual([[T + 700, 0, old - 10, old]]);
    owner.dispose();
    // Retention while held: a local floor past the old read position drops
    // the ordinary frontier, so only the held entry still carries it.
    await f.storage.update((current) => ({
      ...(current as ReadJournal),
      floor: old + 1,
    }));
    owner = complete(f);
    await owner.ready;
    await owner.read("room", T, () => true, true);
    expect(f.journal()?.state.frontiers.far).toBeUndefined();
    expect(held(f).far).toHaveLength(1);
    f.setNow(T + 100);
    await owner.upkeep();
    // Read past its baseline: dead, not unread again.
    expect(active(owner, "far")).toBe(false);
    expect(f.journal()?.state.overrides.far).toEqual({
      set: 0,
      clear: T + 700,
      baseline: 0,
    });
  });

  it("a failed expiry save stays due, idle upkeep saves it, and a clock rollback after restart cannot revive the mark", async () => {
    const f = fixture(T);
    let owner = await started(f);
    await owner.markLocalUnread("room", () => true);
    const update = vi.mocked(f.storage.update).getMockImplementation();
    if (!update) throw new Error("Missing fixture storage");
    const saved = f.journal()?.unread?.watermark;
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    f.setNow(T + H + 1);
    await owner.upkeep();
    // Shown expired at once; the saved watermark did not move.
    expect(active(owner)).toBe(false);
    expect(f.journal()?.unread?.watermark).toBe(saved);
    expect(saved).toBeLessThan(T + H + 1);
    await owner.upkeep();
    expect(f.journal()?.unread?.watermark).toBe(T + H + 1);
    owner.dispose();
    f.setNow(T + H - 100);
    owner = complete(f);
    await owner.ready;
    expect(active(owner)).toBe(false);
  });

  it("a pending unread record is not retried while a group is held back", async () => {
    const f = fixture(T);
    const owner = await started(f);
    await owner.markLocalUnread("room", () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const pending = f.journal()?.pending?.event;
    expect(pending?.tags[0]?.[1]).toMatch(/^read-state-unread-v2:/);
    const far = await peerUnreadMarker(f, "far", 0, {
      createdAt: T,
      set: T + 700,
      slot: "c".repeat(32),
      clientId: "far",
    });
    owner.accept([far]);
    await owner.refresh();
    f.host.publish.mockClear();
    await owner.flush();
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(f.journal()?.pending?.event).toEqual(pending);
    expect(owner.snapshot().status).toBe("error");
    // Released: the exact saved bytes go out, never re-stamped.
    f.setNow(T + 100);
    await owner.upkeep();
    await owner.flush();
    expect(f.host.publish).toHaveBeenCalledWith(pending, expect.anything());
  });

  it("a group admitted during signing refuses that send, and the next pass rebuilds it without re-stamping", async () => {
    const f = fixture(T);
    const owner = await started(f);
    await owner.markLocalUnread("room", () => true);
    const sign = f.host.sign.getMockImplementation();
    let injected = false;
    f.host.sign.mockImplementation(async (intent) => {
      if (intent.blob.v === 2 && !injected) {
        injected = true;
        // Another window admits a peer group into the shared journal.
        const current = f.journal();
        if (!current) throw new Error("Missing journal");
        f.setJournal({
          ...current,
          state: {
            ...current.state,
            overrides: {
              ...current.state.overrides,
              peer: { set: T - 5, clear: 0, baseline: 0 },
            },
          },
        });
      }
      return sign?.(intent) as ReturnType<NonNullable<typeof sign>>;
    });
    await owner.flush();
    expect(f.unread()).toBeUndefined();
    expect(f.journal()?.pending).toBeUndefined();
    await owner.flush();
    expect(f.unread()).toMatchObject({ "ov_s:room": T, "ov_s:peer": T - 5 });
  });

  it("a clear refused while a group is held back shows the notice, even once local", async () => {
    const f = fixture(T);
    const owner = await started(f);
    await owner.read("room", T - 10, () => true);
    await owner.markLocalUnread("room", () => true);
    await owner.flush();
    f.addRemote(
      await peerUnreadMarker(f, "far", 0, {
        createdAt: T,
        set: T + 700,
        slot: "c".repeat(32),
        clientId: "far",
      }),
    );
    await owner.refresh();
    // Nothing new to read: only the clear would end the group.
    await owner.read("room", T - 10, () => true, true);
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("ahead of this clock"),
    });
    expect(active(owner)).toBe(true);
  });

  describe("a held list that is full", () => {
    async function overflowed() {
      const f = fixture(T);
      const owner = await started(f);
      const version = (n: number) =>
        peerUnreadMarker(f, "room", 0, {
          createdAt: T + n,
          set: T + 700 + 2 * n,
          clear: T + 701 + 2 * n,
          slot: "c".repeat(32),
          clientId: "far",
        });
      for (let n = 1; n <= 8; n++) {
        owner.accept([await version(n)]);
        await owner.refresh();
      }
      // The ninth distinct version arrives with an unrelated peer's group;
      // the relay holds both as their peers' latest records.
      const ninth = await version(9);
      const other = await peerUnreadMarker(f, "other", 0, {
        createdAt: T - 5,
        set: T - 5,
      });
      f.addRemote(ninth);
      f.addRemote(other);
      owner.accept([ninth, other]);
      await owner.refresh();
      return { f, owner };
    }
    it("drops only the ninth version, so an unrelated peer's group still merges", async () => {
      const { f, owner } = await overflowed();
      expect(f.journal()?.state.overrides.other).toMatchObject({ set: T - 5 });
      expect(held(f).room).toHaveLength(8);
      expect(owner.snapshot().status).not.toBe("error");
      // Once the clock reaches the held versions, the latest kept one merges.
      f.setNow(T + 100);
      await owner.upkeep();
      expect(held(f)).toEqual({});
      expect(f.journal()?.state.overrides.room).toMatchObject({
        clear: T + 717,
      });
    });
    // Accepted limit of dropping the ninth version (option A): a mark made
    // against the last kept version loses to the dropped later clear once a
    // read returns the peer's latest record. Pinned so a change is deliberate.
    it("accepts that a mark made after the drain loses to the dropped clear", async () => {
      const { f, owner } = await overflowed();
      // The earliest time a new stamp may sit 60 seconds above clear T+717.
      f.setNow(T + 658);
      await owner.upkeep();
      expect(held(f)).toEqual({});
      expect(f.journal()?.state.overrides.room).toMatchObject({
        clear: T + 717,
      });
      expect((await owner.markLocalUnread("room", () => true)).sync).not.toBe(
        "local",
      );
      expect(f.journal()?.state.overrides.room).toMatchObject({
        set: T + 718,
        clear: T + 717,
      });
      expect(active(owner)).toBe(true);
      // The relay still holds the peer's ninth version as its latest record.
      await owner.refresh();
      expect(f.journal()?.state.overrides.room).toMatchObject({
        clear: T + 719,
      });
      expect(active(owner)).toBe(false);
      await owner.refresh();
      expect(active(owner)).toBe(false);
    });
  });

  describe("a clear refused by the clock", () => {
    const clockNotice = {
      status: "error",
      error: expect.stringContaining("ahead of this clock"),
    };
    async function refused() {
      const f = fixture(T);
      const owner = await started(f);
      owner.accept([
        await peerUnreadMarker(f, "room", 0, { createdAt: T, set: T + 300 }),
        await peerUnreadMarker(f, "other", 0, {
          createdAt: T,
          set: T - 5,
          slot: "c".repeat(32),
          clientId: "other-peer",
        }),
      ]);
      await owner.refresh();
      await owner.read("room", 0, () => true, true);
      expect(owner.snapshot()).toMatchObject(clockNotice);
      return { f, owner };
    }
    it("keeps its notice through the next flush", async () => {
      const { owner } = await refused();
      await owner.flush();
      expect(active(owner)).toBe(true);
      expect(owner.snapshot()).toMatchObject(clockNotice);
    });
    it("keeps its notice when another channel's clear succeeds", async () => {
      const { f, owner } = await refused();
      await owner.read("other", 0, () => true, true);
      expect(f.journal()?.state.overrides.other?.clear).toBeGreaterThan(0);
      await owner.flush();
      expect(owner.snapshot()).toMatchObject(clockNotice);
    });
    /** Peer groups overfill the primary, or with `cleared`, shrink again. */
    async function fill(
      f: ReturnType<typeof fixture>,
      owner: Awaited<ReturnType<typeof started>>,
      cleared = false,
    ) {
      const groups = [];
      for (let n = 0; n < 150; n++)
        groups.push(
          await peerUnreadMarker(f, `c${n}`.padEnd(120, "x"), 0, {
            slot: n.toString(16).padStart(32, "b"),
            ...(cleared
              ? { createdAt: T + 1, set: T, clear: T + 1 }
              : { createdAt: T }),
          }),
        );
      owner.accept(groups);
      await owner.refresh();
    }
    it("keeps its notice through a capacity refusal and a later fit", async () => {
      const { f, owner } = await refused();
      // A capacity refusal of another channel must not replace the warning.
      await fill(f, owner);
      await owner.read("other", 0, () => true, true);
      expect(owner.snapshot()).toMatchObject(clockNotice);
      await fill(f, owner, true);
      await owner.flush();
      expect(owner.snapshot()).toMatchObject(clockNotice);
    }, 30000);
    it("lets a fit resolve a capacity refusal once the clock refusal clears", async () => {
      const { f, owner } = await refused();
      await fill(f, owner);
      await owner.read("other", 0, () => true, true);
      await fill(f, owner, true);
      f.setNow(T + 301);
      await owner.read("room", 0, () => true, true);
      expect(f.journal()?.unread?.blockedClear).toBeUndefined();
      await owner.flush();
      expect(f.journal()?.unread?.capacityKeys).toBeUndefined();
      expect(f.journal()?.unread?.blockedClear).toBeUndefined();
      expect(owner.snapshot().error).toBeUndefined();
    }, 30000);
    it("keeps another clock-refused channel's notice through that fit", async () => {
      const { f, owner } = await refused();
      owner.accept([
        await peerUnreadMarker(f, "late", 0, {
          createdAt: T,
          set: T + 400,
          slot: "d".repeat(32),
          clientId: "late-peer",
        }),
      ]);
      await owner.refresh();
      // Refused in turn: room, late, room again, then other for capacity.
      await owner.read("late", 0, () => true, true);
      await owner.read("room", 0, () => true, true);
      await fill(f, owner);
      await owner.read("other", 0, () => true, true);
      await fill(f, owner, true);
      f.setNow(T + 301);
      await owner.read("room", 0, () => true, true);
      await owner.flush();
      expect(f.journal()?.unread?.blockedKeys).toEqual(["late"]);
      expect(f.journal()?.unread?.capacityKeys).toBeUndefined();
      expect(owner.snapshot()).toMatchObject(clockNotice);
    }, 30000);
    it("clears its notice once the same channel's clear succeeds", async () => {
      const { f, owner } = await refused();
      f.setNow(T + 301);
      await owner.read("room", 0, () => true, true);
      expect(f.journal()?.unread?.blockedClear).toBeUndefined();
      expect(owner.snapshot().error).toBeUndefined();
    });
    it("clears its notice once the peer's group is no longer active", async () => {
      const { f, owner } = await refused();
      owner.accept([
        await peerUnreadMarker(f, "room", 0, {
          createdAt: T + 1,
          set: T + 300,
          clear: T + 310,
        }),
      ]);
      await owner.refresh();
      await owner.flush();
      expect(f.journal()?.unread?.blockedClear).toBeUndefined();
      expect(owner.snapshot().error).toBeUndefined();
    });
  });
});

describe("saved expiring unread journal", () => {
  const T2 = 1800000000;
  it("a malformed saved unread record is an error, never a fresh journal", () => {
    const key = keypair();
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          unread: { held: { room: { s: 1 } }, watermark: "x" },
        },
        key.pubkey,
      ),
    ).toThrow("Invalid saved unread state");
  });
  it("a version-2 record from another device ignores unpaired groups and stray read positions", async () => {
    const f = fixture(T2);
    f.addRemote(
      await signReadState(
        {
          slot: "b".repeat(32),
          createdAt: T2,
          blob: {
            v: 2,
            client_id: "peer",
            contexts: {
              stray: T2,
              "ov_s:loose": T2,
              "ov_c:loose": 0,
              "ov_b:loose": 0,
              side: 0,
              "ov_s:side": T2,
              "ov_c:side": 0,
              "ov_b:side": 0,
            },
          },
        },
        f.key.secret,
        T2,
      ),
    );
    const owner = f.make({
      host: { ...f.host, communityId: "test-community" },
      reader: { ...f.reader, readStateSnapshot: () => f.reader.read() },
    });
    await owner.ready;
    await owner.refresh();
    expect(owner.state().frontiers.stray).toBeUndefined();
    expect(owner.state().overrides.loose).toBeUndefined();
    expect(owner.state().overrides.side?.set).toBe(T2);
  });
  it("a journal from before version 2 keeps read positions and imports no marks", () => {
    const key = keypair();
    const { unread: _unread, ...old } = newReadJournal();
    const journal = readJournal(
      {
        ...old,
        state: {
          frontiers: { room: 5 },
          overrides: { room: { set: 2, clear: 0, baseline: 5 } },
        },
      },
      key.pubkey,
    );
    expect(journal.state).toEqual({ frontiers: { room: 5 }, overrides: {} });
  });
});
