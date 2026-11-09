// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import {
  clearView,
  readView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { CanvasEditor } from "./CanvasEditor";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
} from "../../features/channel-templates/model";

// Canvas opens on View; these tests exercise Edit and History.
function openEdit() {
  for (const tab of screen.queryAllByRole("tab", { name: "Edit" }))
    if (tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
}
function render(ui: ReactNode, options?: Parameters<typeof renderView>[1]) {
  const result = renderView(ui, options);
  openEdit();
  const rerender = result.rerender;
  result.rerender = (ui) => {
    rerender(ui);
    openEdit();
  };
  return result;
}

const profiles = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};
const scope = "canvas-test";
const channelId = "11111111-1111-4111-8111-111111111111";
const key = keypair();
const head = signed(key, {
  kind: 40100,
  content: "Saved",
  tags: [["h", channelId]],
});
function fixture(
  configure?: (canvas: {
    available: boolean;
    read: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  }) => void,
  readOnly = false,
) {
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
  };
  configure?.(canvas);
  render(
    <>
      <button type="button">Message composer</button>
      <CanvasEditor
        readOnly={readOnly}
        canvas={canvas}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
      />
    </>,
  );
  return { canvas };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps editing after a save and uses the saved revision for the next edit", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByText("Current saved document")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Load current|Reload saved Canvas|Retry loading/,
    }),
  ).not.toBeInTheDocument();
  const saved = { ...head, content: "Edited", id: "b".repeat(64) };
  canvas.save.mockResolvedValueOnce(saved);
  fireEvent.change(text, { target: { value: "Edited" } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
  );
  expect(text).toBeEnabled();
  expect(text).toHaveValue("Edited");
  expect(canvas.save).toHaveBeenCalledWith(channelId, "Edited", head.id);
  fireEvent.change(text, { target: { value: "Second edit" } });
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Second edit",
    base: saved.id,
  });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(canvas.save).toHaveBeenLastCalledWith(
      channelId,
      "Second edit",
      saved.id,
    ),
  );
});

it("keeps a restored conflict draft until explicit confirmed reload", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "My unsaved work",
    base: "a".repeat(64),
  });
  const { canvas } = fixture();
  expect(await screen.findByRole("alert")).toHaveTextContent("Canvas changed");
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  expect(text).toHaveValue("My unsaved work");
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
  const reload = screen.getByRole("button", { name: "Reload saved Canvas" });
  for (const dismissal of ["backdrop", "escape", "close", "cancel"]) {
    await user.click(reload);
    const confirmation = screen.getByRole("dialog", {
      name: "Reload saved Canvas?",
    });
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.click(
      within(confirmation).getByText(
        "Discard your draft and reload the saved Canvas?",
      ),
    );
    expect(confirmation).toBeInTheDocument();
    if (dismissal === "backdrop")
      await user.click(
        confirmation.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(confirmation).getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(
      screen.getByRole("region", {
        name: "Channel Canvas",
      }),
    ).toBeInTheDocument();
    // jsdom lacks focus({ preventScroll }) detection; browser coverage checks pointer return.
    if (dismissal !== "backdrop")
      await waitFor(() => expect(reload).toHaveFocus());
    expect(text).toHaveValue("My unsaved work");
    expect(canvas.read).toHaveBeenCalledTimes(1);
  }
  await user.click(reload);
  await user.click(screen.getByRole("button", { name: "Discard and reload" }));
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload saved Canvas" }),
  ).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("hands a confirmed reload's focus to the editor unless it moved meanwhile", async () => {
  for (const order of ["closed", "moved", "closing"] as const) {
    const user = userEvent.setup();
    writeView(scope, `canvas-draft-v1:${channelId}`, {
      content: "My unsaved work",
      base: "a".repeat(64),
    });
    let land!: (event: typeof head) => Promise<void>;
    fixture((canvas) => {
      canvas.read.mockResolvedValueOnce(head);
      land = hold(canvas.read);
    });
    // Hold the confirmation's exit transition, which jsdom does not run.
    let exit!: () => void;
    const exiting = new Promise<void>((resolve) => {
      exit = resolve;
    });
    if (order === "closing")
      Object.defineProperty(Element.prototype, "getAnimations", {
        configurable: true,
        value(this: Element) {
          return this.hasAttribute("data-ending-style")
            ? [{ finished: exiting, playState: "finished" }]
            : [];
        },
      });
    try {
      const reload = await screen.findByRole("button", {
        name: "Reload saved Canvas",
      });
      await user.click(reload);
      const confirmation = screen.getByRole("dialog", {
        name: "Reload saved Canvas?",
      });
      await user.click(
        within(confirmation).getByRole("button", {
          name: "Discard and reload",
        }),
      );
      const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
      const composer = screen.getByRole("button", {
        name: "Message composer",
      });
      if (order === "closing") {
        await act(() => land(head));
        expect(text).toHaveValue("Saved");
        expect(confirmation).toBeInTheDocument();
        await act(async () => {
          exit();
          await exiting;
        });
      } else {
        await waitFor(() => expect(confirmation).not.toBeInTheDocument());
        await waitFor(() => expect(reload).toHaveFocus());
        expect(reload).toHaveAttribute("aria-busy", "true");
        if (order === "moved") composer.focus();
        await act(() => land(head));
        expect(text).toHaveValue("Saved");
      }
      await waitFor(() => expect(confirmation).not.toBeInTheDocument());
      await waitFor(() =>
        expect(order === "moved" ? composer : text).toHaveFocus(),
      );
    } finally {
      exit();
      if (order === "closing")
        delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
      cleanup();
    }
  }
});

