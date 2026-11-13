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
import { Context } from "@deepseek-ai/cordis";
import { afterEach, assert, expect, it, vi } from "vitest";
import { PanelsService } from "../../features/panels/service";
import { createRelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { keypair, signed } from "../../features/relay/testing";
import { registerCanvas } from "./canvas-panel";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("lets a joined Guest read the canvas and reacts to promotion and demotion", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const owner = createRelaySession(null);
  const panels = new PanelsService(root);
  const viewer = "a".repeat(64);
  const scope = "guest-canvas-panel";
  const id = "11111111-1111-4111-8111-111111111111";
  let channel: ChannelSummary = {
    id,
    name: "Updates",
    members: [viewer],
    readOnly: true,
    viewerRole: "guest",
  };
  let list = { status: "ready" as const, channels: [channel] };
  const listeners = new Set<() => void>();
  const head = signed(keypair(), {
    kind: 40100,
    content: "Saved canvas",
    tags: [["h", id]],
  });
  const canvas = {
    available: true,
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
    history: vi.fn(async () => ({ revisions: [head], next: undefined })),
  };
  const session = {
    ...owner.session,
    viewer,
    canvas,
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const snapshot = { status: "ready" as const, scope, generation: 1, session };
  root.provide("relay", {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  });
  root.provide("conversation", {
    codeBlocks: { snapshot: () => [], subscribe: () => () => {} },
  });
  const fiber = root
    .extend({ pluginOwner: { id: "channels", revision: "test" } })
    .plugin({ inject: ["conversation"], apply: registerCanvas });
  try {
    await fiber.await();
    const panel = panels.snapshot()[0];
    assert.exists(panel);
    expect(panel?.channelMenu?.eligible(channel, session)).toBe(true);
    expect(
      panel?.channelMenu?.eligible({ ...channel, cached: true }, session),
    ).toBe(false);
    expect(
      panel?.channelMenu?.eligible(
        { id, name: "Updates", readOnly: true, members: [] },
        session,
      ),
    ).toBe(false);
    const Panel = panel.component;
    render(
      <Panel
        target="canvas"
        close={() => {}}
        channelContext={{
          scope,
          channelId: id,
          channelName: "Updates",
          viewer,
          relayUrl: "https://relay.test",
        }}
      />,
    );
    // A Guest opens on the rendered saved Canvas and can still open Edit.
    expect(
      await screen.findByRole("article", { name: "Saved Canvas" }),
    ).toHaveTextContent("Saved canvas");
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Canvas Markdown",
    });
    await waitFor(() => expect(editor).toHaveValue("Saved canvas"));
    expect(editor).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
    expect(screen.queryByText(/Archived channel/)).not.toBeInTheDocument();
    const update = (next: ChannelSummary) =>
      act(() => {
        channel = next;
        list = { ...list, channels: [channel] };
        for (const listener of listeners) listener();
      });
    update({ id, name: "Updates", members: [viewer], viewerRole: "member" });
    expect(editor).not.toHaveAttribute("readonly");
    update({ ...channel, readOnly: true, viewerRole: "guest" });
    expect(editor).toHaveAttribute("readonly");
    expect(canvas.save).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
    await root.fiber.dispose();
  }
});
