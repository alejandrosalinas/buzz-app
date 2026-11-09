// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { CreateModelChoices } from "../../features/agents/CreateModelChoices";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { agentAvatars } from "../../features/agents/avatar-packs";
import type {
  Agent,
  AgentCreateProps,
  AgentCreationRequest,
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  emojiAvatar,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { AgentCreateDialog } from "./AgentCreateDialog";
import {
  BuilderlabLogoIcon,
  CodexLogoIcon,
} from "../../shared/design-system/icons";
import { Select } from "../../shared/design-system/ui/Select";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  uploadAvatar: vi.fn(),
  emojiAvatar: vi.fn(),
  paintEmojiAvatar: vi.fn(),
}));

// Exercise our selection callback without emoji-mart's browser-only observers.
vi.mock("../../bundled/emoji/emoji-mart", () => ({
  mountEmojiMart: ({
    host,
    select,
  }: {
    host: HTMLElement;
    select(value: string): void;
  }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Choose robot";
    button.onclick = () => select("🤖");
    host.append(button);
    return () => button.remove();
  },
}));

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

afterEach(cleanup);
// jsdom has no object URLs; an upload previews its file through one.
beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:upload"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
// jsdom lacks both; tests that need them install stubs, removed here along
// with stubbed frames and media queries.
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
  motion.reduced = false;
});

type Echo = { reply: string };
type Notes = { notes: string; instructions: string };

const echo = {
  key: "test/echo",
  pluginId: "test",
  revision: "1",
  id: "echo",
  title: "Echo",
  description: "Says its line.",
  defaults: () => ({ config: { reply: "" } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Echo;
    disabled: boolean;
    onChange(config: Echo): void;
  }) => (
    <input
      aria-label="Reply"
      disabled={disabled}
      value={config.reply}
      onChange={(event) => onChange({ reply: event.target.value })}
    />
  ),
} as unknown as RegisteredAgentType;

const notes = {
  key: "test/notes",
  pluginId: "test",
  revision: "1",
  id: "notes",
  title: "Notes",
  description: "Takes notes.",
  defaults: () => ({ config: { notes: "start", instructions: "Be brief." } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Notes;
    disabled: boolean;
    onChange(config: Notes): void;
  }) => (
    <>
      <input
        aria-label="Notes"
        disabled={disabled}
        value={config.notes}
        onChange={(event) => onChange({ ...config, notes: event.target.value })}
      />
      <AgentInstructions
        value={config.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...config, instructions })}
      />
    </>
  ),
} as unknown as RegisteredAgentType;

const made = {
  pubkey: "3".repeat(64),
  name: "Nova",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attention: {},
} as unknown as Agent;

function setup(
  types: readonly RegisteredAgentType[],
  create: (input: NewAgent) => Promise<Agent> = async () => made,
  community?: string,
  request?: AgentCreationRequest,
) {
  const agents = { create: vi.fn(create) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentCreateDialog
      agents={agents}
      types={types}
      community={community}
      onCreated={onCreated}
      onClose={onClose}
      {...(request && { request })}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  return { agents, onCreated, onClose, dialog, user: userEvent.setup() };
}

const createButton = () => screen.getByRole("button", { name: "Create agent" });
// The disabled action blocks ordinary attempts; direct submits retain a guard.
const submitForm = (dialog: HTMLElement) =>
  fireEvent.submit(within(dialog).getByRole("form", { name: "New agent" }));
const remoteEcho = {
  ...echo,
  title: "Builderlab",
  remote: {},
} as RegisteredAgentType;

it("places the provider action beside Harness and disables it while creating", async () => {
  let finish = (_agent: Agent) => {};
  const type: RegisteredAgentType = {
    ...echo,
    CreateAction: ({ disabled }) => (
      <button type="button" disabled={disabled}>
        Sign in
      </button>
    ),
  };
  const { dialog, user } = setup(
    [type],
    () =>
      new Promise<Agent>((resolve) => {
        finish = resolve;
      }),
  );
  const action = within(dialog).getByRole("button", { name: "Sign in" });
  const harness = within(dialog).getByRole("combobox", { name: "Harness" });
  expect(harness.closest(".buzz-preference-row")).toContainElement(action);
  expect(action).toBeEnabled();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(action).toBeDisabled();
  await act(async () => finish(made));
});

it("keeps configuration readiness active during the remote introduction", async () => {
  let report = (_ready: boolean) => {};
  const type: RegisteredAgentType = {
    ...remoteEcho,
    CreateConfiguration: ({ harnessControl, onReadyChange }) => {
      useLayoutEffect(() => {
        report = onReadyChange ?? (() => {});
        onReadyChange?.(true);
      }, [onReadyChange]);
      return harnessControl;
    },
  };
  const { agents, dialog, user } = setup([type]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  const intro = screen.getByRole("dialog", { name: "Meet your remote agent" });
  const proceed = within(intro).getByRole("button", { name: "Let’s go" });
  act(() => report(false));
  expect(proceed).toBeDisabled();
  await user.click(proceed);
  expect(agents.create).not.toHaveBeenCalled();
  act(() => report(true));
  expect(proceed).toBeEnabled();
  await user.click(within(intro).getByRole("button", { name: "Back" }));
  act(() => report(false));
  expect(createButton()).toBeDisabled();
});

it("creates with the name, a pack picture and the config from the type's view", async () => {
  const { agents, onCreated, dialog, user } = setup([echo]);
  expect(
    within(dialog).queryByRole("combobox", { name: "Thinking" }),
  ).toBeNull();
  await user.type(within(dialog).getByLabelText("Name"), "  Nova ");

  const grid = within(dialog).getByRole("group", { name: "Agent avatars" });
  const avatar = agentAvatars.find((item) =>
    within(grid).queryByRole("button", { name: item.label }),
  );
  const previous = agentAvatars.find(
    (item) => !within(grid).queryByRole("button", { name: item.label }),
  );
  if (!avatar || !previous)
    throw new Error("The preview and dock have avatars");
  const slot = within(grid).getByRole("button", { name: avatar.label });
  await user.click(slot);
  expect(
    within(grid).queryByRole("button", { name: avatar.label }),
  ).not.toBeInTheDocument();
  expect(slot).toHaveAccessibleName(previous.label);
  expect(await within(dialog).findByLabelText("Name")).toHaveValue("  Nova ");
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/echo",
    name: "Nova",
    picture: avatar.url,
    config: { reply: "Hi there" },
  });
  expect(avatar.url).toMatch(/^https:\/\//);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(made);
});

it("cancels an in-flight Gloopy swap before switching to Emoji", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("(hover: hover)"),
    addEventListener() {},
    removeEventListener() {},
  }));
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    finished: Promise<void>;
  }[] = [];
  Element.prototype.animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(),
      finished: new Promise<void>(() => {}),
    };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  const { dialog, user } = setup([echo]);
  const dock = within(dialog).getByRole("group", { name: "Agent avatars" });
  const slot = within(dock).getAllByRole("button")[0];
  if (!slot) throw new Error("The dock has an avatar");
  fireEvent.click(slot, { detail: 1 });
  expect(animations).toHaveLength(2);
  const swapAnimations = [...animations];
  expect(slot.style.visibility).toBe("hidden");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(
    within(dialog).getByRole("button", { name: "Choose emoji" }),
  ).toBeVisible();
  for (const animation of swapAnimations)
    expect(animation.cancel).toHaveBeenCalledOnce();
  expect(slot.style.visibility).toBe("");
  expect(document.querySelector('body > img[aria-hidden="true"]')).toBeNull();
});