it("retries a failed initial read without discarding the restored draft", async () => {
  for (const moved of [false, true]) {
    const user = userEvent.setup();
    writeView(scope, `canvas-draft-v1:${channelId}`, {
      content: "Unsaved",
      base: head.id,
    });
    let land!: (event: typeof head) => Promise<void>;
    const { canvas } = fixture((canvas) => {
      canvas.read
        .mockRejectedValueOnce(new Error("Offline"))
        .mockRejectedValueOnce(new Error("Still unreachable"));
      land = hold(canvas.read);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    const retry = screen.getByRole("button", { name: "Retry loading" });
    await user.click(retry);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still unreachable",
    );
    expect(retry).toHaveFocus();
    await user.click(retry);
    await waitFor(() => expect(canvas.read).toHaveBeenCalledTimes(3));
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
    const composer = screen.getByRole("button", { name: "Message composer" });
    if (moved) composer.focus();
    await act(() => land(head));
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
    expect(text).toHaveValue("Unsaved");
    expect(moved ? composer : text).toHaveFocus();
    expect(canvas.save).not.toHaveBeenCalled();
    cleanup();
  }
});

it("ignores the stale StrictMode read after the current read enables typing and saving", async () => {
  const user = userEvent.setup();
  let release!: (value: typeof head) => void;
  const stale = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi.fn().mockReturnValueOnce(stale).mockResolvedValue(head),
    save: vi.fn(async () => ({ ...head, id: "b".repeat(64) })),
  };
  render(
    <StrictMode>
      <CanvasEditor
        canvas={canvas}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
      />
    </StrictMode>,
  );
  try {
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toHaveValue("Saved"));
    expect(canvas.read).toHaveBeenCalledTimes(2);
    fireEvent.change(text, { target: { value: "New work" } });
    await act(async () => {
      release({ ...head, content: "Stale response" });
      await stale;
    });
    expect(text).toHaveValue("New work");
    await user.click(screen.getByRole("button", { name: "Save Canvas" }));
    await waitFor(() =>
      expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
    );
    expect(canvas.save).toHaveBeenCalledWith(channelId, "New work", head.id);
  } finally {
    release(head);
  }
});

it("retains the draft after a failed save and keeps editing after a successful retry", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  fireEvent.change(text, { target: { value: "Local draft" } });
  canvas.save.mockRejectedValueOnce(new Error("Offline: draft kept"));
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Offline: draft kept",
  );
  expect(text).toHaveValue("Local draft");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Local draft",
    base: head.id,
  });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
  );
  expect(canvas.save).toHaveBeenLastCalledWith(
    channelId,
    "Local draft",
    head.id,
  );
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
});

it("stores no draft for an unedited view, so a later revision reopens without a conflict", async () => {
  fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toBeEnabled());
  expect(text).toHaveValue("Saved");
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
  cleanup();
  const remote = { ...head, content: "Remote edit", id: "b".repeat(64) };
  fixture((canvas) => canvas.read.mockResolvedValue(remote));
  const reopened = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(reopened).toBeEnabled());
  expect(reopened).toHaveValue("Remote edit");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
});

it.each([
  ["forgets", "the loaded revision", head.id, null],
  [
    "keeps",
    "a stale revision",
    "a".repeat(64),
    { content: "Saved", base: "a".repeat(64) },
  ],
])(
  "%s a draft based on %s once edited back to the loaded Canvas",
  async (_, __, base, kept) => {
    writeView(scope, `canvas-draft-v1:${channelId}`, {
      content: "Recovered",
      base,
    });
    const { canvas } = fixture();
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toBeEnabled());
    fireEvent.change(text, { target: { value: "Saved" } });
    // A recovered draft on an older revision is still the viewer's work.
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(kept);
    if (!kept)
      expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
    expect(text).toHaveValue("Saved");
    expect(canvas.read).toHaveBeenCalledOnce();
  },
);

