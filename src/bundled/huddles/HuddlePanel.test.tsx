// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { File } from "node:buffer";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { writeView } from "../../shared/view-state";
import { attachmentDraft } from "../../features/messages/attachment-draft";
import { HuddlePanel } from "./HuddlePanel";
import { huddleTarget } from "./HuddleCard";

composerDOMFixture();
stubAvatarBrowserApis();
afterEach(cleanup);
it("releases unsent files on close while retaining the saved panel text draft", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  const scope = "panel-attachment-cleanup";
  const store = createRelaySession(null);
  const release = vi.fn();
  const upload = vi.fn(async () => uploaded);
  const uploaded = {
    name: "notes.txt",
    url: `https://relay.test/media/${"a".repeat(64)}.txt`,
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
  };
  const channel = {
    id: room,
    name: "Huddle",
    huddle: true as const,
    parentChannelId: parent,
    members: [],
  };
  const list = { status: "ready" as const, channels: [channel] };
  const pending: readonly never[] = [];
  const rows: readonly never[] = [];
  const session = {
    ...store.session,
    outbox: {
      supports: () => true,
      snapshot: () => pending,
      subscribe: () => () => {},
      observeDismiss: () => () => {},
      observeSend: () => () => {},
      ready: async () => {},
      send: () => {
        throw new Error("No send expected");
      },
      recovery: async () => undefined,
      recover: async () => {},
      acknowledge: async () => {},
      retry: () => {},
      dismiss: async () => {},
    },
    attachments: {
      prepare: async (file: globalThis.File) => file,
      upload,
      release,
    },
    channels: {
      ...store.session.channels,
      resolve: async () => {},
      ensure: () => {},
      get: () => channel,
      list: () => list,
      window: () => ({
        ...store.session.channels.window(room),
        status: "ready" as const,
        rows,
        hasMore: false,
      }),
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, scope, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  writeView(scope, `draft:${room}`, "Keep these notes");
  const panel = () => (
    <HuddlePanel
      target={huddleTarget(parent, room)}
      relay={relay}
      close={() => {}}
    />
  );
  const view = render(panel());
  await waitFor(() =>
    expect(screen.getByRole("textbox").textContent).toContain(
      "Keep these notes",
    ),
  );
  const input = view.container.querySelector('input[type="file"]');
  assert.exists(input);
  fireEvent.change(input, {
    target: {
      files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
    },
  });
  await screen.findByText("notes.txt");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toBeDisabled(),
  );
  await waitFor(() =>
    expect(
      attachmentDraft(session, `${scope}:draft:${room}`, room).snapshot()[0]
        ?.status,
    ).toBe("ready"),
  );
  view.unmount();
  expect(upload).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(uploaded);
  render(panel());
  await waitFor(() =>
    expect(screen.getByRole("textbox").textContent).toContain(
      "Keep these notes",
    ),
  );
  expect(screen.queryByText("notes.txt")).toBeNull();
  cleanup();
  store.dispose();
});