it("switches avatar types directly and restores the emoji draft with the keyboard", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  const tabs = within(
    within(dialog).getByRole("tablist", { name: "Avatar type" }),
  );
  expect(tabs.getAllByRole("tab")).toHaveLength(3);
  expect(tabs.getByRole("tab", { name: "Gloopies" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(tabs.getByRole("tab", { name: "Emoji" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(tabs.getByRole("tab", { name: "Gloopies" }));
  await user.keyboard("{ArrowRight}{Enter}");
  expect(tabs.getByRole("tab", { name: "Emoji" })).toHaveFocus();
  expect(tabs.getByRole("tab", { name: "Emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("creates with a custom emoji on a chosen background", async () => {
  const file = new File(["emoji"], "avatar.png", { type: "image/png" });
  vi.mocked(emojiAvatar).mockResolvedValueOnce(file);
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://images.example/emoji.png",
  );
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(within(dialog).getByRole("tab", { name: "Emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Choose emoji" }),
  );
  await user.click(await screen.findByRole("button", { name: "Choose robot" }));
  expect(
    screen.queryByRole("button", { name: "Choose robot" }),
  ).not.toBeInTheDocument();
  expect(
    within(
      within(dialog).getByRole("group", { name: "Avatar background" }),
    ).getAllByRole("button"),
  ).toHaveLength(20);
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(createButton());
  expect(emojiAvatar).toHaveBeenCalledExactlyOnceWith("🤖", "#0090FF");
  await waitFor(() =>
    expect(uploadAvatar).toHaveBeenCalledWith(
      file,
      "https://a.example",
      expect.any(AbortSignal),
    ),
  );
  expect(agents.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ picture: "https://images.example/emoji.png" }),
  );
});

it("keeps an emoji avatar draft after an outside click", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(document.body);
  expect(dialog).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("does not create an emoji avatar without an upload community", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(createButton());
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Select a community",
  );
  expect(agents.create).not.toHaveBeenCalled();
  expect(createButton()).toBeEnabled();
});

it("opens the file picker directly and recovers from an upload failure", async () => {
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const input = within(dialog).getByLabelText(
    "Upload an image",
  ) as HTMLInputElement;
  const browse = vi.spyOn(input, "click");
  await user.click(within(dialog).getByRole("tab", { name: "Upload image" }));
  expect(browse).toHaveBeenCalledOnce();
  vi.mocked(uploadAvatar).mockRejectedValueOnce(new Error("Upload failed"));
  const file = new File(["image"], "image.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Upload failed",
  );
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://images.example/upload.png",
  );
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument(),
  );
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ picture: "https://images.example/upload.png" }),
  );
});

