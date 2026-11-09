// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelPanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import {
  type ChannelDrawerOpening,
  useChannelPanels,
} from "./useChannelPanels";

afterEach(cleanup);

it.each(["bottom", "side"] as const)(
  "makes settings and %s launchers mutually exclusive without resurrecting a closed panel",
  async (placement) => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const context: ChannelPanelContext = {
      scope: "scope",
      viewer: "viewer",
      channelId: "alpha",
      channelName: "Alpha",
      relayUrl: "wss://example.com",
    };
    const panel: RegisteredPanel = {
      id: "terminal",
      key: "fixture:terminal",
      pluginId: "fixture",
      revision: "1",
      title: "Terminal",
      channelPlacement: placement,
      matches: () => true,
      channelLauncher: ({ toggle, pressed }) => (
        <button
          type="button"
          aria-pressed={pressed}
          onClick={() => toggle("terminal")}
        >
          Terminal
        </button>
      ),
      component: () => <p>Terminal contents</p>,
    };
    const available = [panel];
    const panels: Panels = {
      snapshot: () => available,
      subscribe: () => () => {},
      register: () => {},
      resolve: () => panel,
      requestOpen: () => false,
      handleOpenRequests: () => () => {},
    };
    function Harness() {
      const [settings, setSettings] = useState(false);
      const drawer = useChannelPanels(panels, context, () => {
        onOpen();
        setSettings(false);
      });
      return (
        <>
          {drawer.launchers}
          <button
            type="button"
            onClick={() => {
              drawer.close();
              setSettings(true);
            }}
          >
            Settings
          </button>
          {settings && (
            <button type="button" onClick={() => setSettings(false)}>
              Close settings
            </button>
          )}
          {drawer.content}
          {drawer.side}
        </>
      );
    }
    const label = placement === "side" ? "Terminal panel" : "Terminal drawer";
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: label })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.queryByRole("region", { name: label }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(
      screen.queryByRole("region", { name: label }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "Close settings" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: label })).toBeVisible();
    if (placement !== "side") return;
    // Shift+Escape is Mark all as read; only plain Escape dismisses.
    const region = screen.getByRole("region", { name: label });
    fireEvent.keyDown(region, { key: "Escape", shiftKey: true });
    expect(region).toBeInTheDocument();
    fireEvent.keyDown(region, { key: "Escape" });
    expect(region).not.toBeInTheDocument();
  },
);

it("keeps a side panel with its channel until closed, while bottom drawers close on leaving", async () => {
  const user = userEvent.setup();
  const contextOf = (channelId: string): ChannelPanelContext => ({
    scope: "scope",
    viewer: "viewer",
    channelId,
    channelName: channelId,
    relayUrl: "wss://example.com",
  });
  const launcherPanel = (
    title: string,
    channelPlacement: "bottom" | "side",
  ): RegisteredPanel => ({
    id: title,
    key: `fixture:${title}`,
    pluginId: "fixture",
    revision: "1",
    title,
    channelPlacement,
    matches: () => true,
    channelLauncher: ({ toggle, pressed }) => (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => toggle(title)}
      >
        {title}
      </button>
    ),
    component: () => <p>{title} contents</p>,
  });
  const huddle = launcherPanel("Huddle", "side");
  const terminal = launcherPanel("Terminal", "bottom");
  let available = [huddle, terminal];
  const listeners = new Set<() => void>();
  const panels: Panels = {
    snapshot: () => available,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: () => {},
    resolve: () => huddle,
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  // Stands in for the session's per-channel tab store, which outlives the page.
  const retained: Record<string, ChannelDrawerOpening | undefined> = {};
  const fallback = { current: null as HTMLElement | null };
  function Harness({ channel }: { channel: string }) {
    const [context] = useState(() => contextOf(channel));
    const [, rerender] = useState(0);
    const drawer = useChannelPanels(
      panels,
      context,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        opening: retained[channel],
        set: (opening) => {
          retained[channel] = opening;
          rerender((value) => value + 1);
        },
        fallbackFocus: fallback,
      },
    );
    return (
      <>
        <button
          type="button"
          ref={(node) => {
            fallback.current = node;
          }}
        >
          Conversation
        </button>
        {drawer.launchers}
        {drawer.content}
        {drawer.side}
      </>
    );
  }
  const side = () => screen.queryByRole("region", { name: "Huddle panel" });
  const bottom = () =>
    screen.queryByRole("region", { name: "Terminal drawer" });
  const launcher = (name: string) => screen.getByRole("button", { name });
  // Each channel mounts its own workspace, as ChannelsPage keys it.
  const view = render(<Harness key="alpha" channel="alpha" />);
  await user.click(launcher("Huddle"));
  expect(side()).toBeVisible();
  // The session store keeps no DOM elements; the trigger stays with the page.
  expect(retained.alpha).not.toHaveProperty("trigger");
  view.rerender(<Harness key="beta" channel="beta" />);
  expect(side()).not.toBeInTheDocument();
  expect(launcher("Huddle")).toHaveAttribute("aria-pressed", "false");
  await user.click(launcher("Terminal"));
  expect(bottom()).toBeVisible();
  view.rerender(<Harness key="alpha" channel="alpha" />);
  expect(side()).toBeVisible();
  expect(launcher("Huddle")).toHaveAttribute("aria-pressed", "true");
  view.rerender(<Harness key="beta" channel="beta" />);
  expect(bottom()).not.toBeInTheDocument();
  // Leaving the page entirely keeps the side panel for the return.
  view.unmount();
  const page = render(<Harness key="alpha" channel="alpha" />);
  expect(side()).toBeVisible();
  // Its original trigger is gone, so closing focuses the conversation.
  await user.click(launcher("Huddle"));
  expect(side()).not.toBeInTheDocument();
  expect(launcher("Conversation")).toHaveFocus();
  page.rerender(<Harness key="beta" channel="beta" />);
  page.rerender(<Harness key="alpha" channel="alpha" />);
  expect(side()).not.toBeInTheDocument();
  // Disabling the plugin forgets it; re-enabling starts closed.
  await user.click(launcher("Huddle"));
  act(() => {
    available = [terminal];
    for (const listener of listeners) listener();
  });
  act(() => {
    available = [huddle, terminal];
    for (const listener of listeners) listener();
  });
  expect(side()).not.toBeInTheDocument();
  expect(retained.alpha).toBeUndefined();
});

