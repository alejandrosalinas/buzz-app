import { expect, it, vi } from "vitest";
import type { LocalAgent, LocalAgentsSnapshot } from "../agents/local";
import { bindNames, type NameSource } from "./service";
import { npubEncode } from "nostr-tools/nip19";
import {
  agentDirectory,
  createAgentDirectory,
  defaultNamingPolicy,
} from "./testing";
import { createNameProvider } from "./directory";
import { foldProfiles } from "../relay/profiles";
import { createProfileDirectory } from "../relay/profile-directory";
import { keypair, profile } from "../relay/testing";

it("scopes local agent names to the session community and follows edits and disposal", () => {
  const key = "a".repeat(64);
  const listeners = new Set<() => void>();
  const owner = "f".repeat(64);
  let state: LocalAgentsSnapshot = {
    status: "ready",
    agents: [
      { pubkey: key, relayUrl: "wss://other.example", name: "Other", owner },
      { pubkey: key, relayUrl: "wss://here.example/", name: " Here ", owner },
    ],
  };
  const provider = createAgentDirectory({
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => {},
  });
  const source: NameSource = {
    relayUrl: "https://here.example",
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({
        status: "ready",
        definitions: [],
        identities: [{ pubkey: key, name: "Legacy" }],
      }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  expect(names.resolve(key)).toBe("Here");
  const changed = vi.fn();
  names.subscribe(changed);
  const agent = state.agents[1];
  if (!agent) throw new Error("Missing fixture agent");
  state = { ...state, agents: [{ ...agent, name: "Edited" }] };
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  expect(names.resolve(key)).toBe("Edited");
  expect(provider.scope({ ...source, relayUrl: undefined })(key)?.name).toBe(
    "Legacy",
  );
  expect(
    provider.scope({ ...source, relayUrl: "https://unrelated.example" })(key)
      ?.name,
  ).toBe("Legacy");
  state = { ...state, status: "error" };
  expect(names.resolve(key)).toBe("Legacy");
  names.dispose();
  expect(listeners.size).toBe(0);
});

it("suffixes equal names across profiles, without merging keys or suffixing unique names", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64),
    d = "d".repeat(64),
    e = "e".repeat(64);
  const identities = [
    { pubkey: a, name: "Bad Janet", definitionId: "shared" },
    { pubkey: a.toUpperCase(), name: "Bad Janet", definitionId: "shared" },
    { pubkey: b, name: "Bad Janet", definitionId: "shared" },
    { pubkey: c, name: " Bad Janet ", definitionId: "other" },
    { pubkey: d, name: "Bad Janet" },
    { pubkey: e, name: "Larry", definitionId: "shared" },
  ];
  let library = { status: "ready", definitions: [], identities };
  const profiles = new Map();
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  for (const key of [a, b, c, d]) {
    expect(agentDirectory.scope(source)(key)?.name).toBe(
      `Bad Janet · ${npubEncode(key).slice(-4)}`,
    );
  }
  expect(agentDirectory.scope(source)(e)?.name).toBe("Larry");
  library = { ...library, identities: identities.slice(0, 2) };
  expect(agentDirectory.scope(source)(a)?.name).toBe("Bad Janet");
  expect(agentDirectory.scope(source)(b)?.name).toBeUndefined();
});

