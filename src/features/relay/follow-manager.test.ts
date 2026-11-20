import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { expect, it, vi } from "vitest";
import {
  decodeThreadFollows,
  signThreadFollows,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import type { RelayEvent } from "./events";
import { createThreadFollowSync } from "./follow-manager";
import { followCoordinate, type ReadStateHost } from "./read-state-host";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import type { RelayReader } from "./reader";
import { memoryThreadFollows } from "./thread-follows";

const secret = generateSecretKey();
const viewer = getPublicKey(secret);
const K = `room:${"1".repeat(64)}`;

/** A relay holding one replaceable head per coordinate, full order. */
function relay() {
  const heads = new Map<string, RelayEvent>();
  const published: RelayEvent[] = [];
  /** Other own kind-30078 events (read state) in the same snapshot. */
  const others: RelayEvent[] = [];
  return {
    heads,
    others,
    published,
    put(event: RelayEvent) {
      const coordinate = followCoordinate(event) ?? "";
      const head = heads.get(coordinate);
      if (
        !head ||
        event.created_at > head.created_at ||
        (event.created_at === head.created_at && event.id < head.id)
      )
        heads.set(coordinate, event);
    },
  };
}
type Relay = ReturnType<typeof relay>;
/** Exclusive and non-reentrant, like `navigator.locks`: a nested request
 * for the same lock waits forever. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(_signal: AbortSignal, work: () => Promise<T>) => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
}
/** A relay reader that honours filters, limits and freshness: a non-fresh
 * read may join a stale cached result, as the real reader's dedupe does. */
function relayReader(
  r: Relay,
  options: { beforeRead?: () => Promise<void>; snapshot?: boolean } = {},
) {
  let cache: RelayEvent[] | undefined;
  const all = () => [...r.heads.values(), ...r.others];
  const matches = (
    event: RelayEvent,
    filter: { "#t"?: string[]; "#d"?: string[] },
  ) =>
    (!filter["#t"] ||
      event.tags.some(
        (t) => t[0] === "t" && filter["#t"]?.includes(t[1] ?? ""),
      )) &&
    (!filter["#d"] ||
      event.tags.some(
        (t) => t[0] === "d" && filter["#d"]?.includes(t[1] ?? ""),
      ));
  const reader = {
    async read(
      filters: { "#t"?: string[]; "#d"?: string[]; limit?: number }[],
      read: { fresh?: boolean } = {},
    ) {
      await options.beforeRead?.();
      if (!read.fresh && cache) return cache;
      const out = filters.flatMap((filter) =>
        all()
          .filter((event) => matches(event, filter))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? Infinity),
      );
      cache = out;
      return out;
    },
    ...(options.snapshot === false
      ? {}
      : {
          async readStateSnapshot(read: { fresh?: boolean } = {}) {
            await options.beforeRead?.();
            if (!read.fresh && cache) return cache;
            return all();
          },
        }),
  };
  return reader as unknown as RelayReader;
}
/** Persists through JSON and `readJournal`, as IndexedDB does. */
function memoryStorage(initial?: ReadJournal) {
  let saved = initial && JSON.stringify(initial);
  let failing = false;
  const storage: ReadStateStorage = {
    async update(change) {
      if (failing) throw new Error("Storage unavailable");
      const current = saved
        ? readJournal(JSON.parse(saved), viewer)
        : undefined;
      const next = change(current ?? newReadJournal());
      saved = JSON.stringify(next);
      return readJournal(JSON.parse(saved), viewer);
    },
    async read() {
      return saved ? readJournal(JSON.parse(saved), viewer) : undefined;
    },
    async capture() {
      return this.read?.();
    },
    close() {},
  };
  return {
    storage,
    backup: () => readJournal(JSON.parse(saved ?? "null"), viewer),
    fail: (value: boolean) => {
      failing = value;
    },
  };
}
function setup(
  r: Relay,
  clock: { now: number },
  options: {
    storage?: ReadStateStorage;
    publish?: (event: RelayEvent) => Promise<void>;
    sign?: (event: RelayEvent) => Promise<void>;
    legacy?: ReturnType<typeof memoryThreadFollows>;
    beforeRead?: () => Promise<void>;
    capacity?: Parameters<typeof createThreadFollowSync>[0]["capacity"];
    snapshot?: boolean;
    reader?: RelayReader;
    lock?: ReturnType<typeof mutex>;
    broadcastName?: string;
  } = {},
) {
  const storage = options.storage ?? memoryStorage().storage;
  const host: ReadStateHost = {
    ...(options.snapshot === false ? {} : { communityId: "community" }),
    decode: async () => [],
    async decodeFollows(events) {
      return decodeThreadFollows(events, secret);
    },
    async signFollows(intent) {
      const event = signThreadFollows(intent, secret, clock.now) as RelayEvent;
      await options.sign?.(event);
      return event;
    },
    async publishFollows(event) {
      if (options.publish) return options.publish(event);
      r.put(event);
      r.published.push(event);
    },
  };
  const reader =
    options.reader ??
    relayReader(r, {
      ...(options.beforeRead ? { beforeRead: options.beforeRead } : {}),
      ...(options.snapshot === false ? { snapshot: false } : {}),
    });
  return createThreadFollowSync({
    viewer,
    reader,
    host,
    storage,
    lock: options.lock ?? mutex(),
    legacy: options.legacy ?? memoryThreadFollows(),
    now: () => clock.now,
    debounceMs: 60_000,
    ...(options.capacity ? { capacity: options.capacity } : {}),
    ...(options.broadcastName ? { broadcastName: options.broadcastName } : {}),
  });
}
/** A fresh device reads the relay. */
async function fresh(r: Relay) {
  const reader = setup(r, { now: 1 });
  await reader.refresh();
  return reader.read().get(K);
}

