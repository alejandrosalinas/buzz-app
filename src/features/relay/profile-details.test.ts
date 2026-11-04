import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto, type RelayEvent } from "./events";
import { selectProfiles } from "./profile-selection";
import { foldProfiles } from "./profiles";
import { createProfileDirectory } from "./profile-directory";
import {
  createRelayReader,
  type RelayReader,
  type ReadOptions,
} from "./reader";
import {
  keypair,
  profile,
  scriptedTransport,
  signed,
  unsignedProfiles,
} from "./testing";
const user = keypair();
it("projects about safely and publishes an about-only replacement/removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic", about: "First" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    expect(before?.about).toBe("First");
    directory.accept([profile(user, { name: "Mic", about: "Second" }, 2)]);
    expect(directory.queries.snapshot().get(user.pubkey)?.about).toBe("Second");
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.about,
    ).toBeUndefined();
    expect(
      foldProfiles([
        profile(user, { name: "Mic", about: { unsafe: true } }),
      ]).get(user.pubkey),
    ).toEqual({ name: "Mic" });
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("publishes an agent-marker-only profile change and its removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    directory.accept([
      signed(user, {
        kind: 0,
        content: JSON.stringify({ name: "Mic" }),
        created_at: 2,
        tags: [["auth", "a".repeat(64), "", "b".repeat(128)]],
      }),
    ]);
    expect(directory.queries.snapshot().get(user.pubkey)?.isAgent).toBe(true);
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.isAgent,
    ).toBeUndefined();
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("retains self-authored agent metadata without inferring it from display names", () => {
  const author = keypair();
  const profiles = foldProfiles([
    signed(author, {
      kind: 0,
      content: JSON.stringify({ name: "Agent-looking human", is_agent: true }),
      tags: [],
    }),
  ]);
  expect(profiles.get(author.pubkey)?.isAgent).toBe(true);
});

it.each([
  { field: "is_agent", removal: { is_agent: false } },
  { field: "isAgent", removal: {} },
])(
  "notifies the directory and selected profile on $field-only addition/removal",
  ({ field, removal }) => {
    const wire = scriptedTransport(user.pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const selection = selectProfiles(directory.queries, [user.pubkey]);
    const directoryChanged = vi.fn();
    const selectedChanged = vi.fn();
    const unsubscribeDirectory = directory.queries.subscribe(directoryChanged);
    const unsubscribeSelection = selection.subscribe(selectedChanged);
    try {
      directory.accept([profile(user, { name: "Mic" }, 1)]);
      const before = selection.snapshot();
      directoryChanged.mockClear();
      selectedChanged.mockClear();

      directory.accept([profile(user, { name: "Mic", [field]: true }, 2)]);
      const added = selection.snapshot();
      expect(added).not.toBe(before);
      expect(added.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(added.get(user.pubkey)).toEqual({ name: "Mic", isAgent: true });
      expect(directoryChanged).toHaveBeenCalledTimes(1);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      // A newer event with identical display values must still preserve identity.
      // The directory still notifies: its winning signed event changed.
      directory.accept([profile(user, { name: "Mic", [field]: true }, 3)]);
      expect(selection.snapshot()).toBe(added);
      expect(directoryChanged).toHaveBeenCalledTimes(2);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      directory.accept([profile(user, { name: "Mic", ...removal }, 4)]);
      const removed = selection.snapshot();
      expect(removed).not.toBe(added);
      expect(removed.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(removed.get(user.pubkey)).toEqual({ name: "Mic" });
      expect(directoryChanged).toHaveBeenCalledTimes(3);
      expect(selectedChanged).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeSelection();
      unsubscribeDirectory();
      directory.dispose();
      reader.dispose();
    }
  },
);

it("publishes owner-only changes and removal without treating profile claims as authority", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const changed = vi.fn();
  directory.queries.subscribe(changed);
  try {
    for (const [index, owner] of [
      "a".repeat(64),
      "b".repeat(64),
      undefined,
    ].entries()) {
      directory.accept([
        signed(user, {
          kind: 0,
          content: JSON.stringify({ name: "Honey", is_agent: true }),
          created_at: index + 1,
          tags: owner ? [["auth", owner, "", "c".repeat(128)]] : [],
        }),
      ]);
      expect(directory.queries.snapshot().get(user.pubkey)?.ownerPubkey).toBe(
        owner,
      );
      expect(changed).toHaveBeenCalledTimes(index + 1);
    }
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("notifies once for a batch of verified owner attestations", async () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const owner = keypair();
  const agents = [keypair(), keypair(), keypair()];
  const changed = vi.fn();
  directory.queries.subscribe(changed);
  try {
    directory.accept(
      agents.map((agent) => {
        const digest = createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest();
        const sig = schnorr.sign(new Uint8Array(digest), owner.secret);
        return eventDto(
          signed(agent, {
            kind: 0,
            content: JSON.stringify({ name: "Agent", is_agent: true }),
            tags: [["auth", owner.pubkey, "", bytesToHex(sig)]],
          }),
        );
      }),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        agents.map((agent) => directory.queries.owner?.(agent.pubkey)),
      ).toEqual(agents.map(() => owner.pubkey)),
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("reacts to NIP-05-only replacements and removal without asserting verification", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const selection = selectProfiles(directory.queries, [user.pubkey]);
  const changed = vi.fn();
  const unsubscribe = selection.subscribe(changed);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = selection.snapshot();
    changed.mockClear();
    directory.accept([
      profile(user, { name: "Mic", nip05: "  mic@example.org  " }, 2),
    ]);
    expect(selection.snapshot()).not.toBe(before);
    expect(selection.snapshot().get(user.pubkey)?.nip05).toBe(
      "mic@example.org",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: "mic@example.org" }, 3),
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: { unsafe: true } }, 4),
    ]);
    expect(selection.snapshot().get(user.pubkey)).toEqual({ name: "Mic" });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    directory.dispose();
    reader.dispose();
  }
});

