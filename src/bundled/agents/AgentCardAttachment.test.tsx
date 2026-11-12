// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_PNG_BYTES, snapshotPng } from "../../features/agents/agent-share";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { Attachment } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentCardAttachment, isAgentCard } from "./AgentCardAttachment";
import { agentTarget } from "./routes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const echo = {
  key: "test/echo",
  title: "Echo",
  importShared: (source: { model: string }) => ({ model: source.model }),
} as unknown as RegisteredAgentType;
const snapshot = { agents: [] };
const types = [echo];
const agents = {
  subscribe: () => () => {},
  snapshot: () => snapshot,
  types: () => types,
  port: vi.fn(async () => ({
    agent: { pubkey: "e".repeat(64), name: "Ada" } as Agent,
    notes: [],
  })),
} as unknown as Agents & { port: ReturnType<typeof vi.fn> };
const connection = { status: "ready", origin: "https://relay.example" };
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;
const card: Attachment = {
  url: "https://relay.example/media/ada.png",
  kind: "image",
  mime: "image/png",
  name: "Ada.agent.png",
};

/** A response streaming `chunks`, which counts what was read and whether it
 * was cancelled. jsdom's Blob doesn't survive Node's Response. */
const stream = (chunks: Uint8Array[], length?: number) => {
  const read = { bytes: 0, cancelled: false };
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (!chunk) return controller.close();
      read.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      read.cancelled = true;
    },
  });
  const headers = new Headers(
    length === undefined ? {} : { "content-length": String(length) },
  );
  return { response: { ok: true, status: 200, headers, body }, read };
};

/** Media that answers with `body`. */
const serve = async (body: Blob) => {
  const bytes = new Uint8Array(await body.arrayBuffer());
  const fetch = vi.fn(async () => stream([bytes], bytes.byteLength).response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const ada = () =>
  snapshotPng({
    name: "Ada",
    instructions: "Review pull requests.",
    runtime: "echo",
    model: "echo-1",
  });

const show = (attachment = card) =>
  render(
    <AgentCardAttachment
      attachment={attachment}
      source="buzz-media://ada.png"
      agents={agents}
      relay={relay}
      canOpen={() => false}
      open={() => false}
    />,
  );

it("claims only the agent cards Share sends", () => {
  expect(isAgentCard(card)).toBe(true);
  expect(isAgentCard({ ...card, name: "Ada.png" })).toBe(false);
  expect(isAgentCard({ ...card, kind: "file" })).toBe(false);
});

it("shows a sent agent as its card, and adds it from there", async () => {
  const user = userEvent.setup();
  const fetch = await serve(
    snapshotPng({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    }),
  );
  show();
  const button = await screen.findByRole("button", {
    name: "Add agent: Ada",
  });
  await vi.waitFor(() => expect(button).toBeEnabled());
  expect(fetch).toHaveBeenCalledWith("buzz-media://ada.png", expect.anything());
  expect(within(button).getByText("Add agent")).toBeVisible();
  expect(screen.queryByText("echo-1")).not.toBeInTheDocument();
  await user.click(button);
  const dialog = screen.getByRole("dialog", { name: "Ada" });
  // What it will follow can be changed before it is added.
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  await user.clear(instructions);
  await user.type(instructions, "Review small pull requests.");
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() =>
    expect(agents.port).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "shared",
        name: "Ada",
        instructions: "Review small pull requests.",
      }),
    ),
  );
});

it("shows the picture when the file holds no agent", async () => {
  await serve(new Blob(["not a card"], { type: "image/png" }));
  show();
  expect(await screen.findByRole("img", { name: "Ada" })).toHaveAttribute(
    "src",
    "buzz-media://ada.png",
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("names what it added, and opens it from there", async () => {
  const user = userEvent.setup();
  await serve(
    snapshotPng({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    }),
  );
  const navigator = { open: vi.fn(async () => ({})) };
  render(
    <AgentCardAttachment
      attachment={card}
      source="buzz-media://ada.png"
      agents={agents}
      relay={relay}
      navigator={navigator as unknown as Navigation}
      canOpen={() => false}
      open={() => false}
    />,
    { wrapper: ToastProvider },
  );
  const button = await screen.findByRole("button", {
    name: "Add agent: Ada",
  });
  await vi.waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await user.click(
    within(screen.getByRole("dialog", { name: "Ada" })).getByRole("button", {
      name: "Import",
    }),
  );
  expect(
    await screen.findByText("Added Ada to your agents."),
  ).toBeInTheDocument();
  // sonner's pointer capture is missing in jsdom.
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(navigator.open).toHaveBeenCalledExactlyOnceWith(
    agentTarget("e".repeat(64)),
  );
});

it("refuses a card larger than the limit without reading it all", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const chunks = Array.from({ length: 20 }, () => chunk);
  const declared = stream(chunks, MAX_PNG_BYTES + 1);
  const chunked = stream(chunks);
  for (const { response, read } of [declared, chunked]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const view = show();
    expect(await screen.findByRole("img", { name: "Ada" })).toBeVisible();
    expect(read.cancelled).toBe(true);
    // The stream may pull one chunk ahead of the reader.
    expect(read.bytes).toBeLessThanOrEqual(
      MAX_PNG_BYTES + 2 * chunk.byteLength,
    );
    view.unmount();
  }
  // Refused by its length before reading, past what the stream pulls ahead.
  expect(declared.read.bytes).toBeLessThanOrEqual(chunk.byteLength);
});

it("reads a card again when chosen after its read failed", async () => {
  const user = userEvent.setup();
  const bytes = new Uint8Array(await ada().arrayBuffer());
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementation(async () => stream([bytes]).response);
  vi.stubGlobal("fetch", fetch);
  show();
  const button = await screen.findByRole("button", {
    name: "Try again: Ada",
  });
  expect(within(button).getByText("Couldn’t load. Try again")).toBeVisible();
  expect(screen.queryByRole("img", { name: "Ada" })).not.toBeInTheDocument();
  await user.click(button);
  expect(await screen.findByRole("dialog", { name: "Ada" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps Add agent disabled while loading and restores keyboard focus after cancel", async () => {
  const user = userEvent.setup();
  const bytes = new Uint8Array(await ada().arrayBuffer());
  let respond!: (value: ReturnType<typeof stream>["response"]) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    ),
  );
  show();
  const button = screen.getByRole("button", { name: "Add agent: Ada" });
  expect(button).toBeDisabled();
  respond(stream([bytes]).response);
  await vi.waitFor(() => expect(button).toBeEnabled());
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Ada" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(button).toHaveFocus());
});
