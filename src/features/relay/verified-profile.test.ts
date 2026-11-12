import { assert, expect, it, vi } from "vitest";
import { eventDto } from "./events";
import { keypair, signed } from "./testing";
import { createVerifiedProfileDirectory } from "./verified-profile-directory";
import {
  VERIFIED_PROFILE_BATCH,
  verifiedProfile,
  verifiedProfileAuthority,
  verifiedProfileDiscovery,
  type VerifiedProfileAuthority,
  type VerifiedProfileSink,
} from "./verified-profile";

const tick = () => new Promise((resolve) => setTimeout(resolve));
const relay = keypair();
const alice = keypair();
const bob = keypair();
const authority = { pubkey: relay.pubkey, multipleIssuers: true };
function projection(
  at = 10,
  subject = alice.pubkey,
  extra: string[][] = [],
  name = "Alice",
) {
  return eventDto(
    signed(relay, {
      kind: 30382,
      content: "",
      created_at: at,
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "true"],
        ["display_name", name],
        ["username", "alice"],
        ["issuer_label", "Example"],
        ["verified_at", String(at)],
        ...extra,
      ],
    }),
  );
}
function retract(at: number, subject = alice.pubkey) {
  return eventDto(
    signed(relay, {
      kind: 30382,
      content: "",
      created_at: at,
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "false"],
      ],
    }),
  );
}

it("requires explicit discovery and a cryptographically verified relay event", () => {
  const event = projection();
  expect(verifiedProfile(event, authority, true)?.status).toBe("checked");
  expect(verifiedProfile(event, authority, false)?.status).toBe("cached");
  expect(verifiedProfile({ ...event }, authority, true)).toBeUndefined();
  expect(
    verifiedProfile(event, { ...authority, pubkey: bob.pubkey }, true),
  ).toBeUndefined();
  expect(
    verifiedProfileAuthority({
      pubkey: relay.pubkey,
      federated_identity: {
        public_profile: { kind: 30382, multiple_issuers: false },
      },
    }),
  ).toBeUndefined();
  expect(
    verifiedProfileAuthority({
      self: relay.pubkey,
      federated_identity: {
        public_profile: { kind: 30382, multiple_issuers: false },
      },
    }),
  ).toEqual({ pubkey: relay.pubkey, multipleIssuers: false });
  expect(
    verifiedProfileAuthority({
      self: relay.pubkey,
      federated_identity: {
        public_profile: {
          kind: 30382,
          multiple_issuers: false,
          searchable: true,
        },
      },
    }),
  ).toEqual({ pubkey: relay.pubkey, multipleIssuers: false, searchable: true });
  expect(
    verifiedProfile(
      signed(alice, {
        kind: 0,
        content: JSON.stringify({
          display_name: "Alice ✓",
          nip05: "alice@example.com",
        }),
        tags: [],
      }),
      authority,
      true,
    ),
  ).toBeUndefined();
});

it.each([
  [["display_name", "Other"]],
  [["expiration", "999"]],
  [["email", "private"]],
  [["p", bob.pubkey]],
  [["d", alice.pubkey]],
])("rejects duplicate/extra tags %j", (extra) => {
  expect(
    verifiedProfile(projection(10, alice.pubkey, [extra]), authority, true),
  ).toBeUndefined();
});

it.each([
  " Alice",
  "Alice\u00a0",
  "E\u0301",
  "A\u200d",
  "A\ue000",
  "A\u0378",
  "A\u2028",
])("rejects malformed name %j", (name) => {
  const event = projection();
  const modified = eventDto(
    signed(relay, {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === "display_name" ? ["display_name", name] : tag,
      ),
    }),
  );
  expect(verifiedProfile(modified, authority, true)).toBeUndefined();
});

it("accepts a Relay-signed optional full name and validates it with the same name rules", () => {
  expect(
    verifiedProfile(
      projection(10, alice.pubkey, [["full_name", "Alice Example"]]),
      authority,
      true,
    )?.fullName,
  ).toBe("Alice Example");
  expect(
    verifiedProfile(projection(), authority, true)?.fullName,
  ).toBeUndefined();
  for (const name of ["", " Alice", "A\nB", "A\u200dB", "a".repeat(65)]) {
    expect(
      verifiedProfile(
        projection(10, alice.pubkey, [["full_name", name]]),
        authority,
        true,
      ),
    ).toBeUndefined();
  }
  expect(
    verifiedProfile(
      projection(10, alice.pubkey, [
        ["full_name", "Alice"],
        ["full_name", "Other"],
      ]),
      authority,
      true,
    ),
  ).toBeUndefined();
});

