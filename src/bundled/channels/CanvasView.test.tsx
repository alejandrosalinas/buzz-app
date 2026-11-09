// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { clearView, readView } from "../../shared/view-state";
import { MAX_MARKDOWN_DEPTH } from "../../features/relay/message-content";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { LIVE_CANVAS_BYTES } from "../../features/channel-templates/model";
import { CanvasEditor } from "./CanvasEditor";
import {
  CANVAS_RENDER_CELLS,
  CANVAS_RENDER_CHARS,
  CanvasMarkdown,
  renderable,
} from "./CanvasView";

// Counts Markdown renders while passing them through unchanged.
const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", async (load) => {
  const { default: Markdown } = await load<typeof import("react-markdown")>();
  return {
    default: (props: Parameters<typeof Markdown>[0]) => {
      markdownRenders.count++;
      return Markdown(props);
    },
  };
});

const profiles = {
  get: () => undefined,
  load: async () => undefined,
  subscribe: () => () => {},
} as never;
const scope = "canvas-view-test";
const channelId = "11111111-1111-4111-8111-111111111111";
const key = keypair();
const event = (content: string) =>
  signed(key, {
    kind: 40100,
    content,
    tags: [["h", channelId]],
    created_at: 1_700_000_000,
  });

function mount(read: ChannelCanvas["read"], readOnly = false) {
  const canvas = {
    available: true,
    read: vi.fn(read),
    save: vi.fn(async (_: string, content: string) => event(content)),
    history: vi.fn(async () => ({ revisions: [], next: undefined })),
  };
  render(
    <CanvasEditor
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
      readOnly={readOnly}
    />,
  );
  return canvas;
}
const view = () => screen.getByRole("article", { name: "Saved Canvas" });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens on View with the saved Canvas rendered, beside Edit and History", async () => {
  mount(async () => event("# Plan\n\n- **one**\n- two"));
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["View", "Edit", "History"]);
  expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await within(view()).findByRole("heading", { name: "Plan" }),
  ).toBeInTheDocument();
  expect(within(view()).getByText("one").tagName).toBe("STRONG");
});

