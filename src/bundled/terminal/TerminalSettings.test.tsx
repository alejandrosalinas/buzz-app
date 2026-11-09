// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  createTerminalFontPreference,
  TERMINAL_FONT_KEY,
  type TerminalFontPreference,
} from "./font-preference";
import {
  createTerminalSettingsDraft,
  TerminalSettings,
} from "./TerminalSettings";

const stores: TerminalFontPreference[] = [];
const loadFont = vi.fn<(font: string) => Promise<FontFace[]>>();
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  loadFont.mockReset().mockResolvedValue([]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: loadFont },
  });
  // Fake only layout measurements; React and the font-check lifecycle stay real.
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.style.visibility !== "hidden" || this.style.fontSize !== "32px")
        return measure.call(this);
      const font = this.style.font;
      // A real mono face can match the monospace fallback; serif must detect it.
      return {
        width:
          font.includes(",") && !font.includes('"ASDF"')
            ? 100
            : font.endsWith("monospace")
              ? 100
              : 200,
      } as DOMRect;
    },
  );
});
function setup() {
  const font = createTerminalFontPreference();
  const drafts = createTerminalSettingsDraft();
  stores.push(font);
  const content = (active = true) => (
    <StrictMode>
      <ToastProvider>
        <TerminalSettings font={font} drafts={drafts} active={() => active} />
      </ToastProvider>
    </StrictMode>
  );
  return { font, content, view: render(content()) };
}
afterEach(() => {
  cleanup();
  for (const font of stores.splice(0)) font.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (fontsDescriptor)
    Object.defineProperty(document, "fonts", fontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
  localStorage.clear();
});

it("blocks pending and unavailable submissions without changing the active font", async () => {
  let finish: (() => void) | undefined;
  loadFont.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const { font } = setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  fireEvent.change(input, { target: { value: "ASDF" } });
  expect(loadFont).toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-busy", "true");
  expect(input).toHaveAccessibleDescription(
    /Type an installed font family name/,
  );
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Missing font form");
  fireEvent.submit(form);
  expect(font.snapshot().family).toBeNull();
  await act(async () => finish?.());
  expect(input).toHaveAccessibleDescription(/Couldn’t load “ASDF”/);
  fireEvent.submit(form);
  expect(font.snapshot().family).toBeNull();
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
});

it("ignores a stale success and recovers from probe rejection with Retry", async () => {
  let finishOld: (() => void) | undefined;
  loadFont.mockImplementation((name) =>
    name.includes("Old Font")
      ? new Promise((resolve) => {
          finishOld = () => resolve([]);
        })
      : Promise.reject(new Error("Font access failed")),
  );
  setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  fireEvent.change(input, { target: { value: "Old Font" } });
  fireEvent.change(input, { target: { value: "New Font" } });
  await waitFor(() => expect(input).toHaveAttribute("aria-busy", "false"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.blur(input);
  await screen.findByText(/Couldn’t load “New Font”/);
  await act(async () => finishOld?.());
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  expect(input).toHaveAccessibleDescription(/Couldn’t load “New Font”/);
  loadFont.mockResolvedValue([]);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry font check" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled(),
  );
  expect(input).toHaveFocus();
});

it("reports an unavailable saved font without clearing it, and allows Use default", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "ASDF");
  const { font } = setup();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "The terminal is using JetBrains Mono",
  );
  expect(font.snapshot().family).toBe("ASDF");
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Font size (px)" }), {
    target: { value: "20" },
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toMatchObject({ family: "ASDF", size: 20 });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use default" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
});

it("previews and applies size alone with the default family, then resets both", async () => {
  const { font } = setup();
  const input = screen.getByRole("spinbutton", { name: "Font size (px)" });
  expect(input).toHaveValue(12);
  fireEvent.change(input, { target: { value: "17.5" } });
  expect(screen.getByText(/^Preview:/)).toHaveStyle({
    fontSize: "17.5px",
    letterSpacing: "0",
  });
  expect(font.snapshot().size).toBe(12);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toEqual({ family: null, size: 17.5, error: null });
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue(12);
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
});

