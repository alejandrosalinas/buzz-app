// @vitest-environment jsdom
import { soloAdminRecovery } from "../../features/relay/solo-admins";
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  HELD_RETRY_REFUSED,
  createOutbox,
  type Outbox,
  type OutgoingEvent,
} from "../../features/relay/outbox";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { createRelaySession } from "../../features/relay/session";
import { matchesEvent } from "../../features/relay/projection";
import { eventDto, type RelayEvent } from "../../features/relay/events";
import type { RelayWriter } from "../../features/relay/transport";
import { createRelayProfiler } from "../../features/relay/profiling";
import { soloChatLinkMessage } from "../../features/solo/share";
import { OutboxStatus } from "./OutboxStatus";

afterEach(cleanup);
const invitation = {
  event: {
    id: "invite",
    kind: 9000,
    content: "",
    tags: [["p", "a".repeat(64)]],
  },
  delivery: "failed",
} as OutgoingEvent;
function show(item: OutgoingEvent) {
  const retry = vi.fn();
  const add = vi.fn(async () => {});
  const acknowledge = vi.fn(async () => {});
  const items = [item];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    acknowledge,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(
    <OutboxStatus
      outbox={outbox}
      profiling={createRelayProfiler()}
      memberAdditions={{ add }}
    />,
  );
  fireEvent.click(screen.getByText("Outbox · 1 items"));
  return { retry, add, acknowledge };
}

it("labels a setup with unconfirmed creation and withholds abandonment and removal", () => {
  const viewer = keypair();
  const agent = keypair().pubkey;
  const event = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", "chat"],
      ["p", agent],
    ],
  });
  show({
    event,
    delivery: "unknown",
    recovery: soloAdminRecovery("chat", [agent], [agent]),
  });
  expect(
    screen.getByText("Opening agent admin setup · Unconfirmed"),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Abandon admin setup" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Remove from outbox" }),
  ).not.toBeInTheDocument();
});

it("does not offer generic retry for guarded invitations from either profile or composer", () => {
  const { retry } = show({ ...invitation, guarded: true });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Retry from the channel or agent profile/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Remove from outbox" }),
  ).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});

it("does not offer generic retry for a held send and says where to retry it", () => {
  const { retry } = show({
    event: { id: "brief", kind: 9, content: "Brief", tags: [["h", "c"]] },
    held: true,
    delivery: "failed",
  } as OutgoingEvent);
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(HELD_RETRY_REFUSED)).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});