it("retains safe inline profile pictures through parsing and media routing", async () => {
  const { mediaUrl } = await import("./transport");
  for (const picture of [
    "data:image/png;base64,AAAA",
    "https://source.example/picture.png",
    "data:image/svg+xml;base64,AAAA",
    "javascript:alert(1)",
    "https://user:password@source.example/picture.png",
    `data:image/png;base64,${"A".repeat(512 * 1024)}`,
  ]) {
    const safe =
      picture === "data:image/png;base64,AAAA" ||
      picture === "https://source.example/picture.png";
    const parsed = foldProfiles([profile(user, { name: "Mic", picture })]).get(
      user.pubkey,
    );
    expect(parsed?.picture).toBe(safe ? picture : undefined);
    if (parsed?.picture)
      expect(mediaUrl(parsed.picture, undefined, undefined)).toBe(picture);
  }
});

it("reuses one event's projection across folds", () => {
  const head = profile(user, { name: "Mic" }, 1);
  const parsed = foldProfiles([head]).get(user.pubkey);
  expect(foldProfiles([head]).get(user.pubkey)).toBe(parsed);
  const next = foldProfiles([head, profile(user, { name: "Mike" }, 2)]);
  expect(next.get(user.pubkey)?.name).toBe("Mike");
});

it("refreshes retained profiles in the background without rolling back signed heads", async () => {
  const old = profile(user, { name: "GLM" }, 1);
  const renamed = profile(user, { name: "Luna" }, 2);
  const read = vi.fn(async () => [renamed]);
  const directory = createProfileDirectory({ read });
  try {
    directory.accept([old]);
    await directory.reconnect();
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [0], authors: [user.pubkey], limit: 500 }],
      expect.objectContaining({ priority: "background" }),
    );
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Luna");
    read.mockResolvedValueOnce([old]);
    await directory.reconnect();
    expect(directory.event(user.pubkey)).toBe(renamed);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Luna");
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(directory.reconnect()).rejects.toThrow("offline");
    expect(directory.event(user.pubkey)).toBe(renamed);
    await directory.reconnect();
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    directory.dispose();
  }
});

it("retires pending profile reads before reconnect and fences cache clear/disposal", async () => {
  const old = profile(user, { name: "GLM" }, 1);
  const renamed = profile(user, { name: "Luna" }, 2);
  let resolve!: (events: (typeof old)[]) => void;
  const read = vi.fn(
    (_filters: Parameters<RelayReader["read"]>[0], _options?: ReadOptions) =>
      new Promise<(typeof old)[]>((done) => {
        resolve = done;
      }),
  );
  const directory = createProfileDirectory({ read });
  const pending = directory.ensure([user.pubkey]);
  const finishOld = resolve;
  try {
    directory.accept([old]);
    const refreshed = directory.reconnect();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve([renamed]);
    await refreshed;
    finishOld([old]);
    await pending;
    expect(directory.event(user.pubkey)).toBe(renamed);

    const cleared = directory.reconnect();
    directory.clear();
    resolve([renamed]);
    await cleared;
    expect(directory.queries.snapshot().size).toBe(0);

    directory.accept([old]);
    const disposed = directory.reconnect();
    directory.dispose();
    resolve([renamed]);
    await disposed;
    expect(directory.queries.snapshot().size).toBe(0);
  } finally {
    directory.dispose();
  }
});

