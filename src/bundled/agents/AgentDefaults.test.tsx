// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { registerNavigationShortcuts } from "../../app/shortcuts";
import type {
  AgentProviderSnapshot,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  createNavigationController,
  type Navigation,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import { ShortcutsService } from "../../features/shortcuts/service";
import { AgentDefaults } from "./AgentDefaults";

afterEach(cleanup);

function fixture(initial: AgentProviderSnapshot = { readiness: "ready" }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const check = vi.fn();
  const type = {
    key: "local/echo",
    pluginId: "local",
    revision: "1",
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
    provider: {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check,
      DialogBody: () => <p>Echo controls</p>,
    },
  } satisfies RegisteredAgentType;
  const types = [type];
  const agents = {
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
  const update = (next: AgentProviderSnapshot) =>
    act(() => {
      state = next;
      for (const listener of listeners) listener();
    });
  return { agents, update, check, type };
}

/** The host's history shortcuts, driving a real memory-history controller. */
async function withHistoryShortcuts(
  run: (navigation: Navigation) => Promise<void>,
) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(ctx, window);
  const controller = createNavigationController(createMemoryHistory());
  const remove = registerNavigationShortcuts(shortcuts, controller.navigation);
  try {
    await run(controller.navigation);
  } finally {
    remove();
    controller.dispose();
    await ctx.fiber.dispose();
  }
}

/** Agent setup as Settings routes it: each provider opens as a nested visit. */
function RoutedDefaults({
  agents,
  navigation,
}: {
  agents: Agents;
  navigation: Navigation;
}) {
  const { target } = useSyncExternalStore(
    navigation.subscribe,
    navigation.snapshot,
  ).entry;
  const page = {
    target,
    signal: new AbortController().signal,
  } as unknown as PageNavigation;
  return (
    <AgentDefaults
      agents={agents}
      navigation={page}
      onProvider={(provider) => {
        if (target.kind === "settings" && provider)
          void navigation.open({ ...target, provider });
      }}
    />
  );
}

it("keeps an unrouted provider a local dialog that Back does not close", async () => {
  const { agents } = fixture();
  render(<AgentDefaults agents={agents} />);
  fireEvent.click(screen.getByRole("button", { name: "Echo, ready" }));
  const dialog = await screen.findByRole("dialog", { name: "Echo" });
  expect(dialog).not.toHaveAttribute("data-navigation-visit");
  await withHistoryShortcuts(async (navigation) => {
    const behind = { version: 1, kind: "settings" } as const;
    void navigation.open({ version: 1, kind: "home" });
    void navigation.open(behind);
    await vi.waitFor(() => expect(navigation.snapshot().canGoBack).toBe(true));
    // Not prevented: the reserved chord stays inert over a plain modal.
    expect(fireEvent.keyDown(dialog, { key: "[", ctrlKey: true })).toBe(true);
    await act(async () => {});
    expect(navigation.snapshot().attempt.entry.target).toEqual(behind);
  });
});

it("lets Back hide a routed provider's blocking work and Forward restore it", async () => {
  const { agents, update, check } = fixture();
  await withHistoryShortcuts(async (navigation) => {
    const agentSetup = {
      version: 1,
      kind: "settings",
      section: "agents",
    } as const;
    void navigation.open({ version: 1, kind: "home" });
    void navigation.open(agentSetup);
    await vi.waitFor(() => expect(navigation.snapshot().canGoBack).toBe(true));
    render(<RoutedDefaults agents={agents} navigation={navigation} />);
    fireEvent.click(screen.getByRole("button", { name: "Echo, ready" }));
    const dialog = await screen.findByRole("dialog", { name: "Echo" });
    // Install or sign-in starts from the open controls.
    update({ readiness: "ready", blocking: true });
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(dialog).toHaveAttribute("data-navigation-visit");
    const checks = check.mock.calls.length;
    expect(fireEvent.keyDown(dialog, { key: "[", ctrlKey: true })).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull(),
    );
    expect(navigation.snapshot().entry.target).toEqual(agentSetup);
    // The work continued in the provider, so its controls return still guarded
    // and nothing asked the provider to start over.
    expect(fireEvent.keyDown(document.body, { key: "]", ctrlKey: true })).toBe(
      false,
    );
    expect(await screen.findByRole("dialog", { name: "Echo" })).toHaveAttribute(
      "data-navigation-visit",
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(check).toHaveBeenCalledTimes(checks);
  });
});

it("keeps status-only attention noninteractive and restores the default setup action", async () => {
  const { agents, update } = fixture({
    readiness: "attention",
    attentionLabel: null,
    attentionDescription: "Unavailable for this account",
  });
  render(<AgentDefaults agents={agents} />);
  expect(screen.getByText("Unavailable for this account")).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  update({ readiness: "attention" });
  expect(screen.queryByText("Unavailable for this account")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Set up Echo, attention" }),
  );
  expect(await screen.findByRole("dialog", { name: "Echo" })).toBeVisible();
});

it.each(["Escape", "Close"])(
  "returns focus to the status after in-dialog sign-in without access and %s",
  async (dismissal) => {
    const { agents, update, type } = fixture({
      readiness: "attention",
      attentionLabel: "Log in to Echo",
    });
    type.provider.DialogBody = () => (
      <button
        type="button"
        onClick={() =>
          update({
            readiness: "attention",
            attentionLabel: null,
            attentionDescription: "Unavailable for this account",
          })
        }
      >
        Sign in
      </button>
    );
    const user = userEvent.setup();
    render(<AgentDefaults agents={agents} />);
    await user.click(
      screen.getByRole("button", { name: "Log in to Echo, attention" }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const status = screen.getByText("Unavailable for this account");
    if (dismissal === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(status).toHaveFocus());
    expect(status).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("button")).toBeNull();
  },
);
