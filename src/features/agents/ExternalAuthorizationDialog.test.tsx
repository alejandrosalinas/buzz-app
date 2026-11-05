// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalAuthorizationDialog } from "./ExternalAuthorizationDialog";
import { createExternalApps } from "./external-connection";
import type { Agents } from "./service";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
it.each([
  ["Authorize", true],
  ["Create", true],
  ["Deny", true],
  ["unavailable runtime", false],
  ["custody lost", true],
  ["disabled community", true],
] as const)(
  "handles %s without an unintended authorization",
  async (requestedAction, runtimeReady) => {
    const action = requestedAction === "Create" ? "Authorize" : requestedAction;
    const scopes =
      requestedAction === "Create"
        ? (["read", "post", "create"] as const)
        : (["read", "post"] as const);
    const user = userEvent.setup();
    const key = "a".repeat(64),
      secondKey = "c".repeat(64),
      viewer = "b".repeat(64),
      origin = "https://fixture.example.test";
    vi.stubEnv(
      "VITE_BUZZ_EXTERNAL_MCP_COMMUNITIES",
      action === "disabled community" ? "" : origin,
    );
    const subscribe = () => () => {};
    const choices = {
      selectable: [{ pubkey: key }],
      pending: false,
      archives: { status: "ready" },
    };
    const transport = {
      status: "ready",
      scope: origin,
      session: { agentChoices: { subscribe, snapshot: () => choices } },
    };
    const client = {
      viewer,
      selected: origin,
      memberships: [{ id: origin, name: "Test community" }],
    };
    const inventory = {
      agents: [{ key, pubkey: key, name: "Test agent", place: "here" }],
    };
    if (action === "custody lost") {
      inventory.agents.push({
        key: secondKey,
        pubkey: secondKey,
        name: "Other agent",
        place: "here",
      });
      choices.selectable.push({ pubkey: secondKey });
    }
    let available = runtimeReady;
    const listeners = new Set<() => void>();
    let stop!: () => void;
    const closed = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const authorize = vi.fn(async () => {}),
      deny = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      url: "http://127.0.0.1:1234/mcp",
      headers: [],
      closed,
      close: async () => stop(),
      authorize,
    }));
    const connection = createExternalApps();
    const release = connection.bind({ connect, deny });
    connection.open(
      {
        version: 1,
        client: "Test app",
        callback: "http://127.0.0.1:1234/buzz/authorize",
        state: "A".repeat(43),
        scope: scopes,
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
      },
      viewer,
    );
    render(
      <ExternalAuthorizationDialog
        connection={connection}
        agents={
          {
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            snapshot: () => inventory,
            canConnectExternal: (agent: string) =>
              agent === secondKey || available,
          } as unknown as Agents
        }
        communities={
          {
            subscribe,
            snapshot: () => client,
            select: () => {},
          } as unknown as Communities
        }
        relay={{ subscribe, snapshot: () => transport } as unknown as RelayData}
      />,
    );
    expect(
      await screen.findByRole("dialog", { name: "Authorize app" }),
    ).toBeVisible();
    expect(connect).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    const access = screen.getByText(/Requested access:/);
    if (requestedAction === "Create")
      expect(access).toHaveTextContent(
        "create private Solo chats with you, the selected agent and your saved Bestie",
      );
    else expect(access).not.toHaveTextContent("create private Solo chats");
    if (action === "disabled community") {
      expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
      expect(
        screen.getByText(/External apps are not enabled for this community/),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Deny" }));
      await waitFor(() => expect(deny).toHaveBeenCalledOnce());
      expect(connection.snapshot().pending).toBeUndefined();
      expect(connect).not.toHaveBeenCalled();
      release();
      return;
    }
    if (action === "custody lost") {
      expect(screen.getByRole("button", { name: "Authorize" })).toBeDisabled();
      await user.click(screen.getByRole("combobox", { name: "Agent" }));
      await user.keyboard("{Home}{Enter}");
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Agent" })).toHaveAttribute(
          "aria-expanded",
          "false",
        ),
      );
      expect(screen.getByRole("button", { name: "Authorize" })).toBeEnabled();
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
        "Test agent",
      );
      act(() => {
        available = false;
        for (const listener of listeners) listener();
      });
    }
    if (!available) {
      expect(screen.getByRole("button", { name: "Authorize" })).toBeDisabled();
      act(() => screen.getByRole("combobox", { name: "Agent" }).focus());
      await user.keyboard("{Enter}");
      expect(
        await screen.findByRole("option", { name: /Test agent/ }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText(/Enable its runtime plugin/)).toBeVisible();
      expect(connection.snapshot().pending).toBeDefined();
      expect(connect).not.toHaveBeenCalled();
      if (action === "custody lost") {
        await user.keyboard("{End}{Enter}");
        await user.click(screen.getByRole("button", { name: "Authorize" }));
        await waitFor(() => expect(authorize).toHaveBeenCalledOnce());
        expect(connect).toHaveBeenCalledWith(
          secondKey,
          expect.any(AbortSignal),
          expect.any(Function),
          scopes,
        );
      }
      cleanup();
      release();
      return;
    }
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Test agent",
    );
    await user.click(screen.getByRole("button", { name: action }));
    if (action === "Authorize") {
      await waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      expect(connect).toHaveBeenCalledWith(
        key,
        expect.any(AbortSignal),
        expect.any(Function),
        scopes,
      );
    } else {
      await waitFor(() => expect(deny).toHaveBeenCalledOnce());
      expect(connect).not.toHaveBeenCalled();
    }
    cleanup();
    release();
  },
);

it("lets the owner dismiss an authorization error without starting setup again", async () => {
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      throw new Error("App is closed");
    },
    deny: async () => {},
  });
  connection.open(
    {
      version: 1,
      client: "Test app",
      callback: "http://127.0.0.1:1234/buzz/authorize",
      state: "A".repeat(43),
      scope: ["read"],
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    },
    "viewer",
  );
  await connection.approve("test-agent");
  const subscribe = () => () => {};
  const client = { viewer: "viewer" };
  const transport = { status: "idle" };
  render(
    <ToastProvider>
      <ExternalAuthorizationDialog
        connection={connection}
        agents={{} as Agents}
        communities={
          { subscribe, snapshot: () => client } as unknown as Communities
        }
        relay={{ subscribe, snapshot: () => transport } as unknown as RelayData}
      />
    </ToastProvider>,
  );
  const notice = await screen.findByRole("dialog", {
    name: "External app authorization failed",
  });
  expect(notice).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(notice).not.toBeInTheDocument());
  expect(connection.snapshot().error).toBeUndefined();
  expect(connection.snapshot().grant?.phase).toBe("ended");
});