it("previews an upload in place with progress and cancel, keeping Name editable", async () => {
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  let report: (sent: number, total: number) => void = () => {};
  let signal: AbortSignal | undefined;
  vi.mocked(uploadAvatar).mockImplementationOnce(
    (_file, _community, abort, progress) => {
      signal = abort;
      report = progress ?? report;
      return new Promise<string>(() => {});
    },
  );
  const file = new File(["image"], "image.png", { type: "image/png" });
  fireEvent.change(within(dialog).getByLabelText("Upload an image"), {
    target: { files: [file] },
  });
  expect(
    await within(dialog).findByRole("img", { name: "Uploading avatar" }),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  const ring = within(dialog).getByRole("progressbar", {
    name: "Uploading image",
  });
  expect(ring).not.toHaveAttribute("aria-valuenow");
  act(() => report(1, 4));
  expect(ring).toHaveAttribute("aria-valuenow", "25");
  for (const tab of within(dialog).getAllByRole("tab"))
    expect(tab).toHaveAttribute("aria-disabled", "true");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(
    within(dialog).queryByRole("button", { name: "Choose emoji" }),
  ).not.toBeInTheDocument();
  // Only Create waits on the upload.
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(createButton()).toBeDisabled();

  await user.click(
    within(dialog).getByRole("button", { name: "Cancel upload" }),
  );
  expect(signal?.aborted).toBe(true);
  for (const tab of within(dialog).getAllByRole("tab"))
    expect(tab).not.toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:upload");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Nova",
      picture: expect.not.stringContaining("blob:"),
    }),
  );
});

it("moves the hidden-scrollbar avatar dock with a vertical mouse wheel", () => {
  const { dialog } = setup([echo]);
  const dock = within(dialog).getByRole("group", { name: "Agent avatars" });
  Object.defineProperties(dock, {
    clientWidth: { configurable: true, value: 500 },
    scrollWidth: { configurable: true, value: 3000 },
  });
  const scrollBy = vi.fn();
  dock.scrollBy = scrollBy;
  const slot = within(dock).getAllByRole("button")[0];
  if (!slot) throw new Error("The dock has an avatar");
  const down = new WheelEvent("wheel", {
    deltaY: 120,
    bubbles: true,
    cancelable: true,
  });
  slot.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  expect(scrollBy).toHaveBeenCalledWith({ left: 120, behavior: "instant" });
  // At the start, scrolling back stays native so the gesture is not swallowed.
  const up = new WheelEvent("wheel", {
    deltaY: -120,
    bubbles: true,
    cancelable: true,
  });
  slot.dispatchEvent(up);
  expect(up.defaultPrevented).toBe(false);
  expect(scrollBy).toHaveBeenCalledOnce();
});

it("keeps every bundled avatar available after switching from an uploaded image", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  const dock = within(dialog).getByRole("group", { name: "Agent avatars" });
  const initial = agentAvatars.find(
    (avatar) => !within(dock).queryByRole("button", { name: avatar.label }),
  );
  if (!initial) throw new Error("The selected avatar is outside the dock");
  const input = within(dialog).getByLabelText("Upload an image");
  for (let attempt = 0; attempt < 2; attempt++) {
    vi.mocked(uploadAvatar).mockResolvedValueOnce(
      "https://images.example/upload.png",
    );
    fireEvent.change(input, {
      target: {
        files: [new File(["image"], "image.png", { type: "image/png" })],
      },
    });
    await waitFor(() =>
      expect(within(dialog).queryByRole("status")).not.toBeInTheDocument(),
    );
    const choice = within(dock)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-label") !== initial.label);
    if (!choice) throw new Error("Another bundled avatar is available");
    await user.click(choice);
    expect(within(dock).getAllByRole("button")).toHaveLength(
      agentAvatars.length - 1,
    );
  }
  expect(
    within(dock).getByRole("button", { name: initial.label }),
  ).toBeEnabled();
  await user.click(within(dock).getByRole("button", { name: initial.label }));
  expect(
    within(dock).queryByRole("button", { name: initial.label }),
  ).not.toBeInTheDocument();
});

it("opens on the name field", async () => {
  const { dialog } = setup([echo]);
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveFocus(),
  );
});

it("starts with a pack picture already chosen", async () => {
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  const [input] = agents.create.mock.calls[0] as [NewAgent];
  expect(input.picture).toMatch(/^https:\/\//);
  expect(agentAvatars.map((avatar) => avatar.url)).toContain(input.picture);
});

it("shows the sole harness as a disabled choice", async () => {
  const { dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(screen.getByRole("combobox", { name: "Harness" })).toBeDisabled();
});

it("disables Create until named and guards direct form submissions", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const animate = vi.fn();
  Element.prototype.animate = animate;
  const { agents, dialog, user } = setup([echo]);
  const name = () => within(dialog).getByLabelText("Name");
  const alert = () => within(dialog).queryByRole("alert");
  expect(createButton()).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Next" }),
  ).not.toBeInTheDocument();
  expect(alert()).not.toBeInTheDocument();
  await user.type(name(), "   ");
  submitForm(dialog);
  expect(agents.create).not.toHaveBeenCalled();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(name()).toHaveAccessibleDescription("Add a name to create your agent");
  expect(name()).toHaveAttribute("placeholder", "Name");
  expect(name()).toHaveAttribute("aria-invalid", "true");
  expect(name()).toHaveFocus();
  // Already in view, so nothing scrolls.
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(animate).toHaveBeenCalledOnce();
  expect(name()).toHaveValue("   ");
  // Each further empty submit shakes again.
  submitForm(dialog);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(agents.create).not.toHaveBeenCalled();
  await user.type(name(), "Nova");
  expect(alert()).not.toBeInTheDocument();
  expect(name()).not.toHaveAttribute("aria-invalid");
  expect(createButton()).toBeEnabled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledOnce();
});