function harness(
  refresh?: (signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>,
  initial: VerifiedProfileAuthority | undefined = authority,
) {
  const subscriptions: {
    subjects: readonly string[];
    since: number | undefined;
    sink: VerifiedProfileSink;
    stopped: boolean;
  }[] = [];
  const changed = vi.fn();
  const directory = createVerifiedProfileDirectory(
    initial,
    (filter, sink) => {
      expect(filter.limit).toBe(filter["#d"].length);
      expect(filter).not.toHaveProperty("#p"); // malformed p must still invalidate the address
      const item = {
        subjects: filter["#d"],
        since: filter.since,
        sink,
        stopped: false,
      };
      subscriptions.push(item);
      return () => {
        item.stopped = true;
      };
    },
    changed,
    refresh,
  );
  return { directory, subscriptions, changed };
}

it("batches and deduplicates subjects, retains retractions, and fences retired callbacks", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    expect(h.subscriptions).toHaveLength(1);
    const first = h.subscriptions[0];
    assert(first);
    expect(first.subjects).toHaveLength(2);
    first.sink.event(projection());
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    first.sink.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    h.directory.connected(false);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    h.directory.connected(true);
    await Promise.resolve();
    const second = h.subscriptions[1];
    assert(second);
    second.sink.event(retract(20));
    second.sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
    first.sink.event(projection(30));
    second.sink.event(projection(10));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
    second.sink.event(projection(21));
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(21);
  } finally {
    h.directory.dispose();
  }
});

it("notifies once per replay, then once per live change", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    h.changed.mockClear();
    sink.event(projection(10));
    sink.event(projection(10, bob.pubkey));
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.directory.snapshot().size).toBe(2);
    sink.eose();
    expect(h.changed).toHaveBeenCalledTimes(1);
    sink.event(projection(10)); // Unchanged head.
    expect(h.changed).toHaveBeenCalledTimes(1);
    sink.event(projection(11));
    expect(h.changed).toHaveBeenCalledTimes(2);
  } finally {
    h.directory.dispose();
  }
});

it("a newer malformed projection invalidates an older valid name", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(true);
    sink.event(projection(11, alice.pubkey, [["expiration", "12"]]));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("an incomplete lookup leaves omitted cached subjects unreconciled", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    h.directory.connected(false);
    h.directory.connected(true);
    await Promise.resolve();
    const next = h.subscriptions[1]?.sink;
    assert(next);
    next.event(projection(10, bob.pubkey));
    next.event(projection(11, bob.pubkey));
    next.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
  } finally {
    h.directory.dispose();
  }
});

it("does not re-send a batch an outage ended", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    // An outage ends the sync, with the socket's resume point, then reports
    // the connection down in the same task.
    first.sink.closed("disconnected: live connection lost", { since: 500 });
    h.directory.connected(false);
    await Promise.resolve();
    expect(h.subscriptions).toHaveLength(1);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    h.directory.connected(true);
    await Promise.resolve();
    const active = h.subscriptions.filter((item) => !item.stopped);
    expect(active).toHaveLength(1);
    // Recovery re-reads every head.
    expect(active[0]?.since).toBeUndefined();
  } finally {
    h.directory.dispose();
  }
});