it("recomputes collisions for local agent edits, community scope, and profile fallbacks", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  let agent: LocalAgent = {
    pubkey: a,
    name: "Native Larry",
    relayUrl: "wss://here.test",
    owner: "f".repeat(64),
  };
  const listeners = new Set<() => void>();
  let native: LocalAgentsSnapshot = { status: "ready", agents: [agent] };
  const library = {
    status: "ready",
    definitions: [],
    identities: [
      { pubkey: a, name: "Legacy", definitionId: "linked" },
      { pubkey: b, name: "Legacy", definitionId: "linked" },
      { pubkey: c, name: "" },
    ],
  };
  let profiles = new Map([[c, { name: "Public Larry" }]]);
  const source: NameSource = {
    relayUrl: "https://here.test",
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => native,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => {},
  });
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  const changed = vi.fn();
  names.subscribe(changed);
  expect(names.resolve(a)).toBe("Native Larry");
  expect(names.resolve(b)).toBe("Legacy");
  expect(
    provider.scope({ ...source, relayUrl: "https://other.test" })(a)?.name,
  ).toBe(`Legacy · ${npubEncode(a).slice(-4)}`);
  expect(agent.name).toBe("Native Larry");

  agent = { ...agent, name: "Legacy" };
  native = { ...native, agents: [agent] };
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  for (const key of [a, b])
    expect(names.resolve(key)).toBe(`Legacy · ${npubEncode(key).slice(-4)}`);

  profiles = new Map([[c, { name: "Legacy" }]]);
  for (const listener of listeners) listener();
  expect(names.resolve(c)).toBe(`Legacy · ${npubEncode(c).slice(-4)}`);
  profiles = new Map([[c, { name: "Public Larry" }]]);
  for (const listener of listeners) listener();
  expect(names.resolve(c)).toBe("Public Larry");
  names.dispose();
  expect(listeners.size).toBe(0);
});

it("includes local-only identities but ignores other-community and unready local records", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const library = {
    status: "ready",
    definitions: [],
    identities: [{ pubkey: a, name: "Larry" }],
  };
  let native: LocalAgentsSnapshot = {
    status: "ready",
    agents: [
      {
        pubkey: b,
        name: "Larry",
        relayUrl: "wss://here.test",
        owner: "f".repeat(64),
      },
    ],
  };
  const profiles = new Map();
  const source: NameSource = {
    relayUrl: "https://here.test",
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => native,
    subscribe: () => () => {},
    refresh: async () => {},
  });
  for (const key of [a, b])
    expect(provider.scope(source)(key)?.name).toBe(
      `Larry · ${npubEncode(key).slice(-4)}`,
    );
  expect(
    provider.scope({ ...source, relayUrl: "https://elsewhere.test" })(a)?.name,
  ).toBe("Larry");
  expect(
    provider.scope({ ...source, relayUrl: "https://elsewhere.test" })(b)?.name,
  ).toBeUndefined();
  native = { ...native, status: "error" };
  expect(provider.scope(source)(a)?.name).toBe("Larry");
  expect(provider.scope(source)(b)?.name).toBeUndefined();
});