/** Hands each animation frame to the test, so it can step a scroll. */
const stepFrames = () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) =>
    frames.push(frame),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // One tick runs every frame requested before it, like the browser.
  return () =>
    act(() => {
      for (const frame of frames.splice(0)) frame(performance.now());
    });
};

/** An out-of-view name whose position the test moves frame by frame. */
const scrolledName = (dialog: HTMLElement) => {
  const name = within(dialog).getByLabelText("Name");
  // Just below the fold.
  const position = { top: window.innerHeight - 38 };
  name.getBoundingClientRect = () =>
    ({ top: position.top, bottom: position.top + 40 }) as DOMRect;
  const scrollIntoView = vi.fn();
  name.scrollIntoView = scrollIntoView;
  return { name, position, scrollIntoView };
};

it("scrolls an out-of-view name to center, then flags it as the glide slows", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  const alert = () => within(dialog).queryByRole("alert");
  submitForm(dialog);
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "center",
    behavior: "smooth",
  });
  // Pressing again mid-scroll doesn't start a second scroll.
  submitForm(dialog);
  expect(scrollIntoView).toHaveBeenCalledOnce();
  step();
  // Easing in: barely moving, and just in view, but not yet past the glide.
  position.top = window.innerHeight - 41;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 600;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 300;
  step();
  expect(alert()).not.toBeInTheDocument();
  // In view and slowing: the prompt plays while the glide lands.
  position.top = 298;
  step();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(Element.prototype.animate).toHaveBeenCalledOnce();
});

it("does not flag a name typed while it scrolls into view", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog } = setup([echo]);
  const { name, position } = scrolledName(dialog);
  submitForm(dialog);
  step();
  fireEvent.change(name, { target: { value: "Nova" } });
  position.top = 300;
  step();
  position.top = 300;
  step();
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(Element.prototype.animate).not.toHaveBeenCalled();
});

it("jumps instead of gliding, and skips the shake, under reduced motion", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  }));
  motion.reduced = true;
  const { dialog } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  submitForm(dialog);
  expect(scrollIntoView).toHaveBeenCalledWith(
    expect.objectContaining({ behavior: "auto" }),
  );
  position.top = 300;
  step();
  step();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Add a name to create your agent",
  );
  expect(Element.prototype.animate).not.toHaveBeenCalled();
});

it("shows registered logos in the harness value and choices with independent SVG masks", async () => {
  const { dialog, user } = setup([
    { ...echo, icon: BuilderlabLogoIcon },
    { ...notes, icon: CodexLogoIcon },
  ]);
  const select = within(dialog).getByRole("combobox", { name: "Harness" });
  const selectedMask = select.querySelector("mask");
  expect(selectedMask).not.toBeNull();
  await user.click(select);
  const option = await screen.findByRole("option", { name: "Echo" });
  const optionMask = option.querySelector("mask");
  expect(optionMask).not.toBeNull();
  expect(optionMask?.id).not.toBe(selectedMask?.id);
  for (const svg of [
    select.querySelector("svg"),
    option.querySelector("svg"),
  ]) {
    const mask = svg?.querySelector("mask");
    expect(svg?.querySelector("path[mask]")).toHaveAttribute(
      "mask",
      `url(#${mask?.id})`,
    );
    const filter = svg?.querySelector("filter");
    expect(mask?.querySelector("path")).toHaveAttribute(
      "filter",
      `url(#${filter?.id})`,
    );
  }
  const other = screen.getByRole("option", { name: "Notes" });
  expect(other.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  await user.click(other);
  expect(select).toHaveTextContent("Notes");
  expect(select.querySelector("svg")).not.toBeNull();
  expect(select.querySelector("mask")).toBeNull();
});

it.each([false, true])(
  "applies a suggested configuration without starting the draft (remote: %s)",
  async (remote) => {
    const suggesting: RegisteredAgentType = {
      ...notes,
      ...(remote ? { remote: remoteEcho.remote } : {}),
      key: "test/suggesting",
      title: "Suggesting",
      CreateConfiguration: function Suggest({
        config,
        onChange,
        onReadyChange,
        harnessControl,
      }) {
        // biome-ignore lint/correctness/useExhaustiveDependencies: suggests once on mount.
        useEffect(() => {
          onChange(
            { ...(config as object), model: "suggested" },
            { suggested: true },
          );
          onReadyChange?.(true);
        }, []);
        return <SettingsGroup>{harnessControl}</SettingsGroup>;
      },
    };
    const first = setup([suggesting]);
    await first.user.type(within(first.dialog).getByLabelText("Name"), "Nova");
    await first.user.click(createButton());
    if (remote) {
      expect(first.agents.create).not.toHaveBeenCalled();
      const intro = screen.getByRole("dialog", {
        name: "Meet your remote agent",
      });
      await first.user.click(
        within(intro).getByRole("button", { name: "Let’s go" }),
      );
    }
    await waitFor(() =>
      expect(first.agents.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: "suggested" }),
        }),
      ),
    );
    cleanup();
    const second = setup([suggesting]);
    await second.user.click(document.body);
    await waitFor(() => expect(second.onClose).toHaveBeenCalledOnce());
  },
);