it.each([
  ["Alice", "Alice"],
  ["Alice", "Alice "],
  ["Alice", "\u00a0Alice\u3000"],
  ["Alice", "Al\u200bice"],
  ["Alice", "Alice \u200b"],
  ["Alice", "\u200b Alice"],
  ["Alice", "Al\u00adice"],
  ["Alice", "Al\u034fice"],
  ["Alice", "Alice\u200d"],
  ["Alice", "Alice\ufe0f"],
  ["Alice", "Alice\u{e0061}"],
  ["Alice", "Alice\u3164"],
  ["Alice\u034f", "Alice"],
  ["Alice \ufe0f", "Alice"],
  ["Alice 😀", "Alice 😀\ufe0f"],
  ["Alice 😀\ufe0f", "Alice 😀"],
])("qualifies %j against %j", async (verifiedName, claimedName) => {
  const { createProfileDirectory } = await import("./profile-directory");
  let sink: VerifiedProfileSink | undefined;
  const directory = createProfileDirectory(
    { read: async () => [] },
    undefined,
    undefined,
    {
      authority: { ...authority, multipleIssuers: false },
      subscribe(_filter, next) {
        sink = next;
        return () => {};
      },
    },
  );
  try {
    directory.accept([
      eventDto(
        signed(alice, {
          kind: 0,
          tags: [],
          content: JSON.stringify({
            name: "Self name",
            about: "About Alice",
            picture: "https://example.test/alice.png",
          }),
        }),
      ),
      eventDto(
        signed(bob, {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: claimedName }),
        }),
      ),
    ]);
    await directory.ensure([alice.pubkey, bob.pubkey]);
    assert(sink);
    sink.event(projection(10, alice.pubkey, [], verifiedName));
    sink.eose();
    await tick(); // Verified changes publish on the next macrotask.
    const profile = directory.queries.snapshot().get(alice.pubkey);
    expect(profile?.name).toBe(verifiedName);
    expect(profile?.about).toBe("About Alice");
    expect(profile?.picture).toBe("https://example.test/alice.png");
    expect(profile?.verified?.status).toBe("checked");
    expect(directory.queries.snapshot().get(bob.pubkey)?.name).toContain(
      bob.pubkey.slice(0, 10),
    );
    expect(directory.queries.snapshot().get(bob.pubkey)?.name).toBe(
      `${claimedName.trim()} (${bob.pubkey.slice(0, 10)})`,
    );
    expect(
      JSON.parse(directory.queries.event?.(bob.pubkey)?.content ?? "{}"),
    ).toEqual({
      name: claimedName,
    });
    sink.event(retract(20));
    await tick(); // Verified changes publish on the next macrotask.
    expect(directory.queries.snapshot().get(alice.pubkey)?.name).toBe(
      "Self name",
    );
    expect(
      directory.queries.snapshot().get(alice.pubkey)?.verified,
    ).toBeUndefined();
    expect(directory.queries.snapshot().get(bob.pubkey)?.name).toBe(
      claimedName.trim(),
    );
  } finally {
    directory.dispose();
  }
});

it("qualifies verified namesakes and shared usernames, but not a unique verified name", async () => {
  const { createProfileDirectory } = await import("./profile-directory");
  const carol = keypair();
  const dave = keypair();
  const verifiedAs = (subject: string, displayName: string, username: string) =>
    eventDto(
      signed(relay, {
        kind: 30382,
        content: "",
        created_at: 10,
        tags: [
          ["d", subject],
          ["p", subject],
          ["active", "true"],
          ["display_name", displayName],
          ["username", username],
          ["issuer_label", "Example"],
          ["verified_at", "10"],
        ],
      }),
    );
  let sink: VerifiedProfileSink | undefined;
  const directory = createProfileDirectory(
    { read: async () => [] },
    undefined,
    undefined,
    {
      authority: { ...authority, multipleIssuers: false },
      subscribe(_filter, next) {
        sink = next;
        return () => {};
      },
    },
  );
  try {
    const people = [alice, bob, carol, dave];
    directory.accept(
      people.map((key) =>
        eventDto(signed(key, { kind: 0, tags: [], content: "{}" })),
      ),
    );
    await directory.ensure(people.map((key) => key.pubkey));
    assert(sink);
    sink.event(verifiedAs(alice.pubkey, "Sam", "sam1"));
    sink.event(verifiedAs(bob.pubkey, "Sam", "sam2"));
    sink.event(verifiedAs(carol.pubkey, "Carol", "shared"));
    sink.event(verifiedAs(dave.pubkey, "Dave", "shared"));
    sink.eose();
    await tick(); // Verified changes publish on the next macrotask.
    const name = (key: { pubkey: string }) =>
      directory.queries.snapshot().get(key.pubkey)?.name;
    expect(name(alice)).toBe(`Sam (${alice.pubkey.slice(0, 10)})`);
    expect(name(bob)).toBe(`Sam (${bob.pubkey.slice(0, 10)})`);
    expect(name(carol)).toBe(`Carol (${carol.pubkey.slice(0, 10)})`);
    expect(name(dave)).toBe(`Dave (${dave.pubkey.slice(0, 10)})`);
    sink.event(retract(20, bob.pubkey));
    sink.event(retract(20, dave.pubkey));
    await tick(); // Verified changes publish on the next macrotask.
    expect(name(alice)).toBe("Sam");
    expect(name(carol)).toBe("Carol");
  } finally {
    directory.dispose();
  }
});

