import { describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { createRelaySession } from "../relay/session";
import { keypair, profile, signed } from "../relay/testing";
import { eventDto, type ReadFilter } from "../relay/events";
import { searchMembers, MEMBER_SEARCH_PAGE_SIZE } from "./search";

it("uses the server prefix-search page, distinguishes namesakes, ranks exact names, and reports another page", async () => {
  const viewer = keypair(),
    relay = keypair();
  const rows = Array.from({ length: MEMBER_SEARCH_PAGE_SIZE }, (_, i) =>
    profile(keypair(), { name: i === 2 ? "Morgan" : "Morgan Martin" }),
  );
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => rows);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  try {
    const result = await searchMembers(
      owner.session,
      "Morgan",
      2,
      new AbortController().signal,
    );
    expect(query.mock.calls[0]?.[0]).toEqual([
      {
        kinds: [0],
        search: "Morgan",
        search_mode: "prefix",
        page: 2,
        limit: MEMBER_SEARCH_PAGE_SIZE,
      },
    ]);
    expect(result.people).toHaveLength(MEMBER_SEARCH_PAGE_SIZE);
    expect(result.people[0]?.name).toBe("Morgan");
    expect(result.more).toBe(true);
  } finally {
    owner.dispose();
  }
});
it.each([
  ["an npub", (pubkey: string) => nip19.npubEncode(pubkey)],
  ["a nostr: npub", (pubkey: string) => `nostr:${nip19.npubEncode(pubkey)}`],
  ["uppercase hex", (pubkey: string) => pubkey.toUpperCase()],
])(
  "resolves an exact key from %s without searching its display text",
  async (_case, typed) => {
    const viewer = keypair(),
      relay = keypair(),
      person = keypair();
    const query = vi.fn(async (_filters: readonly ReadFilter[]) => [
      profile(person, { name: "Morgan" }),
    ]);
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
    });
    try {
      const result = await searchMembers(
        owner.session,
        typed(person.pubkey),
        1,
        new AbortController().signal,
      );
      expect(query.mock.calls[0]?.[0]).toEqual([
        {
          kinds: [0],
          authors: [person.pubkey],
          limit: MEMBER_SEARCH_PAGE_SIZE,
        },
      ]);
      expect(result.people[0]?.pubkey).toBe(person.pubkey);
      expect(result.more).toBe(false);
    } finally {
      owner.dispose();
    }
  },
);
it("propagates a failed search instead of displaying no matches", async () => {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => {
      throw new Error("Offline");
    },
  });
  try {
    await expect(
      searchMembers(owner.session, "Morgan", 1, new AbortController().signal),
    ).rejects.toThrow("Offline");
  } finally {
    owner.dispose();
  }
});

describe("people with a verified profile and no kind:0", () => {
  const verifiedHead = (
    author: ReturnType<typeof keypair>,
    subject: string,
    full: string,
  ) =>
    signed(author, {
      kind: 30382,
      created_at: 1_000_000,
      content: "",
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "true"],
        ["display_name", full.split(" ")[0] as string],
        ["username", "glilienfeld"],
        ["full_name", full],
        ["issuer_label", "Example"],
        ["verified_at", "1000000"],
      ],
    });
  function setup(searchable: boolean) {
    const viewer = keypair(),
      relay = keypair(),
      named = keypair(),
      unnamed = keypair(),
      stranger = keypair();
    const head = verifiedHead(relay, unnamed.pubkey, "Gabi Lilienfeld");
    const query = vi.fn(async (_filters: readonly ReadFilter[]) => []);
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      searchProfiles: async () =>
        [
          profile(named, { name: "Gabi Zandi" }),
          head,
          // Only the relay key verifies; another signer's head finds nobody.
          verifiedHead(stranger, keypair().pubkey, "Gabi Forged"),
        ].map((event) => eventDto(event)),
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        ...(searchable ? { searchable: true as const } : {}),
      },
    });
    return { owner, query, named, unnamed };
  }

  it("finds them by verified name and names them from the search's head", async () => {
    const t = setup(true);
    try {
      const signal = new AbortController().signal;
      const result = await searchMembers(t.owner.session, "gabi", 1, signal);
      expect(result.people).toEqual([
        expect.objectContaining({ pubkey: t.named.pubkey, name: "Gabi Zandi" }),
        {
          pubkey: t.unnamed.pubkey,
          name: t.unnamed.pubkey.slice(0, 10),
          nameIsFallback: true,
        },
      ]);
      const verified = await t.owner.session.directMessages.verified(
        [t.unnamed.pubkey],
        signal,
      );
      expect(verified?.profiles.get(t.unnamed.pubkey)).toMatchObject({
        username: "glilienfeld",
        fullName: "Gabi Lilienfeld",
      });
      // The search already answered: naming the row needs no read.
      expect(t.query).not.toHaveBeenCalled();
    } finally {
      t.owner.dispose();
    }
  });

  it("finds nobody by a head the relay does not advertise as searchable", async () => {
    const t = setup(false);
    try {
      const result = await searchMembers(
        t.owner.session,
        "gabi",
        1,
        new AbortController().signal,
      );
      expect(result.people.map(({ pubkey }) => pubkey)).toEqual([
        t.named.pubkey,
      ]);
    } finally {
      t.owner.dispose();
    }
  });

  it("names nobody from a head on the NIP-50 path, whoever signed it", async () => {
    const relay = keypair(),
      named = keypair();
    // A relay without the name endpoint, answering with heads it should not.
    const forged = [
      verifiedHead(keypair(), keypair().pubkey, "Gabi Forged"),
      signed(keypair(), {
        kind: 30382,
        created_at: 1_000_000,
        content: "",
        tags: [["d", "not-a-key"]],
      }),
      verifiedHead(relay, keypair().pubkey, "Gabi Unasked"),
    ];
    const owner = createRelaySession({
      viewer: keypair().pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [profile(named, { name: "Gabi Zandi" }), ...forged],
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        searchable: true,
      },
    });
    try {
      const result = await searchMembers(
        owner.session,
        "gabi",
        1,
        new AbortController().signal,
      );
      expect(result.people.map(({ pubkey }) => pubkey)).toEqual([named.pubkey]);
    } finally {
      owner.dispose();
    }
  });

  it("offers a pasted key whose owner has no kind:0", async () => {
    const t = setup(true);
    try {
      const result = await searchMembers(
        t.owner.session,
        nip19.npubEncode(t.unnamed.pubkey),
        1,
        new AbortController().signal,
      );
      expect(t.query.mock.calls[0]?.[0]).toEqual([
        {
          kinds: [0],
          authors: [t.unnamed.pubkey],
          limit: MEMBER_SEARCH_PAGE_SIZE,
        },
      ]);
      expect(result).toEqual({
        people: [
          {
            pubkey: t.unnamed.pubkey,
            name: t.unnamed.pubkey.slice(0, 10),
            nameIsFallback: true,
          },
        ],
        more: false,
      });
    } finally {
      t.owner.dispose();
    }
  });
});