it("keeps keyboard focus on Harness when switching into and out of a configuration group", async () => {
  const grouped: RegisteredAgentType = {
    ...notes,
    key: "test/grouped",
    title: "Grouped",
    CreateModel: () => <span>Legacy model field</span>,
    CreateConfiguration: ({ harnessControl }) => (
      <SettingsGroup>{harnessControl}</SettingsGroup>
    ),
  };
  const { dialog, user } = setup([echo, grouped]);
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveFocus(),
  );
  const harness = () =>
    within(dialog).getByRole("combobox", { name: "Harness" });
  harness().focus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Echo" })).toHaveFocus(),
  );
  await user.keyboard("{End}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Grouped" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(harness()).toHaveTextContent("Grouped"));
  await waitFor(() => expect(harness()).toHaveFocus());
  expect(
    within(dialog).queryByText("Legacy model field"),
  ).not.toBeInTheDocument();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Grouped" })).toHaveFocus(),
  );
  await user.keyboard("{Home}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Echo" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(harness()).toHaveTextContent("Echo"));
  await waitFor(() => expect(harness()).toHaveFocus());
});

it("uses displayed configuration readiness without interpreting or editing raw config", async () => {
  let report: ((ready: boolean) => void) | undefined;
  const grouped: RegisteredAgentType = {
    ...notes,
    key: "test/ready",
    title: "Ready",
    defaults: () => ({ config: { modelId: "", reasoningEffort: "" } }),
    Create: () => null,
    CreateConfiguration: ({ harnessControl, onReadyChange }) => {
      useEffect(() => {
        report = onReadyChange;
        onReadyChange?.(false);
      }, [onReadyChange]);
      return (
        <SettingsGroup>
          {harnessControl}
          <p>Recommended choices</p>
        </SettingsGroup>
      );
    },
  };
  const { agents, dialog, user } = setup([echo, grouped]);
  const name = within(dialog).getByLabelText("Name");
  await user.type(name, "Nova");
  expect(createButton()).toBeEnabled();
  const chooseHarness = async (title: string) => {
    await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
    await user.click(await screen.findByRole("option", { name: title }));
  };
  await chooseHarness("Ready");
  expect(createButton()).toBeDisabled();
  act(() => report?.(true));
  expect(createButton()).toBeEnabled();
  await user.clear(name);
  expect(createButton()).toBeDisabled();
  await user.type(name, "   ");
  expect(createButton()).toBeDisabled();
  await user.type(name, "Nova");
  act(() => report?.(false));
  expect(createButton()).toBeDisabled();
  submitForm(dialog);
  expect(agents.create).not.toHaveBeenCalled();
  act(() => report?.(true));
  await chooseHarness("Echo");
  expect(createButton()).toBeEnabled();
  await chooseHarness("Ready");
  expect(createButton()).toBeDisabled();
  act(() => report?.(true));
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { modelId: "", reasoningEffort: "" },
    }),
  );
});

it("groups remote and local harnesses without an inline execution hint", async () => {
  const { dialog, user } = setup([remoteEcho, notes]);
  const harness = within(dialog).getByRole("combobox", { name: "Harness" });
  expect(harness).toHaveTextContent(/^Builderlab$/);
  expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
  await user.click(harness);
  const remoteGroup = await screen.findByRole("group", { name: "Remote" });
  const localGroup = screen.getByRole("group", { name: "Local" });
  expect(
    within(remoteGroup).getByRole("option", { name: "Builderlab" }),
  ).toBeInTheDocument();
  await user.click(within(localGroup).getByRole("option", { name: "Notes" }));
  expect(harness).toHaveTextContent(/^Notes$/);
  expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
});