const edited = { ...head, content: "Edited", id: "b".repeat(64) };
const editor = () => ({
  available: true,
  history: vi.fn<ChannelCanvas["history"]>(),
  read: vi.fn(async () => head),
  save: vi.fn(async () => edited),
});
it("keeps a self-retired draft retired when editing precedes the loaded render's effects", async () => {
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "Recovered",
    base: head.id,
  });
  const canvas = editor();
  render(
    <div data-panel-workspace data-testid="workspace">
      <button type="button">Canvas tab</button>
      <div data-testid="canvas-mount" />
    </div>,
  );
  const host = screen.getByTestId("workspace");
  const tab = screen.getByRole("button", { name: "Canvas tab" });
  tab.focus();
  // Focus handoff precedes retirement's passive effect. Send a native input
  // within that handoff; nesting RTL's act wrapper inside the effect is invalid.
  host.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(event.target, "Saved");
    event.target.dispatchEvent(new Event("input", { bubbles: true }));
  });
  render(
    <CanvasEditor
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
    />,
    { container: screen.getByTestId("canvas-mount") },
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toHaveValue("Saved"),
  );
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
  expect(canvas.read).toHaveBeenCalledOnce();
});
it.each([head, edited])(
  "reconciles a draft cleared externally before mounting effects with head $content",
  async (current) => {
    writeView(scope, `canvas-draft-v1:${channelId}`, {
      content: "Recovered",
      base: head.id,
    });
    const canvas = editor();
    canvas.read.mockResolvedValue(current);
    function Mount() {
      useLayoutEffect(() => {
        // A peer clears the recovered draft after render, before passive effects.
        clearView(scope, `canvas-draft-v1:${channelId}`);
      }, []);
      return (
        <CanvasEditor
          canvas={canvas}
          profiles={profiles}
          scope={scope}
          channelId={channelId}
        />
      );
    }
    render(<Mount />);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Canvas Markdown" }),
      ).toHaveValue(current.content),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
    expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
    expect(canvas.read).toHaveBeenCalledTimes(2);
  },
);

async function twoEditors(third?: ReturnType<typeof editor>) {
  const saved = edited;
  const first = editor();
  const second = editor();
  render(
    <>
      <CanvasEditor
        canvas={first}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
      />
      <CanvasEditor
        canvas={second}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
      />
      {third && (
        <CanvasEditor
          canvas={third}
          profiles={profiles}
          scope={scope}
          channelId={channelId}
        />
      )}
    </>,
  );
  const [editing, other] = screen.getAllByRole("textbox", {
    name: "Canvas Markdown",
  }) as [HTMLElement, HTMLElement];
  await waitFor(() => {
    expect(editing).toBeEnabled();
    expect(other).toBeEnabled();
  });
  return { saved, first, second, editing, other };
}
it("reloads another open editor after it saves and removes the shared draft", async () => {
  const user = userEvent.setup();
  const { saved, first, second, editing, other } = await twoEditors();
  fireEvent.change(editing, { target: { value: "Edited" } });
  second.read.mockResolvedValue(saved);
  await user.click(
    screen.getAllByRole("button", { name: "Save Canvas" })[0] as HTMLElement,
  );
  await waitFor(() => expect(other).toHaveValue("Edited"));
  expect(second.read).toHaveBeenCalledTimes(2);
  expect(first.read).toHaveBeenCalledOnce();
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a draft typed after a save while another editor's reload is pending", async () => {
  const user = userEvent.setup();
  const { saved, first, second, editing, other } = await twoEditors();
  fireEvent.change(editing, { target: { value: "Edited" } });
  const land = hold(second.read);
  await user.click(
    screen.getAllByRole("button", { name: "Save Canvas" })[0] as HTMLElement,
  );
  await waitFor(() => {
    expect(second.read).toHaveBeenCalledTimes(2);
    expect(
      screen.getAllByRole("region", { name: "Channel Canvas" })[0],
    ).toHaveAttribute("aria-busy", "false");
  });
  fireEvent.change(editing, { target: { value: "After save" } });
  await act(() => land(saved));
  expect(other).toHaveValue("Edited");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "After save",
    base: saved.id,
  });
  expect(first.read).toHaveBeenCalledOnce();
  expect(editing).toHaveValue("After save");
});