it("shows the saved head, not an unsaved draft", async () => {
  mount(async () => event("Saved text"));
  await within(view()).findByText("Saved text");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas Markdown" }), {
    target: { value: "Draft text" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toHaveTextContent("Saved text");
  expect(view()).not.toHaveTextContent("Draft text");
});

it("delays loading feedback, then shows a read failure with Retry, then the Canvas", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let fail = true;
    let settle = () => {};
    const canvas = mount(
      () =>
        new Promise((resolve, reject) => {
          settle = () =>
            fail
              ? reject(new Error("Relay unavailable"))
              : resolve(event("Recovered"));
        }),
    );
    expect(screen.queryByText("Loading Canvas…")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("status")).toHaveTextContent("Loading Canvas…");
    await act(async () => settle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Relay unavailable",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await act(async () => settle());
    expect(await within(view()).findByText("Recovered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(canvas.read).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

function retryable() {
  const reads: Array<{ resolve(): void; reject(): void }> = [];
  const canvas = mount(
    () =>
      new Promise((resolve, reject) =>
        reads.push({
          resolve: () => resolve(event("Recovered")),
          reject: () => reject(new Error("Relay unavailable")),
        }),
      ),
  );
  return { canvas, reads };
}
const retryButton = () => screen.getByRole("button", { name: "Retry loading" });

it("keeps keyboard focus on View's Retry while it is pending and after another failure", async () => {
  const user = userEvent.setup();
  const { reads } = retryable();
  await act(async () => reads[0]?.reject());
  await screen.findByRole("alert");
  retryButton().focus();
  await user.keyboard("{Enter}");
  expect(reads).toHaveLength(2);
  expect(retryButton()).toHaveFocus();
  expect(retryButton()).toHaveAttribute("aria-busy", "true");
  await act(async () => reads[1]?.reject());
  expect(retryButton()).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("Relay unavailable");
});

it("moves focus from a successful Retry into the rendered View", async () => {
  const user = userEvent.setup();
  const { reads } = retryable();
  await act(async () => reads[0]?.reject());
  await screen.findByRole("alert");
  retryButton().focus();
  await user.keyboard("{Enter}");
  await act(async () => reads[1]?.resolve());
  await within(view()).findByText("Recovered");
  expect(view()).toHaveFocus();
});

it("leaves focus where the user moved it during Retry", async () => {
  const user = userEvent.setup();
  const { reads } = retryable();
  await act(async () => reads[0]?.reject());
  await screen.findByRole("alert");
  retryButton().focus();
  await user.keyboard("{Enter}");
  screen.getByRole("tab", { name: "History" }).focus();
  await act(async () => reads[1]?.resolve());
  await within(view()).findByText("Recovered");
  expect(screen.getByRole("tab", { name: "History" })).toHaveFocus();
});

it("keeps the saved content and the local draft when a later reread fails", async () => {
  let fail = false;
  const canvas = mount(async () => {
    if (fail) throw new Error("Relay unavailable");
    return event("Saved text");
  });
  await within(view()).findByText("Saved text");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
  fireEvent.change(editor, { target: { value: "Draft text" } });
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  // Another editor retiring the shared draft makes this one reread.
  fail = true;
  act(() => clearView(scope, `canvas-draft-v1:${channelId}`));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay unavailable",
  );
  expect(view()).toHaveTextContent("Saved text");
  fail = false;
  fireEvent.click(retryButton());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(view()).toHaveTextContent("Saved text");
  expect(canvas.read).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(editor).toHaveValue("Draft text");
  fireEvent.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(canvas.save).toHaveBeenCalledWith(
      channelId,
      "Draft text",
      event("Saved text").id,
    ),
  );
});

it("settles a save in Edit after switching to View and back while it was in flight", async () => {
  let land = (_: RelayEvent) => {};
  const canvas = mount(async () => event("Saved text"));
  canvas.save.mockImplementation(
    () => new Promise<RelayEvent>((resolve) => (land = resolve)),
  );
  await within(view()).findByText("Saved text");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
  fireEvent.change(editor, { target: { value: "New text" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Canvas" }));
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toHaveTextContent("Saved text");
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(editor).toHaveAttribute("readonly");
  await act(async () => land(event("New text")));
  expect(editor).toHaveValue("New text");
  expect(editor).not.toHaveAttribute("readonly");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toHaveTextContent("New text");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
});

it("says when the Canvas is empty", async () => {
  mount(async () => undefined);
  expect(
    await within(view()).findByText("This Canvas is empty."),
  ).toBeInTheDocument();
});

it("switches between View and Edit while the first read is pending", () => {
  mount(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toBeVisible();
});

it("keeps Edit for read-only viewers, with Save disabled", async () => {
  mount(async () => event("Saved"), true);
  await within(view()).findByText("Saved");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(
    screen.getByRole("textbox", { name: "Canvas Markdown" }),
  ).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
});

it("never runs raw HTML, inline images or unsafe links", () => {
  const openLink = vi.fn(() => true);
  const { container } = render(
    <CanvasMarkdown
      openLink={openLink}
      content={[
        '<script>alert(1)</script><b onclick="x()">bold</b>',
        "",
        "![tracker chart](https://example.test/chart.png)",
        "",
        "[unsafe](javascript:alert(1)) [creds](https://u:p@example.test/) [safe](https://example.test/doc)",
      ].join("\n")}
    />,
  );
  expect(container.querySelector("script, b, img")).toBeNull();
  expect(container).toHaveTextContent("<script>alert(1)</script>");
  expect(container).toHaveTextContent("tracker chart");
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://example.test/doc",
  ]);
});

it("renders every Canvas within the save limit", () => {
  const largest = "x".repeat(LIVE_CANVAS_BYTES);
  expect(renderable(largest)).toBe(true);
});

it("falls back to labelled source past the render budget or nesting limit", () => {
  const large = `# Big\n\n${"x".repeat(CANVAS_RENDER_CHARS)}`;
  const deep = `${">".repeat(MAX_MARKDOWN_DEPTH + 5)} deep`;
  for (const content of [large, deep]) {
    const { container, unmount } = render(
      <CanvasMarkdown content={content} openLink={() => false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "shown as Markdown source",
    );
    expect(container.querySelector("pre")?.textContent).toBe(content);
    expect(container.querySelector("h1")).toBeNull();
    unmount();
  }
});

it("falls back to labelled source for a sparse wide table past the cell budget", () => {
  // 500 header cells pad 500 one-cell rows to 250,000 cells from 3 KB.
  const wide = (n: number) =>
    `|${"a|".repeat(n)}\n|${"-|".repeat(n)}\n${"x\n".repeat(n)}`;
  const sparse = wide(500);
  expect(sparse.length).toBeLessThan(4_000);
  const { container, unmount } = render(
    <CanvasMarkdown content={sparse} openLink={() => false} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "shown as Markdown source",
  );
  expect(container.querySelector("pre")?.textContent).toBe(sparse);
  expect(container.querySelector("table")).toBeNull();
  unmount();
  // A table inside a referenced footnote is counted too.
  const footnote = `Note[^1]\n\n[^1]:\n    ${sparse.trimEnd().split("\n").join("\n    ")}\n`;
  const nested = render(
    <CanvasMarkdown content={footnote} openLink={() => false} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "shown as Markdown source",
  );
  expect(nested.container.querySelector("table")).toBeNull();
  nested.unmount();
  // A table at the budget still renders.
  const side = Math.floor(Math.sqrt(CANVAS_RENDER_CELLS)) - 1;
  const { container: within } = render(
    <CanvasMarkdown content={wide(side)} openLink={() => false} />,
  );
  expect(within.querySelectorAll("td")).toHaveLength(side * side);
});

it("renders a Canvas larger than the shared-notes cutoff", async () => {
  const body = Array.from({ length: 4_000 }, (_, i) => `- item ${i}`).join(
    "\n",
  );
  expect(body.length).toBeGreaterThan(40_000);
  const content = `# Tracker\n\n${body}\n\n${"word ".repeat(15_000)}`;
  expect(content.length).toBeGreaterThan(100_000);
  render(<CanvasMarkdown content={content} openLink={() => false} />);
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Tracker" }),
    ).toBeInTheDocument(),
  );
});

it("keeps View rendered across tab switches while the head is unchanged", async () => {
  const user = userEvent.setup();
  mount(async () =>
    event("| Item | Status |\n| --- | --- |\n| Canvas | Ready |"),
  );
  const article = await waitFor(() => {
    const found = view();
    expect(within(found).getByRole("cell", { name: "Ready" })).toBeVisible();
    return found;
  });
  const renders = markdownRenders.count;
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas Markdown" }), {
    target: { value: "Unsaved" },
  });
  await user.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toBe(article);
  expect(markdownRenders.count).toBe(renders);
});