it("introduces remote creation with the chosen avatar and preserves the draft on Back and Escape", async () => {
  motion.reduced = true;
  let finish = (_agent: Agent) => {};
  const { agents, onCreated, onClose, dialog, user } = setup(
    [remoteEcho],
    () =>
      new Promise<Agent>((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(createButton());
  expect(
    screen.queryByRole("dialog", { name: "Meet your remote agent" }),
  ).not.toBeInTheDocument();
  expect(agents.create).not.toHaveBeenCalled();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.type(within(dialog).getByLabelText("Reply"), "Hello");
  const avatars = within(dialog).getByRole("group", { name: "Agent avatars" });
  const avatar = agentAvatars.find((item) =>
    within(avatars).queryByRole("button", { name: item.label }),
  );
  if (!avatar) throw new Error("Avatar dock is empty");
  await user.click(within(avatars).getByRole("button", { name: avatar.label }));
  await user.click(createButton());
  const intro = await screen.findByRole("dialog", {
    name: "Meet your remote agent",
  });
  expect(intro).toBe(dialog);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    within(intro).queryByRole("textbox", { name: "Name" }),
  ).not.toBeInTheDocument();
  expect(intro).toHaveTextContent("Hi, I’m Nova.");
  expect(intro).toHaveTextContent("I work on another computer.");
  expect(intro).toHaveTextContent(
    "My availability and file access depend on that computer’s setup.",
  );
  expect(intro).not.toHaveTextContent("always ready for you");
  expect(intro).not.toHaveTextContent("even when this computer is off");
  expect(intro).not.toHaveTextContent("won’t be able to open files");
  expect(
    within(intro)
      .getByRole("img", { name: "Nova’s avatar" })
      .querySelector("img"),
  ).toHaveAttribute("src", avatar.preview);
  expect(agents.create).not.toHaveBeenCalled();
  await user.click(within(intro).getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Meet your remote agent" }),
    ).not.toBeInTheDocument(),
  );
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");
  expect(within(dialog).getByLabelText("Reply")).toHaveValue("Hello");
  await waitFor(() => expect(createButton()).toHaveFocus());
  await user.click(createButton());
  await screen.findByRole("dialog", { name: "Meet your remote agent" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Meet your remote agent" }),
    ).not.toBeInTheDocument(),
  );
  expect(dialog).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  await user.click(createButton());
  const again = await screen.findByRole("dialog", {
    name: "Meet your remote agent",
  });
  await user.click(within(again).getByRole("button", { name: "Let’s go" }));
  await waitFor(() =>
    expect(agents.create).toHaveBeenCalledExactlyOnceWith({
      type: remoteEcho.key,
      name: "Nova",
      picture: avatar.url,
      config: { reply: "Hello" },
    }),
  );
  try {
    expect(screen.getByRole("dialog", { name: "Meet your remote agent" })).toBe(
      again,
    );
    expect(
      screen.queryByRole("button", { name: "Create agent" }),
    ).not.toBeInTheDocument();
    const proceed = within(again).getByRole("button", { name: "Let’s go" });
    expect(proceed).toHaveAttribute("aria-busy", "true");
    expect(proceed).toHaveAttribute("aria-disabled", "true");
    expect(within(again).getByRole("button", { name: "Back" })).toBeDisabled();
    expect(
      within(again).getByRole("button", { name: "Back to agent settings" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(proceed);
    expect(screen.getByRole("dialog", { name: "Meet your remote agent" })).toBe(
      again,
    );
    expect(agents.create).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    await act(async () => finish(made));
  }
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(made);
});

it("previews an emoji without uploading until Continue and retries a failed remote create within the same introduction", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const file = new File(["emoji"], "avatar.png", { type: "image/png" });
  vi.mocked(emojiAvatar).mockResolvedValue(file);
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/emoji.png");
  let attempts = 0;
  const { agents, onCreated, dialog, user } = setup(
    [remoteEcho],
    async () => {
      if (++attempts === 1) throw new Error("Try again");
      return made;
    },
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(createButton());
  const intro = await screen.findByRole("dialog", {
    name: "Meet your remote agent",
  });
  const portrait = within(intro).getByRole("img", { name: "Nova’s avatar" });
  expect(portrait.querySelector("canvas")).not.toBeNull();
  expect(portrait.firstElementChild).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(emojiAvatar).not.toHaveBeenCalled();
  expect(uploadAvatar).not.toHaveBeenCalled();
  await user.click(within(intro).getByRole("button", { name: "Let’s go" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Try again",
  );
  expect(agents.create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "Meet your remote agent" })).toBe(
    intro,
  );
  expect(within(intro).getByRole("alert")).toBeVisible();
  const proceed = within(intro).getByRole("button", { name: "Let’s go" });
  expect(proceed).toBeEnabled();
  expect(proceed).not.toHaveAttribute("aria-busy", "true");
  expect(within(intro).getByRole("button", { name: "Back" })).toBeEnabled();
  await user.click(proceed);
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(made));
  expect(agents.create).toHaveBeenCalledTimes(2);
  expect(within(intro).queryByRole("alert")).not.toBeInTheDocument();
});

it("switches harness, starting over on the new type's defaults", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.type(within(dialog).getByLabelText("Reply"), "typed in echo");
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Notes" }));

  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Reply")).not.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Notes")).toHaveValue("start");
  // The name stays; only the type's own settings start over.
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/notes",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { notes: "start", instructions: "Be brief." },
  });
});

it("starts over again when switching back to the first type", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.type(within(dialog).getByLabelText("Reply"), "typed");
  const switchTo = async (to: string) => {
    await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
    await user.click(await screen.findByRole("option", { name: to }));
  };
  await switchTo("Notes");
  await switchTo("Echo");
  expect(within(dialog).getByLabelText("Reply")).toHaveValue("");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

it("edits instructions directly without a separate editing step", async () => {
  const { agents, dialog, user } = setup([notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  expect(
    within(dialog).getByRole("form", { name: "New agent" }),
  ).toContainElement(instructions);
  await user.type(instructions, " And kind.{Enter}Keep it short.");
  expect(agents.create).not.toHaveBeenCalled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        notes: "start",
        instructions: "Be brief. And kind.\nKeep it short.",
      },
    }),
  );
});

it("shows a failed create's error in view, stays open, and lets it be tried again", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  let attempts = 0;
  const { agents, onCreated, onClose, dialog, user } = setup(
    [echo],
    async () => {
      if (++attempts === 1) throw new Error("Credential store refused");
      return made;
    },
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Credential store refused");
  // Below a long form, the error would otherwise be out of sight.
  expect(scrollIntoView.mock.contexts).toEqual([alert]);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  expect(createButton()).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a shown error when the name changes", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { dialog, user } = setup([echo], async () => {
    throw new Error("Nope");
  });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  await user.type(within(dialog).getByLabelText("Name"), "!");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks a second create while the first is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [echo],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalledTimes(1));
  expect(within(dialog).getByLabelText("Name")).toBeDisabled();
  expect(within(dialog).getByLabelText("Reply")).toBeDisabled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(1);
  finish(made);
});

