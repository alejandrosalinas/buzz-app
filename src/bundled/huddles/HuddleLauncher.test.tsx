// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { createHuddles } from "../../features/huddle/service";
import { MenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
import { HuddleCapsule } from "./HuddleCapsule";
import { HuddleLauncher, SoloHuddleMenu } from "./HuddleLauncher";

afterEach(cleanup);

it("moves idle Solo huddles to the menu while preserving Team's header action", async () => {
  const store = createRelaySession(null);
  const channel = {
    id: "chat",
    name: "Chat",
    channelType: "solo" as "solo" | "stream",
  };
  const list = { status: "ready" as const, channels: [channel] };
  const session = {
    ...store.session,
    channels: { ...store.session.channels, list: () => list },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "https://example.com:viewer",
    viewer: "viewer",
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const huddles = createHuddles(
    relay,
    {
      available: false,
      open: async () => {},
      close: async () => {},
      touch: async () => {},
      send: async () => {},
    },
    async () => {
      throw new Error("No audio expected");
    },
  );
  const start = vi.spyOn(huddles, "start").mockResolvedValue();
  const context = {
    scope: snapshot.scope,
    viewer: "viewer",
    channelId: "chat",
    channelName: "Chat",
    relayUrl: "wss://example.com",
  };
  const props = {
    context,
    relay,
    huddles,
    showWindow: async () => {},
    available: () => true,
  };
  try {
    const view = render(<HuddleLauncher {...props} />);
    expect(screen.queryByRole("button", { name: "Start a huddle" })).toBeNull();
    view.rerender(
      <MenuRoot open>
        <MenuPopup>
          <SoloHuddleMenu {...props} session={session} channelId="chat" />
        </MenuPopup>
      </MenuRoot>,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Start a huddle" }),
    );
    expect(start).toHaveBeenCalledWith(context);
    const connecting = {
      phase: "connecting" as const,
      muted: false,
      participants: [],
    };
    vi.spyOn(huddles, "snapshot").mockReturnValue(connecting);
    const leave = vi.spyOn(huddles, "leave").mockResolvedValue();
    const presentation = { visible: false, failed: false };
    view.rerender(
      <>
        <HuddleCapsule
          relay={relay}
          huddles={huddles}
          companion={{
            snapshot: () => presentation,
            subscribe: () => () => {},
            open: async () => {},
            dispose: async () => {},
            dismissError: () => {},
          }}
        />
        <MenuRoot open>
          <MenuPopup>
            <SoloHuddleMenu {...props} session={session} channelId="chat" />
          </MenuPopup>
        </MenuRoot>
      </>,
    );
    // Sidebar starts must remain cancellable without any channel header.
    expect(screen.queryByRole("menuitem")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(leave).toHaveBeenCalledOnce();
    leave.mockClear();
    view.rerender(<HuddleLauncher {...props} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel Huddle connection" }),
    );
    expect(leave).toHaveBeenCalledOnce();
    for (const phase of ["connecting", "connected", "leaving"] as const) {
      vi.mocked(huddles.snapshot).mockReturnValue({
        ...connecting,
        phase,
        destination: { ...context, channelId: "other-chat" },
      });
      view.rerender(
        <>
          <HuddleLauncher {...props} />
          <MenuRoot open>
            <MenuPopup>
              <SoloHuddleMenu {...props} session={session} channelId="chat" />
            </MenuPopup>
          </MenuRoot>
        </>,
      );
      const label =
        phase === "connecting"
          ? "Cancel Huddle connection"
          : "Show active Huddle";
      expect(screen.getByRole("button", { name: label })).toBeVisible();
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull();
    }
    vi.mocked(huddles.snapshot).mockRestore();
    channel.channelType = "stream";
    view.rerender(<HuddleLauncher {...props} />);
    start.mockClear();
    const headphones = screen.getByRole("button", {
      name: "Start or join a huddle",
    });
    // A stray tap on the header button asks before starting a call.
    await userEvent.click(headphones);
    const dialog = screen.getByRole("alertdialog", {
      name: "Start a huddle?",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start huddle" }),
      ).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(headphones);
    await userEvent.click(screen.getByRole("button", { name: "Start huddle" }));
    expect(start).toHaveBeenCalledWith(context);
    // A pending confirmation never carries over to another conversation.
    await userEvent.click(headphones);
    const other = { ...context, channelId: "other", channelName: "Other" };
    view.rerender(<HuddleLauncher {...props} context={other} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    view.rerender(<HuddleLauncher {...props} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    view.unmount();
  } finally {
    await huddles.dispose();
    store.dispose();
  }
});

it("offers voice for a capable agent DM, explains automatic joining, and keeps ordinary calls otherwise", async () => {
  const store = createRelaySession(null);
  const agent = {
    pubkey: "agent",
    name: "Codex",
    owner: "viewer",
    place: "here",
    relay: "https://example.com",
    type: "buzz.codex/codex",
  };
  const choices = {
    ...store.session.agentChoices.snapshot(),
    identities: [agent],
    selectable: [agent],
    archives: { status: "idle" as const, archived: [] },
  };
  const ensure = vi.fn();
  const channel = {
    id: "dm",
    name: "Codex",
    channelType: "dm" as const,
    members: ["viewer", "agent"],
  };
  const list = { status: "ready" as const, channels: [channel] };
  const session = {
    ...store.session,
    channels: { ...store.session.channels, list: () => list },
    agentChoices: {
      ...store.session.agentChoices,
      ensure,
      snapshot: () =>
        choices as unknown as ReturnType<
          typeof store.session.agentChoices.snapshot
        >,
    },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "scope",
    viewer: "viewer",
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const huddles = createHuddles(
    relay,
    {
      available: false,
      open: async () => {},
      close: async () => {},
      touch: async () => {},
      send: async () => {},
    },
    async () => {
      throw new Error("No real audio");
    },
  );
  let voice = true;
  const agentSnapshot = { status: "ready", running: [agent] };
  const agents = {
    snapshot: () => agentSnapshot,
    subscribe: () => () => {},
    types: () => (voice ? [{ key: "buzz.codex/codex", voice: () => {} }] : []),
  } as unknown as import("../../features/agents/service").Agents;
  const props = {
    agents,
    relay,
    huddles,
    context: {
      scope: "scope",
      viewer: "viewer",
      channelId: "dm",
      channelName: "Codex",
      relayUrl: "wss://example.com",
    },
    available: () => true,
    showWindow: async () => {},
  };
  const start = vi.spyOn(huddles, "start").mockResolvedValue();
  try {
    const view = render(<HuddleLauncher {...props} />);
    // Archive evidence loads; until then archives fail open, as elsewhere.
    expect(ensure).toHaveBeenCalledWith(false, true);
    await userEvent.click(
      screen.getByRole("button", { name: "Talk with Codex" }),
    );
    expect(
      screen.getByText(
        "Your microphone will turn on and Codex will join automatically.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start huddle" }));
    expect(start).toHaveBeenCalledWith(props.context);
    voice = false;
    view.rerender(<HuddleLauncher {...props} />);
    expect(
      screen.getByRole("button", { name: "Start or join a huddle" }),
    ).toBeInTheDocument();
  } finally {
    await huddles.dispose();
    store.dispose();
  }
});