it("a tap resolves only once saved, then a fresh reader sees it", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  expect(disk.backup().follows?.slots).toHaveLength(1);
  expect(sync.read().get(K)).toBe(true);
  await sync.flush();
  expect(sync.snapshot().status).toBe("synchronized");
  expect(await fresh(r)).toBe(true);
});

it("C1: a second tap while the first is being signed is never lost", async () => {
  const r = relay();
  const clock = { now: 1000 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const sync = setup(r, clock, {
    sign: async () => {
      if (first) {
        first = false;
        await held;
      }
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  const flushing = sync.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // set queues behind the flush, so accept it concurrently.
  const tapping = sync.set(K, false);
  release();
  await flushing;
  await tapping;
  await sync.flush();
  expect(sync.read().get(K)).toBe(false);
  expect(await fresh(r)).toBe(false);
});

it("C2: restoring a backup taken before the first send recognizes its own slot", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  const backup = disk.backup(); // before debounce/send
  await sync.flush();
  clock.now = 990; // backward clock
  await sync.set(K, false);
  await sync.flush();
  expect(await fresh(r)).toBe(false);
  sync.dispose();
  const restored = setup(r, clock, {
    storage: memoryStorage(backup).storage,
  });
  await restored.refresh();
  expect(restored.read().get(K)).toBe(false);
  await restored.flush();
  expect(r.heads.size).toBe(1);
  expect(await fresh(r)).toBe(false);
});

it("I1: an OK without echo acknowledges from the retained packet", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  // Publish stores the event but no echo is ever delivered.
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  const follows = disk.backup().follows;
  expect(follows?.state.packets).toEqual({});
  expect(follows?.state.edits).toEqual({});
});

it("an unknown send outcome retries the exact signed bytes", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const attempts: string[] = [];
  let fail = true;
  const sync = setup(r, clock, {
    storage: disk.storage,
    publish: async (event) => {
      attempts.push(JSON.stringify(event));
      if (fail) throw new Error("Relay delivery could not be confirmed");
      r.put(event);
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  expect(sync.snapshot().status).toBe("failed");
  fail = false;
  clock.now = 1010;
  await sync.flush();
  expect(attempts[1]).toBe(attempts[0]);
  expect(await fresh(r)).toBe(true);
});

it("a failed save rejects the tap and leaves the choice unchanged", async () => {
  const r = relay();
  const disk = memoryStorage();
  const sync = setup(r, { now: 1000 }, { storage: disk.storage });
  await sync.refresh();
  disk.fail(true);
  await expect(sync.set(K, true)).rejects.toThrow("Storage unavailable");
  expect(sync.read().get(K)).toBeUndefined();
});

it("an unreadable own head refuses taps and holds retained packets", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  let fail = true;
  const sync = setup(r, clock, {
    storage: disk.storage,
    publish: async (event) => {
      if (fail) throw new Error("Relay delivery could not be confirmed");
      r.put(event);
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  const [slot] = disk.backup().follows?.slots ?? [];
  // A newer own event this build can't read lands in our slot.
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  r.put(
    finalizeEvent(
      {
        kind: 30078,
        created_at: 1100,
        tags: [
          ["d", `thread-follows:${slot}`],
          ["t", "thread-follows"],
        ],
        content: nip44.v2.encrypt(JSON.stringify({ v: 2 }), key),
      },
      secret,
    ) as RelayEvent,
  );
  await sync.refresh();
  fail = false;
  await sync.flush();
  expect(sync.snapshot()).toMatchObject({ status: "failed", complete: false });
  expect(Object.keys(disk.backup().follows?.state.packets ?? {})).toHaveLength(
    1,
  );
  await expect(sync.set(K, false)).rejects.toThrow("unreadable");
});

it("legacy choices import once at at=0, only where nothing is synced", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const other = `room:${"2".repeat(64)}`;
  const peer = setup(r, clock);
  await peer.refresh();
  await peer.set(K, false);
  await peer.flush();
  const legacy = memoryThreadFollows();
  legacy.write(
    new Map([
      [K, true],
      [other, true],
    ]),
  );
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  expect(sync.read().get(K)).toBe(false);
  expect(sync.read().get(other)).toBe(true);
  const follows = disk.backup().follows;
  expect(follows?.imported).toBe(true);
  expect(follows?.state.edits[other]).toMatchObject({
    origin: "legacy-import",
    entry: { follow: true, at: 0 },
  });
  expect(follows?.state.edits[K]).toBeUndefined();
  await sync.refresh();
  expect(Object.keys(disk.backup().follows?.state.edits ?? {})).toEqual([
    other,
  ]);
});

it("a reservation pushed past the host window fails the send visibly, never clamped", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  // Another device with a fast clock publishes into a peer slot; our own
  // head is then pushed ahead by a restore from that device.
  clock.now = 1300;
  await sync.set(K, false);
  clock.now = 1000;
  const published = r.heads.size;
  await sync.flush();
  expect(sync.snapshot().status).toBe("failed");
  expect(sync.snapshot().error).toMatch("ahead of this device's clock");
  expect(r.heads.size).toBe(published);
  expect(Object.keys(disk.backup().follows?.state.edits ?? {})).toEqual([K]);
});

it("spills new keys to another slot when one is full, without omission", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const keys = Array.from(
    { length: 500 },
    (_, i) => `room:${i.toString(16).padStart(64, "0")}`,
  );
  // A large legacy import shares one reservation, so it stays signable.
  const legacy = memoryThreadFollows();
  legacy.write(new Map(keys.map((key) => [key, true])));
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  // A tap while the import is unsent joins its slot's successor.
  await sync.set(keys[0] as string, false);
  await sync.flush();
  await sync.flush();
  expect(disk.backup().follows?.slots.length).toBeGreaterThan(1);
  const reader = setup(r, { now: 1 });
  await reader.refresh();
  expect(reader.read().get(keys[0] as string)).toBe(false);
  for (const key of keys.slice(1)) expect(reader.read().get(key)).toBe(true);
});

it("counts follow events toward the shared snapshot limit before sending", async () => {
  const r = relay();
  const disk = memoryStorage();
  const admitted: string[] = [];
  let refreshed = 0;
  const sync = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      capacity: {
        admit(events) {
          admitted.push(...events.map((event) => event.id));
          throw new Error(
            "Read-state snapshot capacity reached; saved intent retained",
          );
        },
        observeSize() {},
        async refresh() {
          refreshed++;
        },
      },
    },
  );
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  expect(sync.snapshot()).toMatchObject({
    status: "failed",
    error: "Read-state snapshot capacity reached; saved intent retained",
  });
  expect(admitted).toHaveLength(1);
  expect(refreshed).toBe(1);
  expect(r.heads.size).toBe(0);
  // The choice and its exact packet are kept for retry.
  expect(Object.keys(disk.backup().follows?.state.packets ?? {})).toHaveLength(
    1,
  );
  expect(sync.read().get(K)).toBe(true);
});

it("a second window's import never overwrites a choice saved since it read the relay", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const disk = memoryStorage();
  // Window B reads the relay first, then A imports and the user unfollows.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = setup(r, clock, {
    storage: disk.storage,
    legacy,
    beforeRead: () => held,
  });
  const reading = b.refresh();
  const a = setup(r, clock, { storage: disk.storage, legacy });
  await a.refresh();
  await a.set(K, false);
  release();
  await reading;
  const edit = disk.backup().follows?.state.edits[K];
  expect(edit).toMatchObject({ origin: "explicit", entry: { follow: false } });
});

