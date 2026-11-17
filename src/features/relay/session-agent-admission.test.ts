import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { keypair, ownedProfile, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import { eventDto, type RelayEvent } from "./events";
import { SOLO_LABEL } from "../solo/labels";

type ViewerRole = "owner" | "admin" | "member";

function setup(
  visibility: "private" | "public" = "private",
  initialRole: ViewerRole = "member",
  ownership: "viewer" | "other" | "missing" = "viewer",
) {
  let viewerRole = initialRole;
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const parent = "11111111-1111-4111-8111-111111111111",
    child = "22222222-2222-4222-8222-222222222222";
  let members = [viewer.pubkey];
  let childMembers = [viewer.pubkey];
  let clock = 1700000000;
  let denied = false;
  let foreignRoster = false;
  let libraryFailure = false;
  let profileResponse: "missing" | "unavailable" | undefined;
  let afterPublish = () => {};
  let omitMembership = false;
  const archived: string[] = [];
  let holdRoster: Promise<void> | undefined;
  let releaseRoster: (() => void) | undefined;
  let rosterStarted: (() => void) | undefined;
  let rosterRequested: Promise<void> | undefined;
  let holdSigning: Promise<void> | undefined;
  let releaseSigning: (() => void) | undefined;
  let signingStarted: (() => void) | undefined;
  let signingRequested: Promise<void> | undefined;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) => {
    if (template.kind === 9000 && holdSigning) {
      signingStarted?.();
      await holdSigning;
    }
    return signed(viewer, template);
  });
  const second = keypair(),
    other = keypair();
  const secondAgent = second.pubkey;
  let agentProfile =
    ownership === "missing"
      ? Promise.resolve(
          signed(agent, {
            kind: 0,
            tags: [],
            content: JSON.stringify({ owner: viewer.pubkey }),
          }),
        )
      : ownedProfile(agent, ownership === "viewer" ? viewer : other);
  const secondProfile = ownedProfile(second, other);
  const meta = (id: string, type: string, extra: string[][] = []) =>
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", id], ["t", type], ["name", id], ...extra],
    });
  const membership = (id: string, keys: string[]) =>
    signed(relay, {
      kind: 39002,
      created_at: clock,
      content: "",
      tags: [
        ["d", id],
        ...keys.map((key) =>
          key === viewer.pubkey ? ["p", key, "", viewerRole] : ["p", key],
        ),
      ],
    });
  const publish = vi.fn(async (_event: RelayEvent) => {
    const target = _event.tags.find(([name]) => name === "h")?.[1];
    if (denied) throw new PublishRejected("Only channel admins can add agents");
    const added = _event.tags.flatMap(([tag, key]) =>
      tag === "p" && key ? [key] : [],
    );
    if (!omitMembership && target === parent)
      members = [...new Set([...members, ...added])];
    if (!omitMembership && target === child)
      childMembers = [...new Set([...childMembers, ...added])];
    clock++;
    afterPublish();
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => {
        if (libraryFailure) throw new Error("Fixture library unavailable");
        return {
          definitions: [],
          identities: [
            { pubkey: agent.pubkey, name: "Outside agent" },
            { pubkey: secondAgent, name: "Second agent" },
          ],
        };
      },
      writer: {
        kinds: [9, 9000, 9007],
        sign,
        publish,
      },
      query: async (filters) => {
        if (
          profileResponse === "unavailable" &&
          filters.some((filter) => filter.kinds?.includes(0))
        )
          throw new Error("Profile read unavailable");
        if (
          holdRoster &&
          filters.some(
            (filter) =>
              filter.kinds?.includes(39002) && filter["#d"]?.includes(parent),
          )
        ) {
          rosterStarted?.();
          await holdRoster;
        }
        if (
          libraryFailure &&
          filters.some((filter) => filter.kinds?.includes(30177))
        )
          throw new Error("Fixture inventory unavailable");
        if (foreignRoster && filters.some((filter) => filter["#d"]))
          return [
            roster(agent, child, [viewer.pubkey, agent.pubkey], clock + 1),
          ];
        const events = [
          ...(profileResponse === "missing"
            ? []
            : [eventDto(await agentProfile), eventDto(await secondProfile)]),
          signed(relay, {
            kind: 13535,
            created_at: clock,
            content: "",
            tags: [["-"], ...archived.map((key) => ["p", key])],
          }),
          meta(parent, "stream"),
          meta(child, "stream", [
            [visibility],
            ["t", SOLO_LABEL],
            ["join_role", "guest"],
          ]),
          membership(parent, members),
          membership(child, childMembers),
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  return {
    owner,
    parent,
    child,
    agent: agent.pubkey,
    secondAgent,
    async transferAgent(receive = true) {
      const profile = await ownedProfile(agent, other);
      agentProfile = Promise.resolve(
        signed(agent, {
          kind: 0,
          tags: profile.tags,
          content: profile.content,
          created_at: clock + 10,
        }),
      );
      if (!receive) return;
      await owner.session.read(
        [{ kinds: [0], authors: [agent.pubkey], limit: 1 }],
        { fresh: true },
      );
      expect(
        owner.session.profiles
          .event?.(agent.pubkey)
          ?.tags.find(([tag]) => tag === "auth")?.[1],
      ).toBe(other.pubkey);
    },
    archive: (key: string) => {
      clock++;
      archived.push(key);
    },
    returnForeignRoster: () => {
      foreignRoster = true;
    },
    failLibraryRefresh: () => {
      libraryFailure = true;
    },
    profileResponse: (response: "missing" | "unavailable") => {
      profileResponse = response;
    },
    afterPublish: (callback: () => void) => {
      afterPublish = callback;
    },
    publish,
    sign,
    omitMembership: () => {
      omitMembership = true;
    },
    holdRoster: () => {
      rosterRequested = new Promise<void>((resolve) => {
        rosterStarted = resolve;
      });
      holdRoster = new Promise<void>((resolve) => {
        releaseRoster = resolve;
      });
      return rosterRequested;
    },
    releaseRoster: () => releaseRoster?.(),
    holdSigning: () => {
      signingRequested = new Promise<void>((resolve) => {
        signingStarted = resolve;
      });
      holdSigning = new Promise<void>((resolve) => {
        releaseSigning = resolve;
      });
      return signingRequested;
    },
    releaseSigning: () => releaseSigning?.(),
    setViewerRole: (role: ViewerRole) => {
      viewerRole = role;
      clock++;
    },
    setDenied: (value: boolean) => {
      denied = value;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find((item) => item.id === child)?.channelType,
        ).toBe("solo"),
      );
      await owner.session.agentLibrary.refresh();
    },
  };
}

it.each(["other", "missing"] as const)(
  "adds a selectable agent as Bot when its signed ownership is %s",
  async (ownership) => {
    const test = setup("private", "owner", ownership);
    try {
      await test.ready();
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
        "role",
        "bot",
      ]);
    } finally {
      test.owner.dispose();
    }
  },
);

