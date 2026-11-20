// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoicePreview } from "./VoicePreview";
import { previewVoice, preloadPreview } from "./voice-preview";
import type { PreviewHost } from "./voice-preview";

vi.mock("./voice-preview", () => ({
  previewVoice: vi.fn(),
  preloadPreview: vi.fn(async () => new Uint8Array()),
}));
const voiceName = () =>
  screen.queryByRole("radio", { name: "Maple", checked: true })
    ? "Maple"
    : screen.queryByRole("radio", { name: "Cove", checked: true })
      ? "Cove"
      : "Codex default";
const host: PreviewHost = { request: vi.fn(), requestBytes: vi.fn() };
const previews = {
  cove: "https://persistent.oaistatic.com/voice/previews/cove.test.m4a",
  maple: "https://persistent.oaistatic.com/voice/previews/maple.test.m4a",
};
beforeEach(() => {
  vi.mocked(previewVoice).mockImplementation(async (_host, url) => {
    await url;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(previewVoice).mockReset();
});

it("previews the unsaved choice, stops immediately, and ignores a late failure", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(previewVoice).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="maple"
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  expect(previewVoice).toHaveBeenCalledWith(
    host,
    expect.any(Promise),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(signal?.aborted).toBe(true);
  reject(new Error("Late error"));
  expect(
    await screen.findByRole("button", { name: "Huddle voice" }),
  ).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("ends a preview when its keyed voice changes or settings closes", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const onCommit = vi.fn();
  const view = render(
    <VoicePreview
      key="cove"
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  view.rerender(
    <VoicePreview
      key="maple"
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="maple"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  expect(first?.aborted).toBe(true);
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const second = vi.mocked(previewVoice).mock.calls[1]?.[2];
  view.unmount();
  expect(second?.aborted).toBe(true);
  expect(onCommit).not.toHaveBeenCalled();
});

it("shows errors and lets the user retry the default voice", async () => {
  vi.mocked(previewVoice)
    .mockRejectedValueOnce(new Error("Sign in to Codex."))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to Codex.",
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(previewVoice).toHaveBeenLastCalledWith(
    host,
    expect.any(Promise),
    expect.any(AbortSignal),
    expect.any(Function),
  );
});

it("selects and previews rows, replaces playback and stops on dismissal", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const onCommit = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      defaultVoice="cove"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  expect(screen.getByRole("radio", { name: "Cove" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  expect(onCommit).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.click(screen.getByRole("radio", { name: "Cove" }));
  expect(first?.aborted).toBe(true);
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  const second = vi.mocked(previewVoice).mock.calls[2]?.[2];
  await user.keyboard("{Escape}");
  expect(second?.aborted).toBe(true);
  expect(onCommit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Huddle voice" })).toBeVisible();
});

it("previews multiple voices and commits only the final choice on Close", async () => {
  const onCommit = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Huddle voice" }),
  ).toHaveTextContent("Cove · Default");
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(onCommit).not.toHaveBeenCalled();
  expect(previewVoice).toHaveBeenCalledWith(
    host,
    expect.any(Promise),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.click(screen.getByRole("radio", { name: "Cove" }));
  expect(onCommit).not.toHaveBeenCalled();
  const playback = vi.mocked(previewVoice).mock.calls.at(-1)?.[2];
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(playback?.aborted).toBe(true);
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("cove");
});

it("ignores stale audio callbacks after another selection", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice="cove"
      voices={["cove", "maple"]}
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: "Cove" }));
  const first = vi.mocked(previewVoice).mock.calls[0];
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  act(() => first?.[3]?.());
  expect(first?.[2].aborted).toBe(true);
  expect(vi.mocked(previewVoice).mock.calls[1]?.[2].aborted).toBe(false);
});

it("preloads the selected recording, then the other choices when the picker opens", async () => {
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(preloadPreview).toHaveBeenCalledWith(host, previews.cove),
  );
  expect(preloadPreview).not.toHaveBeenCalledWith(host, previews.maple);
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  expect(preloadPreview).toHaveBeenCalledWith(host, previews.maple);
});

it("keeps playback alive when loading changes to playing", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const call = vi.mocked(previewVoice).mock.calls[0];
  act(() => call?.[3]?.());
  expect(call?.[2].aborted).toBe(false);
  view.unmount();
  expect(call?.[2].aborted).toBe(true);
});
it("keeps arrow navigation and activation of the selected row open", async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  screen.getByRole("radio", { name: "Codex default" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("dialog", { name: "Choose voice" })).toBeVisible();
  expect(screen.getByRole("radio", { name: "Cove" })).toBeChecked();
  expect(onCommit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "Codex default" }));
  expect(screen.getByRole("dialog", { name: "Choose voice" })).toBeVisible();
});