it("keeps another editor's typed text when an edit back to the Canvas removes the draft", async () => {
  const { second, editing, other } = await twoEditors();
  const region = screen.getAllByRole("region", {
    name: "Channel Canvas",
  })[1] as HTMLElement;
  fireEvent.change(other, { target: { value: "Mine" } });
  fireEvent.change(editing, { target: { value: "Theirs" } });
  fireEvent.change(editing, { target: { value: head.content } });
  await waitFor(() => {
    expect(second.read).toHaveBeenCalledTimes(2);
    expect(region).toHaveAttribute("aria-busy", "false");
  });
  expect(other).toHaveValue("Mine");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Mine",
    base: head.id,
  });
  expect(within(region).queryByRole("alert")).toBeNull();
  expect(
    within(region).getByRole("button", { name: "Save Canvas" }),
  ).toBeEnabled();
});

it("keeps typed text stored when its save fails after another editor removed the draft", async () => {
  const user = userEvent.setup();
  const { second, editing, other } = await twoEditors();
  const region = screen.getAllByRole("region", {
    name: "Channel Canvas",
  })[1] as HTMLElement;
  fireEvent.change(other, { target: { value: "Mine" } });
  fireEvent.change(editing, { target: { value: "Theirs" } });
  fireEvent.change(editing, { target: { value: head.content } });
  await waitFor(() => {
    expect(second.read).toHaveBeenCalledTimes(2);
    expect(region).toHaveAttribute("aria-busy", "false");
  });
  // The edit back removed the draft; this editor stored its typed text again.
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).not.toBeNull();
  second.save.mockRejectedValueOnce(new Error("Offline: draft kept"));
  await user.click(within(region).getByRole("button", { name: "Save Canvas" }));
  expect(await within(region).findByRole("alert")).toHaveTextContent(
    "Offline: draft kept",
  );
  expect(other).toHaveValue("Mine");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Mine",
    base: head.id,
  });
});

it("keeps another editor's typed text through a reopen and blocks its Save after a save", async () => {
  const user = userEvent.setup();
  const { saved, second, editing, other } = await twoEditors();
  const region = screen.getAllByRole("region", {
    name: "Channel Canvas",
  })[1] as HTMLElement;
  fireEvent.change(other, { target: { value: "Mine" } });
  fireEvent.change(editing, { target: { value: "Edited" } });
  second.read.mockResolvedValue(saved);
  await user.click(
    screen.getAllByRole("button", { name: "Save Canvas" })[0] as HTMLElement,
  );
  await waitFor(() => {
    expect(second.read).toHaveBeenCalledTimes(2);
    expect(region).toHaveAttribute("aria-busy", "false");
  });
  expect(other).toHaveValue("Mine");
  expect(within(region).getByRole("alert")).toHaveTextContent(
    "Canvas changed since this draft began",
  );
  expect(
    within(region).getByRole("button", { name: "Save Canvas" }),
  ).toBeDisabled();
  cleanup();
  fixture((canvas) => canvas.read.mockResolvedValue(saved));
  const reopened = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(reopened).toBeEnabled());
  expect(reopened).toHaveValue("Mine");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Canvas changed since this draft began",
  );
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
});

it("reloads a busy clean editor after a save even when another editor stores its text again meanwhile", async () => {
  const user = userEvent.setup();
  const third = editor();
  const land = hold(third.read);
  const { saved, second, editing, other } = await twoEditors(third);
  const region = screen.getAllByRole("region", {
    name: "Channel Canvas",
  })[2] as HTMLElement;
  const busy = within(region).getByRole("textbox", { name: "Canvas Markdown" });
  expect(busy).toBeDisabled();
  fireEvent.change(other, { target: { value: "Mine" } });
  fireEvent.change(editing, { target: { value: "Edited" } });
  second.read.mockResolvedValue(saved);
  third.read.mockResolvedValue(saved);
  await user.click(
    screen.getAllByRole("button", { name: "Save Canvas" })[0] as HTMLElement,
  );
  // The save removed the shared draft and the second editor stored "Mine"
  // again before the third editor's held read landed.
  await waitFor(() =>
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
      content: "Mine",
      base: head.id,
    }),
  );
  expect(third.read).toHaveBeenCalledOnce();
  await act(() => land(head));
  await waitFor(() => expect(busy).toHaveValue("Edited"));
  expect(third.read).toHaveBeenCalledTimes(2);
  expect(within(region).queryByRole("alert")).toBeNull();
  expect(
    within(region).getByRole("button", { name: "Save Canvas" }),
  ).toBeEnabled();
  // The reload left the stored draft alone, so its editor did not reread.
  expect(second.read).toHaveBeenCalledTimes(2);
  expect(other).toHaveValue("Mine");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Mine",
    base: head.id,
  });
});