it("a refused import reservation saves nothing, and the retry imports once", async () => {
  const r = relay();
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const disk = memoryStorage();
  const clock = { now: 4_294_967_295 + 1 }; // past uint32: reservation refused
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  expect(sync.snapshot().status).toBe("failed");
  expect(disk.backup().follows?.imported).toBeUndefined();
  expect(disk.backup().follows?.state.edits ?? {}).toEqual({});
  expect(legacy.read().get(K)).toBe(true);
  clock.now = 1000;
  await sync.refresh();
  expect(disk.backup().follows?.imported).toBe(true);
  expect(disk.backup().follows?.state.edits[K]).toMatchObject({
    origin: "legacy-import",
  });
});

const slotOf = (n: number) => n.toString(16).padStart(32, "0");
const keyOf = (n: number) => `room:${n.toString(16).padStart(64, "0")}`;
/** Our own signed thread-follows event, from any installation. */
function head(
  slot: string,
  createdAt: number,
  threads: Record<string, { follow: boolean; at: number }>,
  clientId = "peer-device",
  extra: Record<string, unknown> = {},
) {
  return signThreadFollows(
    {
      slot,
      createdAt,
      payload: { v: 1, client_id: clientId, threads, ...extra },
    },
    secret,
    createdAt,
  ) as RelayEvent;
}
/** The installation's client ID, after its first load. */
async function installed(clock = { now: 1000 }) {
  const r = relay();
  const disk = memoryStorage();
  const first = setup(r, clock, { storage: disk.storage });
  await first.refresh();
  first.dispose();
  return { r, disk, clock, clientId: disk.backup().clientId };
}
const within = <T>(promise: Promise<T>, ms = 500) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out")), ms),
    ),
  ]);