it("coalesces a burst of verified changes into one directory notification", async () => {
  const { createProfileDirectory } = await import("./profile-directory");
  let sink: VerifiedProfileSink | undefined;
  const directory = createProfileDirectory(
    { read: async () => [] },
    undefined,
    undefined,
    {
      authority,
      subscribe(_filter, next) {
        sink = next;
        return () => {};
      },
    },
  );
  try {
    await directory.ensure([alice.pubkey, bob.pubkey]);
    assert(sink);
    const changed = vi.fn();
    directory.queries.subscribe(changed);
    sink.event(projection(10));
    sink.event(projection(10, bob.pubkey));
    sink.eose();
    sink.event(projection(11)); // A live change in the same burst.
    expect(changed).not.toHaveBeenCalled();
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      directory.queries.snapshot().get(alice.pubkey)?.verified,
    ).toMatchObject({
      verifiedAt: 11,
    });
  } finally {
    directory.dispose();
  }
});

it("invalidates a signed newer duplicate-d event at its NIP-01 address", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(true);
    sink.event(projection(11, alice.pubkey, [["d", bob.pubkey]]));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("distinguishes explicit discovery omission from malformed capability", () => {
  expect(verifiedProfileDiscovery({ self: relay.pubkey })).toBeNull();
  expect(verifiedProfileDiscovery({ federated_identity: {} })).toBeNull();
  for (const federated_identity of [
    null,
    [],
    "bad",
    { public_profile: null },
    { public_profile: { kind: 30382 } },
  ]) {
    expect(() =>
      verifiedProfileDiscovery({ self: relay.pubkey, federated_identity }),
    ).toThrow();
  }
});

it("hides cached marks on successful disable, retains history, and reconciles after reenable", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(authority);
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    const withdrawn = h.directory.authority();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.directory.authority()).toBeUndefined();
    expect(h.directory.snapshot().size).toBe(0);
    expect(h.subscriptions[0]?.stopped).toBe(true);
    first.event(projection(30)); // retired subscriptions cannot edit history
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The same key, re-enabled, is a new authority: nothing checked under the
    // withdrawn one counts as checked by it.
    expect(h.directory.authority()).toEqual(withdrawn);
    expect(h.directory.authority()).not.toBe(withdrawn);
    expect(h.directory.snapshot().get(alice.pubkey)).toMatchObject({
      verifiedAt: 10,
      status: "cached",
    });
    const next = h.subscriptions[1]?.sink;
    assert(next);
    next.event(projection());
    next.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
  } finally {
    h.directory.dispose();
    vi.useRealTimers();
  }
});

it("preserves the last successful discovery on failed or malformed refresh, with cache disclosure", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(async () =>
      verifiedProfileDiscovery({ federated_identity: { public_profile: {} } }),
    );
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(h.directory.snapshot().get(alice.pubkey)?.issuerLabel).toBe(
      "Example",
    );
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
  } finally {
    h.directory.dispose();
    vi.useRealTimers();
  }
});

it("fences stale discovery after reconnect and clears history on relay-key rotation", async () => {
  let resolveOld!: (value: VerifiedProfileAuthority | null) => void;
  let oldSignal: AbortSignal | undefined;
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockImplementationOnce((signal) => {
      oldSignal = signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    })
    .mockResolvedValueOnce({ pubkey: bob.pubkey, multipleIssuers: false });
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    h.directory.connected(false);
    h.directory.connected(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    h.directory.connected(false);
    h.directory.connected(true);
    await Promise.resolve();
    expect(oldSignal?.aborted).toBe(true);
    expect(h.directory.snapshot().size).toBe(0);
    resolveOld(authority);
    await Promise.resolve();
    expect(h.directory.snapshot().size).toBe(0);
    first.event(projection(50));
    expect(h.directory.snapshot().size).toBe(0);
  } finally {
    h.directory.dispose();
  }
});