it("does not show private feedback body or generic retry in the channel outbox", () => {
  const retry = vi.fn();
  const items = [
    {
      ...invitation,
      event: { ...invitation.event, kind: 42000, content: "private report" },
    },
  ];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(
    <OutboxStatus
      outbox={outbox}
      profiling={createRelayProfiler()}
      memberAdditions={{ add: vi.fn(async () => {}) }}
    />,
  );
  fireEvent.click(screen.getByText("Outbox · 0 items"));
  expect(screen.queryByText(/private report/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(retry).not.toHaveBeenCalled();
});

it("routes an unadopted no-role invitation through member verification", async () => {
  const { retry, add } = show({
    ...invitation,
    delivery: "unknown",
    event: {
      ...invitation.event,
      tags: [
        ["h", "channel"],
        ["p", "person"],
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("channel", "person", {
      retry: true,
    }),
  );
  expect(retry).not.toHaveBeenCalled();
});
it("keeps a malformed no-role invitation out of generic replay", async () => {
  const { retry, add } = show(invitation);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Reopen Members");
  expect(retry).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

it("routes an ordinary addition retry through fresh membership checks", async () => {
  const { retry, add } = show({
    ...invitation,
    event: {
      ...invitation.event,
      tags: [
        ["h", "channel"],
        ["p", "person"],
        ["role", "member"],
      ],
    },
    recovery: { key: "member-add:channel:person", value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("channel", "person", {
      retry: true,
    }),
  );
  expect(retry).not.toHaveBeenCalled();
});

it("retries a guest addition as a guest", async () => {
  const { add } = show({
    ...invitation,
    event: {
      ...invitation.event,
      tags: [
        ["h", "channel"],
        ["p", "person"],
        ["role", "guest"],
      ],
    },
    recovery: { key: "member-add:channel:person", value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("channel", "person", {
      role: "guest",
      retry: true,
    }),
  );
});

it("retries a guest batch per person as guests, each as a new addition", async () => {
  const { add } = show({
    ...invitation,
    event: {
      ...invitation.event,
      tags: [
        ["h", "channel"],
        ["p", "one"],
        ["p", "two"],
        ["role", "guest"],
      ],
    },
    recovery: { key: "member-add:batch:operation", value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(add.mock.calls).toEqual([
      ["channel", "one", { role: "guest" }],
      ["channel", "two", { role: "guest" }],
    ]),
  );
});

it.each(["failed", "accepted"] as const)(
  "retries a %s batch addition per person, never resending it",
  async (delivery) => {
    const { retry, add, acknowledge } = show({
      ...invitation,
      delivery,
      event: {
        ...invitation.event,
        tags: [
          ["h", "channel"],
          ["p", "one"],
          ["p", "two"],
          ["role", "member"],
        ],
      },
      recovery: { key: "member-add:batch:operation", value: "1" },
    });
    expect(screen.getByText(/Add 2 people/)).toBeVisible();
    add.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "two") throw new Error("Could not add two");
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Could not add two/)).toBeVisible();
    expect(add.mock.calls).toEqual([
      ["channel", "one", {}],
      ["channel", "two", {}],
    ]);
    // Additions settle the batch once everyone is; Retry never clears it.
    expect(acknowledge).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  },
);

it.each(
  (["failed", "unknown", "admitted"] as const).flatMap((failure) =>
    [false, true].map((restart) => ({ failure, restart })),
  ),
)(
  "Diagnostics recovers a Solo-agent $failure receipt (restart: $restart)",
  async ({ failure, restart }) => {
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair(),
      freshAgent = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    let members =
      failure === "admitted" ? [viewer.pubkey, agent.pubkey] : [viewer.pubkey];
    let clock = 1_700_000_000;
    // Released clients could persist this exact Bot grant. Recovery must not
    // need a live admission bypass to construct or finish that saved state.
    const legacy = signed(viewer, {
      kind: 9000,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", channelId],
        ["p", agent.pubkey],
        ["role", "bot"],
      ],
    });
    let records: readonly OutgoingEvent[] = [
      {
        event: eventDto(legacy),
        signed: legacy,
        recovery: {
          key: `member-add:${channelId}:${agent.pubkey}`,
          value: "1",
        },
        delivery: failure === "failed" ? "failed" : "unknown",
        error: failure === "failed" ? "Not committed" : "Receipt lost",
      },
    ];
    const sign = vi.fn<RelayWriter["sign"]>(async (template) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async (_event: RelayEvent) => {
      members = [viewer.pubkey, agent.pubkey];
      clock++;
    });
    const create = () =>
      createRelaySession(
        {
          channelIdentity: true,
          viewer: viewer.pubkey,
          relayAuthor: relay.pubkey,
          media: () => undefined,
          readAgentLibrary: async () => ({
            definitions: [],
            identities: [
              { pubkey: agent.pubkey, name: "Agent" },
              { pubkey: freshAgent.pubkey, name: "Fresh agent" },
            ],
          }),
          writer: { kinds: [9000], sign, publish },
          query: async (filters) =>
            [
              metadata(relay, channelId, "Chat", clock, [
                ["t", "stream"],
                ["t", "buzz.solo"],
                ["private"],
              ]),
              roster(relay, channelId, members, clock),
            ].filter((event) =>
              filters.some((filter) => matchesEvent(event, filter)),
            ),
        },
        {
          outboxStorage: {
            load: () => structuredClone(records),
            save: (next) => {
              records = structuredClone(next);
            },
          },
        },
      );
    let owner = create();
    const ready = async () => {
      await owner.session.outbox?.ready();
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      await owner.session.agentChoices.refresh();
    };
    try {
      await ready();
      // A new ordinary Solo addition still cannot admit an agent.
      await expect(
        owner.session.memberAdditions.add(channelId, freshAgent.pubkey),
      ).rejects.toThrow(/tagging them/);
      expect(publish).not.toHaveBeenCalled();
      const original = records[0];
      assert.exists(original);
      expect(original).toMatchObject({
        recovery: { key: `member-add:${channelId}:${agent.pubkey}` },
        delivery: failure === "failed" ? "failed" : "unknown",
      });
      expect(original.event.tags).toContainEqual(["role", "bot"]);
      expect(original.guarded).not.toBe(true);
      if (restart) {
        owner.dispose();
        owner = create();
        await ready();
      }
      const outbox = owner.session.outbox;
      assert.exists(outbox);
      const view = render(
        <OutboxStatus
          outbox={outbox}
          profiling={owner.session.profiling}
          memberAdditions={owner.session.memberAdditions}
        />,
      );
      try {
        fireEvent.click(screen.getByText("Outbox · 1 items"));
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() =>
          expect(
            records.find((item) => item.event.id === original.event.id)
              ?.acknowledged,
          ).toBe(true),
        );
        expect(publish.mock.calls.map(([event]) => event.id)).toEqual(
          failure === "admitted" ? [] : [original.event.id],
        );
        expect(sign).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        // A completed receipt no longer supplies admission context.
        await expect(
          owner.session.memberAdditions.add(channelId, agent.pubkey),
        ).rejects.toThrow(/tagging them/);
        expect(publish).toHaveBeenCalledTimes(failure === "admitted" ? 0 : 1);
      } finally {
        view.unmount();
      }
    } finally {
      owner.dispose();
    }
  },
);

// The recovery page deliberately has no source inventory or encoder: deleted
// agents and teams must not be needed to finish an already journaled delivery.
it.each(["agent", "team", "solo", "agent-share"] as const)(
  "retries and acknowledges a restored %s share without its deleted source",
  async (kind) => {
    const viewer = keypair();
    let records: readonly OutgoingEvent[] = [];
    let failAcknowledgement = false;
    const storage = {
      load: () => structuredClone(records),
      save: (next: readonly OutgoingEvent[]) => {
        if (failAcknowledgement && next.some((item) => !item.recovery))
          throw new Error("Storage unavailable");
        records = structuredClone(next);
      },
    };
    const sign = vi.fn<RelayWriter["sign"]>(async (event) =>
      signed(viewer, event),
    );
    const interruptedPublish = vi.fn<RelayWriter["publish"]>(async () => {
      throw new Error("Receipt lost");
    });
    const first = createOutbox(
      viewer.pubkey,
      { sign, publish: interruptedPublish },
      storage,
    );
    let restored: ReturnType<typeof createOutbox> | undefined;
    try {
      await first.outbox.ready();
      const id = first.outbox.send(
        {
          kind: 9,
          content:
            kind === "solo"
              ? soloChatLinkMessage("deleted-source")
              : "Snapshot attachment",
          tags: [["h", "dm"]],
        },
        {
          key:
            kind === "solo"
              ? "solo-share-link:deleted-source:dm"
              : kind === "agent-share"
                ? // Sent from Share, for one copy and recipient.
                  `agent-share:${"a".repeat(64)}:${"b".repeat(64)}:${"0".repeat(40)}`
                : // Shares queued by the removed snapshot dialog.
                  `snapshot-share:${kind}:deleted-source`,
          value:
            kind === "solo" || kind === "agent-share"
              ? "1"
              : JSON.stringify({
                  people: [{ pubkey: "b".repeat(64), name: "Recipient" }],
                  level: "none",
                }),
        },
      );
      await waitFor(() => expect(records[0]?.delivery).toBe("unknown"));
      const original = interruptedPublish.mock.calls[0]?.[0];
      first.dispose(); // Interrupted dialog/session; source is no longer available.
      const publish = vi.fn<RelayWriter["publish"]>(async () => {});
      const restoredSign = vi.fn<RelayWriter["sign"]>(async (event) =>
        signed(viewer, event),
      );
      restored = createOutbox(
        viewer.pubkey,
        { sign: restoredSign, publish },
        storage,
      );
      await restored.outbox.ready();
      const outbox = restored.outbox;
      render(
        <OutboxStatus
          outbox={outbox}
          profiling={createRelayProfiler()}
          memberAdditions={{ add: vi.fn(async () => {}) }}
        />,
      );
      fireEvent.click(screen.getByText("Outbox · 1 items"));
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Confirm this message",
        ),
      );
      expect(outbox.snapshot()[0]?.event.id).toBe(id);
      expect(records[0]?.recovery).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(records[0]?.delivery).toBe("accepted"));
      expect(publish.mock.calls[0]?.[0]).toEqual(original);
      expect(restoredSign).not.toHaveBeenCalled();
      if (kind !== "agent") {
        const operation = outbox.snapshot()[0];
        assert.exists(operation);
        restored.observe([signed(viewer, operation.event)]);
      }
      failAcknowledgement = true;
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Storage unavailable",
        ),
      );
      expect(outbox.snapshot()[0]?.recovery).toBeDefined();
      expect(records[0]?.recovery).toBeDefined();
      failAcknowledgement = false;
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByText("Outbox · 0 items")).toBeInTheDocument(),
      );
      expect(records.every((item) => !item.recovery)).toBe(true);
      restored.dispose();
      restored = createOutbox(
        viewer.pubkey,
        { sign: restoredSign, publish },
        storage,
      );
      await restored.outbox.ready();
      expect(restored.outbox.snapshot()).toEqual([]);
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      first.dispose();
      restored?.dispose();
    }
  },
);

it("abandons expired admin setup durably through Outbox and releases the chat gate", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const channel = crypto.randomUUID();
  const creation = signed(viewer, {
    kind: 9007,
    created_at: Math.floor(Date.now() / 1000) - 16 * 60,
    content: "",
    tags: [
      ["h", channel],
      ["p", agent.pubkey],
    ],
  });
  let records: readonly OutgoingEvent[] = [
    {
      event: eventDto(creation),
      signed: creation,
      delivery: "accepted",
      recovery: soloAdminRecovery(channel, [agent.pubkey], [agent.pubkey]),
    },
  ];
  const events = new Map<string, RelayEvent>([[creation.id, creation]]);
  const now = Date.now();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue((creation.created_at + 14 * 60) * 1000);
  let failRemoval = false;
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      if (failRemoval && !next.some((item) => item.recovery))
        throw new Error("Storage unavailable");
      records = structuredClone(next);
    },
  };
  const adminSign = vi.fn<RelayWriter["sign"]>(async (template) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    events.set(event.id, event);
  });
  const open = () =>
    createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        channelIdentity: true,
        media: () => undefined,
        query: async (filters) =>
          [
            ...events.values(),
            metadata(relay, channel, "Work", creation.created_at, [
              ["t", "stream"],
              ["t", "buzz.solo"],
              ["private"],
              ["P", viewer.pubkey],
            ]),
            signed(relay, {
              kind: 39002,
              content: "",
              tags: [
                ["d", channel],
                ["p", viewer.pubkey, "", "owner"],
                ["p", agent.pubkey, "", "member"],
              ],
            }),
          ].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        writer: {
          kinds: [9, 9007],
          sign: async (template) => signed(viewer, template),
          publish,
        },
        memberAdministration: { sign: adminSign, publish },
      },
      { outboxStorage: storage },
    );
  const first = open();
  let resumed: ReturnType<typeof open> | undefined;
  try {
    const session = first.session;
    const outbox = session.outbox;
    assert.exists(outbox);
    await outbox.ready();
    session.channels.ensureList();
    await vi.waitFor(() =>
      expect(session.channels.list().status).toBe("ready"),
    );
    const view = render(
      <OutboxStatus
        outbox={outbox}
        profiling={session.profiling}
        memberAdditions={session.memberAdditions}
      />,
    );
    fireEvent.click(screen.getByText("Outbox · 1 items"));
    const remove = () =>
      screen.getByRole("button", { name: "Abandon admin setup" });
    await screen.findByRole("button", { name: "Abandon admin setup" });
    expect(screen.getByText(/Opening agent admin setup · Sent/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Remove from outbox" }),
    ).not.toBeInTheDocument();
    fireEvent.click(remove());
    let confirmation = screen.getByRole("alertdialog", {
      name: "Abandon admin setup?",
    });
    expect(
      within(confirmation).getByText(/Retry your opening message/),
    ).toBeVisible();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(outbox.snapshot().some((item) => item.recovery)).toBe(true);
    clock.mockReturnValue(now);
    await expect(session.channelWrites.prepareOpening(channel)).rejects.toThrow(
      "expired",
    );
    failRemoval = true;
    fireEvent.click(remove());
    confirmation = screen.getByRole("alertdialog", {
      name: "Abandon admin setup?",
    });
    const confirm = within(confirmation).getByRole("button", {
      name: "Abandon admin setup",
    });
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage unavailable",
    );
    expect(outbox.snapshot().some((item) => item.recovery)).toBe(true);
    await expect(session.channelWrites.prepareOpening(channel)).rejects.toThrow(
      "expired",
    );
    failRemoval = false;
    fireEvent.click(confirm);
    await waitFor(() => expect(outbox.snapshot()).toHaveLength(0));
    expect(records.some((item) => item.recovery)).toBe(false);
    expect(session.channels.get?.(channel)?.members).toContain(agent.pubkey);
    view.unmount();
    const sent = session.messages.send(
      channel,
      "Continue with the current roles",
      [agent.pubkey],
    );
    await vi.waitFor(() => expect(events.has(sent)).toBe(true));
    first.dispose();
    resumed = open();
    await resumed.session.outbox?.ready();
    resumed.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(resumed?.session.channels.list().status).toBe("ready"),
    );
    const next = resumed.session.messages.send(channel, "After restart", [
      agent.pubkey,
    ]);
    await vi.waitFor(() => expect(events.has(next)).toBe(true));
    expect(adminSign).not.toHaveBeenCalled();
    expect(publish.mock.calls.every(([event]) => event.kind === 9)).toBe(true);
  } finally {
    first.dispose();
    resumed?.dispose();
    clock.mockRestore();
  }
});