it("D1: recovery reads the fresh complete snapshot, not a cached tag read", async () => {
  const r = relay();
  const sync = setup(r, { now: 1000 });
  await sync.refresh();
  r.put(head(slotOf(1), 1000, { [K]: { follow: true, at: 5 } }));
  await sync.refresh();
  expect(sync.read().get(K)).toBe(true);
  expect(sync.snapshot().complete).toBe(true);
});

it("D1: a host without the complete snapshot never counts as complete or imports", async () => {
  const r = relay();
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const disk = memoryStorage();
  const sync = setup(
    r,
    { now: 1000 },
    { storage: disk.storage, legacy, snapshot: false },
  );
  await sync.refresh();
  expect(sync.snapshot().complete).toBe(false);
  expect(disk.backup().follows?.imported).toBeUndefined();
  expect(r.heads.size).toBe(0);
});

it("D1: gap repair reconciles follow heads from read state's complete snapshot", async () => {
  const r = relay();
  let repair!: (events: readonly RelayEvent[], complete: boolean) => void;
  const sync = setup(
    r,
    { now: 1000 },
    {
      capacity: {
        admit() {},
        observeSize() {},
        async refresh() {},
        subscribeOwn(listener) {
          repair = listener;
          return () => {};
        },
      },
    },
  );
  await sync.refresh();
  const missed = head(slotOf(1), 1000, { [K]: { follow: true, at: 5 } });
  repair([missed], true);
  await vi.waitFor(() => expect(sync.read().get(K)).toBe(true));
});

it("D1: flush reads our heads before writing, so a newer unreadable head blocks it", async () => {
  const { r, disk, clock } = await installed();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  const [slot] = disk.backup().follows?.slots ?? [];
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  r.put(
    finalizeEvent(
      {
        kind: 30078,
        created_at: 1100,
        tags: [
          ["d", `thread-follows:${slot}`],
          ["t", "thread-follows"],
        ],
        content: nip44.v2.encrypt(JSON.stringify({ v: 2 }), key),
      },
      secret,
    ) as RelayEvent,
  );
  await sync.flush();
  expect(sync.snapshot().error).toContain("unreadable");
  expect(r.published).toHaveLength(0);
});