it("stops a pending preview when retained settings become hidden", async () => {
  let visible = true;
  const previous = HTMLElement.prototype.checkVisibility;
  HTMLElement.prototype.checkVisibility = () => visible;
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <div data-testid="retained">
      <VoicePreview
        host={host}
        voices={["cove", "maple"]}
        previews={previews}
        voice="maple"
        disabled={false}
        onCommit={vi.fn()}
      />
    </div>,
  );
  try {
    if (!screen.queryByRole("dialog"))
      await user.click(screen.getByRole("button", { name: "Huddle voice" }));
    await user.click(screen.getByRole("radio", { name: voiceName() }));
    const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
    visible = false;
    view.getByTestId("retained").hidden = true;
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it("stops hidden retained previews without checkVisibility", async () => {
  const previous = HTMLElement.prototype.checkVisibility;
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <div data-testid="older">
      <VoicePreview
        host={host}
        voices={["cove", "maple"]}
        previews={previews}
        voice="maple"
        disabled={false}
        onCommit={vi.fn()}
      />
    </div>,
  );
  try {
    if (!screen.queryByRole("dialog"))
      await user.click(screen.getByRole("button", { name: "Huddle voice" }));
    await user.click(screen.getByRole("radio", { name: voiceName() }));
    const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
    view.getByTestId("older").hidden = true;
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it("filters supported voices by locale without changing the saved voice", async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(
    <VoicePreview
      voice="vale"
      voices={["cove", "vale", "neer", "new"]}
      accents={{
        cove: "American English",
        vale: "British English",
        neer: "Hindi",
        unsupported: "French",
      }}
      disabled={false}
      onCommit={onCommit}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Huddle voice" });
  expect(trigger).toHaveAttribute("data-variant", "outline");
  await user.click(trigger);
  const locale = screen.getByRole("combobox", { name: "Language and region" });
  expect(locale).toHaveTextContent("British English");
  expect(screen.getByRole("radio", { name: "Vale" })).toBeChecked();
  expect(screen.queryByRole("radio", { name: "Cove" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  locale.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.queryByRole("option", { name: "French" })).toBeNull();
  await user.click(await screen.findByRole("option", { name: "Hindi" }));
  expect(screen.getByRole("radio", { name: "Neer" })).toBeEnabled();
  expect(screen.queryByRole("radio", { name: "Vale" })).toBeNull();
  expect(onCommit).not.toHaveBeenCalled();
  await waitFor(() => expect(locale).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: "Other voices" }));
  expect(screen.getByRole("radio", { name: "New" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  expect(locale).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Language and region" }),
  ).toHaveTextContent("British English");
});

it("retains a selected preview through recording discovery and uses its new URL", async () => {
  const user = userEvent.setup();
  const props = {
    voice: "cove",
    voices: ["cove", "maple"],
    disabled: false,
    onCommit: vi.fn(),
  };
  const view = render(<VoicePreview {...props} previewLoading />);
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  view.rerender(<VoicePreview {...props} previews={previews} />);
  await waitFor(() => expect(previewVoice).toHaveBeenCalledOnce());
  expect(await vi.mocked(previewVoice).mock.calls[0]?.[1]).toBe(previews.maple);
});
it("returns focus to Voice when the picker closes during persistence", async () => {
  const user = userEvent.setup();
  const props = { voice: "cove", disabled: false, onCommit: vi.fn() };
  const view = render(<VoicePreview {...props} />);
  const trigger = screen.getByRole("button", { name: "Huddle voice" });
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  view.rerender(<VoicePreview {...props} disabled />);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("refreshes after a retained pane finishes leaving and returns", async () => {
  const previous = HTMLElement.prototype.checkVisibility;
  HTMLElement.prototype.checkVisibility = function () {
    const pane = this.closest("[data-testid=retained]");
    return (
      !pane?.hasAttribute("data-covered") || pane.hasAttribute("data-leaving")
    );
  };
  const onShown = vi.fn();
  const view = render(
    <div data-testid="retained">
      <VoicePreview
        voices={["cove"]}
        voice=""
        disabled={false}
        onCommit={vi.fn()}
        onShown={onShown}
      />
    </div>,
  );
  const pane = view.getByTestId("retained");
  try {
    await act(async () => {
      pane.setAttribute("data-leaving", "");
      pane.setAttribute("data-covered", "");
      pane.setAttribute("inert", "");
    });
    await act(async () => pane.removeAttribute("data-leaving"));
    await act(async () => {
      pane.removeAttribute("data-covered");
      pane.removeAttribute("inert");
    });
    expect(onShown).toHaveBeenCalledOnce();
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it.each([
  { voice: "maple", expected: "Maple" },
  { voice: "", expected: "Cove · Default" },
  { voice: "retired", expected: "Retired (unavailable)" },
])(
  "describes the current voice accessibly: $expected",
  ({ voice, expected }) => {
    render(
      <VoicePreview
        voices={["cove", "maple"]}
        voice={voice}
        defaultVoice="cove"
        disabled={false}
        onCommit={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Huddle voice" }),
    ).toHaveAccessibleDescription(expect.stringContaining(expected));
  },
);

it("shows neutral status for missing recordings and still lets the user save", async () => {
  const onCommit = vi.fn();
  render(
    <VoicePreview
      voices={["cove", "maple"]}
      voice="cove"
      disabled={false}
      onCommit={onCommit}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(onCommit).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "No recording is available for this voice.",
    ),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("maple");
});

it("keeps preview download failures as errors", async () => {
  vi.mocked(previewVoice).mockRejectedValueOnce(
    new Error("Recording could not be decoded"),
  );
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voices={["cove", "maple"]}
      voice="cove"
      disabled={false}
      onCommit={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Huddle voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recording could not be decoded",
  );
});