it("refreshes cached ownership before choosing a new Solo agent's role", async () => {
  const test = setup("private", "owner");
  try {
    await test.ready();
    await test.owner.session.profiles.ensure([test.agent]);
    const cached = test.owner.session.profiles.event?.(test.agent);
    expect(cached).toBeDefined();
    await test.transferAgent(false);
    expect(test.owner.session.profiles.event?.(test.agent)).toBe(cached);
    await test.owner.session.channelWrites.addAgents(test.child, [test.agent]);
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "role",
      "bot",
    ]);
    expect(test.owner.session.profiles.event?.(test.agent)).not.toBe(cached);
  } finally {
    test.owner.dispose();
  }
});

it.each(["missing", "unavailable"] as const)(
  "does not use cached ownership for a later addition when the profile read is %s",
  async (response) => {
    const test = setup("private", "owner");
    try {
      await test.ready();
      await test.owner.session.profiles.ensure([test.agent]);
      test.profileResponse(response);
      const adding = test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      if (response === "unavailable") {
        await expect(adding).rejects.toThrow("Profile read unavailable");
        expect(test.publish).not.toHaveBeenCalled();
      } else {
        await adding;
        expect(test.publish).toHaveBeenCalledOnce();
        expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
          "role",
          "bot",
        ]);
      }
    } finally {
      test.owner.dispose();
    }
  },
);

