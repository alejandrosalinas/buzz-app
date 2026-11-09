// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentConnectionForm,
  connectionDraft,
  connectionMentions,
} from "./AgentConnectionSetup";
import type { Agents, RegisteredAgentType } from "./service";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { PortableAgent } from "./native";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const candidate: PortableAgent = {
  source: "installed",
  pubkey: "a".repeat(64),
  name: "Helper",
  relay: "wss://example.test",
  connection: {
    runtime: "goose",
    provider: "anthropic",
    model: "saved-model",
    effort: "high",
  },
};
const type = {
  key: "buzz.goose/goose",
  title: "Goose",
  defaults: () => ({ config: { model: "", effort: "" } }),
  importShared: (saved: {
    runtime?: string;
    provider?: string;
    model: string;
  }) =>
    saved.runtime === "goose"
      ? { provider: saved.provider, model: saved.model, effort: "" }
      : undefined,
} as RegisteredAgentType;

it("restores compatible saved selections without silently substituting an unavailable runtime", () => {
  expect(connectionDraft(candidate, [type])).toEqual({
    type: type.key,
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  expect(
    connectionDraft(
      {
        ...candidate,
        connection: { runtime: "buzz-agent", model: "saved-model" },
      },
      [type],
    ),
  ).toBeUndefined();
  expect(
    connectionDraft({ ...candidate, connection: { runtime: "goose" } }, [type])
      ?.config,
  ).toMatchObject({ model: "", effort: "" });
});

it("connects the exact identity with reviewed defaults and retains errors for retry", async () => {
  const port = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue({ notes: [] });
  const types = [type];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm agents={agents} candidate={candidate} scope="scope" />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection interrupted",
  );
  expect(port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: candidate.pubkey,
    type: type.key,
    scope: "scope",
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByRole("heading", { name: / connected$/ }),
  ).toBeVisible();
});

/** An offline agent the viewer owns, mentioned by the viewer in a shared channel. */
async function ownedAgentChannel(
  channelType: "dm" | "stream" | "forum",
  {
    choicesReady = false,
    listed = false,
  }: {
    /** Agent choices are complete and none covers the agent yet. */
    choicesReady?: boolean;
    /** The channel list carries the channel, so its roster updates live. */
    listed?: boolean;
  } = {},
) {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const { bytesToHex } = await import("nostr-tools/utils");
  const secret = new Uint8Array(32);
  secret[31] = 1;
  const viewer = bytesToHex(schnorr.getPublicKey(secret));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${candidate.pubkey}:`),
  );
  const profile = {
    id: "f".repeat(64),
    kind: 0,
    pubkey: candidate.pubkey,
    created_at: 1,
    content: "{}",
    tags: [
      [
        "auth",
        viewer,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), secret)),
      ],
    ],
  };
  const view = { status: "ready", events: [profile] };
  const channel = {
    id: channelType,
    name: "Helper",
    channelType,
    members: [viewer, candidate.pubkey],
    viewerRole: "member",
  } as ChannelSummary;
  const state = {
    choices: {
      complete: choicesReady,
      identities: [],
      archives: { status: "ready", archived: [] },
    } as {
      complete: boolean;
      archives: { status: "ready"; archived: string[] };
      identities: { pubkey: string; managed: boolean; messageable: boolean }[];
    },
    presence: "offline",
    list: { status: "ready", channels: listed ? [channel] : [] },
  };
  const profiles = new Map([
    [candidate.pubkey, { name: candidate.name, isAgent: true }],
  ]);
  type Store = keyof typeof state;
  const listeners: Record<Store, Set<() => void>> = {
    choices: new Set(),
    presence: new Set(),
    list: new Set(),
  };
  const subscribe = (store: Store) => (listener: () => void) => {
    listeners[store].add(listener);
    return () => {
      listeners[store].delete(listener);
    };
  };
  /** Tells only `store`'s subscribers that its `state` entry changed. */
  const notify = (store: Store) => {
    for (const listener of [...listeners[store]]) listener();
  };
  const noop = () => () => {};
  const reply = vi.fn();
  const observe = vi.fn(() => ({
    snapshot: () => view,
    subscribe: noop,
    dispose: () => {},
  }));
  const sendObservers = new Set<
    Parameters<import("../relay/outbox").Outbox["observeSend"]>[0]
  >();
  const session = {
    outbox: {
      observeSend: (
        listener: Parameters<
          import("../relay/outbox").Outbox["observeSend"]
        >[0],
      ) => {
        sendObservers.add(listener);
        return () => {
          sendObservers.delete(listener);
        };
      },
    },
    messages: { reply },
    scope: "scope",
    viewer,
    observe,
    profiles: {
      subscribe: noop,
      snapshot: () => profiles,
      event: () => profile,
    },
    agentChoices: {
      subscribe: subscribe("choices"),
      snapshot: () => state.choices,
    },
    presence: {
      status: () => state.presence,
      subscribe: (_key: string, listener: () => void) =>
        subscribe("presence")(listener),
    },
    channels: { subscribeList: subscribe("list"), list: () => state.list },
  } as unknown as import("../relay/session").RelaySession;
  const types = [type];
  const snapshot = {};
  const portable = vi.fn(async () => ({
    agents: [candidate],
    warnings: [],
    here: [],
  }));
  const agents = {
    port: vi
      .fn()
      .mockRejectedValueOnce(new Error("Import interrupted"))
      .mockResolvedValue({ notes: [] }),
    types: () => types,
    snapshot: () => snapshot,
    subscribe: noop,
    find: () => undefined,
    portable,
  } as unknown as Agents;
  const { AgentConnectionSetup } = await import("./AgentConnectionSetup");
  const { AgentsContext } = await import("./react");
  const setup = (sessionValue = session, channelValue = channel) => (
    <ToastProvider>
      <AgentsContext.Provider value={agents}>
        <AgentConnectionSetup
          session={sessionValue}
          channel={channelValue}
          rows={[
            {
              id: "b".repeat(64),
              channelId: channel.id,
              createdAt: 1,
              content: "Hello",
              attachments: [],
              reactions: [],
              replyCount: 0,
              participants: [],
              threadRootId: "c".repeat(64),
              authorId: viewer,
              mentions: [candidate.pubkey, "human"],
            },
          ]}
        />
      </AgentsContext.Provider>
    </ToastProvider>
  );
  /** Reports the viewer sending the mention in `rows` (or a variant) live. */
  const sendMention = (kind = 9, author = viewer, destination = channel.id) => {
    const event = {
      id: "b".repeat(64),
      kind,
      pubkey: author,
      created_at: 1,
      content: "Hello",
      tags: [
        ["h", destination],
        ["p", candidate.pubkey],
      ],
    };
    return [...sendObservers].map((observer) =>
      observer(event, new AbortController().signal),
    );
  };
  /** Sends the mention and confirms its delivery. */
  const deliverMention = (destination = channel.id) => {
    act(() => {
      for (const delivered of sendMention(9, viewer, destination))
        delivered?.([]);
    });
  };
  return {
    viewer,
    state,
    notify,
    reply,
    observe,
    session,
    portable,
    agents,
    channel,
    setup,
    sendMention,
    deliverMention,
  };
}

it.each(["dm", "stream", "forum"] as const)(
  "persists channel-scoped dismissal for the exact owned %s identity and preserves explicit connection",
  async (channelType) => {
    const {
      viewer,
      state,
      notify,
      reply,
      observe,
      session,
      portable,
      agents,
      channel,
      setup,
      sendMention,
      deliverMention,
    } = await ownedAgentChannel(channelType);
    const { act } = await import("@testing-library/react");
    let mounted = render(setup());
    if (channelType !== "dm") {
      // History hydration alone does not even start candidate discovery.
      expect(portable).not.toHaveBeenCalled();
      for (const args of [
        [40003, viewer, channel.id],
        [9, "other", channel.id],
        [9, viewer, "elsewhere"],
      ] as const) {
        expect(sendMention(args[0], args[1], args[2])).toEqual([undefined]);
      }
      const pending = sendMention();
      expect(portable).not.toHaveBeenCalled();
      act(() => {
        for (const delivered of pending) delivered?.([]);
      });
    }
    await waitFor(() => expect(portable).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    act(() => {
      state.choices = {
        complete: true,
        archives: { status: "ready", archived: [] },
        identities: [
          { pubkey: candidate.pubkey, managed: false, messageable: true },
        ],
      };
      notify("choices");
    });
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    act(() => {
      state.choices = {
        complete: true,
        identities: [],
        archives: { status: "ready", archived: [candidate.pubkey] },
      };
      notify("choices");
    });
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    act(() => {
      state.choices = {
        ...state.choices,
        archives: { status: "ready", archived: [] },
      };
      notify("choices");
    });
    expect(
      await screen.findByRole("heading", { name: /^Connect / }),
    ).toBeVisible();
    expect(portable).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledExactlyOnceWith([
      { kinds: [0], authors: [candidate.pubkey], limit: 1 },
    ]);
    const user = userEvent.setup();
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
    await user.click(
      screen.getByRole("button", {
        name: "Dismiss connection setup for Helper",
      }),
    );
    expect(
      await screen.findByText("Could not save dismissal. Try again."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect" })).toBeVisible();
    storage.mockRestore();
    await user.click(
      screen.getByRole("button", {
        name: "Dismiss connection setup for Helper",
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Agent connection setup" }),
    ).toBeNull();
    expect(agents.port).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    // Navigation to another channel remains eligible; returning retains dismissal.
    mounted.rerender(setup(session, { ...channel, id: "other-channel" }));
    deliverMention("other-channel");
    await screen.findByRole("button", { name: "Connect" });
    mounted.rerender(setup());
    deliverMention();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    // A fresh mount reads durable state, as after reload. A new scope is independent.
    mounted.unmount();
    mounted = render(setup());
    deliverMention();
    await waitFor(() => expect(observe).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    mounted.rerender(setup({ ...session, scope: "other-viewer-community" }));
    deliverMention();
    await user.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Import interrupted",
    );
    act(() => {
      state.presence = "online";
      notify("presence");
    });
    expect(screen.queryByRole("heading", { name: /^Connect / })).toBeNull();
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Import interrupted",
    );
    if (channelType !== "dm") {
      act(() => {
        state.presence = "offline";
        notify("presence");
      });
      await user.click(await screen.findByRole("button", { name: "Connect" }));
      await screen.findByRole("button", { name: "Ask Helper to respond" });
      expect(reply).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", { name: "Ask Helper to respond" }),
      );
      expect(reply).toHaveBeenCalledExactlyOnceWith(
        channel.id,
        "c".repeat(64),
        "Please respond to my message above.",
        [candidate.pubkey],
        [],
        "b".repeat(64),
      );
    }
  },
);

it.each(["stream", "forum"] as const)(
  "offers no %s setup for a mentioned agent outside the channel roster",
  async (channelType) => {
    const f = await ownedAgentChannel(channelType, { choicesReady: true });
    render(f.setup(f.session, { ...f.channel, members: [f.viewer] }));
    f.deliverMention();
    // A mounted candidate observes owner evidence on mount, inside the delivery's act.
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.portable).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Agent connection setup" }),
    ).toBeNull();
  },
);

it.each(["stream", "forum"] as const)(
  "withdraws %s setup when a render drops the agent from the roster",
  async (channelType) => {
    const f = await ownedAgentChannel(channelType, { choicesReady: true });
    const mounted = render(f.setup());
    f.deliverMention();
    await screen.findByRole("region", { name: "Agent connection setup" });
    mounted.rerender(f.setup(f.session, { ...f.channel, members: [f.viewer] }));
    expect(
      screen.queryByRole("region", { name: "Agent connection setup" }),
    ).toBeNull();
  },
);

// The viewer case keeps the agent listed, so only a viewer check that reads the
// live roster withdraws the card.
it.each([
  ["stream", "agent"],
  ["forum", "agent"],
  ["stream", "viewer"],
  ["forum", "viewer"],
] as const)(
  "withdraws %s setup when a live roster update drops the %s, without a parent render",
  async (channelType, dropped) => {
    const f = await ownedAgentChannel(channelType, {
      choicesReady: true,
      listed: true,
    });
    render(f.setup());
    f.deliverMention();
    await screen.findByRole("region", { name: "Agent connection setup" });
    act(() => {
      f.state.list = {
        status: "ready",
        channels: [
          {
            ...f.channel,
            members: [dropped === "agent" ? f.viewer : candidate.pubkey],
          },
        ],
      };
      f.notify("list");
    });
    expect(
      screen.queryByRole("region", { name: "Agent connection setup" }),
    ).toBeNull();
  },
);

it("keeps dismissal disabled while an explicit import is pending", async () => {
  let finish!: (result: { notes: string[] }) => void;
  const port = vi.fn(
    () =>
      new Promise<{ notes: string[] }>((resolve) => {
        finish = resolve;
      }),
  );
  const types = [type];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  const onDismiss = vi.fn();
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      onDismiss={onDismiss}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  const dismiss = screen.getByRole("button", {
    name: "Dismiss connection setup for Helper",
  });
  try {
    expect(port).toHaveBeenCalledOnce();
    expect(dismiss).toBeDisabled();
    await user.click(dismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  } finally {
    finish({ notes: [] });
  }
  await screen.findByRole("heading", { name: "Helper connected" });
  expect(dismiss).toBeEnabled();
  await user.click(dismiss);
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("removes a disabled harness from the choices and never imports from a preview", async () => {
  const { act } = await import("@testing-library/react");
  let types: readonly RegisteredAgentType[] = [type];
  const snapshot = {};
  const listeners = new Set<() => void>();
  const port = vi.fn();
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      preview
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Preview only");
  expect(port).not.toHaveBeenCalled();
  act(() => {
    types = [];
    for (const listener of [...listeners]) listener();
  });
  expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
    "Choose harness",
  );
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  expect(screen.queryByText("Goose")).toBeNull();
});

it("uses only explicit own delivered mentions and deduplicates to the latest request", () => {
  const row: ChannelMessage = {
    channelId: "channel",
    createdAt: 1,
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    id: "first",
    authorId: "viewer",
    mentions: ["agent", "viewer"],
    content: "@someone",
  };
  const rows: ChannelMessage[] = [
    row,
    { ...row, id: "latest" },
    { ...row, authorId: "other", mentions: ["other-agent"] },
    { ...row, id: "edited", edited: true },
    { ...row, id: "delegated", signerId: "someone-else" },
    { ...row, id: "failed", delivery: "failed" },
    { ...row, id: "sending", delivery: "sending" },
    { ...row, id: "unknown", delivery: "unknown" },
  ];
  const found = connectionMentions(rows, "viewer");
  expect([...found.keys()]).toEqual(["agent"]);
  expect(found.get("agent")?.id).toBe("latest");
});

it("requires an explicit follow-up after import and preserves send failure for retry", async () => {
  const types = [type];
  const snapshot = {};
  const port = vi.fn(async () => ({ notes: [] }));
  const sendAgain = vi
    .fn()
    .mockRejectedValueOnce(new Error("Cannot send here"))
    .mockResolvedValue(undefined);
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      onSendAgain={sendAgain}
    />,
  );
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Ask Helper to respond" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("button", { name: "Ask Helper to respond" });
  expect(sendAgain).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Ask Helper to respond" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot send here",
  );
  await user.click(
    screen.getByRole("button", { name: "Ask Helper to respond" }),
  );
  expect(
    await screen.findByRole("button", { name: "Follow-up queued" }),
  ).toBeDisabled();
  expect(sendAgain).toHaveBeenCalledTimes(2);
  expect(port).toHaveBeenCalledOnce();
});

it("requires the model control to resolve provider and model, and revokes readiness after edits", async () => {
  const port = vi.fn(async () => ({ notes: [] }));
  const types: RegisteredAgentType[] = [
    {
      ...type,
      createModelReportsReadiness: true,
      CreateModel: ({ config, onChange, onReadyChange }) => {
        const values = config as { provider: string; model: string };
        const ready = !!values.provider?.trim() && !!values.model?.trim();
        useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
        return (
          <>
            <input
              aria-label="Provider"
              value={values.provider ?? ""}
              onChange={(event) =>
                onChange({ ...values, provider: event.target.value })
              }
            />
            <input
              aria-label="Model"
              value={values.model}
              onChange={(event) =>
                onChange({ ...values, model: event.target.value })
              }
            />
          </>
        );
      },
    },
  ];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={{ ...candidate, connection: { runtime: "goose" } }}
      scope="scope"
    />,
  );
  const user = userEvent.setup();
  const connect = screen.getByRole("button", { name: "Connect" });
  expect(connect).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Provider" }),
    "anthropic",
  );
  expect(connect).toBeDisabled();
  await user.click(connect);
  expect(port).not.toHaveBeenCalled();
  await user.type(screen.getByRole("textbox", { name: "Model" }), "model-a");
  expect(connect).toBeEnabled();
  await user.clear(screen.getByRole("textbox", { name: "Provider" }));
  expect(connect).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Provider" }),
    "anthropic",
  );
  await user.click(connect);
  expect(port).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        provider: "anthropic",
        model: "model-a",
      }),
    }),
  );
});

it("offers another harness when the saved plugin cannot report model readiness", async () => {
  const unsupported = {
    ...type,
    CreateModel: () => <span>Old plugin model</span>,
  };
  const replacement = {
    ...type,
    key: "replacement",
    title: "Replacement",
    importShared: () => undefined,
  };
  const snapshot = {};
  const port = vi.fn(async () => ({ notes: [] }));
  const types = [unsupported, replacement];
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm agents={agents} candidate={candidate} scope="scope" />,
  );
  expect(screen.getByText(/Choose a harness to continue/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  expect(screen.queryByText("Old plugin model")).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Replacement" }));
  expect(
    screen.queryByText(/Choose a harness to continue/),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({ type: "replacement" }),
    ),
  );
});