const withModels = (type: RegisteredAgentType): RegisteredAgentType => ({
  ...type,
  CreateModel: ({ config, onChange, ...props }) => {
    const current = config as Record<string, unknown>;
    return (
      <CreateModelChoices
        {...props}
        models={[
          { id: "fast", label: "Fast" },
          { id: "deep", label: "Deep" },
        ]}
        value={String(current.model ?? "")}
        defaultLabel={`${type.title} default`}
        onChange={(model) => onChange({ ...current, model })}
      />
    );
  },
});

const withThinking = (type: RegisteredAgentType): RegisteredAgentType =>
  ({
    ...type,
    defaults: () => ({
      config: { notes: "start", instructions: "Be brief.", effort: "" },
    }),
    CreateThinking: ({ config, disabled, onChange }: AgentCreateProps) => {
      const current = config as Record<string, unknown>;
      return (
        <Select
          label="Thinking"
          value={String(current.effort ?? "")}
          variant="compact"
          disabled={disabled}
          groups={[
            {
              label: "",
              options: [
                { value: "", label: "Automatic · Default" },
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          ]}
          onValueChange={(effort) => onChange({ ...current, effort })}
        />
      );
    },
  }) as unknown as RegisteredAgentType;

it("saves the create-time Thinking choice in the initial agent config", async () => {
  const { agents, dialog, user } = setup([withThinking(notes)]);
  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");

  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(thinking);
  const inherited = await screen.findByRole("option", {
    name: "Automatic · Default",
  });
  await waitFor(() => expect(inherited).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Low" })).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}");
  const high = screen.getByRole("option", { name: "High" });
  await waitFor(() => expect(high).toHaveFocus());
  await user.keyboard("{Enter}");
  await user.click(createButton());

  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/notes",
      config: { notes: "start", instructions: "Be brief.", effort: "high" },
    }),
  );
});

it("leaves Thinking to its own row instead of the model field", async () => {
  const shown: unknown[] = [];
  const type = {
    ...withThinking(notes),
    CreateModel: (props: AgentCreateProps) => {
      shown.push(props.showEffort);
      return <span>Model field</span>;
    },
  } as RegisteredAgentType;
  const { dialog } = setup([type]);
  expect(within(dialog).getByText("Model field")).toBeInTheDocument();
  expect(shown.at(-1)).toBe(false);
});

it("restores inherited Thinking when Default is chosen before creation", async () => {
  const { agents, dialog, user } = setup([withThinking(notes)]);
  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  expect(thinking).toHaveTextContent("High");
  await user.click(thinking);
  await user.click(
    await screen.findByRole("option", { name: "Automatic · Default" }),
  );
  expect(thinking).toHaveTextContent("Automatic · Default");

  await user.click(createButton());

  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/notes",
      config: { notes: "start", instructions: "Be brief.", effort: "" },
    }),
  );
});

it("drops the provider-specific Thinking choice when changing harnesses", async () => {
  const { agents, dialog, user } = setup([withThinking(notes), echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));

  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Echo" }));
  expect(
    within(dialog).queryByRole("combobox", { name: "Thinking" }),
  ).toBeNull();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

it("disables the Thinking control while creation is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [withThinking(notes)],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  try {
    await user.click(createButton());
    await waitFor(() => expect(agents.create).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("combobox", { name: "Thinking" }),
    ).toBeDisabled();
  } finally {
    finish(made);
  }
});

it("keeps typed instructions when choosing a harness or model", async () => {
  // Both types carry instructions, as the bundled harnesses do.
  const carrying = (key: string, title: string): RegisteredAgentType => ({
    ...withModels(notes),
    key,
    title,
    carry: (config) => ({ instructions: (config as Notes).instructions }),
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  });
  const { agents, dialog, user } = setup([
    carrying("test/notes", "Notes"),
    carrying("test/other", "Other"),
  ]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByLabelText("Instructions");
  await user.clear(instructions);
  await user.type(instructions, "Keep this.");
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "Keep this.",
  );
  await user.click(within(dialog).getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Deep" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "Keep this.",
  );
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/other",
      config: { notes: "start", instructions: "Keep this.", model: "deep" },
    }),
  );
});

it("keeps requested instructions the owner cleared when choosing a harness", async () => {
  // Both carry instructions as the bundled harnesses do, omitting blank ones.
  const carrying = (key: string, title: string): RegisteredAgentType => ({
    ...notes,
    key,
    title,
    carry: (config) => {
      const { instructions } = config as Notes;
      return instructions.trim() ? { instructions } : {};
    },
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  });
  const { agents, dialog, user } = setup(
    [carrying("test/notes", "Notes"), carrying("test/other", "Other")],
    undefined,
    undefined,
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      type: "test/notes",
      name: "Nova",
      instructions: "Review PRs.",
    },
  );
  const instructions = within(dialog).getByLabelText("Instructions");
  expect(instructions).toHaveValue("Review PRs.");
  await user.clear(instructions);
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue("");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/other",
      config: { notes: "start", instructions: "" },
    }),
  );
});