it("chooses each new agent's role separately in a mixed-ownership Solo addition", async () => {
  const test = setup("private", "owner");
  try {
    await test.ready();
    await test.owner.session.channelWrites.addAgents(test.child, [
      test.agent,
      test.secondAgent,
    ]);
    expect(
      test.publish.mock.calls.map(([event]) =>
        event.tags.filter(([tag]) => tag === "role"),
      ),
    ).toEqual([[["role", "admin"]], [["role", "bot"]]]);
  } finally {
    test.owner.dispose();
  }
});

it.each(
  (["private", "public"] as const).flatMap((visibility) =>
    (["owner", "admin", "member"] as const).map((viewerRole) => ({
      visibility,
      viewerRole,
      addedRole: viewerRole === "owner" ? "admin" : "bot",
    })),
  ),
)(
  "adds an agent as $addedRole for a $viewerRole in a $visibility Solo chat with a Guest default",
  async ({ visibility, viewerRole, addedRole }) => {
    const test = setup(visibility, viewerRole);
    try {
      await test.ready();
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
        test.agent,
      ]);
      expect(test.publish).toHaveBeenCalledOnce();
      expect(test.publish.mock.calls[0]?.[0]).toMatchObject({
        kind: 9000,
        tags: expect.arrayContaining([
          ["h", test.child],
          ["p", test.agent],
          ["role", addedRole],
        ]),
      });
      expect(
        test.owner.session.channels
          .list()
          .channels.find((item) => item.id === test.child)?.members,
      ).toContain(test.agent);
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish).toHaveBeenCalledOnce();
    } finally {
      test.owner.dispose();
    }
  },
);
it.each([
  { roleTags: [] },
  { roleTags: [["role", "guest"]] },
  { roleTags: [["role", "member"]] },
  {
    roleTags: [
      ["role", "bot"],
      ["role", "bot"],
    ],
  },
])(
  "does not reuse a Solo agent receipt with incompatible role tags $roleTags",
  async ({ roleTags }) => {
    const test = setup();
    try {
      await test.ready();
      test.setDenied(true);
      const outbox = test.owner.session.outbox;
      if (!outbox) throw new Error("Missing fixture outbox");
      const previous = outbox.send({
        kind: 9000,
        content: "",
        tags: [["h", test.child], ["p", test.agent], ...roleTags],
      });
      await vi.waitFor(() =>
        expect(
          outbox.snapshot().find((item) => item.event.id === previous)
            ?.delivery,
        ).toBe("failed"),
      );
      test.setDenied(false);
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish.mock.lastCall?.[0].id).not.toBe(previous);
      expect(test.publish.mock.lastCall?.[0].tags).toContainEqual([
        "role",
        "bot",
      ]);
    } finally {
      test.owner.dispose();
    }
  },
);
it("reports channel-specific uncertainty when an accepted addition lacks roster confirmation", async () => {
  const test = setup();
  try {
    await test.ready();
    test.omitMembership();
    vi.useFakeTimers();
    const adding = test.owner.session.channelWrites.addAgents(test.parent, [
      test.agent,
    ]);
    const result = expect(adding).rejects.toThrow(
      /Agent addition is unconfirmed.*Check channel membership/,
    );
    await vi.waitFor(() => expect(test.publish).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  } finally {
    vi.useRealTimers();
    test.owner.dispose();
  }
});

it.each([
  { initialRole: "member", retryRole: "member", addedRole: "bot" },
  { initialRole: "member", retryRole: "owner", addedRole: "bot" },
  { initialRole: "owner", retryRole: "member", addedRole: "admin" },
  {
    initialRole: "owner",
    retryRole: "owner",
    addedRole: "admin",
    transferred: true,
  },
] as const)(
  "keeps the saved $addedRole invitation when $initialRole retries as $retryRole",
  async ({ initialRole, retryRole, addedRole, ...options }) => {
    const test = setup("private", initialRole);
    try {
      await test.ready();
      test.setDenied(true);
      await expect(
        test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
      ).rejects.toThrow(/Only channel admins/);
      expect(
        test.owner.session.channels
          .list()
          .channels.find((item) => item.id === test.child)?.members,
      ).not.toContain(test.agent);
      const first = test.publish.mock.calls[0]?.[0];
      expect(first?.tags).toContainEqual(["role", addedRole]);
      if ("transferred" in options) {
        await test.transferAgent();
        test.profileResponse("unavailable");
      }
      test.setViewerRole(retryRole);
      test.setDenied(false);
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish.mock.calls[1]?.[0]).toEqual(first);
      expect(test.publish).toHaveBeenCalledTimes(2);
    } finally {
      test.owner.dispose();
    }
  },
);
it("preserves ordinary channel admission defaults for an owner", async () => {
  const test = setup("private", "owner");
  try {
    await test.ready();
    await test.owner.session.channelWrites.addAgents(test.parent, [test.agent]);
    expect(test.publish).toHaveBeenCalledOnce();
    const tags = test.publish.mock.calls[0]?.[0].tags ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        ["h", test.parent],
        ["p", test.agent],
      ]),
    );
    expect(tags.filter(([name]) => name === "role")).toEqual([]);
  } finally {
    test.owner.dispose();
  }
});
it("explains how to recover an expired failed invitation without republishing it", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    const now = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await expect(
        test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
      ).rejects.toThrow(/Only channel admins/);
      expect(test.publish).toHaveBeenCalledOnce();
      vi.mocked(Date.now).mockReturnValue(1_700_000_901_000);
      test.setDenied(false);
      await expect(
        test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
      ).rejects.toThrow(/expired.*Outbox.*remove.*add the agent again/i);
      expect(test.publish).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      expect(Date.now).toBe(now);
    }
  } finally {
    test.owner.dispose();
  }
});

