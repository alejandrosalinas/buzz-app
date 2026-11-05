// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import { createPluginRequests } from "../plugins/requests";
import type { Catalog, ImportPreview } from "../plugins/types";
import { foldMessages } from "../features/relay/fold";
import { keypair, signed } from "../features/relay/testing";
import { PluginRequestCard } from "./PluginRequestCard";

afterEach(cleanup);

// https://github.com/squareup/buzz-plugin-browser, whose manifest is this.
const BROWSER = "https://github.com/squareup/buzz-plugin-browser";
const commit = "6de3f81448ba218b67939b9ca240898f46aecfd7";
const manifest = {
  id: "example.browser",
  name: "Browser",
  apiVersion: 1 as const,
  description: "Open HTTP(S) links in Buzz's side panel.",
};
const reason = "Open the staging site you linked";
const agentKey = keypair();
const agent = { pubkey: agentKey.pubkey, name: "Builder" };
const preview = (): ImportPreview => ({
  token: "preview",
  source: BROWSER,
  commit,
  warnings: [],
  candidates: [{ path: ".", revision: "new", manifest }],
});
const catalog: Catalog = { profile: "test", location: "test", plugins: [] };

/** The message the plugin_request tool posts, as the conversation folds it. */
function messageFor(requestId: string, author = agentKey) {
  const [row] = foldMessages("chan", "relay", [
    signed(author, {
      kind: 9,
      content: `Requested: install Browser — ${reason}`,
      tags: [
        ["h", "chan"],
        ["plugin-request", requestId],
      ],
    }),
  ]);
  if (!row) throw new Error("No message");
  return row;
}

function harness() {
  const imports = {
    git: vi.fn(async () => preview()),
    checkGit: vi.fn(async () => preview()),
    discard: vi.fn(async () => {}),
  };
  const listeners = new Set<() => void>();
  const snapshot = {
    configuration: { status: "ready" as const, catalog },
    busy: false,
    error: null as string | null,
  };
  const manager = {
    imports,
    installImport: vi.fn(async () => true),
    change: vi.fn(async () => true),
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requests: createPluginRequests({
      catalog: () => catalog,
      imports: imports as never,
      change: vi.fn(),
      error: () => null,
    }),
  };
  const release = vi.fn();
  const holdReview = vi.fn(() => release);
  const asker = manager.requests.forAgent(agent);
  const show = (requestId: string, author = agentKey) =>
    render(
      <PluginRequestCard
        message={messageFor(requestId, author)}
        plugins={manager as unknown as PluginManager}
        holdReview={holdReview}
      />,
    );
  const ask = () =>
    asker.request({
      action: "install",
      repository: BROWSER,
      reference: "main",
      reason,
    });
  return { manager, imports, asker, ask, show, holdReview, release };
}

it("offers Review and Decline for a request this device holds", async () => {
  const { ask, show, imports } = harness();
  const { requestId } = await ask();
  show(requestId);
  const card = screen.getByRole("region", { name: "Plugin request: Browser" });
  expect(within(card).getByText("Install Browser")).toBeVisible();
  expect(within(card).getByText(`Builder: ${reason}`)).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Review Browser" }),
  ).toBeEnabled();
  expect(
    within(card).getByRole("button", { name: "Decline Browser" }),
  ).toBeEnabled();
  expect(imports.git).not.toHaveBeenCalled();
});

it("reviews in place at the pinned commit, then shows the outcome and tells the agent", async () => {
  const { ask, asker, show, manager, holdReview, release } = harness();
  const { requestId } = await ask();
  show(requestId);
  fireEvent.click(screen.getByRole("button", { name: "Review Browser" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Review plugin access",
  });
  await within(dialog).findByText(`Commit: ${commit}`);
  expect(
    within(dialog).getByText(
      "Requested by Builder. Only install code you trust.",
    ),
  ).toBeVisible();
  expect(within(dialog).getByText(reason)).toBeVisible();
  expect(holdReview).toHaveBeenCalledOnce();
  expect(asker.status(requestId).state).toBe("pending");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.installImport).toHaveBeenCalledExactlyOnceWith("preview", ".");
  expect(release).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("Installed");
  expect(screen.queryByRole("button")).toBeNull();
  expect(asker.status(requestId)).toEqual({
    state: "approved",
    action: "install",
    pluginId: "example.browser",
  });
});

it("leaves the request pending when the review is cancelled", async () => {
  const { ask, asker, show } = harness();
  const { requestId } = await ask();
  show(requestId);
  fireEvent.click(screen.getByRole("button", { name: "Review Browser" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(`Commit: ${commit}`);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(asker.status(requestId).state).toBe("pending");
  expect(screen.getByRole("button", { name: "Review Browser" })).toBeVisible();
});

it("declines without opening a review", async () => {
  const { ask, asker, show, manager } = harness();
  const { requestId } = await ask();
  show(requestId);
  fireEvent.click(screen.getByRole("button", { name: "Decline Browser" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Declined"),
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(asker.status(requestId).state).toBe("declined");
});

it("shows only the message, with no buttons, for a request this device does not hold", () => {
  const { show } = harness();
  show("5d1f0b8e-8c2a-4a39-9a54-0f6a4e7e6c11");
  expect(screen.getByText(/^Requested: install Browser/)).toBeVisible();
  expect(screen.getByText(/no longer available/i)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("does not let another author's message act on an agent's request", async () => {
  const { ask, show, asker } = harness();
  const { requestId } = await ask();
  show(requestId, keypair());
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(/no longer available/i)).toBeVisible();
  expect(asker.status(requestId).state).toBe("pending");
});

it("moves keyboard focus to the outcome when Decline removes the button", async () => {
  const { ask, show } = harness();
  const { requestId } = await ask();
  show(requestId);
  const decline = screen.getByRole("button", { name: "Decline Browser" });
  decline.focus();
  fireEvent.click(decline);
  await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
});

it("returns keyboard focus to the outcome once an approved review closes", async () => {
  const { ask, show } = harness();
  const { requestId } = await ask();
  show(requestId);
  const review = screen.getByRole("button", { name: "Review Browser" });
  review.focus();
  fireEvent.click(review);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(`Commit: ${commit}`);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
});