it("D2: decodes 17 coordinates and more than 512 KiB in host-sized batches", async () => {
  const r = relay();
  for (let n = 0; n < 17; n++)
    r.put(head(slotOf(n + 1), 1000, { [keyOf(n)]: { follow: true, at: 5 } }));
  const sync = setup(r, { now: 1000 });
  await sync.refresh();
  expect(sync.snapshot().status).toBe("synchronized");
  expect(sync.read().get(keyOf(16))).toBe(true);

  const big = relay();
  for (let n = 0; n < 14; n++)
    big.put(
      head(
        slotOf(n + 1),
        1000,
        { [keyOf(n)]: { follow: true, at: 5 } },
        "peer",
        {
          pad: "x".repeat(39 * 1024),
        },
      ),
    );
  const large = setup(big, { now: 1000 });
  await large.refresh();
  expect(large.snapshot().status).toBe("synchronized");
  expect(large.read().get(keyOf(13))).toBe(true);
});

it("D3: a readable head from another client in our slot is never adopted", async () => {
  const { r, disk, clock } = await installed();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  const [slot = ""] = disk.backup().follows?.slots ?? [];
  r.put(head(slot, 1100, { [K]: { follow: false, at: 1100 } }, "intruder"));
  await sync.refresh();
  await expect(sync.set(keyOf(9), true)).rejects.toThrow("unreadable");
  expect(disk.backup().follows?.state.heads[slot]?.payload).toBeUndefined();
  expect(r.published).toHaveLength(1);
});

it("D4: owned slots merge by the protocol rule in either order", async () => {
  for (const [a, b, want] of [
    [{ follow: true, at: 5 }, { follow: false, at: 3 }, true],
    [{ follow: false, at: 3 }, { follow: true, at: 5 }, true],
    [{ follow: true, at: 5 }, { follow: false, at: 5 }, false],
    [{ follow: false, at: 5 }, { follow: true, at: 5 }, false],
  ] as const) {
    const { r, disk, clock, clientId } = await installed();
    r.put(head(slotOf(1), 1000, { [K]: a }, clientId));
    r.put(head(slotOf(2), 1000, { [K]: b }, clientId));
    const sync = setup(r, clock, { storage: disk.storage });
    await sync.refresh();
    expect(disk.backup().follows?.slots).toHaveLength(2);
    expect(sync.read().get(K)).toBe(want);
  }
});

it("D5: an unreadable head in one owned slot holds publication of every slot", async () => {
  const { r, disk, clock, clientId } = await installed();
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  r.put(head(slotOf(1), 1000, { [K]: { follow: true, at: 5 } }, clientId));
  // Our second slot, padded so the next new key cannot go there.
  r.put(
    head(slotOf(2), 1000, { [keyOf(2)]: { follow: true, at: 5 } }, clientId, {
      pad: "x".repeat(40 * 1024 - 200),
    }),
  );
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(keyOf(3), true); // lands in slot 1
  r.put(
    finalizeEvent(
      {
        kind: 30078,
        created_at: 1100,
        tags: [
          ["d", `thread-follows:${slotOf(2)}`],
          ["t", "thread-follows"],
        ],
        content: nip44.v2.encrypt(JSON.stringify({ v: 2 }), key),
      },
      secret,
    ) as RelayEvent,
  );
  await sync.flush();
  expect(sync.snapshot().error).toContain("unreadable");
  expect(r.published).toHaveLength(0);
  expect(disk.backup().follows?.state.edits[keyOf(3)]).toBeDefined();
});

it("D6: peer choices display offline after a restart", async () => {
  const r = relay();
  const other = keyOf(7);
  r.put(
    head(slotOf(1), 1000, {
      [K]: { follow: true, at: 5 },
      [other]: { follow: false, at: 5 },
    }),
  );
  const disk = memoryStorage();
  const online = setup(r, { now: 1000 }, { storage: disk.storage });
  await online.refresh();
  online.dispose();
  const offline = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      reader: {
        read: async () => {
          throw new Error("Relay is disconnected");
        },
        readStateSnapshot: async () => {
          throw new Error("Relay is disconnected");
        },
      } as unknown as RelayReader,
    },
  );
  await offline.refresh();
  expect(offline.read().get(K)).toBe(true);
  expect(offline.read().get(other)).toBe(false);
});