it("promotes a queued background profile read when foreground demand joins it", async () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    // Unrelated background work holds the reader's only background slot.
    const held = reader.reader.read([{ kinds: [3], limit: 1 }], {
      priority: "background",
    });
    const enrichment = directory.ensure([user.pubkey], "background");
    expect(wire.pending).toHaveLength(1);
    const demanded = directory.ensure([user.pubkey], "foreground");
    expect(wire.pending).toHaveLength(2);
    wire.pending[1]?.respond([profile(user, { name: "Mic" })]);
    await Promise.all([enrichment, demanded]);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Mic");
    wire.next().respond([]);
    await held;
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("records identities a completed read found no profile for, until one arrives", async () => {
  const other = keypair();
  const third = keypair();
  const read = vi.fn(async () => [profile(user, { name: "Mic" })]);
  const directory = createProfileDirectory({ read });
  const listener = vi.fn();
  directory.queries.subscribe(listener);
  try {
    await directory.ensure([user.pubkey, other.pubkey]);
    const absent = directory.queries.unnamed?.();
    expect(absent).toEqual(new Set([other.pubkey]));
    // Once for the profile, once for the absence.
    expect(listener).toHaveBeenCalledTimes(2);
    // A failed read is not evidence.
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(directory.ensure([third.pubkey])).rejects.toThrow("offline");
    expect(directory.queries.unnamed?.()).toBe(absent);
    // A profile that arrives later outranks the absence.
    directory.accept([profile(other, { name: "Nu" })]);
    expect(directory.queries.snapshot().get(other.pubkey)?.name).toBe("Nu");
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    // Clearing forgets the evidence and tells subscribers so.
    await directory.ensure([third.pubkey]);
    expect(directory.queries.unnamed?.()).toEqual(new Set([third.pubkey]));
    listener.mockClear();
    directory.clear();
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    expect(listener).toHaveBeenCalled();
  } finally {
    directory.dispose();
  }
});

it("background enrichment does not reread a known absence until reconnect", async () => {
  const other = keypair();
  const read = vi.fn(async () => [profile(user, { name: "Mic" })]);
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure([user.pubkey, other.pubkey], "background");
    expect(directory.queries.unnamed?.()).toEqual(new Set([other.pubkey]));
    await directory.ensure([user.pubkey, other.pubkey], "background");
    expect(read).toHaveBeenCalledTimes(1);
    // A demanded read still asks again.
    await directory.ensure([other.pubkey], "foreground");
    expect(read).toHaveBeenCalledTimes(2);
    // A kind 0 that arrives later ends the absence, so eviction rereads it.
    directory.accept([profile(other, { name: "Nu" })]);
    const filler = profile(user, { name: "Filler" });
    directory.accept(
      Array.from({ length: 1024 }, (_, i) => ({
        ...filler,
        pubkey: i.toString(16).padStart(64, "0"),
      })),
    );
    expect(directory.queries.snapshot().has(other.pubkey)).toBe(false);
    await directory.ensure([other.pubkey], "background");
    expect(read).toHaveBeenCalledTimes(3);
    // The live route may have missed a kind 0 while offline.
    await directory.reconnect();
    read.mockClear();
    await directory.ensure([other.pubkey], "background");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    directory.dispose();
  }
});