it("wires session profile demand, live updates, disconnection, and refreshed discovery", async () => {
  const { createRelaySession } = await import("./session");
  const { scriptedTransport } = await import("./testing");
  const wire = scriptedTransport(alice.pubkey, relay.pubkey);
  let live: import("./live").LiveCallbacks | undefined;
  let sink: VerifiedProfileSink | undefined;
  let requests = 0;
  const refresh = vi.fn(async () => null);
  const owner = createRelaySession({
    ...wire.transport,
    query: async () => [],
    verifiedProfiles: { ...authority, multipleIssuers: false },
    readVerifiedProfileAuthority: refresh,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, next) {
          requests++;
          sink = next;
          return () => {};
        },
      };
    },
  });
  try {
    assert(live);
    live.state({ status: "connected", routes: [] });
    // An over-budget request is rejected before it reaches verification.
    await expect(
      owner.session.profiles.ensure(
        Array.from({ length: 1025 }, (_, index) =>
          index.toString(16).padStart(64, "0"),
        ),
      ),
    ).rejects.toThrow("budget");
    await Promise.resolve();
    expect(requests).toBe(0);
    await owner.session.profiles.ensure([alice.pubkey]);
    assert(sink);
    sink.event(projection());
    sink.eose();
    await tick(); // Verified changes publish on the next macrotask.
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified?.status,
    ).toBe("checked");
    live.state({ status: "connecting", routes: [] });
    await tick(); // Verified changes publish on the next macrotask.
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified?.status,
    ).toBe("cached");
    live.state({ status: "connected", routes: [] });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    await tick();
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified,
    ).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("keeps a verified name and its live check when channel access ends", async () => {
  const { createRelaySession } = await import("./session");
  const { roster, scriptedTransport } = await import("./testing");
  const wire = scriptedTransport(alice.pubkey, relay.pubkey);
  let live: import("./live").LiveCallbacks | undefined;
  let sink: VerifiedProfileSink | undefined;
  let subscribed = 0;
  let stopped = 0;
  const owner = createRelaySession({
    ...wire.transport,
    verifiedProfiles: { ...authority, multipleIssuers: false },
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, next) {
          subscribed++;
          sink = next;
          return () => {
            stopped++;
          };
        },
      };
    },
  });
  const isProfileRead = (filters: readonly { kinds?: readonly number[] }[]) =>
    filters.every(
      (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 0,
    );
  const denyPending = () => {
    for (const entry of wire.pending.splice(0))
      if (isProfileRead(entry.filters)) entry.respond([]);
      else entry.fail(new Error("Relay read failed (403)"));
  };
  const verified = () =>
    owner.session.profiles.snapshot().get(alice.pubkey)?.verified;
  try {
    assert(live);
    live.state({ status: "connected", routes: [] });
    const ensured = owner.session.profiles.ensure([alice.pubkey]);
    await vi.waitFor(() =>
      expect(wire.pending.some((entry) => isProfileRead(entry.filters))).toBe(
        true,
      ),
    );
    denyPending();
    await ensured;
    assert(sink);
    sink.event(projection());
    sink.eose();
    await tick(); // Verified changes publish on the next macrotask.
    expect(verified()).toMatchObject({
      displayName: "Alice",
      status: "checked",
    });
    // A denied channel, then a denied channel list: profiles do not depend on
    // channels, so neither removes the verified name or stops its check.
    live.receive(["a", "b"].map((id) => roster(relay, id, [alice.pubkey], 10)));
    owner.session.channels.ensure("a");
    await vi.waitFor(() => {
      denyPending();
      expect(owner.session.channels.window("a").status).toBe("error");
    });
    owner.session.channels.refreshList?.();
    await vi.waitFor(() => {
      denyPending();
      expect(owner.session.channels.list().status).toBe("error");
    });
    expect(verified()).toMatchObject({
      displayName: "Alice",
      status: "checked",
    });
    expect([subscribed, stopped]).toEqual([1, 0]);
  } finally {
    owner.dispose();
  }
});