it("rejects nonmember identities outside the agent library before adding anyone", async () => {
  const test = setup();
  try {
    await test.ready();
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [
        test.agent,
        "f".repeat(64),
      ]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("rejects a known-archived library agent before adding it to a session", async () => {
  const test = setup();
  try {
    await test.ready();
    test.archive(test.agent);
    await test.owner.session.archives.ensure();
    expect(test.owner.session.archives.state(test.agent)).toBe("archived");
    await expect(
      test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/archived/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("rejects a stale cached identity after the current library refresh fails", async () => {
  const test = setup();
  try {
    await test.ready();
    test.failLibraryRefresh();
    await test.owner.session.agentLibrary.refresh();
    const library = test.owner.session.agentLibrary.snapshot();
    expect(library.status).toBe("error");
    expect(library.identities.map((identity) => identity.pubkey)).toContain(
      test.agent,
    );
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("stops additional invitations when the composing view closes during admission", async () => {
  const test = setup();
  let active = true;
  try {
    await test.ready();
    test.afterPublish(() => {
      active = false;
    });
    await expect(
      test.owner.session.channelWrites.addAgents(
        test.child,
        [test.agent, test.secondAgent],
        () => active,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "p",
      test.agent,
    ]);
  } finally {
    test.owner.dispose();
  }
});

it("does not accept a foreign-signed roster as fresh membership", async () => {
  const test = setup();
  try {
    await test.ready();
    test.returnForeignRoster();
    await expect(
      test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/refresh channel membership/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it.each(["roster", "signing"])(
  "stops admission after native evidence disappears at the %s boundary",
  async (boundary) => {
    const test = setup();
    let active = true;
    try {
      await test.ready();
      const started =
        boundary === "roster" ? test.holdRoster() : test.holdSigning();
      const admission = test.owner.session.channelWrites.addAgents(
        test.parent,
        [test.agent],
        () => active,
      );
      await started;
      active = false; // Legacy choice remains available to the broad session API.
      if (boundary === "roster") test.releaseRoster();
      else test.releaseSigning();
      await expect(admission).rejects.toThrow(/cancelled/);
      expect(test.publish).not.toHaveBeenCalled();
      if (boundary === "roster") expect(test.sign).not.toHaveBeenCalled();
      else expect(test.sign).toHaveBeenCalledOnce();
    } finally {
      test.releaseRoster();
      test.releaseSigning();
      test.owner.dispose();
    }
  },
);