it("records no absence for a returned profile the cache evicted", async () => {
  // A short response can still outgrow the directory's byte budget.
  const big = profile(user, { name: "Big", about: "x".repeat(5 * 1024) });
  const ids = Array.from({ length: 450 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const first = "0".repeat(64);
  const read = vi.fn(async () => ids.map((pubkey) => ({ ...big, pubkey })));
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure(ids, "background");
    expect(directory.queries.snapshot().has(first)).toBe(false);
    // Returned, so not known unnamed either.
    expect(directory.queries.unnamed?.().has(first)).toBe(false);
    await directory.ensure([first], "background");
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    directory.dispose();
  }
});

it("a background skip never leaves an identity neither named nor unnamed", async () => {
  const ids = Array.from({ length: 1024 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const first = "0".repeat(64);
  const later = "f".repeat(64);
  const read = vi.fn(async () => []);
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure(ids, "background");
    // Unnamed survives the reconnect; the absence does not.
    await directory.reconnect();
    await directory.ensure([first], "background");
    // A new absence trims the oldest unnamed identity.
    await directory.ensure([later], "background");
    expect(directory.queries.unnamed?.().has(first)).toBe(false);
    read.mockClear();
    await directory.ensure([first], "background");
    expect(read).toHaveBeenCalledTimes(1);
    expect(directory.queries.unnamed?.().has(first)).toBe(true);
  } finally {
    directory.dispose();
  }
});

it("records no absence from a read that filled its page", async () => {
  const other = keypair();
  // A relay that keeps every kind 0 can fill the page from one author. The
  // directory does not verify events, so older versions are cheap copies.
  const head = profile(user, { name: "Mic" }, 1_700_000_500);
  const versions = Array.from({ length: 500 }, (_, i) => ({
    ...head,
    id: i.toString(16).padStart(64, "0"),
    created_at: head.created_at - i,
  }));
  const read = vi.fn(async () => versions);
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure([user.pubkey, other.pubkey]);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Mic");
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    // One short of the limit is complete.
    read.mockResolvedValueOnce(versions.slice(1));
    await directory.ensure([other.pubkey]);
    expect(directory.queries.unnamed?.()).toEqual(new Set([other.pubkey]));
  } finally {
    directory.dispose();
  }
});

it("moves the purge generation and notifies on every clear, even with nothing loaded", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const changed = vi.fn();
  const unsubscribe = directory.queries.subscribe(changed);
  try {
    expect(directory.queries.generation?.()).toBe(0);
    directory.clear();
    expect(directory.queries.generation?.()).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    changed.mockClear();
    directory.clear();
    expect(directory.queries.snapshot().size).toBe(0);
    expect(directory.queries.generation?.()).toBe(2);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    directory.dispose();
    reader.dispose();
  }
});

it("evicts the least recently ensured profile, not the oldest stored one", async () => {
  const read = vi.fn(async () => []);
  const directory = createProfileDirectory({ read });
  try {
    const people = unsignedProfiles(1024);
    directory.accept(people);
    expect(directory.queries.snapshot().size).toBe(1024);
    const [oldest, next] = people as [RelayEvent, RelayEvent];
    await directory.ensure([oldest.pubkey]);
    expect(read).not.toHaveBeenCalled();
    directory.accept([profile(keypair(), { name: "Newcomer" })]);
    const snapshot = directory.queries.snapshot();
    expect(snapshot.size).toBe(1024);
    expect(snapshot.get(oldest.pubkey)?.name).toBe("P0");
    expect(snapshot.has(next.pubkey)).toBe(false);
  } finally {
    directory.dispose();
  }
});

it("holds an open channel's roster on top of the base and shrinks back when released", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => []);
  const directory = createProfileDirectory({ read });
  const changed = vi.fn();
  const unsubscribe = directory.queries.subscribe(changed);
  try {
    const people = unsignedProfiles(1524);
    const ids = people.map((event) => event.pubkey);
    let release = directory.queries.reserve?.(500);
    expect(directory.queries.limit?.()).toBe(1524);
    // A whole roster fits in one request while the room is reserved.
    await directory.ensure(ids.slice(0, 1100));
    expect(read).toHaveBeenCalled();
    directory.accept(people);
    expect(directory.queries.snapshot().size).toBe(1524);
    expect(directory.queries.evictions?.()).toBe(0);
    // A larger reservation wins at once; giving it back keeps the smaller one.
    const larger = directory.queries.reserve?.(20_000);
    expect(directory.queries.limit?.()).toBe(10_240);
    larger?.();
    await vi.runAllTimersAsync();
    expect(directory.queries.limit?.()).toBe(1524);
    // A view that releases and reserves again in one commit, as an effect
    // does when the member count changes, keeps the roster it loaded.
    release?.();
    release = directory.queries.reserve?.(500);
    await vi.runAllTimersAsync();
    expect(directory.queries.limit?.()).toBe(1524);
    expect(directory.queries.snapshot().size).toBe(1524);
    await directory.ensure([ids[0] as string]);
    changed.mockClear();
    release?.();
    release?.();
    // The shrink waits for the end of the task.
    expect(directory.queries.limit?.()).toBe(1524);
    await vi.runAllTimersAsync();
    expect(directory.queries.limit?.()).toBe(1024);
    const snapshot = directory.queries.snapshot();
    expect(snapshot.size).toBe(1024);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(directory.queries.evictions?.()).toBe(500);
    // The least recently used go first: P0 was just ensured, P1..P500 were not.
    expect(snapshot.get(ids[0] as string)?.name).toBe("P0");
    expect(snapshot.has(ids[1] as string)).toBe(false);
    expect(snapshot.has(ids[500] as string)).toBe(false);
    expect(snapshot.get(ids[501] as string)?.name).toBe("P501");
    await expect(directory.ensure(ids.slice(0, 1100))).rejects.toThrow(
      "exceeds the directory budget",
    );
  } finally {
    unsubscribe();
    directory.dispose();
    vi.useRealTimers();
  }
});