it("keeps batch membership and checked status stable when subjects are added or evicted", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    h.directory.ensure([bob.pubkey]);
    await Promise.resolve();
    // The open batch is reissued with the new subject; its replacement covers alice.
    expect(active().map((item) => item.subjects)).toEqual([
      [alice.pubkey, bob.pubkey],
    ]);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    // A full replacement response that omits alice cannot reconfirm her.
    const replacement = active()[0];
    assert(replacement);
    replacement.sink.event(projection(10, bob.pubkey));
    replacement.sink.event(projection(11, bob.pubkey));
    replacement.sink.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    expect(h.directory.snapshot().get(bob.pubkey)?.status).toBe("checked");
    h.directory.ensure(
      Array.from({ length: 1022 }, (_, index) =>
        (index + 1).toString(16).padStart(64, "0"),
      ),
    );
    await Promise.resolve();
    const full = active();
    expect(full.map((item) => item.subjects.length)).toEqual(
      Array(8).fill(128),
    );
    const issued = h.subscriptions.length;
    // Evicting alice and adding one key reissues only alice's batch.
    h.directory.ensure(["f".repeat(64)]);
    await Promise.resolve();
    const stopped = full.filter((item) => item.stopped);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.subjects).toContain(alice.pubkey);
    expect(h.subscriptions).toHaveLength(issued + 1);
    expect(h.subscriptions.at(-1)?.subjects).not.toContain(alice.pubkey);
    expect(h.subscriptions.at(-1)?.subjects).toContain("f".repeat(64));
    // A re-wanted evicted subject needs a fresh REQ, not its retired slot.
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    expect(h.subscriptions.at(-1)?.subjects).toContain(alice.pubkey);
  } finally {
    h.directory.dispose();
  }
});

it("notifies when ensure evicts a subject, not when it only adds one", async () => {
  const h = harness();
  const keys = Array.from({ length: 1025 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  try {
    h.directory.ensure(keys.slice(0, 1024));
    await Promise.resolve();
    expect(h.changed).not.toHaveBeenCalled();
    // Re-ensuring the first key makes the second the least recent.
    h.directory.ensure([keys[0] as string]);
    h.directory.ensure([keys[1024] as string]);
    await Promise.resolve();
    expect(h.changed).toHaveBeenCalledTimes(1);
    const wanted = h.subscriptions
      .filter((item) => !item.stopped)
      .flatMap((item) => item.subjects);
    expect(wanted).toHaveLength(1024);
    expect(wanted).toContain(keys[0]);
    expect(wanted).not.toContain(keys[1]);
  } finally {
    h.directory.dispose();
  }
});

it("keeps kind-0 enrichment retryable after a verified-only profile loads", async () => {
  const { createProfileDirectory } = await import("./profile-directory");
  let sink: VerifiedProfileSink | undefined;
  let fail = true;
  const read = vi.fn(async () => {
    if (fail) throw new Error("profile read rejected");
    return [
      eventDto(
        signed(alice, {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: "Self name", about: "About Alice" }),
        }),
      ),
    ];
  });
  const directory = createProfileDirectory({ read }, undefined, undefined, {
    authority,
    subscribe(_filter, next) {
      sink = next;
      return () => {};
    },
  });
  try {
    await expect(directory.ensure([alice.pubkey])).rejects.toThrow(
      "profile read rejected",
    );
    assert(sink);
    sink.event(projection());
    sink.eose();
    await tick();
    expect(directory.queries.snapshot().get(alice.pubkey)?.name).toBe("Alice");
    fail = false;
    await directory.ensure([alice.pubkey]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(directory.queries.snapshot().get(alice.pubkey)).toMatchObject({
      name: "Alice",
      about: "About Alice",
    });
  } finally {
    directory.dispose();
  }
});

it("reuses an unchanged head's projection across snapshots", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    const checked = h.directory.snapshot().get(alice.pubkey);
    expect(checked?.status).toBe("checked");
    expect(h.directory.snapshot().get(alice.pubkey)).toBe(checked);
    h.directory.connected(false);
    const cached = h.directory.snapshot().get(alice.pubkey);
    expect(cached?.status).toBe("cached");
    expect(h.directory.snapshot().get(alice.pubkey)).toBe(cached);
  } finally {
    h.directory.dispose();
  }
});

it("keeps an unchanged head's projection through an equal discovery refresh", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => ({ ...authority }));
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    const checked = h.directory.snapshot().get(alice.pubkey);
    expect(checked?.status).toBe("checked");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().get(alice.pubkey)).toBe(checked);
  } finally {
    h.directory.dispose();
    vi.useRealTimers();
  }
});

