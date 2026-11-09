// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  Agent,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentDetails } from "./AgentDetails";
import {
  AccountRecoverySheet,
  createProfileActions,
} from "../builderlab/adapter-type/SignInFooter";
import { SignInAction } from "../builderlab/adapter-type/SignInAction";
import { deferred, createTestSession } from "../builderlab/test-helpers";

vi.mock("../builderlab/oauth/browser", async (original) => ({
  ...(await original<typeof import("../builderlab/oauth/browser")>()),
  browserLoginAvailable: () => true,
}));

afterEach(cleanup);

it("keeps one provider footer across tabs and measures its changing height for the scroll area", async () => {
  const signedIn = deferred<void>();
  const callbacks = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private changed: () => void) {}
      observe(target: Element) {
        callbacks.set(target, this.changed);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  function Footer() {
    const [connected, setConnected] = useState(false);
    return connected ? null : (
      <section aria-label="Account access">
        <Button
          onClick={async () => {
            await signedIn.promise;
            setConnected(true);
          }}
        >
          Sign in
        </Button>
      </section>
    );
  }
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "f".repeat(64),
    name: "Ada",
    type: "test/hosted",
    place: "hosted",
    relay: "wss://current.example",
    config: {},
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    key: agent.type,
    pluginId: "test",
    revision: "1",
    id: "hosted",
    title: "Hosted",
    defaults: () => ({ config: {} }),
    PanelFooter: Footer,
    ProfileActions: ({ children }: { children: ReactNode }) => (
      <section aria-label="Profile editing">{children}</section>
    ),
    tabs: [
      {
        id: "settings",
        title: "Identity",
        role: "settings",
        component: () => <p>Provider settings</p>,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: () => <p>Agent activity</p>,
      },
    ],
  } as RegisteredAgentType;
  const agents = {
    subscribe: () => () => {},
    snapshot: () => ({ agents: [agent] }),
    configHistory: () => undefined,
    agentSync: () => undefined,
    addedTabs: () => [],
    memberships: () => [],
  } as unknown as Agents;
  render(
    <AgentDetails
      agents={agents}
      agent={agent}
      type={type}
      types={[type]}
      channels={[]}
      memories={undefined}
      onRemoved={vi.fn()}
      messageAction={() => <Button>Message</Button>}
    />,
  );
  const card = screen.getByRole("region", { name: "Account access" });
  expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Profile editing" })).getByRole(
      "button",
      { name: "Agent profile actions" },
    ),
  ).toBeVisible();
  const footer = card.parentElement;
  if (!footer) throw new Error("Missing pane footer");
  const scroll = footer.previousElementSibling as HTMLElement;
  const width = vi.spyOn(scroll, "clientWidth", "get").mockReturnValue(420);
  const left = vi.spyOn(scroll, "clientLeft", "get").mockReturnValue(0);
  const box = vi.spyOn(footer, "getBoundingClientRect");
  box.mockReturnValue({ height: 240 } as DOMRect);
  act(() => callbacks.get(footer)?.());
  await waitFor(() =>
    expect(scroll.style.getPropertyValue("--agent-footer-height")).toBe(
      "240px",
    ),
  );
  expect(footer.style.width).toBe("420px");
  expect(footer.style.left).toBe("0px");
  const user = userEvent.setup();
  for (const name of ["Memory", "Activity", "Settings", "Identity"]) {
    await user.click(screen.getByRole("tab", { name }));
    expect(screen.getByRole("region", { name: "Account access" })).toBe(card);
  }
  box.mockReturnValue({ height: 320 } as DOMRect);
  act(() => callbacks.get(footer)?.());
  await waitFor(() =>
    expect(scroll.style.getPropertyValue("--agent-footer-height")).toBe(
      "320px",
    ),
  );
  // Resize/removal of a scrollbar and a left-side scrollbar use the same inset.
  width.mockReturnValue(460);
  left.mockReturnValue(12);
  act(() => callbacks.get(scroll)?.());
  await waitFor(() => expect(footer.style.width).toBe("460px"));
  expect(footer.style.left).toBe("12px");
  const selected = screen.getByRole("tab", { name: "Settings" });
  await user.click(selected);
  const signIn = screen.getByRole("button", { name: "Sign in" });
  act(() => signIn.focus());
  try {
    await user.keyboard("{Enter}");
    expect(signIn).toHaveFocus();
  } finally {
    await act(async () => signedIn.resolve());
  }
  box.mockReturnValue({ height: 0 } as DOMRect);
  act(() => callbacks.get(footer)?.());
  expect(screen.queryByRole("region", { name: "Account access" })).toBeNull();
  await waitFor(() =>
    expect(scroll.style.getPropertyValue("--agent-footer-height")).toBe("0px"),
  );
  await waitFor(() => expect(selected).toHaveFocus());
  box.mockRestore();
  width.mockRestore();
  left.mockRestore();
});