it("opens the host member picker only while the launcher binding is current", async () => {
  const openMembers = vi.fn();
  let requested: (() => void) | undefined;
  const panel = {
    id: "huddles",
    key: "buzz.huddles/huddles",
    pluginId: "buzz.huddles",
    revision: "1",
    title: "Huddles",
    matches: () => false,
    component: () => null,
    channelLauncher: (props: { openMembers?: (() => void) | undefined }) => {
      requested = props.openMembers;
      return (
        <button type="button" onClick={props.openMembers}>
          Add someone
        </button>
      );
    },
  } satisfies RegisteredPanel;
  const available = [panel];
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    register: () => {},
    resolve: () => panel,
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  function Harness() {
    return useChannelPanels(
      panels,
      {
        scope: "scope",
        viewer: "viewer",
        channelId: "alpha",
        channelName: "Alpha",
        relayUrl: "wss://example.com",
      },
      undefined,
      undefined,
      undefined,
      openMembers,
    ).launchers;
  }
  const view = render(<Harness />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Add someone" }));
  expect(openMembers).toHaveBeenCalledTimes(1);
  view.unmount();
  requested?.();
  expect(openMembers).toHaveBeenCalledTimes(1);
});

it.each(["bottom", "side"] as const)(
  "lets a %s panel and its launcher open targets as channel tabs",
  async (placement) => {
    const user = userEvent.setup();
    const context: ChannelPanelContext = {
      scope: "scope",
      viewer: "viewer",
      channelId: "alpha",
      channelName: "Alpha",
      relayUrl: "wss://example.com",
    };
    let retained: ((target: string) => boolean) | undefined;
    const panel: RegisteredPanel = {
      id: "todos",
      key: "fixture:todos",
      pluginId: "fixture",
      revision: "1",
      title: "Todos",
      channelPlacement: placement,
      matches: () => true,
      channelLauncher: ({ toggle, open, canOpen }) => (
        <>
          <button type="button" onClick={() => toggle("todos")}>
            Todos
          </button>
          <button
            type="button"
            disabled={!canOpen("todo:launcher")}
            onClick={() => open("todo:launcher")}
          >
            Open from launcher
          </button>
        </>
      ),
      component: ({ context: opening }) => {
        retained = opening?.open;
        return (
          <button type="button" onClick={() => opening?.open("todo:one")}>
            Open todo
          </button>
        );
      },
    };
    const available = [panel];
    const panels: Panels = {
      snapshot: () => available,
      subscribe: () => () => {},
      register: () => {},
      resolve: () => panel,
      requestOpen: () => false,
      handleOpenRequests: () => () => {},
    };
    const open = vi.fn(() => true);
    function Harness() {
      const drawer = useChannelPanels(panels, context, undefined, undefined, {
        canOpen: (target) => target.startsWith("todo:"),
        open,
      });
      return (
        <>
          {drawer.launchers}
          {drawer.content}
          {drawer.side}
        </>
      );
    }
    render(<Harness />);
    await user.click(
      screen.getByRole("button", { name: "Open from launcher" }),
    );
    expect(open).toHaveBeenLastCalledWith("todo:launcher");
    await user.click(screen.getByRole("button", { name: "Todos" }));
    await user.click(screen.getByRole("button", { name: "Open todo" }));
    expect(open).toHaveBeenLastCalledWith("todo:one");
    // Closing the drawer retires that opening's commands.
    await user.click(screen.getByRole("button", { name: "Todos" }));
    expect(
      screen.queryByRole("button", { name: "Open todo" }),
    ).not.toBeInTheDocument();
    open.mockClear();
    expect(retained?.("todo:one")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  },
);

it("keeps the huddle last, with the linked PR just before it, regardless of registration order", () => {
  const available = [
    "buzz.huddles/huddles",
    "other/tool",
    "buzz.github/object",
  ].map((key) => ({
    key,
    id: key,
    pluginId: key,
    revision: "1",
    title: key,
    matches: () => false,
    component: () => null,
    channelLauncher: () => <button type="button">{key}</button>,
  }));
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    register: () => {},
    resolve: () => undefined,
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  function Harness() {
    return useChannelPanels(panels, {
      scope: "scope",
      viewer: "viewer",
      channelId: "solo",
      channelName: "Solo",
      relayUrl: "wss://example.com",
    }).launchers;
  }
  render(<Harness />);
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["other/tool", "buzz.github/object", "buzz.huddles/huddles"]);
});