it("re-sends a batch a replaced socket ended and keeps its check quiet while connected", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0];
    assert(first);
    first.sink.event(projection());
    first.sink.event(projection(10, bob.pubkey));
    first.sink.eose();
    const shown = h.directory.snapshot();
    h.changed.mockClear();
    // A planned renewal replaces the socket; the connection stays up.
    first.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.directory.snapshot()).toEqual(shown);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    const replacement = active()[0];
    assert(replacement && replacement !== first);
    expect(replacement.subjects).toEqual([alice.pubkey, bob.pubkey]);
    // A replay that confirms what is shown does not notify.
    replacement.sink.event(projection());
    replacement.sink.event(projection(10, bob.pubkey));
    replacement.sink.eose();
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.directory.snapshot().get(bob.pubkey)?.status).toBe("checked");
    // A replay that differs notifies once.
    replacement.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    const third = active()[0];
    assert(third);
    third.sink.event(projection(12));
    third.sink.eose();
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(12);
    expect(h.directory.snapshot().has(bob.pubkey)).toBe(false);
    // Any other end still fails the batch without a retry.
    h.changed.mockClear();
    third.sink.closed("error: relay refused");
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(active()).toHaveLength(0);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
  } finally {
    h.directory.dispose();
  }
});

it("publishes a pre-EOSE change after a second renewal", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    first.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    const second = active()[0];
    assert(second);
    second.sink.event(projection(12));
    h.changed.mockClear();
    second.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    const third = active()[0];
    assert(third && third !== second);
    third.sink.event(projection(12));
    third.sink.eose();
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(12);
  } finally {
    h.directory.dispose();
  }
});

it("publishes a pre-EOSE change after an open batch is rebuilt", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = active()[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    first.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    const renewed = active()[0];
    assert(renewed);
    renewed.sink.event(projection(12));
    h.changed.mockClear();
    h.directory.ensure([bob.pubkey]);
    await Promise.resolve();
    const rebuilt = active()[0];
    assert(rebuilt && rebuilt !== renewed);
    // An incomplete replay that flips no checked status.
    rebuilt.sink.event(projection(12));
    rebuilt.sink.event(projection(12));
    rebuilt.sink.eose();
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(12);
  } finally {
    h.directory.dispose();
  }
});

it("grows with the profile limit and evicts the least recently ensured when it shrinks", async () => {
  const h = harness();
  try {
    h.directory.resize(1025);
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    h.subscriptions[0]?.sink.event(projection());
    h.directory.ensure(
      Array.from({ length: 1024 }, (_, i) => i.toString(16).padStart(64, "0")),
    );
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(true);
    h.changed.mockClear();
    h.directory.resize(1024);
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
    expect(h.changed).toHaveBeenCalledTimes(1);
  } finally {
    h.directory.dispose();
  }
});

it("shrinks a full head cache by request order, not by arrival order", async () => {
  const h = harness();
  const carol = keypair();
  try {
    // The directory follows any limit; three heads stand for a full cache.
    h.directory.resize(3);
    const subjects = [alice.pubkey, bob.pubkey, carol.pubkey];
    h.directory.ensure(subjects);
    await Promise.resolve();
    const [batch] = h.subscriptions;
    assert(batch);
    for (const subject of subjects) batch.sink.event(projection(10, subject));
    batch.sink.eose();
    expect(h.directory.snapshot().size).toBe(3);
    // The first head to arrive is now the most recently requested.
    h.directory.ensure([alice.pubkey]);
    h.changed.mockClear();
    h.directory.resize(2);
    const snapshot = h.directory.snapshot();
    expect([...snapshot.keys()].sort()).toEqual(
      [alice.pubkey, carol.pubkey].sort(),
    );
    expect(h.changed).toHaveBeenCalledTimes(1);
  } finally {
    h.directory.dispose();
  }
});