it("applies viewer and owner metadata through the shared view and follows owner edits", () => {
  const me = "1".repeat(64),
    other = "2".repeat(64),
    a = "a".repeat(64),
    b = "b".repeat(64);
  const listeners = new Set<() => void>();
  let profiles = new Map([
    [me, { name: "Logan" }],
    [other, { name: "Wes" }],
    [a, { name: "Honey", isAgent: true as const, ownerPubkey: me }],
    [b, { name: "Honey", isAgent: true as const, ownerPubkey: other }],
  ]);
  const source: NameSource = {
    viewer: me,
    profiles: {
      snapshot: () => profiles,
      ensure: async () => {},
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    agentLibrary: {
      snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory();
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  expect(names.resolve(a)).toBe("Honey");
  expect(names.resolve(b)).toBe("Wes’s Honey");
  expect(provider.scope({ ...source, viewer: other })(a)?.name).toBe(
    "Logan’s Honey",
  );
  expect(names.resolve(a)).toBe("Honey");
  const changed = vi.fn();
  names.subscribe(changed);
  profiles = new Map([...profiles, [other, { name: "Wesley" }]]);
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  expect(names.resolve(b)).toBe("Wesley’s Honey");
  names.dispose();
});

it("preserves agent ownership for an authored alias when the public name is synthetic", () => {
  const agent = "a".repeat(64),
    human = "b".repeat(64),
    owner = "c".repeat(64);
  const source: NameSource = {
    profiles: {
      snapshot: () =>
        new Map([
          [
            agent,
            {
              name: agent.slice(0, 10),
              nameIsFallback: true as const,
              isAgent: true as const,
              ownerPubkey: owner,
            },
          ],
          [human, { name: "Honey" }],
          [owner, { name: "Salman" }],
        ]),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const label = createAgentDirectory().scope(
    source,
    [agent, human],
    [{ pubkey: agent, name: "Honey" }],
  );
  expect(label(human)?.name).toBe("Honey");
  expect(label(agent)?.name).toBe("Salman’s Honey");
});

it("reuses one policy run per candidate scope across mixed case, outside keys, and updates", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((key) => key.repeat(64));
  if (!a || !b || !c || !d) throw new Error("Missing fixture keys");
  let profiles = new Map([
    [a, { name: "Alex" }],
    [b, { name: "Alex" }],
    [c, { name: "Alex" }],
    [d, { name: "Dana" }],
  ]);
  const library = {
    status: "ready",
    definitions: [],
    identities: [],
  } as const;
  const listeners = new Set<() => void>();
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const resolve = vi.fn(defaultNamingPolicy.resolve);
  const names = bindNames(source, {
    snapshot: () => [createNameProvider({ id: "spy", resolve })],
    subscribe: () => () => {},
  });
  const suffixed = (key: string) => `Alex · ${npubEncode(key).slice(-4)}`;
  const candidates = [a.toUpperCase(), b, d];
  const scoped = names.scope(candidates);
  expect(scoped(a)?.name).toBe(suffixed(a));
  expect(scoped(b.toUpperCase())).toEqual({
    name: suffixed(b),
    qualifier: npubEncode(b).slice(-4),
    source: "agent-directory",
  });
  expect(scoped(d)?.name).toBe("Dana");
  expect(names.lookup(b, candidates)).toEqual(scoped(b));
  // Interleaved unscoped lookups keep their own cached scope.
  expect(names.resolve(d)).toBe("Dana");
  expect(scoped(a)?.name).toBe(suffixed(a));
  expect(resolve).toHaveBeenCalledTimes(2);
  // An outside historical reference joins the scope only for its own lookup.
  expect(names.scope([d])(a)?.name).toBe("Alex");
  expect(scoped(c)?.name).toBe(suffixed(c));
  expect(scoped(a)?.name).toBe(suffixed(a));
  expect(resolve).toHaveBeenCalledTimes(4);
  // A hot scope survives a stream of distinct historical lookups.
  for (const digit of "01234567") {
    expect(names.scope([digit.repeat(64)])(a)?.name).toBe("Alex");
    expect(scoped(a)?.name).toBe(suffixed(a));
  }
  expect(resolve).toHaveBeenCalledTimes(12);
  // Equal candidate sets share outside labels.
  expect(scoped(c)?.name).toBe(suffixed(c));
  expect(names.scope([d, b, a])(c)?.name).toBe(suffixed(c));
  expect(resolve).toHaveBeenCalledTimes(13);
  // One scope keeps many historical authors' labels at once.
  const authors = [..."0123456789"].map((digit) => digit.repeat(64));
  for (const author of [...authors, ...authors]) scoped(author);
  expect(resolve).toHaveBeenCalledTimes(23);
  // Membership churn keeps only recent scopes' outside labels.
  for (const digit of "01234567") names.scope([a, b, d, digit.repeat(64)])(c);
  expect(resolve).toHaveBeenCalledTimes(31);
  expect(scoped(c)?.name).toBe(suffixed(c));
  expect(resolve).toHaveBeenCalledTimes(32);
  profiles = new Map([...profiles, [b, { name: "Blake" }]]);
  for (const listener of listeners) listener();
  expect(scoped(a)?.name).toBe("Alex");
  expect(scoped(b)?.name).toBe("Blake");
  expect(scoped(c)?.name).toBe(suffixed(c));
  expect(resolve).toHaveBeenCalledTimes(34);
});

it("keeps every DM scope of a sidebar pass for the next pass", () => {
  const profiles = new Map();
  const library = {
    status: "ready",
    definitions: [],
    identities: [],
  } as const;
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const resolve = vi.fn(defaultNamingPolicy.resolve);
  const names = bindNames(source, {
    snapshot: () => [createNameProvider({ id: "spy", resolve })],
    subscribe: () => () => {},
  });
  const dms = Array.from({ length: 40 }, (_, index) => [
    index.toString(16).padStart(64, "0"),
  ]);
  // Two sidebar passes; the second hits every scope.
  for (const participants of [...dms, ...dms])
    names.resolve(participants[0] as string, "", participants);
  expect(resolve).toHaveBeenCalledTimes(dms.length);
});

it("reuses a scope's labels for display facts rebuilt with equal content", () => {
  const profiles = new Map();
  const library = {
    status: "ready",
    definitions: [],
    identities: [],
  } as const;
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const resolve = vi.fn(defaultNamingPolicy.resolve);
  const names = bindNames(source, {
    snapshot: () => [createNameProvider({ id: "spy", resolve })],
    subscribe: () => () => {},
  });
  const [a, b] = ["a", "b"].map((key) => key.repeat(64));
  if (!a || !b) throw new Error("Missing fixture keys");
  const facts = (name: string) => [
    { pubkey: a, name: "Alex" },
    { pubkey: b, name },
  ];
  // A view rebuilds its facts on every render: equal content, new arrays.
  expect(names.scope([a, b], facts("Blake"))(b)?.name).toBe("Blake");
  expect(names.scope([a, b], facts("Blake"))(b)?.name).toBe("Blake");
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(names.scope([a, b], facts("Bo"))(b)?.name).toBe("Bo");
  expect(resolve).toHaveBeenCalledTimes(2);
  // A fact that changes who is an agent, or whose, is a new scope.
  const agent = (ownerPubkey?: string) => [
    { pubkey: a, name: "Alex" },
    {
      pubkey: b,
      name: "Bo",
      isAgent: true,
      ...(ownerPubkey ? { ownerPubkey } : {}),
    },
  ];
  names.scope([a, b], agent())(b);
  names.scope([a, b], agent(a))(b);
  names.scope([a, b], agent(a))(b);
  expect(resolve).toHaveBeenCalledTimes(4);
  // A key outside the scope keeps its label across equal rebuilt facts.
  const outside = "c".repeat(64);
  names.scope([a, b], agent(a))(outside);
  names.scope([a, b], agent(a))(outside);
  expect(resolve).toHaveBeenCalledTimes(5);
  names.scope([a, b], facts("Bo"))(outside);
  expect(resolve).toHaveBeenCalledTimes(6);
});

it("labels a frozen member list like an equal unfrozen one, across interleaved scopes", () => {
  const [a, b, d] = ["a", "b", "d"].map((key) => key.repeat(64));
  if (!a || !b || !d) throw new Error("Missing fixture keys");
  const profiles = new Map([
    [a, { name: "Alex" }],
    [b, { name: "Alex" }],
    [d, { name: "Dana" }],
  ]);
  const library = {
    status: "ready",
    definitions: [],
    identities: [],
  } as const;
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const resolve = vi.fn(defaultNamingPolicy.resolve);
  const names = bindNames(source, {
    snapshot: () => [createNameProvider({ id: "spy", resolve })],
    subscribe: () => () => {},
  });
  const members = Object.freeze([b.toUpperCase(), a]);
  const suffixed = (key: string) => `Alex · ${npubEncode(key).slice(-4)}`;
  for (let pass = 0; pass < 2; pass++) {
    expect(names.resolve(a, "", members)).toBe(suffixed(a));
    expect(names.resolve(d, "", [d])).toBe("Dana");
    expect(names.resolve(b, "", members)).toBe(suffixed(b));
    expect(names.resolve(a, "", [a, b])).toBe(suffixed(a));
  }
  // The frozen list and its equal unfrozen copy share one policy run.
  expect(resolve).toHaveBeenCalledTimes(2);
});

it.each(
  [
    '{"about":"Artwork-only agent"}',
    '{"name":" ","display_name":""}',
    "malformed",
    '{"name":"aaaaaaaaaa"}',
  ].flatMap((content) =>
    ["Saved Luna", ""].map((alias) => ({ content, alias })),
  ),
)(
  "uses saved aliases for unnamed public profiles but respects an explicit key-like name (%j)",
  ({ content, alias }) => {
    const key = "a".repeat(64);
    const profiles = foldProfiles([
      {
        id: "1".repeat(64),
        pubkey: key,
        created_at: 1,
        kind: 0,
        content,
        tags: [["auth", "b".repeat(64), "", "c".repeat(128)]],
      },
    ]);
    const source: NameSource = {
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
      agentLibrary: {
        snapshot: () => ({
          status: "ready",
          definitions: [],
          identities: [{ pubkey: key, name: alias }],
        }),
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
    };
    expect(agentDirectory.scope(source)(key)?.name).toBe(
      content === '{"name":"aaaaaaaaaa"}' ? "aaaaaaaaaa" : alias || "Agent",
    );
  },
);

it.each([false, true])(
  "updates alias precedence when fallback provenance changes without changing display fields (initially named: %s)",
  (initiallyNamed) => {
    const agent = keypair();
    const explicitName = agent.pubkey.slice(0, 10);
    const directory = createProfileDirectory({ read: vi.fn(async () => []) });
    const source: NameSource = {
      profiles: directory.queries,
      agentLibrary: {
        snapshot: () => ({
          status: "ready",
          definitions: [],
          identities: [{ pubkey: agent.pubkey, name: "Saved alias" }],
        }),
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
    };
    const names = bindNames(source, {
      snapshot: () => [agentDirectory],
      subscribe: () => () => {},
    });
    try {
      for (const [index, named] of [
        initiallyNamed,
        !initiallyNamed,
      ].entries()) {
        directory.accept([
          profile(
            agent,
            { is_agent: true, ...(named ? { name: explicitName } : {}) },
            index + 1,
          ),
        ]);
        expect(directory.queries.snapshot().get(agent.pubkey)?.name).toBe(
          explicitName,
        );
        expect(names.resolve(agent.pubkey)).toBe(
          named ? explicitName : "Saved alias",
        );
        expect(
          directory.queries.snapshot().get(agent.pubkey)?.nameIsFallback,
        ).toBe(named ? undefined : true);
      }
    } finally {
      names.dispose();
      directory.dispose();
    }
  },
);

it("labels a scope from its own keys and their owners, not the whole profile cache", () => {
  const me = "1".repeat(64),
    owner = "2".repeat(64),
    a = "a".repeat(64),
    b = "b".repeat(64);
  const crowd = Array.from(
    { length: 500 },
    (_, index) =>
      [index.toString(16).padStart(64, "c"), { name: "Honey" }] as const,
  );
  const profiles = new Map<
    string,
    { name: string; isAgent?: true; ownerPubkey?: string }
  >([
    ...crowd,
    [owner, { name: "Wes" }],
    [a, { name: "Honey", isAgent: true, ownerPubkey: owner }],
    [b, { name: "Honey", isAgent: true, ownerPubkey: me }],
  ]);
  const library = { status: "ready" as const, definitions: [], identities: [] };
  const source: NameSource = {
    viewer: me,
    profiles: {
      snapshot: () => profiles,
      ensure: async () => {},
      subscribe: () => () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const resolve = vi.fn(defaultNamingPolicy.resolve);
  const provider = createNameProvider({ ...defaultNamingPolicy, resolve });
  const scoped = provider.scope(source, [a, b]);
  // The owner outside the scope still qualifies its agent's name.
  expect(scoped(a)?.name).toBe("Wes’s Honey");
  expect(scoped(b)?.name).toBe("Honey");
  const rows = resolve.mock.calls[0]?.[0] ?? [];
  expect(new Set(rows.map((row) => row.pubkey))).toEqual(
    new Set([a, b, owner]),
  );
  // Unscoped lookups still see every cached namesake.
  expect(provider.scope(source)(crowd[0]?.[0] as string)?.name).not.toBe(
    "Honey",
  );
});
