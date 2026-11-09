import { beforeAll, describe, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { createRelaySession } from "./session";
import { createDirectMessages } from "./direct-messages";
import type { RelayReader } from "./reader";
import type { VerifiedProfileAuthority } from "./verified-profile";
import { keypair, profile, roster, signed } from "./testing";
import { PublishRejected } from "./outbox";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import type { RelayWriter } from "./transport";

const id = "11111111-1111-4111-8111-111111111111";
function setup(
  options: {
    badRoster?: boolean;
    untrusted?: boolean;
    lagging?: boolean;
    human?: boolean;
  } = {},
) {
  const viewer = keypair(),
    other = keypair(),
    agentOwner = keypair(),
    relay = keypair(),
    stranger = keypair();
  const authority = options.untrusted ? stranger : relay;
  const discovery = [
    signed(authority, {
      kind: 39000,
      content: JSON.stringify({ name: "Direct message", channel_type: "dm" }),
      tags: [
        ["d", id],
        ["t", "dm"],
      ],
    }),
    roster(authority, id, [
      viewer.pubkey,
      options.badRoster ? stranger.pubkey : other.pubkey,
    ]),
  ];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters.some((f) => f.kinds?.includes(0)))
      return [
        profile(viewer, { name: "Me" }),
        options.human
          ? profile(other, { name: "Other" })
          : signed(other, {
              kind: 0,
              content: JSON.stringify({
                name: "Other",
                picture: "https://example.com/avatar.png",
                is_agent: true,
                about: "Unused biography",
              }),
              tags: [["auth", agentOwner.pubkey, "", "a".repeat(128)]],
            }),
      ];
    return options.lagging &&
      !filters.every((filter) => filter.consistency === "strong")
      ? []
      : discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        );
  });
  const publish = vi.fn<RelayWriter["publish"]>(async () => {});
  const openDirectMessage = vi.fn(async () => id);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      openDirectMessage,
      writer: {
        kinds: [9],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  return {
    owner,
    viewer,
    other,
    agentOwner,
    query,
    publish,
    openDirectMessage,
    dm: owner.session.directMessages,
  };
}
it("opens using signed exact membership, then confirms the regular outbox message", async () => {
  const t = setup();
  const opened = vi.fn();
  t.dm.subscribeOpened(opened);
  try {
    await expect(
      t.dm.open([t.other.pubkey], new AbortController().signal),
    ).resolves.toBe(id);
    expect(t.owner.session.channels.get?.(id)?.channelType).toBe("dm");
    expect(opened).toHaveBeenCalledExactlyOnceWith(id);
    let release = () => {};
    t.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const message = t.owner.session.messages.send(id, "Hello", []);
    let confirmed = false;
    const done = t.dm
      .delivered(message, id, new AbortController().signal)
      .then(() => {
        confirmed = true;
      });
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    expect(confirmed).toBe(false);
    release();
    await done;
    expect(t.dm.delivery(message)).toBe("accepted");
  } finally {
    t.owner.dispose();
  }
});
it.each([
  { human: false, tagged: true },
  { human: true, tagged: false },
])(
  "a first plain message to a fresh 1:1 DM wakes only an agent partner: %j",
  async ({ human, tagged }) => {
    // New Message reads people outside the shared profile cache, so open is
    // the first point that can classify the partner before the first send.
    const t = setup({ human });
    try {
      expect(t.owner.session.profiles.snapshot().has(t.other.pubkey)).toBe(
        false,
      );
      await t.dm.open([t.other.pubkey], new AbortController().signal);
      t.owner.session.messages.send(id, "hello", []);
      await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
      const tags = t.publish.mock.calls[0]?.[0].tags ?? [];
      expect(tags.some(([name]) => name === "p")).toBe(tagged);
      if (tagged) expect(tags).toContainEqual(["p", t.other.pubkey]);
    } finally {
      t.owner.dispose();
    }
  },
);
it("opens a DM before its signed discovery reaches the replica", async () => {
  const t = setup({ lagging: true });
  try {
    await expect(
      t.dm.open([t.other.pubkey], new AbortController().signal),
    ).resolves.toBe(id);
    expect(t.owner.session.channels.get?.(id)?.members).toEqual(
      [t.viewer.pubkey, t.other.pubkey].sort(),
    );
    expect(t.query.mock.calls.map(([filters]) => filters)).toContainEqual([
      expect.objectContaining({ consistency: "strong", "#d": [id] }),
    ]);
  } finally {
    t.owner.dispose();
  }
});
it.each([{ badRoster: true }, { untrusted: true }])(
  "refuses a receipt without trusted exact participants: %j",
  async (options) => {
    const t = setup(options);
    const opened = vi.fn();
    t.dm.subscribeOpened(opened);
    try {
      await expect(
        t.dm.open([t.other.pubkey], new AbortController().signal),
      ).rejects.toThrow("participants");
      expect(t.publish).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    } finally {
      t.owner.dispose();
    }
  },
);
it("rejects self, duplicate, empty and over-limit recipients before contacting the host", async () => {
  const t = setup();
  try {
    for (const keys of [
      [],
      [t.viewer.pubkey],
      [t.other.pubkey, t.other.pubkey],
      ["a".repeat(63)],
      ["A".repeat(64)],
      [` ${t.other.pubkey}`],
      Array.from({ length: 9 }, () => keypair().pubkey),
    ])
      await expect(
        t.dm.open(keys, new AbortController().signal),
      ).rejects.toThrow("eight");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
  } finally {
    t.owner.dispose();
  }
});
it("retries a rejected first message with the same signed event", async () => {
  const t = setup();
  try {
    await t.dm.open([t.other.pubkey], new AbortController().signal);
    t.publish.mockRejectedValueOnce(
      new PublishRejected("Temporarily rejected"),
    );
    const message = t.owner.session.messages.send(id, "Keep me", []);
    await expect(
      t.dm.delivered(message, id, new AbortController().signal),
    ).rejects.toThrow("Temporarily rejected");
    await t.dm.delivered(message, id, new AbortController().signal);
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(t.publish.mock.calls[0]?.[0]).toEqual(t.publish.mock.calls[1]?.[0]);
  } finally {
    t.owner.dispose();
  }
});
it("reads paginated verified profiles, excludes the viewer, and cancels with the caller", async () => {
  const t = setup();
  try {
    const page = await t.dm.people("Other", 2, new AbortController().signal);
    expect(page).toEqual({
      people: [
        {
          pubkey: t.other.pubkey,
          name: "Other",
          picture: "https://example.com/avatar.png",
          isAgent: true,
          ownerPubkey: t.agentOwner.pubkey,
        },
      ],
      hasMore: false,
    });
    expect(
      t.query.mock.calls.some(
        ([filters]) =>
          filters[0]?.page === 2 &&
          filters[0]?.limit === 30 &&
          filters[0]?.search === "Other",
      ),
    ).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(t.dm.people("", 1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    t.owner.dispose();
  }
});

it.each([
  ["hex", (pubkey: string) => pubkey],
  ["uppercase hex", (pubkey: string) => pubkey.toUpperCase()],
  ["an npub", (pubkey: string) => npubEncode(pubkey)],
  ["a nostr: npub", (pubkey: string) => `nostr:${npubEncode(pubkey)}`],
])(
  "reads an exact public-key profile from %s without widening directory search",
  async (_case, typed) => {
    const t = setup();
    try {
      const result = await t.dm.people(
        typed(t.other.pubkey),
        1,
        new AbortController().signal,
      );
      expect(result.people).toEqual([
        expect.objectContaining({ pubkey: t.other.pubkey, name: "Other" }),
      ]);
      expect(t.query.mock.calls.at(-1)?.[0]).toEqual([
        {
          kinds: [0],
          authors: [t.other.pubkey],
          limit: 30,
          page: 1,
        },
      ]);
      expect(
        t.query.mock.calls.some(([filters]) =>
          filters.some((filter) => filter.search !== undefined),
        ),
      ).toBe(false);
    } finally {
      t.owner.dispose();
    }
  },
);

it.each(["", "C"])(
  "keeps large-profile pages within the read budget without skipping matches: %s",
  async (query) => {
    const t = setup();
    try {
      // Production C results carry roughly 200 KB each: 100 exceed the 8 MB reader budget.
      const content = "x".repeat(200_000);
      const directory = Array.from({ length: 65 }, (_, index) =>
        profile(keypair(), { name: `C person ${index}`, about: content }),
      );
      t.query.mockImplementation(async (filters) => {
        const filter = filters[0];
        const start = ((filter?.page ?? 1) - 1) * (filter?.limit ?? 100);
        return directory.slice(start, start + (filter?.limit ?? 100));
      });
      const seen = new Set<string>();
      const signal = new AbortController().signal;
      const lastPage = query ? 3 : 4;
      for (let page = 1; page <= lastPage; page++) {
        const result = await t.dm.people(query, page, signal);
        for (const person of result.people) seen.add(person.pubkey);
        expect(result.hasMore).toBe(page < lastPage);
      }
      expect(seen.size).toBe(65);
      expect(
        t.query.mock.calls
          .flatMap(([filters]) => filters)
          .map((filter) => filter.limit),
      ).toEqual(query ? [30, 30, 30] : [15, 30, 30, 30]);
    } finally {
      t.owner.dispose();
    }
  },
);

describe("directory browsing beyond the shared profile budget", () => {
  let directory: RelayEvent[];
  beforeAll(() => {
    // Signing 1,030 distinct authors is fixture setup, separate from the timed
    // browsing behavior. Keep the dataset larger than the 1,024-profile cache.
    directory = Array.from({ length: 1030 }, (_, i) =>
      profile(keypair(), { name: `Directory ${i}` }),
    );
  });

  it("browses beyond the shared profile budget without evicting or republishing conversation names", async () => {
    const t = setup();
    try {
      await t.owner.session.profiles.ensure([t.other.pubkey]);
      const before = t.owner.session.profiles.snapshot();
      expect(before.get(t.other.pubkey)?.name).toBe("Other");
      const changed = vi.fn();
      const unsubscribe = t.owner.session.profiles.subscribe(changed);
      t.query.mockImplementation(async (filters) => {
        const filter = filters[0];
        const start = ((filter?.page ?? 1) - 1) * (filter?.limit ?? 100);
        return directory.slice(start, start + (filter?.limit ?? 100));
      });
      const signal = new AbortController().signal;
      const seen = new Set<string>();
      for (let page = 1; page <= 36; page++) {
        const result = await t.dm.people("", page, signal);
        for (const person of result.people) seen.add(person.pubkey);
        expect(t.owner.session.profiles.snapshot()).toBe(before);
        if (!result.hasMore) break;
      }
      expect(seen.size).toBe(1030);
      expect(changed).not.toHaveBeenCalled();
      expect(
        t.owner.session.profiles.snapshot().get(t.other.pubkey)?.name,
      ).toBe("Other");
      unsubscribe();
    } finally {
      t.owner.dispose();
    }
  });
});

describe("verified names for a search page", () => {
  const assertion = (
    author: ReturnType<typeof keypair>,
    subject: string,
    names: { display: string; full?: string },
    created_at = 1_000_000,
  ) =>
    signed(author, {
      kind: 30382,
      created_at,
      content: "",
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "true"],
        ["display_name", names.display],
        ["username", names.display],
        ["issuer_label", "Example"],
        ["verified_at", String(created_at)],
        ...(names.full ? [["full_name", names.full]] : []),
      ],
    });
  function verifiedSetup(advertised: boolean) {
    const viewer = keypair(),
      relay = keypair(),
      stranger = keypair(),
      fake = keypair(),
      renamed = keypair(),
      unasked = keypair();
    const events = [
      assertion(relay, fake.pubkey, {
        display: "fname",
        full: "Fake Name",
      }),
      assertion(
        stranger,
        fake.pubkey,
        { display: "forged", full: "Forged" },
        2_000_000,
      ),
      assertion(relay, renamed.pubkey, { display: "old", full: "Old Name" }),
      // A newer malformed head hides the older name at its address.
      signed(relay, {
        kind: 30382,
        created_at: 2_000_000,
        content: "",
        tags: [
          ["d", renamed.pubkey],
          ["p", renamed.pubkey],
        ],
      }),
      assertion(relay, unasked.pubkey, { display: "unasked" }),
    ];
    // Transports admit signed events; the relay key decides, not the signature alone.
    const query = vi.fn(async (_filters: readonly ReadFilter[]) =>
      events.map((event) => eventDto(event)),
    );
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      ...(advertised
        ? { verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false } }
        : {}),
    });
    return { owner, query, relay, fake, renamed };
  }

  it("reads one bounded filter by the relay and keeps only its valid newest heads", async () => {
    const t = verifiedSetup(true);
    try {
      const verified = await t.owner.session.directMessages.verified(
        [t.fake.pubkey, t.renamed.pubkey],
        new AbortController().signal,
      );
      expect(t.query).toHaveBeenCalledOnce();
      expect(t.query.mock.calls[0]?.[0]).toEqual([
        {
          kinds: [30382],
          authors: [t.relay.pubkey],
          // The reader canonicalizes value order.
          "#d": [t.fake.pubkey, t.renamed.pubkey].sort(),
          limit: 2,
        },
      ]);
      expect(verified?.authority.pubkey).toBe(t.relay.pubkey);
      expect([...(verified?.profiles.keys() ?? [])]).toEqual([t.fake.pubkey]);
      expect(verified?.profiles.get(t.fake.pubkey)).toMatchObject({
        displayName: "fname",
        username: "fname",
        fullName: "Fake Name",
      });
      // The shared profile views are not filled by a search read.
      expect(
        t.owner.session.profiles.snapshot().get(t.fake.pubkey),
      ).toBeUndefined();
    } finally {
      t.owner.dispose();
    }
  });

  it("reads nothing where the community advertises no verified names", async () => {
    const t = verifiedSetup(false);
    try {
      const verified = await t.owner.session.directMessages.verified(
        [t.fake.pubkey],
        new AbortController().signal,
      );
      // Nothing was checked, so a caller must not remember it as absent.
      expect(verified).toBeUndefined();
      expect(t.query).not.toHaveBeenCalled();
    } finally {
      t.owner.dispose();
    }
  });

  it("cancels with the caller", async () => {
    const t = verifiedSetup(true);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        t.owner.session.directMessages.verified(
          [t.fake.pubkey],
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      t.owner.dispose();
    }
  });

  it.each([true, false])(
    "names a searched page without a read where the relay is searchable (%s)",
    async (searchable) => {
      const viewer = keypair(),
        relay = keypair(),
        fake = keypair(),
        plain = keypair();
      const head = assertion(relay, fake.pubkey, {
        display: "fname",
        full: "Fake Name",
      });
      const query = vi.fn(async (_filters: readonly ReadFilter[]) => [
        eventDto(head),
      ]);
      const owner = createRelaySession({
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        searchProfiles: async () =>
          [
            profile(fake, { name: "Fak" }),
            head,
            profile(plain, { name: "Plain" }),
          ].map((event) => eventDto(event)),
        verifiedProfiles: {
          pubkey: relay.pubkey,
          multipleIssuers: false,
          ...(searchable ? { searchable: true as const } : {}),
        },
      });
      try {
        const signal = new AbortController().signal;
        const { people } = await owner.session.directMessages.people(
          "fname",
          1,
          signal,
        );
        expect(people.map(({ pubkey }) => pubkey)).toEqual([
          fake.pubkey,
          plain.pubkey,
        ]);
        const verified = await owner.session.directMessages.verified(
          [fake.pubkey, plain.pubkey],
          signal,
        );
        expect(query).toHaveBeenCalledTimes(searchable ? 0 : 1);
        expect([...(verified?.profiles.keys() ?? [])]).toEqual([fake.pubkey]);
        expect(verified?.profiles.get(fake.pubkey)).toMatchObject({
          displayName: "fname",
          fullName: "Fake Name",
        });
        // The search answered once; asking again reads.
        await owner.session.directMessages.verified([fake.pubkey], signal);
        expect(query).toHaveBeenCalledTimes(searchable ? 1 : 2);
      } finally {
        owner.dispose();
      }
    },
  );

  const changes: [string, () => VerifiedProfileAuthority | undefined][] = [
    ["withdrawn", () => undefined],
    ["rotated", () => ({ pubkey: keypair().pubkey, multipleIssuers: false })],
  ];
  it.each(changes)(
    "checks nothing when the authority is %s during the read",
    async (_change, next) => {
      const relay = keypair(),
        fake = keypair();
      let authority: VerifiedProfileAuthority | undefined = {
        pubkey: relay.pubkey,
        multipleIssuers: false,
      };
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const directoryReader = {
        async read() {
          await held;
          return [
            assertion(relay, fake.pubkey, {
              display: "fname",
              full: "Fake Name",
            }),
          ];
        },
      } as unknown as RelayReader;
      const directMessages = createDirectMessages(
        null,
        directoryReader,
        undefined as never,
        undefined,
        undefined,
        new AbortController().signal,
        directoryReader,
        { verifiedHeads: () => new Map() } as never,
        () => authority,
      );
      const pending = directMessages.verified(
        [fake.pubkey],
        new AbortController().signal,
      );
      authority = next();
      release();
      await expect(pending).resolves.toBeUndefined();
    },
  );
});