it.each([
  { target: "name", recovery: false },
  { target: "avatar", recovery: false },
  { target: "name", recovery: true },
  { target: "avatar", recovery: true },
])(
  "closes the $target editor for account access (recovery: $recovery)",
  async ({ target, recovery }) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    // Switching accounts from the sheet is the development broker's recovery.
    if (recovery) vi.stubEnv("VITE_BUZZ_LIVE", "1");
    let canUseRemoteAgents = true;
    const callbacks = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private changed: () => void) {}
        observe() {
          callbacks.add(this.changed);
        }
        disconnect() {
          callbacks.delete(this.changed);
        }
        unobserve() {}
      },
    );
    const session = createTestSession(async () => ({
      revision: "credential",
      account: {
        subject: "account",
        email: "a@example.com",
        canUseRemoteAgents,
        canUseBuilderlabDecisions: false,
      },
    }));
    await session.signIn();
    const signIn = vi.spyOn(session, "signIn");
    const agent = {
      key: "a".repeat(64),
      pubkey: "a".repeat(64),
      owner: "f".repeat(64),
      name: "Ada",
      type: "test/hosted",
      place: "hosted",
      relay: "wss://current.example",
      config: {},
      attention: {},
      skipped: {},
      timers: {},
      attentionEnabled: true,
    } satisfies Agent;
    function RecoverySettings() {
      const login = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <>
          <SignInAction session={session} />
          <AccountRecoverySheet
            session={session}
            mismatch={false}
            active={
              login.status === "signed-in" &&
              login.account?.canUseRemoteAgents === false
            }
          />
        </>
      );
    }
    const type = {
      key: agent.type,
      pluginId: "test",
      revision: "1",
      id: "hosted",
      title: "Hosted",
      defaults: () => ({ config: {} }),
      ProfileActions: createProfileActions(session),
      tabs: [
        {
          id: "settings",
          title: "Identity",
          role: "settings",
          component: RecoverySettings,
        },
      ],
    } as RegisteredAgentType;
    const agents = {
      save: vi.fn(),
      subscribe: () => () => {},
      snapshot: () => ({ agents: [agent] }),
      configHistory: () => undefined,
      agentSync: () => undefined,
      addedTabs: () => [],
      memberships: () => [],
    } as unknown as Agents;
    const view = render(
      <AgentDetails
        agents={agents}
        agent={agent}
        type={type}
        types={[type]}
        channels={[]}
        memories={undefined}
        onRemoved={vi.fn()}
        messageAction={() => <Button>Message</Button>}
      />,
    );
    try {
      const user = userEvent.setup();
      if (!recovery)
        await user.click(screen.getByRole("tab", { name: "Memory" }));
      await user.click(
        screen.getByRole("button", { name: "Agent profile actions" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: `Change ${target}` }),
      );
      if (target === "name")
        expect(
          screen.getByRole("textbox", { name: "Agent name" }),
        ).toBeVisible();
      else
        expect(
          screen.getByRole("dialog", { name: "Change avatar" }),
        ).toBeVisible();
      if (recovery) {
        canUseRemoteAgents = false;
        await act(() => session.signIn());
      } else act(() => session.signOut());
      act(() => {
        for (const callback of callbacks) callback();
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("textbox", { name: "Agent name" }),
        ).toBeNull();
        expect(
          screen.queryByRole("dialog", { name: "Change avatar" }),
        ).toBeNull();
      });
      if (recovery) {
        const sheet = await screen.findByRole("region", {
          name: "Try another Builderlab account",
        });
        const identity = screen.getByRole("complementary", {
          name: "Ada identity",
        });
        const scroll = identity.parentElement;
        expect(scroll).not.toContainElement(sheet);
        expect(scroll?.nextElementSibling).toContainElement(sheet);
        expect(
          screen.queryByRole("button", { name: "Sign in to Builderlab" }),
        ).toBeNull();
      }
      expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
      expect(screen.queryByText("Offline")).toBeNull();
      if (!recovery)
        expect(
          screen.queryByRole("button", { name: "Sign in to Builderlab" }),
        ).toBeNull();
      const attempts = signIn.mock.calls.length;
      act(() => screen.getByRole("tab", { selected: true }).focus());
      await user.keyboard("{Enter}");
      expect(signIn).toHaveBeenCalledTimes(attempts);
      expect(agents.save).not.toHaveBeenCalled();
      if (recovery) {
        const useAnother = screen.getByRole("button", {
          name: "Use another account",
        });
        act(() => useAnother.focus());
        await user.keyboard("{Enter}");
        const reconnect = await screen.findByRole("button", {
          name: "Sign in to Builderlab",
        });
        expect(reconnect).toBeEnabled();
        await waitFor(() =>
          expect(screen.getByRole("tab", { selected: true })).toHaveFocus(),
        );
        expect(session.snapshot().status).toBe("signed-out");
        expect(signIn).toHaveBeenCalledTimes(attempts);
        const selected = screen.getByRole("tab", { selected: true });
        act(() => selected.focus());
        await act(() => session.signIn());
        await screen.findByRole("button", { name: "Use another account" });
        act(() => session.signOut());
        await screen.findByRole("button", { name: "Sign in to Builderlab" });
        expect(selected).toHaveFocus();
      }
      canUseRemoteAgents = true;
      await act(() => session.signIn());
      act(() => {
        for (const callback of callbacks) callback();
      });
      expect(
        await screen.findByRole("button", { name: "Agent profile actions" }),
      ).toBeVisible();
      expect(screen.queryByRole("textbox", { name: "Agent name" })).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: "Change avatar" }),
      ).toBeNull();
      if (recovery) {
        canUseRemoteAgents = false;
        await act(() => session.signIn());
        const sheet = await screen.findByRole("region", {
          name: "Try another Builderlab account",
        });
        const footer = sheet.parentElement?.parentElement;
        if (!footer) throw new Error("Missing pane notice host");
        // An entrance still at opacity 0 can correctly finish exit immediately.
        await waitFor(() =>
          expect(sheet.parentElement).toHaveStyle({ opacity: "1" }),
        );
        const memory = screen.getByRole("tab", { name: "Memory" });
        act(() => memory.focus());
        fireEvent.click(memory);
        // The host must survive clearing the notice so Motion can finish exit.
        expect(footer).toBeInTheDocument();
        expect(sheet).toBeInTheDocument();
        expect(sheet.closest("[inert]")).toHaveAttribute("aria-hidden", "true");
        await waitFor(() => expect(sheet).not.toBeInTheDocument());
        expect(footer).toBeEmptyDOMElement();
        expect(screen.getByRole("tab", { name: "Memory" })).toHaveFocus();
      }
    } finally {
      view.unmount();
      session.dispose();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);