it("D7: a tap saves while signing is held", async () => {
  const r = relay();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disk = memoryStorage();
  const sync = setup(
    r,
    { now: 1000 },
    { storage: disk.storage, sign: () => held },
  );
  await sync.refresh();
  await sync.set(K, true);
  const flushing = sync.flush();
  await vi.waitFor(() =>
    expect(
      Object.keys(disk.backup().follows?.state.packets ?? {}),
    ).toHaveLength(0),
  );
  await within(sync.set(keyOf(5), true));
  expect(disk.backup().follows?.state.edits[keyOf(5)]).toBeDefined();
  release();
  await flushing;
});

it("D7: a lost capacity basis is re-read before the shared lock, never inside it", async () => {
  const r = relay();
  const lock = mutex();
  let basis = false;
  const sync = setup(
    r,
    { now: 1000 },
    {
      lock,
      capacity: {
        admit() {
          if (!basis)
            throw new Error(
              "Read-state capacity basis lost; saved intent retained",
            );
        },
        observeSize() {},
        // Read state's refresh queues behind its flush, which holds the lock.
        refresh: () =>
          lock(new AbortController().signal, async () => {
            basis = true;
          }),
      },
    },
  );
  await sync.refresh();
  await sync.set(K, true);
  await within(sync.flush());
  expect(r.published).toHaveLength(1);
});

it("D9: an existing key's update is sized, so an unsendable edit is refused", async () => {
  const clock = { now: 1_000_000_000 };
  const { r, disk, clientId } = await installed(clock);
  const threads = { [K]: { follow: true, at: 1_000_000_000 } };
  const size = (pad: number) =>
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        client_id: clientId,
        threads,
        pad: "x".repeat(pad),
      }),
    ).byteLength;
  const pad = 40 * 1024 - size(0);
  expect(size(pad)).toBe(40 * 1024);
  r.put(
    head(slotOf(1), clock.now, threads, clientId, { pad: "x".repeat(pad) }),
  );
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await expect(sync.set(K, false)).rejects.toThrow("do not fit");
  expect(disk.backup().follows?.state.edits[K]).toBeUndefined();
});

it("D9: other devices' slots never count against our 16", async () => {
  const r = relay();
  for (let n = 0; n < 16; n++)
    r.put(head(slotOf(n + 1), 1000, { [keyOf(n)]: { follow: true, at: 5 } }));
  const sync = setup(r, { now: 1000 });
  await sync.refresh();
  await sync.set(K, true);
  expect(sync.read().get(K)).toBe(true);
});

it("D1: without a complete snapshot, flush publishes nothing and keeps the work", async () => {
  const r = relay();
  const disk = memoryStorage();
  // A tap saved after complete recovery, then a restart on a host without
  // the complete snapshot.
  const first = setup(r, { now: 1000 }, { storage: disk.storage });
  await first.refresh();
  await first.set(K, true);
  first.dispose();
  const sync = setup(
    r,
    { now: 1000 },
    { storage: disk.storage, snapshot: false },
  );
  await sync.refresh();
  await sync.flush();
  expect(r.published).toHaveLength(0);
  // Missing capability is local-only, not a failure.
  expect(sync.snapshot()).toMatchObject({ status: "local" });
  expect(disk.backup().follows?.state.edits[K]).toBeDefined();
  expect(sync.read().get(K)).toBe(true);
});

for (const retry of [false, true])
  it(`D5: an unreadable owned head stored between two slot publications stops the second${retry ? " (retained packets)" : ""}`, async () => {
    const { r, disk, clock, clientId } = await installed();
    r.put(head(slotOf(1), 1000, { [K]: { follow: true, at: 5 } }, clientId));
    r.put(
      head(slotOf(2), 1000, { [keyOf(2)]: { follow: true, at: 5 } }, clientId, {
        pad: "x".repeat(40 * 1024 - 200),
      }),
    );
    r.put(
      head(slotOf(3), 1000, { [keyOf(4)]: { follow: true, at: 5 } }, clientId),
    );
    let other = false;
    let down = retry;
    const sync = setup(r, clock, {
      storage: disk.storage,
      publish: async (event) => {
        if (down) throw new Error("Relay delivery could not be confirmed");
        r.put(event);
        r.published.push(event);
        if (other) return;
        other = true;
        // Another window stores an unreadable head for a third, idle slot.
        const rest = slotOf(3);
        await disk.storage.update((journal) => {
          const follows = journal?.follows;
          if (!journal || !follows) throw new Error("no journal");
          return {
            ...journal,
            follows: {
              ...follows,
              state: {
                ...follows.state,
                heads: {
                  ...follows.state.heads,
                  [rest]: {
                    id: "9".repeat(64),
                    created_at: 1200,
                    payload: undefined,
                  },
                },
              },
            },
          };
        });
      },
    });
    await sync.refresh();
    await sync.set(K, false);
    await sync.set(keyOf(2), false);
    if (retry) {
      await sync.flush();
      expect(
        Object.keys(disk.backup().follows?.state.packets ?? {}),
      ).toHaveLength(2);
      down = false;
    }
    await sync.flush();
    expect(r.published).toHaveLength(1);
    expect(sync.snapshot().error).toContain("unreadable");
  });