it("submits custom creation instructions and disables editing while saving", async () => {
  let finish: (agent: Agent) => void = () => {};
  const creationType: RegisteredAgentType = {
    ...withModels(notes),
    Create: ({ config, disabled, onChange }) => {
      const current = config as Notes;
      return (
        <AgentInstructions
          creation
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
      );
    },
  };
  const { agents, onCreated, dialog, user } = setup(
    [creationType],
    () =>
      new Promise<Agent>((resolve) => {
        finish = resolve;
      }),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions Optional",
  });
  expect(
    within(dialog).queryByRole("group", { name: "Instruction presets" }),
  ).not.toBeInTheDocument();
  await user.clear(instructions);
  await user.type(instructions, "Build accessible tools for my team.");
  try {
    await user.click(createButton());
    await waitFor(() => expect(agents.create).toHaveBeenCalledOnce());
    expect(instructions).toBeDisabled();

    expect(agents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          notes: "start",
          instructions: "Build accessible tools for my team.",
        },
      }),
    );
  } finally {
    finish(made);
  }
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
});

it("preserves the existing avatar and requested name when saving a proposed update", async () => {
  const agents = { create: vi.fn() } as unknown as Agents;
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCreated = vi.fn();
  const agent = {
    ...made,
    picture: "https://example.test/existing.png",
    config: { reply: "kept" },
  };
  render(
    <AgentCreateDialog
      agents={agents}
      types={[echo]}
      onClose={vi.fn()}
      onCreated={onCreated}
      update={{
        agent,
        onSave,
        request: {
          id: "request",
          requester: "requester",
          requesterName: "Ada",
          owner: made.owner,
          community: "here",
          agent: made.pubkey,
          agentName: made.name,
          agentType: made.type,
          name: "Requested name",
        },
      }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Requested name",
  );
  expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("kept");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      type: made.type,
      name: "Requested name",
      picture: agent.picture,
      config: { reply: "kept" },
    }),
  );
  expect(agents.create).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});

it("starts from an agent card's name, picture and instructions, in each harness that takes them", async () => {
  const adopting = (key: string, title: string): RegisteredAgentType => ({
    ...notes,
    key,
    title,
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  });
  const agents = { create: vi.fn(async () => made) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  render(
    <AgentCreateDialog
      agents={agents}
      types={[echo, adopting("test/card", "Card")]}
      draft={{
        name: "Tinker",
        picture: "https://cdn.example/tinker/avatar.png",
        instructions: "You are Tinker.",
      }}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(dialog).toHaveAccessibleDescription(
    "From an agent card. Review its settings before creating it.",
  );
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Tinker");
  // Echo has no instructions to take; the card's follow to one that does.
  expect(within(dialog).queryByLabelText("Instructions")).toBeNull();
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Card" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "You are Tinker.",
  );
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith({
    type: "test/card",
    name: "Tinker",
    picture: "https://cdn.example/tinker/avatar.png",
    config: { notes: "start", instructions: "You are Tinker." },
  });
});

it("keeps an agent card's draft through the remote introduction and Back", async () => {
  const type: RegisteredAgentType = {
    ...remoteEcho,
    ...notes,
    key: "test/remote-card",
    title: "Remote card",
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  };
  const agents = { create: vi.fn(async () => made) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  render(
    <AgentCreateDialog
      agents={agents}
      types={[type]}
      draft={{
        name: "Tinker",
        picture: "https://cdn.example/tinker/avatar.png",
        instructions: "You are Tinker.",
      }}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(createButton());
  const intro = screen.getByRole("dialog", { name: "Meet your remote agent" });
  expect(intro).toHaveTextContent("Tinker");
  expect(agents.create).not.toHaveBeenCalled();
  await user.click(within(intro).getByRole("button", { name: "Back" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(dialog).toHaveAccessibleDescription(
    "From an agent card. Review its settings before creating it.",
  );
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Tinker");
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "You are Tinker.",
  );
  await user.click(createButton());
  await user.click(
    within(
      screen.getByRole("dialog", { name: "Meet your remote agent" }),
    ).getByRole("button", { name: "Let’s go" }),
  );
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/remote-card",
    name: "Tinker",
    picture: "https://cdn.example/tinker/avatar.png",
    config: { notes: "start", instructions: "You are Tinker." },
  });
});

it("keeps an agent card's instructions cleared when choosing another harness", async () => {
  // Like the bundled harnesses, empty instructions are not carried.
  const carrying = (key: string, title: string): RegisteredAgentType => ({
    ...notes,
    key,
    title,
    carry: (config) => {
      const { instructions } = config as Notes;
      return instructions.trim() ? { instructions } : {};
    },
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  });
  const agents = { create: vi.fn(async () => made) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  render(
    <AgentCreateDialog
      agents={agents}
      types={[carrying("test/notes", "Notes"), carrying("test/other", "Other")]}
      draft={{
        name: "Tinker",
        picture: "https://cdn.example/tinker/avatar.png",
        instructions: "You are Tinker.",
      }}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.clear(within(dialog).getByLabelText("Instructions"));
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue("");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/other",
      config: { notes: "start", instructions: "" },
    }),
  );
});

it("shows an agent card's pack avatar as that Gloopie", () => {
  const pack = agentAvatars.find((avatar) => avatar.id === "gloopies-13");
  if (!pack) throw new Error("gloopies-13 is missing from the catalog");
  render(
    <AgentCreateDialog
      agents={{ create: vi.fn() } as unknown as Agents}
      types={[echo]}
      draft={{ name: "Tinker", picture: pack.url, instructions: "" }}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  const tabs = within(
    within(dialog).getByRole("tablist", { name: "Avatar type" }),
  );
  expect(tabs.getByRole("tab", { name: "Gloopies" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