function hold(operation: ReturnType<typeof vi.fn>) {
  let land!: (event: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    land = resolve;
  });
  operation.mockReturnValueOnce(pending);
  // The editor awaited this promise first, so its continuation has run once
  // a later await of the same promise resumes.
  return async (event: typeof head) => {
    land(event);
    await pending;
  };
}
async function saveThenClose(content: string) {
  const user = userEvent.setup();
  let land!: (event: typeof head) => Promise<void>;
  const { canvas } = fixture((canvas) => {
    land = hold(canvas.save);
  });
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  fireEvent.change(text, { target: { value: content } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() => expect(canvas.save).toHaveBeenCalledOnce());
  // Closing the tab, changing channel or disabling the plugin unmounts it.
  cleanup();
  return land;
}
it("retires the saved draft when the editor closes before its save lands", async () => {
  const land = await saveThenClose("Edited");
  const saved = { ...head, content: "Edited", id: "b".repeat(64) };
  await land(saved);
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
  fixture((canvas) => canvas.read.mockResolvedValue(saved));
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Edited"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
});

it.each(["edited", "unchanged", "loading"])(
  "reconciles an earlier save after reopening with the draft %s",
  async (state) => {
    const land = await saveThenClose("Edited");
    const saved = { ...head, content: "Edited", id: "b".repeat(64) };
    let finishRead: ((event: typeof head) => Promise<void>) | undefined;
    const { canvas } = fixture((canvas) => {
      if (state === "loading") finishRead = hold(canvas.read);
    });
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    if (state !== "loading") await waitFor(() => expect(text).toBeEnabled());
    expect(text).toHaveValue("Edited");
    if (state === "edited")
      fireEvent.change(text, { target: { value: "Newer" } });
    canvas.read.mockResolvedValue(saved);
    await act(async () => {
      await land(saved);
      await finishRead?.(head);
    });
    // The retired draft reloads this editor; an edited one keeps its draft.
    await waitFor(() => {
      expect(canvas.read).toHaveBeenCalledTimes(state === "edited" ? 1 : 2);
      expect(
        screen.getByRole("region", { name: "Channel Canvas" }),
      ).toHaveAttribute("aria-busy", "false");
    });
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(
      state === "edited" ? { content: "Newer", base: head.id } : null,
    );
    expect(text).toHaveValue(state === "edited" ? "Newer" : "Edited");
    expect(screen.queryByRole("alert")).toBeNull();
    if (state !== "edited") {
      fireEvent.change(text, { target: { value: "Next edit" } });
      await userEvent.click(
        screen.getByRole("button", { name: "Save Canvas" }),
      );
      expect(canvas.save).toHaveBeenCalledWith(
        channelId,
        "Next edit",
        saved.id,
      );
    }
  },
);

it.each(["tab", "moved", "elsewhere"])(
  "hands initial focus into Canvas only from its own tab: %s",
  async (start) => {
    let finish!: (event: typeof head) => void;
    const reading = new Promise<typeof head>((resolve) => {
      finish = resolve;
    });
    const canvas = {
      available: true,
      history: vi.fn<ChannelCanvas["history"]>(),
      read: vi.fn(() => reading),
      save: vi.fn(async () => head),
    };
    render(
      <>
        <button type="button">Message composer</button>
        <div data-panel-workspace>
          <button type="button">Canvas tab</button>
          <div data-testid="canvas-mount" />
        </div>
      </>,
    );
    const composer = screen.getByRole("button", { name: "Message composer" });
    const tab = screen.getByRole("button", { name: "Canvas tab" });
    (start === "elsewhere" ? composer : tab).focus();
    render(
      <CanvasEditor
        canvas={canvas}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
      />,
      { container: screen.getByTestId("canvas-mount") },
    );
    if (start === "moved") composer.focus();
    await act(async () => {
      finish(head);
      await reading;
    });
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toBeEnabled());
    expect(start === "tab" ? text : composer).toHaveFocus();
  },
);