it("stops the syncs a shrink emptied without another ensure", async () => {
  const h = harness();
  try {
    h.directory.resize(VERIFIED_PROFILE_BATCH + 1);
    const old = Array.from({ length: VERIFIED_PROFILE_BATCH }, (_, i) =>
      (i + 1).toString(16).padStart(64, "0"),
    );
    h.directory.ensure(old);
    await Promise.resolve();
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const [full, recent] = h.subscriptions;
    assert(full && recent);
    // Shrinking to one keeps the most recently requested subject only.
    h.directory.resize(1);
    await Promise.resolve();
    expect(full.stopped).toBe(true);
    expect(recent.stopped).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("notifies profile subscribers when discovery withdraws the authority, even with no verified profile shown", async () => {
  vi.useFakeTimers();
  const { createRelaySession } = await import("./session");
  const { scriptedTransport } = await import("./testing");
  const wire = scriptedTransport(alice.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query: async () => [],
    verifiedProfiles: authority,
    readVerifiedProfileAuthority: async () => null,
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles: () => () => {},
      };
    },
  });
  const profiles = owner.session.profiles;
  try {
    // Demand arms the discovery refresh; nobody here has a verified profile.
    void profiles.ensure([alice.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    const before = profiles.snapshot();
    expect(profiles.verifiedAuthority?.()).toMatchObject(authority);
    const notified = vi.fn();
    const stop = profiles.subscribe(notified);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The directory coalesces its publish to the next macrotask.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(profiles.verifiedAuthority?.()).toBeUndefined();
    expect(profiles.snapshot()).toBe(before);
    expect(notified).toHaveBeenCalled();
    stop();
  } finally {
    owner.dispose();
    vi.useRealTimers();
  }
});

it("resumes a renewed batch from its cursor and reads an omitted subject as unchanged", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    const first = active()[0];
    assert(first);
    expect(first.since).toBeUndefined();
    first.sink.event(projection());
    first.sink.event(projection(10, bob.pubkey));
    first.sink.eose();
    const shown = h.directory.snapshot();
    h.changed.mockClear();
    first.sink.closed("disconnected: live connection lost", { since: 500 });
    await Promise.resolve();
    const resumed = active()[0];
    assert(resumed && resumed !== first);
    expect(resumed.subjects).toEqual([alice.pubkey, bob.pubkey]);
    expect(resumed.since).toBe(500);
    // Nothing changed since the cursor: an empty resume keeps every name.
    resumed.sink.eose();
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.directory.snapshot()).toEqual(shown);
    expect(h.directory.snapshot().get(bob.pubkey)?.status).toBe("checked");
    // A changed head arrives; the omitted subject keeps its head and check.
    resumed.sink.closed("disconnected: live connection lost", { since: 800 });
    await Promise.resolve();
    const next = active()[0];
    assert(next && next !== resumed);
    expect(next.since).toBe(800);
    next.sink.event(projection(12));
    next.sink.eose();
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(12);
    expect(h.directory.snapshot().get(bob.pubkey)).toEqual(
      shown.get(bob.pubkey),
    );
    // A retraction is a newer head, so a resume still delivers it.
    next.sink.event(retract(13, bob.pubkey));
    expect(h.directory.snapshot().has(bob.pubkey)).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("keeps a resume's start point until a resumed batch reaches EOSE", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = active()[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    first.sink.closed("disconnected: live connection lost", { since: 500 });
    await Promise.resolve();
    const resumed = active()[0];
    assert(resumed);
    // The next socket ends before this resume completes: no new cursor.
    resumed.sink.closed("disconnected: live connection lost");
    await Promise.resolve();
    const again = active()[0];
    assert(again && again !== resumed);
    expect(again.since).toBe(500);
  } finally {
    h.directory.dispose();
  }
});

it("replays in full a batch that had not reached EOSE or was rebuilt", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = active()[0];
    assert(first);
    // Not live yet: a cursor from the socket cannot cover this batch.
    first.sink.closed("disconnected: live connection lost", { since: 500 });
    await Promise.resolve();
    const full = active()[0];
    assert(full && full !== first);
    expect(full.since).toBeUndefined();
    full.sink.event(projection());
    full.sink.eose();
    full.sink.closed("disconnected: live connection lost", { since: 600 });
    await Promise.resolve();
    expect(active()[0]?.since).toBe(600);
    // A new subject rebuilds the open batch, which needs every head again.
    h.directory.ensure([bob.pubkey]);
    await Promise.resolve();
    const rebuilt = active()[0];
    assert(rebuilt);
    expect(rebuilt.subjects).toEqual([alice.pubkey, bob.pubkey]);
    expect(rebuilt.since).toBeUndefined();
  } finally {
    h.directory.dispose();
  }
});