it("startup gate: a tap before the first complete recovery is refused and changes nothing", async () => {
  const r = relay();
  const disk = memoryStorage();
  const sync = setup(r, { now: 1000 }, { storage: disk.storage });
  await expect(sync.set(K, true)).rejects.toThrow(
    "Follow choices are not ready. Connect and try again.",
  );
  expect(sync.read().get(K)).toBeUndefined();
  // Nothing was saved.
  expect(() => disk.backup()).toThrow();
});

it("a relay without the snapshot keeps taps as local edits and never fails", async () => {
  vi.useFakeTimers();
  try {
    const r = relay();
    const disk = memoryStorage();
    const local = setup(
      r,
      { now: 1000 },
      { snapshot: false, storage: disk.storage },
    );
    await local.refresh();
    await local.set(K, true);
    expect(local.read().get(K)).toBe(true);
    await vi.runAllTimersAsync();
    await local.flush();
    expect(r.published).toHaveLength(0);
    expect(local.snapshot().status).toBe("local");
    expect(Object.keys(disk.backup().follows?.state.edits ?? {})).toContain(K);
  } finally {
    vi.useRealTimers();
  }
});

it("startup gate: a tap after complete recovery works, and a new writer starts closed", async () => {
  const r = relay();
  const disk = memoryStorage();
  const sync = setup(r, { now: 1000 }, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  expect(sync.read().get(K)).toBe(true);
  sync.dispose();
  // Recreated on the same journal while offline: cached choices show, and
  // taps wait for this writer's own complete recovery.
  const offline = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      reader: {
        read: async () => {
          throw new Error("Relay is disconnected");
        },
        readStateSnapshot: async () => {
          throw new Error("Relay is disconnected");
        },
      } as unknown as RelayReader,
    },
  );
  await offline.refresh();
  expect(offline.read().get(K)).toBe(true);
  await expect(offline.set(K, false)).rejects.toThrow("not ready");
  expect(offline.read().get(K)).toBe(true);
  offline.dispose();
  const again = setup(r, { now: 1000 }, { storage: disk.storage });
  await again.refresh();
  await again.set(K, false);
  expect(again.read().get(K)).toBe(false);
});

it("startup gate: a reconnect's complete snapshot opens the gate without a follow retry", async () => {
  const r = relay();
  let repair!: (events: readonly RelayEvent[], complete: boolean) => void;
  const sync = setup(
    r,
    { now: 1000 },
    {
      reader: {
        read: async () => {
          throw new Error("Relay is disconnected");
        },
        readStateSnapshot: async () => {
          throw new Error("Relay is disconnected");
        },
      } as unknown as RelayReader,
      capacity: {
        admit() {},
        observeSize() {},
        async refresh() {},
        subscribeOwn(listener) {
          repair = listener;
          return () => {};
        },
      },
    },
  );
  await sync.refresh();
  await expect(sync.set(K, true)).rejects.toThrow("not ready");
  repair([], true);
  await vi.waitFor(() => expect(sync.set(K, true)).resolves.toBeUndefined());
  expect(sync.read().get(K)).toBe(true);
});

const offlineReader = () =>
  ({
    read: async () => {
      throw new Error("Relay is disconnected");
    },
    readStateSnapshot: async () => {
      throw new Error("Relay is disconnected");
    },
  }) as unknown as RelayReader;