const old = {
  ...head,
  id: "c".repeat(64),
  content: "Earlier",
  created_at: head.created_at - 60,
};
const restored = {
  ...head,
  id: "d".repeat(64),
  content: old.content,
  created_at: head.created_at + 1,
};
async function fullRevision(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole("checkbox", { name: "Show full content" });
  if (toggle.getAttribute("aria-checked") !== "true") await user.click(toggle);
  return screen.getByRole("textbox", { name: "Revision Markdown" });
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  await user.click(screen.getAllByRole("radio").at(-1) as HTMLElement);
}
function historyFixture() {
  return fixture((canvas) => {
    canvas.history.mockResolvedValue({
      revisions: [head, old],
      next: undefined,
    });
    canvas.save.mockResolvedValue(restored);
  });
}
it.each([false, true])(
  "keeps archived Canvas and History readable with a local draft: %s",
  async (hasDraft) => {
    if (hasDraft)
      writeView(scope, `canvas-draft-v1:${channelId}`, {
        content: "Unpublished draft",
        base: head.id,
      });
    const user = userEvent.setup();
    const { canvas } = fixture((canvas) => {
      canvas.history.mockResolvedValue({
        revisions: [head, old],
        next: undefined,
      });
    }, true);
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    const content = hasDraft ? "Unpublished draft" : head.content;
    await waitFor(() => expect(text).toHaveValue(content));
    await waitFor(() => expect(text).toBeEnabled());
    expect(text).toHaveAttribute("readonly");
    if (hasDraft)
      expect(
        screen.getByText(
          "Showing your unsaved local draft. Open History to view saved versions.",
        ),
      ).toBeVisible();
    await user.type(text, "cannot change");
    expect(text).toHaveValue(content);
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
    await openHistory(user);
    expect(await fullRevision(user)).toHaveValue(old.content);
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    expect(screen.getByText("Canvas is read-only.")).toBeVisible();
    expect(canvas.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(text).toHaveValue(content);
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(
      hasDraft ? { content, base: head.id } : null,
    );
  },
);

it.each(["closed", "reopened", "edited"])(
  "reconciles a clean restore after a prior save with the editor %s",
  async (state) => {
    const user = userEvent.setup();
    const { canvas } = historyFixture();
    const saved = { ...head, content: "Edited", id: "e".repeat(64) };
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toHaveValue(head.content));
    canvas.save.mockResolvedValueOnce(saved);
    fireEvent.change(text, { target: { value: saved.content } });
    await user.click(screen.getByRole("button", { name: "Save Canvas" }));
    await waitFor(() => expect(text).toBeEnabled());
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
    canvas.history.mockResolvedValue({
      revisions: [saved, old],
      next: undefined,
    });
    const land = hold(canvas.save);
    await openHistory(user);
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(canvas.save).toHaveBeenCalledTimes(2));
    cleanup();
    const reopened =
      state !== "closed"
        ? fixture((canvas) => canvas.read.mockResolvedValue(saved)).canvas
        : undefined;
    if (reopened) {
      const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
      await waitFor(() => expect(editor).toHaveValue(saved.content));
      if (state === "edited")
        fireEvent.change(editor, { target: { value: "Newer" } });
      reopened.read.mockResolvedValue(restored);
    }
    await land(restored);
    if (!reopened) fixture((canvas) => canvas.read.mockResolvedValue(restored));
    const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() =>
      expect(editor).toHaveValue(
        state === "edited" ? "Newer" : restored.content,
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    if (reopened) {
      fireEvent.change(editor, { target: { value: "Next edit" } });
      await user.click(screen.getByRole("button", { name: "Save Canvas" }));
      expect(reopened.save).toHaveBeenCalledWith(
        channelId,
        "Next edit",
        state === "edited" ? saved.id : restored.id,
      );
    }
  },
);
it("loads history only on demand and preserves draft/base through preview and cancelled restore", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(editor).toHaveValue(head.content));
  expect(canvas.history).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "Local edits" } });
  const before = readView(scope, `canvas-draft-v1:${channelId}`, null);
  await openHistory(user);
  expect(await fullRevision(user)).toHaveValue(old.content);
  for (const dismissal of ["cancel", "escape", "backdrop"]) {
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    const confirm = screen.getByRole("dialog", {
      name: "Restore this version?",
    });
    await waitFor(() =>
      expect(
        within(confirm).getByRole("button", { name: "Restore version" }),
      ).toHaveFocus(),
    );
    if (dismissal === "cancel")
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        confirm.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
  }
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toBe(editor);
  expect(editor).toHaveValue("Local edits");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(before);
  expect(canvas.save).not.toHaveBeenCalled();
});
it.each([false, true])(
  "restores as a new revision and preserves dirty drafts (dirty=%s)",
  async (dirty) => {
    const user = userEvent.setup();
    const { canvas } = historyFixture();
    const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(editor).toHaveValue(head.content));
    if (dirty) fireEvent.change(editor, { target: { value: "Local edits" } });
    await openHistory(user);
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Restore this version?" }),
      ).not.toBeInTheDocument(),
    );
    expect(canvas.save).toHaveBeenCalledWith(channelId, old.content, head.id);
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(editor).toHaveValue(dirty ? "Local edits" : old.content);
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(
      dirty ? { content: "Local edits", base: head.id } : null,
    );
    if (dirty) {
      expect(
        screen.getByRole("button", { name: "Save Canvas" }),
      ).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "unsaved draft is kept",
      );
    } else
      expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
  },
);
it("stores no draft after restoring over a revision Refresh history found", async () => {
  const user = userEvent.setup();
  const remote = { ...head, content: "Remote edit", id: "b".repeat(64) };
  const { canvas } = historyFixture();
  await openHistory(user);
  canvas.read.mockResolvedValue(remote);
  canvas.history.mockResolvedValue({
    revisions: [remote, head, old],
    next: undefined,
  });
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() =>
    expect(screen.getAllByRole("radio")[0]).toHaveAccessibleName(/Current/),
  );
  // The selected older revision now compares against the refreshed head.
  const changes = screen.getByRole("region", {
    name: "Changes from current version",
  });
  expect(changes).toHaveTextContent("Removed: Remote edit");
  expect(changes).toHaveTextContent(`Added: ${old.content}`);
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Restore this version?" }),
    ).not.toBeInTheDocument(),
  );
  expect(canvas.save).toHaveBeenCalledWith(channelId, old.content, remote.id);
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
  cleanup();
  fixture((canvas) => canvas.read.mockResolvedValue(restored));
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toBeEnabled());
  expect(text).toHaveValue(restored.content);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
});
it.each(["save", "restore"])(
  "keeps typed text stored when a %s fails after typing could not store it",
  async (action) => {
    const user = userEvent.setup();
    const { canvas } = historyFixture();
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toBeEnabled());
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    fireEvent.change(text, { target: { value: "Mine" } });
    // No draft is stored, so the write stores a snapshot of the typed text.
    expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
    canvas.save.mockRejectedValueOnce(new Error("Offline: draft kept"));
    if (action === "save")
      await user.click(screen.getByRole("button", { name: "Save Canvas" }));
    else {
      await openHistory(user);
      await user.click(
        screen.getByRole("button", { name: "Restore this version" }),
      );
      await user.click(screen.getByRole("button", { name: "Restore version" }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Offline: draft kept",
    );
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
      content: "Mine",
      base: head.id,
    });
  },
);
it("keeps a stale recovered draft even when its text matches the loaded head", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: head.content,
    base: "e".repeat(64),
  });
  historyFixture();
  await openHistory(user);
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Restore this version?" }),
    ).not.toBeInTheDocument(),
  );
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: head.content,
    base: "e".repeat(64),
  });
});
it.each([
  "Canvas changed",
  "Save is awaiting exact relay confirmation",
  "A different Canvas is selected",
])("retains drafts and displays restore outcome: %s", async (message) => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  await openHistory(user);
  canvas.save.mockRejectedValueOnce(new Error(message));
  canvas.read.mockResolvedValueOnce({
    ...head,
    id: "e".repeat(64),
    content: "Another editor",
  });
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(message),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    head.content,
  );
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
  expect(canvas.save).toHaveBeenCalledOnce();
  // The pending write's clean snapshot is not left behind as a draft.
  expect(viewRevision(scope, `canvas-draft-v1:${channelId}`)).toBeNull();
});
it("restores empty revisions but refuses current and oversized revisions", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture((canvas) => {
    canvas.history.mockResolvedValue({
      revisions: [
        head,
        { ...old, content: "" },
        {
          ...old,
          id: "f".repeat(64),
          content: "x".repeat(LIVE_CANVAS_BYTES + 1),
        },
      ],
      next: undefined,
    });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
  const radios = screen.getAllByRole("radio");
  await user.click(radios[2] as HTMLElement);
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
  expect(
    screen.getByText(`exceeds the ${LIVE_CANVAS_LIMIT}`, { exact: false }),
  ).toBeInTheDocument();
  await user.click(radios[1] as HTMLElement);
  expect(screen.getByText("This version is empty.")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(canvas.save).toHaveBeenCalledWith(channelId, "", head.id),
  );
});

it("retries history failures, pages without losing selection and reconciles selection after restore", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture((canvas) => {
    canvas.history.mockRejectedValueOnce(new Error("History offline"));
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("History offline");
  const cursor = { until: head.created_at, before_id: head.id };
  canvas.history.mockResolvedValueOnce({ revisions: [head], next: cursor });
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await screen.findByRole("radio", { name: /Current/ });
  canvas.history.mockResolvedValueOnce({ revisions: [old], next: undefined });
  await user.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
  expect(canvas.history).toHaveBeenLastCalledWith(channelId, cursor);
  await waitFor(() => expect(screen.getAllByRole("radio")[1]).toHaveFocus());
  await user.click(screen.getAllByRole("radio")[1] as HTMLElement);
  const changes = () =>
    screen.getByRole("region", { name: "Changes from current version" });
  expect(changes()).toHaveTextContent("Removed: Saved");
  expect(changes()).toHaveTextContent("Added: Earlier");
  canvas.save.mockResolvedValueOnce(restored);
  canvas.history.mockResolvedValueOnce({
    revisions: [restored, head],
    next: cursor,
  });
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: /Current/ })).toBeChecked(),
  );
  expect(screen.getByText("Same as current version.")).toBeVisible();
  // The diff follows the new head.
  await user.click(screen.getAllByRole("radio")[1] as HTMLElement);
  expect(changes()).toHaveTextContent("Removed: Earlier");
  expect(changes()).toHaveTextContent("Added: Saved");
  await user.click(screen.getAllByRole("radio")[0] as HTMLElement);
  expect(await fullRevision(user)).toHaveValue(restored.content);
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
});
it("keeps the real same-second refusal on Edit without telling an unchanged draft to reload", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  await openHistory(user);
  canvas.save.mockRejectedValueOnce(
    new Error("Please wait a second before saving Canvas again"),
  );
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Please wait a second"),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Please wait a second");
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "Reload the saved Canvas before editing",
  );
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
});
it("prevents all dismissal during restore and ignores a history response from an unmounted panel", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  await openHistory(user);
  let release!: (event: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  canvas.save.mockReturnValueOnce(pending);
  try {
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(canvas.save).toHaveBeenCalledOnce());
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Restore this version?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  } finally {
    await act(async () => {
      release(restored);
      await pending;
    });
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Restore this version?" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  let finish!: (page: { revisions: (typeof head)[]; next: undefined }) => void;
  const stale = new Promise<{ revisions: (typeof head)[]; next: undefined }>(
    (resolve) => {
      finish = resolve;
    },
  );
  canvas.history.mockReturnValueOnce(stale);
  await user.click(screen.getByRole("tab", { name: "History" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Loading history"),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  canvas.history.mockResolvedValueOnce({
    revisions: [restored],
    next: undefined,
  });
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  await act(async () => {
    finish({ revisions: [old], next: undefined });
    await stale;
  });
  expect(screen.getByRole("radio", { name: /Current/ })).toBeChecked();
  expect(await fullRevision(user)).toHaveValue(restored.content);
});

it.each(["diff", "absent", "moved"] as const)(
  "keeps History's head-read Retry focused through repeated failure and hands focus to the comparison: %s",
  async (outcome) => {
    const user = userEvent.setup();
    let land!: (event: typeof head) => Promise<void>;
    const { canvas } = fixture((canvas) => {
      canvas.read.mockRejectedValueOnce(new Error("Offline"));
      canvas.history.mockResolvedValue({
        revisions: [head, old],
        next: undefined,
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    await user.click(screen.getByRole("tab", { name: "History" }));
    await user.click(
      (await screen.findAllByRole("radio")).at(-1) as HTMLElement,
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(
      screen.queryByRole("region", { name: "Changes from current version" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();

    canvas.read.mockRejectedValueOnce(new Error("Still unreachable"));
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(canvas.read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retry).not.toHaveAttribute("aria-busy", "true"));
    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus();

    land = hold(canvas.read);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(canvas.read).toHaveBeenCalledTimes(3));
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(retry).toHaveFocus();
    // Repeat activation while the read is pending starts no other read.
    await user.keyboard("{Enter}");
    expect(canvas.read).toHaveBeenCalledTimes(3);
    const composer = screen.getByRole("button", { name: "Message composer" });
    if (outcome === "moved") composer.focus();
    await act(() => land(outcome === "absent" ? (undefined as never) : head));
    const changes = screen.getByRole("region", {
      name: "Changes from current version",
    });
    expect(changes).toHaveTextContent(`Added: ${old.content}`);
    if (outcome === "absent") expect(changes).not.toHaveTextContent("Removed:");
    else expect(changes).toHaveTextContent(`Removed: ${head.content}`);
    if (outcome === "moved") expect(composer).toHaveFocus();
    else expect(document.activeElement).toContainElement(changes);
  },
);

it("stops comparing with a loaded head whose refresh fails, keeping the draft", async () => {
  const user = userEvent.setup();
  const newer = {
    ...head,
    id: "e".repeat(64),
    content: "Published elsewhere",
    created_at: head.created_at + 5,
  };
  const { canvas } = historyFixture();
  const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(editor).toHaveValue(head.content));
  fireEvent.change(editor, { target: { value: "Local edits" } });
  await openHistory(user);
  expect(
    screen.getByRole("region", { name: "Changes from current version" }),
  ).toBeInTheDocument();

  // Another client publishes; History finds it but the head read fails.
  canvas.history.mockResolvedValue({
    revisions: [newer, head, old],
    next: undefined,
  });
  canvas.read.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(canvas.history).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(3));
  await user.click(screen.getAllByRole("radio")[0] as HTMLElement);
  expect(
    await screen.findByText(/current Canvas could not be read/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Same as current version."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Changes from current version" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();

  canvas.read.mockResolvedValue(newer);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Same as current version."),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(editor).toHaveValue("Local edits");
});