it("cancels background reads still in flight when it shrinks, but not foreground ones", async () => {
  vi.useFakeTimers();
  const answers: {
    authors: readonly string[];
    resolve: (events: RelayEvent[]) => void;
  }[] = [];
  const read = vi.fn(
    (
      filters: readonly { authors?: readonly string[] | undefined }[],
      options?: { signal?: AbortSignal },
    ) =>
      new Promise<RelayEvent[]>((resolve, reject) => {
        answers.push({ authors: filters[0]?.authors ?? [], resolve });
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const directory = createProfileDirectory({ read });
  try {
    const roster = unsignedProfiles(600, "R");
    const onScreen = unsignedProfiles(1, "S");
    const release = directory.queries.reserve?.(600);
    const menu = directory.ensure(
      roster.map((event) => event.pubkey),
      "background",
    );
    const row = directory.ensure([onScreen[0]?.pubkey as string]);
    expect(answers).toHaveLength(3);
    const before = directory.queries.evictions?.() ?? 0;
    release?.();
    await vi.runAllTimersAsync();
    // The menu's two pages were cancelled quietly; its requester asks again.
    await expect(menu).resolves.toBeUndefined();
    expect(directory.queries.evictions?.()).toBe(before + 2);
    for (const answer of answers.slice(0, 2))
      answer.resolve(
        roster.filter((event) => answer.authors.includes(event.pubkey)),
      );
    answers[2]?.resolve(onScreen);
    await row;
    await vi.runAllTimersAsync();
    expect(
      directory.queries.snapshot().has(onScreen[0]?.pubkey as string),
    ).toBe(true);
    expect(directory.queries.snapshot().has(roster[0]?.pubkey as string)).toBe(
      false,
    );
  } finally {
    directory.dispose();
    vi.useRealTimers();
  }
});

it("keeps background reads asked for after a release when the shrink runs", async () => {
  vi.useFakeTimers();
  const answers: {
    authors: readonly string[];
    resolve: (events: RelayEvent[]) => void;
  }[] = [];
  const read = vi.fn(
    (
      filters: readonly { authors?: readonly string[] | undefined }[],
      options?: { signal?: AbortSignal },
    ) =>
      new Promise<RelayEvent[]>((resolve, reject) => {
        answers.push({ authors: filters[0]?.authors ?? [], resolve });
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const directory = createProfileDirectory({ read });
  try {
    const profiles = unsignedProfiles(4, "N");
    const [stale, joined, other, fresh] = profiles as [
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
    ];
    const release = directory.queries.reserve?.(1);
    // The departing view's reads, both asked for before its release.
    const departing = Promise.all([
      directory.ensure([stale.pubkey], "background"),
      directory.ensure([joined.pubkey, other.pubkey], "background"),
    ]);
    const before = directory.queries.evictions?.() ?? 0;
    release?.();
    // The next view mounts before the shrink runs: one new author, and one
    // on the departing view's pending page.
    const next = directory.ensure([fresh.pubkey, joined.pubkey], "background");
    expect(answers.map((answer) => answer.authors)).toEqual([
      [stale.pubkey],
      [joined.pubkey, other.pubkey],
      [fresh.pubkey, joined.pubkey],
    ]);
    await vi.runAllTimersAsync();
    expect(directory.queries.limit?.()).toBe(1024);
    // Both departing reads were cancelled.
    expect(directory.queries.evictions?.()).toBe(before + 2);
    for (const answer of answers) answer.resolve(profiles);
    await Promise.all([departing, next]);
    const snapshot = directory.queries.snapshot();
    expect(snapshot.has(fresh.pubkey)).toBe(true);
    expect(snapshot.has(joined.pubkey)).toBe(true);
    expect(snapshot.has(stale.pubkey)).toBe(false);
    expect(snapshot.has(other.pubkey)).toBe(false);
  } finally {
    directory.dispose();
    vi.useRealTimers();
  }
});

it("returns known-unnamed identities past the base when it shrinks", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => []);
  const directory = createProfileDirectory({ read });
  try {
    const ids = unsignedProfiles(1500).map((event) => event.pubkey);
    const release = directory.queries.reserve?.(500);
    await directory.ensure(ids);
    expect(directory.queries.unnamed?.().size).toBe(1500);
    const changed = vi.fn();
    const unsubscribe = directory.queries.subscribe(changed);
    release?.();
    await vi.runAllTimersAsync();
    unsubscribe();
    expect(directory.queries.unnamed?.().size).toBe(1024);
    expect(directory.queries.unnamed?.().has(ids[1499] as string)).toBe(true);
    expect(directory.queries.unnamed?.().has(ids[0] as string)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    directory.dispose();
    vi.useRealTimers();
  }
});

it("publishes a background read's pages once, also when the session accepts each page first", async () => {
  vi.useFakeTimers();
  const answers: {
    authors: readonly string[];
    signal: AbortSignal | undefined;
    resolve: (events: RelayEvent[]) => void;
  }[] = [];
  const read = vi.fn(
    (
      filters: readonly { authors?: readonly string[] | undefined }[],
      options?: { signal?: AbortSignal },
    ) =>
      new Promise<RelayEvent[]>((resolve) => {
        answers.push({
          authors: filters[0]?.authors ?? [],
          signal: options?.signal,
          resolve,
        });
      }),
  );
  const directory = createProfileDirectory({ read });
  try {
    const roster = unsignedProfiles(1500, "R");
    const row = unsignedProfiles(1, "S");
    const release = directory.queries.reserve?.(1500);
    const changed = vi.fn();
    const unsubscribe = directory.queries.subscribe(changed);
    const menu = directory.ensure(
      roster.map((event) => event.pubkey),
      "background",
    );
    const shown = directory.ensure([row[0]?.pubkey as string]);
    expect(answers).toHaveLength(4);
    // The session accepts every read's events, with the read's signal, before
    // the read returns them.
    const answer = (index: number, events: RelayEvent[]) => {
      const page = events.filter((event) =>
        answers[index]?.authors.includes(event.pubkey),
      );
      directory.accept(page, answers[index]?.signal);
      answers[index]?.resolve(page);
    };
    answer(0, roster);
    await vi.runAllTimersAsync();
    expect(changed).not.toHaveBeenCalled();
    expect(directory.queries.snapshot().has(roster[0]?.pubkey as string)).toBe(
      false,
    );
    // An accepted page counts as loaded before its publish: asking again
    // for it reads nothing, and that caller gets its names when it resolves.
    await directory.ensure(
      roster.slice(0, 500).map((event) => event.pubkey),
      "background",
    );
    await vi.runAllTimersAsync();
    expect(answers).toHaveLength(4);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(directory.queries.snapshot().has(roster[0]?.pubkey as string)).toBe(
      true,
    );
    changed.mockClear();
    // A foreground read still publishes its page at once.
    answer(3, row);
    await shown;
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(directory.queries.snapshot().has(row[0]?.pubkey as string)).toBe(
      true,
    );
    changed.mockClear();
    answer(1, roster);
    await vi.runAllTimersAsync();
    expect(changed).not.toHaveBeenCalled();
    // Live traffic for a member still being read publishes at once.
    const live = roster[1400] as RelayEvent;
    directory.accept([
      { ...live, id: "f".repeat(64), created_at: live.created_at + 1 },
    ]);
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    answer(2, roster);
    await menu;
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(directory.queries.snapshot().size).toBe(1501);
    unsubscribe();
    release?.();
  } finally {
    directory.dispose();
    vi.useRealTimers();
  }
});