/** Read state's own-author reads, driven by the test. */
function ownReads(
  capacity: { observeSize?: (event: RelayEvent) => void } = {},
) {
  let repair!: (events: readonly RelayEvent[], complete: boolean) => void;
  return {
    repair: (events: readonly RelayEvent[]) => repair(events, true),
    capacity: {
      admit() {},
      observeSize: capacity.observeSize ?? (() => {}),
      async refresh() {},
      subscribeOwn(
        listener: (events: readonly RelayEvent[], complete: boolean) => void,
      ) {
        repair = listener;
        return () => {};
      },
    },
  };
}

it("every own event in the follow snapshot is sized, even with no follow heads", async () => {
  const r = relay();
  const unrelated = finalizeEvent(
    {
      kind: 30078,
      created_at: 900,
      tags: [["d", "read-state:x"]],
      content: "",
    },
    secret,
  ) as RelayEvent;
  r.others.push(unrelated);
  const sized: string[] = [];
  const own = ownReads({ observeSize: (event) => sized.push(event.id) });
  const sync = setup(r, { now: 1000 }, { capacity: own.capacity });
  await sync.refresh();
  expect(sized).toContain(unrelated.id);
});

it("a reconnect's complete snapshot imports legacy choices", async () => {
  const r = relay();
  const disk = memoryStorage();
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const own = ownReads();
  const sync = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      legacy,
      reader: offlineReader(),
      capacity: own.capacity,
    },
  );
  await sync.refresh();
  expect(disk.backup().follows?.imported).toBeUndefined();
  own.repair([]);
  await vi.waitFor(() =>
    expect(disk.backup().follows?.state.edits[K]).toMatchObject({
      origin: "legacy-import",
    }),
  );
  expect(disk.backup().follows?.imported).toBe(true);
  sync.dispose();
});

it("a reconnect's complete snapshot retries a retained packet with no dirty slot", async () => {
  const r = relay();
  const disk = memoryStorage();
  const own = ownReads();
  let fail = true;
  const follows = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      capacity: own.capacity,
      publish: async (event) => {
        if (fail) throw new Error("Relay delivery could not be confirmed");
        r.put(event);
      },
    },
  );
  await follows.refresh();
  await follows.set(K, true);
  await follows.flush();
  expect(Object.keys(disk.backup().follows?.state.packets ?? {})).toHaveLength(
    1,
  );
  fail = false;
  own.repair([]);
  await vi.waitFor(() => expect(r.heads.size).toBe(1));
  follows.dispose();
});

it("hydrated choices show before a slow startup snapshot, with taps still closed", async () => {
  const r = relay();
  const disk = memoryStorage();
  const online = setup(r, { now: 1000 }, { storage: disk.storage });
  await online.refresh();
  await online.set(K, true);
  online.dispose();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = setup(
    r,
    { now: 1000 },
    { storage: disk.storage, beforeRead: () => held },
  );
  expect(slow.read().get(K)).toBeUndefined();
  const notified = vi.fn();
  const stop = slow.subscribe(notified);
  const refreshing = slow.refresh();
  await vi.waitFor(() => expect(slow.read().get(K)).toBe(true));
  expect(notified).toHaveBeenCalled();
  await expect(slow.set(K, false)).rejects.toThrow("not ready");
  release();
  await refreshing;
  stop();
  slow.dispose();
});

it("a follow commit reloads the other window's owner, without an echo", async () => {
  const r = relay();
  const disk = memoryStorage();
  const broadcastName = `follows:${crypto.randomUUID()}`;
  const options = { storage: disk.storage, snapshot: false, broadcastName };
  const a = setup(r, { now: 1000 }, options);
  const b = setup(r, { now: 1000 }, options);
  await a.refresh();
  await b.refresh();
  expect(b.read().get(K)).toBeUndefined();
  const heard = vi.fn();
  const spy = new BroadcastChannel(broadcastName);
  const barrier = new BroadcastChannel(broadcastName);
  let drained!: () => void;
  const done = new Promise<void>((resolve) => {
    drained = resolve;
  });
  spy.onmessage = (event: MessageEvent) => {
    if (event.data === "barrier") drained();
    else heard(event);
  };
  await a.set(K, false);
  await vi.waitFor(() => expect(b.read().get(K)).toBe(false));
  // Anything b posted while reloading is delivered before this marker.
  barrier.postMessage("barrier");
  await done;
  expect(heard).toHaveBeenCalledOnce();
  barrier.close();
  spy.close();
  a.dispose();
  b.dispose();
});