function Settings({ agent, save }: AgentViewProps<{ reply: string }>) {
  const form = useId();
  const [saved, setSaved] = useState(agent.config.reply);
  const [reply, setReply] = useState(saved);
  const [saving, setSaving] = useState(false);
  return (
    <form
      id={form}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await save({ reply });
          setSaved(reply);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Input aria-label="Reply" value={reply} onValueChange={setReply} />
      <AgentSaveButton form={form} disabled={reply === saved} saving={saving} />
    </form>
  );
}

it("shows every affected community with unsaved shared settings and submits the portaled Save", async () => {
  const user = userEvent.setup();
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "f".repeat(64),
    name: "Ada",
    type: "test/echo",
    place: "here",
    relay: "wss://current.example",
    config: { reply: "Hello" },
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    key: agent.type,
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: Settings,
      },
    ],
  } as RegisteredAgentType;
  let finish!: () => void;
  const saving = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const agents = {
    save: vi.fn(() => saving),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => ({ agents: [agent] }),
    configHistory: () => undefined,
    agentSync: () => undefined,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
    memberships: () => [
      { key: agent.key, origin: "https://current.example", connected: true },
      { key: "other", origin: "wss://other.example", connected: false },
      { key: "unknown", origin: "https://unknown.example", connected: true },
      {
        key: "leaving",
        origin: "https://leaving.example",
        connected: true,
        deleting: true,
      },
    ],
  } as unknown as Agents;
  let known = {
    memberships: [
      {
        id: "https://other.example",
        name: "Feedback",
        icon: "https://images.example/pollen.png",
      },
      {
        id: "https://current.example",
        name: "Current",
        icon: "https://images.example/current.png",
      },
    ],
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => known,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CommunityReader;
  const view = render(
    <AgentDetails
      agents={agents}
      agent={agent}
      type={type}
      types={[type]}
      channels={[]}
      memories={undefined}
      communities={communities}
      onRemoved={() => {}}
      messageAction={() => null}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Shared across").closest("[inert]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.type(field, "!");
  expect(field).toHaveFocus();
  const badge = screen.getByText("Shared across");
  expect(badge).toHaveTextContent("Current, Feedback, unknown.example");
  expect(badge).not.toHaveTextContent("leaving");
  expect(
    Array.from(badge.querySelectorAll("img"), (image) =>
      image.getAttribute("src"),
    ),
  ).toEqual([
    "https://images.example/current.png",
    "https://images.example/pollen.png",
  ]);
  act(() => {
    known = {
      memberships: [
        {
          id: "https://other.example",
          name: "Feedback",
          icon: "javascript:alert(1)",
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(badge.querySelector("img")).toBeNull();
  await user.click(badge);
  const popover = await screen.findByRole("dialog", {
    name: "Ada’s shared settings",
  });
  expect(popover).toHaveTextContent(
    "Ada’s name, instructions, and settings are shared across these communities:",
  );
  expect(popover).not.toHaveTextContent(/pictures|attention/i);
  expect(popover).toHaveTextContent("Feedback");
  expect(popover).toHaveTextContent("current.example");
  expect(popover).toHaveTextContent("unknown.example");
  const memberships = vi.spyOn(agents, "memberships").mockReturnValue([
    { key: "other", origin: "wss://other.example", connected: false },
    { key: agent.key, origin: "https://current.example", connected: true },
  ]);
  act(() => {
    known = { ...known };
    for (const listener of listeners) listener();
  });
  expect(popover).toHaveTextContent(
    "Ada’s name, instructions, and settings are shared across these communities:",
  );
  expect(within(popover).getAllByRole("listitem")[0]).toHaveTextContent(
    "current.example",
  );
  await user.keyboard("{Escape}");
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(agents.save).toHaveBeenCalledWith(agent.key, {
      config: { reply: "Hello!" },
    });
    expect(screen.getByRole("button", { name: /Saving/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(badge).toBeInTheDocument();
  } finally {
    await act(async () => {
      finish();
      await saving;
    });
  }
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  // Hidden footer contents are removed from pointer and keyboard interaction.
  expect(badge.closest("[inert]")).toHaveAttribute("aria-hidden", "true");
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(
    screen.queryByText("Memories stay in this community."),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Shared across")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    screen.queryByText("Memories stay in this community."),
  ).not.toBeInTheDocument();
  // A single remaining community needs no shared-settings notice.
  memberships.mockReturnValue([
    { key: agent.key, origin: "https://current.example", connected: true },
    {
      key: "leaving",
      origin: "https://leaving.example",
      connected: true,
      deleting: true,
    },
  ]);
  act(() => {
    known = { ...known };
    for (const listener of listeners) listener();
  });
  await user.type(screen.getByRole("textbox", { name: "Reply" }), "?");
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  expect(screen.queryByText("Shared across")).not.toBeInTheDocument();
  act(() => {
    known = {
      memberships: [
        {
          id: "https://current.example",
          name: "Current",
          icon: "https://images.example/current.png",
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const editor = await screen.findByRole("dialog", { name: "Change avatar" });
  await waitFor(() =>
    expect(within(editor).getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  expect(
    screen.queryByRole("dialog", { name: "Avatar scope" }),
  ).not.toBeInTheDocument();
  expect(editor).not.toHaveAccessibleDescription();
  expect(
    within(editor).queryByRole("button", { name: /^Only in/ }),
  ).not.toBeInTheDocument();
  act(() => {
    memberships.mockReturnValue([
      { key: agent.key, origin: "https://current.example", connected: true },
      { key: "other", origin: "https://other.example", connected: false },
    ]);
    for (const listener of listeners) listener();
  });
  const scope = await within(editor).findByRole("button", {
    name: "Only in Current",
  });
  expect(editor).toHaveAccessibleDescription("Only in Current");
  expect(scope.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/current.png",
  );
  await user.click(scope);
  const explanation = await screen.findByRole("dialog", {
    name: "Avatar scope",
  });
  expect(explanation).toHaveTextContent(
    "This avatar is specific to this community and isn’t shared with other communities.",
  );
  // Hover can open the popover while focus stays on the editor's Close button.
  within(editor).getByRole("button", { name: "Close" }).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(explanation).not.toBeInTheDocument());
  expect(editor).toBeVisible();
  await user.click(scope);
  expect(
    await screen.findByRole("dialog", { name: "Avatar scope" }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(editor).toBeVisible();
  expect(scope).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(editor).not.toBeInTheDocument());
  // Default focus follows the scope label when reopening with it already present.
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const reopened = await screen.findByRole("dialog", { name: "Change avatar" });
  await waitFor(() =>
    expect(
      within(reopened).getByRole("button", { name: "Only in Current" }),
    ).toHaveFocus(),
  );
  expect(reopened).toHaveAccessibleDescription("Only in Current");
  expect(
    screen.queryByRole("dialog", { name: "Avatar scope" }),
  ).not.toBeInTheDocument();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("retains the inline save action outside an agent pane", () => {
  const view = render(
    <AgentSaveButton form="settings" disabled saving={false} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <AgentSaveButton form="settings" disabled={false} saving={false} />,
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "form",
    "settings",
  );
});