it("blocks invalid sizes and preserves both drafts across external changes", async () => {
  const { font } = setup();
  const input = screen.getByRole("spinbutton", { name: "Font size (px)" });
  for (const value of ["", "33"]) {
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const form = input.closest("form");
    if (!form) throw new Error("Missing font form");
    fireEvent.submit(form);
    expect(font.snapshot().size).toBe(12);
  }
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use default" }));
  const family = screen.getByRole("textbox", { name: "Font family" });
  act(() => font.set("MesloLGS NF", 20));
  expect(family).toHaveValue("MesloLGS NF");
  expect(input).toHaveValue(20);
  fireEvent.change(input, { target: { value: "16" } });
  fireEvent.change(family, { target: { value: "Courier New" } });
  act(() => font.set("Other Font", 24));
  expect(input).toHaveValue(16);
  expect(family).toHaveValue("Courier New");
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toEqual({
    family: "Courier New",
    size: 16,
    error: null,
  });
});

it("shows the saved family and previews a draft without applying it until Apply", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "MesloLGS NF");
  const { font } = setup();
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  expect(input).toHaveValue("MesloLGS NF");
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  await user.clear(input);
  await user.type(input, "  JetBrainsMono Nerd Font Mono  ");
  expect(font.snapshot().family).toBe("MesloLGS NF");
  expect(screen.getByText(/^Preview:/)).toHaveStyle({
    fontFamily: '"JetBrainsMono Nerd Font Mono", var(--font-system-mono)',
  });
  expect(screen.getByText(/^Preview:/)).toHaveTextContent(
    /^Preview: ABC 0123$/,
  );
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("JetBrainsMono Nerd Font Mono");
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe(
    "JetBrainsMono Nerd Font Mono",
  );
  expect(input).toHaveValue("JetBrainsMono Nerd Font Mono");
  await user.click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue("");
  expect(font.snapshot().family).toBeNull();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("rejects invalid drafts even on form submission and clears invalid input with Use default", async () => {
  const { font } = setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  for (const value of ["A,B", ""]) {
    fireEvent.change(input, { target: { value: value || " " } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Enter one font family name/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const form = input.closest("form");
    if (!form) throw new Error("Missing font form");
    fireEvent.submit(form);
    expect(font.snapshot().family).toBeNull();
    expect(screen.getByText(/^Preview:/)).toHaveStyle({
      fontFamily: "var(--font-system-mono)",
    });
  }
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps failed saves active, hides recovery while inactive, and retries the active preference", async () => {
  const { font, content, view } = setup();
  const user = userEvent.setup();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  await user.type(
    screen.getByRole("textbox", { name: "Font family" }),
    "MesloLGS NF",
  );
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("MesloLGS NF");
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be saved",
  );
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(content(true));
  write.mockRestore();
  await user.click(
    await screen.findByRole("button", {
      name: "Retry terminal font preference",
    }),
  );
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe("MesloLGS NF");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

function setupOptionMeta(platform = "MacIntel") {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const font = createTerminalFontPreference();
  stores.push(font);
  render(
    <ToastProvider>
      <TerminalSettings
        font={font}
        drafts={createTerminalSettingsDraft()}
        active={() => true}
      />
    </ToastProvider>,
  );
}

it("switches Option as Meta immediately on a Mac", async () => {
  setupOptionMeta();
  const toggle = screen.getByRole("switch", { name: "Use Option as Meta key" });
  expect(toggle).not.toBeChecked();
  await userEvent.setup().click(toggle);
  expect(toggle).toBeChecked();
  expect(localStorage.getItem("buzz-terminal-option-meta.v1")).toBe("on");
});

it("offers Option as Meta only on a Mac", () => {
  setupOptionMeta("Linux x86_64");
  expect(
    screen.queryByRole("switch", { name: "Use Option as Meta key" }),
  ).not.toBeInTheDocument();
});

it("keeps an unsaved Option as Meta choice and its retry across Settings visits", async () => {
  setupOptionMeta();
  const user = userEvent.setup();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Use Option as Meta key" }),
  );
  // Leave Terminal settings and return.
  cleanup();
  setupOptionMeta();
  expect(
    screen.getByRole("switch", { name: "Use Option as Meta key" }),
  ).toBeChecked();
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(localStorage.getItem("buzz-terminal-option-meta.v1")).toBe("on");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
