// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageSearch, type SearchServices } from "./PageSearch";
import type { RegisteredPage } from "../../features/pages/service";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { isApplePlatform } from "../../features/shortcuts/format";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot } from "../../features/relay/service";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
} from "../../features/relay/testing";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("keeps typing focus while arrows select results and Enter opens the selection", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(
    <PageSearch
      pages={[
        {
          key: "buzz.channels/channels",
          pluginId: "buzz.channels",
          id: "channels",
          title: "Channels",
          revision: "bundled",
          component: () => null,
        },
      ]}
      onSelect={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const input = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  const messages = within(dialog).getByRole("option", { name: "Messages" });
  expect(
    within(dialog).queryByRole("option", { name: "Home" }),
  ).not.toBeInTheDocument();
  const settings = within(dialog).getByRole("option", { name: "Settings" });
  for (const [attribute, value] of Object.entries({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
  }))
    expect(input).toHaveAttribute(attribute, value);
  await vi.waitFor(() => expect(input).toHaveFocus());
  for (const [key, result] of [
    ["ArrowDown", messages],
    ["ArrowDown", settings],
    ["ArrowDown", settings],
    ["ArrowUp", messages],
    ["ArrowUp", messages],
  ] as const) {
    await user.keyboard(`{${key}}`);
    expect(input).toHaveFocus();
    expect(result).toHaveAttribute("aria-selected", "true");
    expect(result).toHaveAttribute("data-highlighted");
    expect(result).not.toHaveAttribute("data-selected");
    expect(input).toHaveAttribute("aria-activedescendant", result.id);
  }
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    fireEvent.keyDown(input, { key: "ArrowDown", [modifier]: true });
    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });
  }
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(messages).toHaveAttribute("data-highlighted", "true");
  expect(settings).toHaveAttribute("aria-selected", "false");
  expect(messages).not.toHaveAttribute("aria-current", "page");
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

it("clears selection on typing, handles empty results, and retains pointer activation", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  await user.click(input);
  await user.keyboard("{ArrowDown}");
  await user.type(input, "missing");
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(input).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "sett");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("option", { name: "Settings" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
});

it("closes search when the backdrop is clicked", async () => {
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  expect(screen.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  const backdrop = document.querySelector(".buzz-dialog-backdrop");
  expect(backdrop).not.toBeNull();
  await user.click(backdrop as Element);
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
  );
});

it("keeps result shortcuts without badges and follows the hovered row", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(
    <PageSearch
      pages={[
        {
          key: "buzz.channels/channels",
          pluginId: "buzz.channels",
          id: "channels",
          title: "Channels",
          revision: "bundled",
          component: () => null,
        },
      ]}
      onSelect={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const input = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  const messages = within(dialog).getByRole("option", { name: "Messages" });
  const settings = within(dialog).getByRole("option", { name: "Settings" });
  const apple = isApplePlatform(navigator.platform);
  expect(messages).toHaveAttribute(
    "aria-keyshortcuts",
    `Shift+${apple ? "Meta" : "Control"}+1`,
  );
  expect(settings).toHaveAttribute(
    "aria-keyshortcuts",
    `Shift+${apple ? "Meta" : "Control"}+2`,
  );
  expect(dialog.querySelector("kbd")).toBeNull();
  await user.keyboard("{ArrowDown}");
  expect(messages).toHaveAttribute("aria-selected", "true");
  // A replayed event at a resting position is not a hover.
  const at = (clientX: number) =>
    fireEvent.pointerMove(settings, {
      pointerType: "mouse",
      clientX,
      clientY: 10,
      // Linux WebKit's screen coordinates do not follow the pointer.
      screenX: 0,
      screenY: 0,
    });
  at(10);
  at(10);
  expect(messages).toHaveAttribute("aria-selected", "true");
  at(12);
  expect(settings).toHaveAttribute("aria-selected", "true");
  expect(messages).toHaveAttribute("aria-selected", "false");
  expect(input).toHaveAttribute("aria-activedescendant", settings.id);
  // Leaving the list hands the highlight back to the keyboard's row.
  const palette = dialog.querySelector("[data-search-palette]");
  if (!palette) throw new Error("Missing search palette");
  fireEvent.pointerLeave(palette, { pointerType: "mouse" });
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(settings).toHaveAttribute("aria-selected", "false");
  at(14);
  expect(settings).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, {
    key: "@",
    code: "Digit2",
    metaKey: apple,
    ctrlKey: !apple,
    shiftKey: true,
  });
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
});

it("selects the first typed result and keeps it as results change", async () => {
  const select = vi.fn();
  const user = userEvent.setup();
  const page = (key: string, title: string): RegisteredPage => ({
    key,
    pluginId: "test",
    id: key,
    title,
    revision: "bundled",
    component: () => null,
  });
  const first = page("test/first", "Target");
  const second = page("test/second", "Target ahead");
  const { rerender } = render(<PageSearch pages={[first]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  // An empty query selects nothing, so Enter alone opens nothing.
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.type(input, "Target");
  const target = screen.getByRole("option", { name: /^Target$/ });
  expect(target).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", target.id);
  // A later row above the selection cannot redirect Enter.
  rerender(<PageSearch pages={[second, first]} onSelect={select} />);
  expect(screen.getByRole("option", { name: /^Target$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // When the selected row leaves, the new first result takes over and stays
  // selected when the old row returns.
  rerender(<PageSearch pages={[second]} onSelect={select} />);
  rerender(<PageSearch pages={[first, second]} onSelect={select} />);
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: "Target ahead" }).id,
  );
  // A pointer passing over the results returns Enter to the first one.
  const other = screen.getByRole("option", { name: /^Target$/ });
  for (const clientX of [10, 12])
    fireEvent.pointerMove(other, {
      pointerType: "mouse",
      clientX,
      clientY: 10,
    });
  expect(other).toHaveAttribute("aria-selected", "true");
  const palette = document.querySelector("[data-search-palette]");
  if (!palette) throw new Error("Missing search palette");
  const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
  scroll.mockClear();
  fireEvent.pointerLeave(palette, { pointerType: "mouse" });
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: "Target ahead" }).id,
  );
  // The list stays where the pointer left it.
  expect(scroll).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("test/second");
});

it("shows the live search shortcut in the trigger and its hint, following a rebind", async () => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  try {
    // Only the shortcut services are read while the dialog is closed.
    render(
      <PageSearch
        pages={[]}
        onSelect={vi.fn()}
        services={
          { shortcuts, shortcutBindings: bindings } as unknown as SearchServices
        }
      />,
    );
    // The title renders as a focus/hover tooltip rather than a native attribute.
    const user = userEvent.setup();
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Search Buzz" });
    expect(trigger).toHaveFocus();
    expect(within(trigger).getByText("⌘K")).toBeInTheDocument();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Search Buzz (⌘K)",
    );
    act(() =>
      bindings.set("global-search", { key: "p", mod: true, shift: true }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⇧⌘P)");
    expect(within(trigger).getByText("⇧⌘P")).toBeInTheDocument();
    act(() => bindings.reset());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⌘K)");
  } finally {
    Reflect.deleteProperty(navigator, "platform");
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("opens conversation-scoped search with Command F and returns to overall search", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const navigation = {
    entry: { target: { kind: "conversation", channelId: "crew" } },
  };
  const community = { selected: null, viewer: null };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => navigation,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  try {
    render(<PageSearch pages={[]} onSelect={vi.fn()} services={services} />);
    const apple = isApplePlatform(navigator.platform);
    fireEvent.keyDown(window, {
      key: "f",
      metaKey: apple,
      ctrlKey: !apple,
    });
    const scoped = await screen.findByRole("dialog", {
      name: "Search this conversation",
    });
    expect(
      within(scoped).getByRole("combobox", {
        name: "Search this conversation",
      }),
    ).toHaveFocus();
    expect(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("does not open a DM that finishes starting after search closed and reopened", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const relay = keypair(),
    viewer = keypair(),
    bob = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  let started!: (channelId: string) => void;
  let attempt!: AbortSignal;
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      // The started DM is known, so only the closed palette stops it.
      get: (id: string) =>
        id === "bob-dm"
          ? { id, name: "", channelType: "dm" }
          : owner.session.channels.get?.(id),
    },
    directMessages: {
      ...owner.session.directMessages,
      available: true,
      people: async () => ({
        people: [{ pubkey: bob.pubkey, name: "Bob" }],
        hasMore: false,
      }),
      open: (_pubkeys: readonly string[], signal: AbortSignal) => {
        attempt = signal;
        return new Promise<string>((resolve) => (started = resolve));
      },
    },
  } as unknown as typeof owner.session;
  const connection = { status: "ready", generation: 0, session, scope: "s" };
  const community = {
    selected: "wss://relay.example",
    viewer: viewer.pubkey,
  };
  const open = vi.fn(async () => {});
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
      open,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  const user = userEvent.setup();
  try {
    render(
      <PageSearch
        pages={[
          {
            key: "buzz.channels/channels",
            pluginId: "buzz.channels",
            id: "channels",
            title: "Channels",
            revision: "bundled",
            component: () => null,
          },
        ]}
        onSelect={vi.fn()}
        services={services}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Search Buzz" }));
    const input = await screen.findByRole("combobox", { name: "Search Buzz" });
    await user.type(input, "bob");
    await user.click(await screen.findByRole("option", { name: /Bob/ }));
    expect(
      await screen.findByText("Opening your conversation with Bob…"),
    ).toBeVisible();
    // Hold the dialog's close animation, so search reopens with the same
    // results still mounted before the DM resolves.
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    const animations = vi.fn(() => [{ finished }]);
    const dialog = screen.getByRole("dialog", { name: "Search Buzz" });
    Object.defineProperty(dialog, "getAnimations", { value: animations });
    try {
      fireEvent.keyDown(input, { key: "Escape" });
      await vi.waitFor(() => expect(animations).toHaveBeenCalled());
      expect(attempt.aborted).toBe(true);
      fireEvent.click(
        screen.getByRole("button", { name: "Search Buzz", hidden: true }),
      );
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("");
      await act(async () => started("bob-dm"));
      expect(open).not.toHaveBeenCalled();
      expect(
        screen.queryByText("Opening your conversation with Bob…"),
      ).toBeNull();
    } finally {
      await act(async () => release());
    }
  } finally {
    cleanup();
    owner.dispose();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("opens Search Buzz with Command T as well as Command K, as Slack does", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const community = { selected: null, viewer: null };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  try {
    render(<PageSearch pages={[]} onSelect={vi.fn()} services={services} />);
    const apple = isApplePlatform(navigator.platform);
    fireEvent.keyDown(window, { key: "t", metaKey: apple, ctrlKey: !apple });
    expect(
      await screen.findByRole("dialog", { name: "Search Buzz" }),
    ).toBeVisible();
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("ranks pages by match when no community is connected", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const community = { selected: null, viewer: null };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  const page = (key: string, title: string): RegisteredPage => ({
    key,
    pluginId: "test",
    id: key,
    title,
    revision: "bundled",
    component: () => null,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  try {
    render(
      <PageSearch
        pages={[
          page("test/processes", "Processes"),
          page("test/sessions", "Sessions"),
        ]}
        onSelect={select}
        services={services}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Search Buzz" }));
    const input = await screen.findByRole("combobox", { name: "Search Buzz" });
    // "ses" starts Sessions, appears inside Processes, and only fuzzily
    // matches Settings.
    await user.type(input, "ses");
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Sessions", "Processes", "Settings"]);
    await user.keyboard("{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("test/sessions");
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it.each(["pointer", "keyboard"])(
  "hands %s page selection to main, not its first control",
  async (method) => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <>
        <PageSearch pages={[]} onSelect={select} />
        <main id="main-content" tabIndex={-1}>
          <button type="button">First control</button>
        </main>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Search Buzz" });
    await user.click(trigger);
    if (method === "pointer")
      await user.click(screen.getByRole("option", { name: "Settings" }));
    else await user.keyboard("{ArrowDown}{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("settings");
    await vi.waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("shows a plugin page's declared icon on its search row", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const user = userEvent.setup();
  const icon = "data:image/png;base64,iVBORbeacon";
  render(
    <PageSearch
      pages={[
        {
          key: "example.plugin/main",
          pluginId: "example.plugin",
          id: "main",
          title: "Beacon",
          revision: "one",
          component: () => null,
          icon,
        },
        {
          key: "example.other/main",
          pluginId: "example.other",
          id: "main",
          title: "Plain",
          revision: "one",
          component: () => null,
        },
      ]}
      onSelect={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const beacon = within(dialog).getByRole("option", { name: "Beacon" });
  const plain = within(dialog).getByRole("option", { name: "Plain" });
  const image = beacon.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", icon);
  expect(plain.querySelector("img")).toBeNull();
});

it("opens a Settings section from overall search, never from a conversation's", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const community = {
    selected: "primary",
    viewer: "viewer",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const navigation = {
    entry: { target: { kind: "conversation", channelId: "crew" } },
  };
  const cards: never[] = [];
  const release = vi.fn();
  const retainVisibility = vi.fn(() => release);
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => navigation,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
    settingsCards: {
      subscribe: () => () => {},
      snapshot: () => cards,
      retainVisibility,
    },
  } as unknown as SearchServices;
  const select = vi.fn();
  const user = userEvent.setup();
  try {
    render(
      <>
        <PageSearch pages={[]} onSelect={select} services={services} />
        <main id="main-content" tabIndex={-1} />
      </>,
    );
    const apple = isApplePlatform(navigator.platform);
    fireEvent.keyDown(window, { key: "f", metaKey: apple, ctrlKey: !apple });
    const scoped = await screen.findByRole("dialog", {
      name: "Search this conversation",
    });
    await user.type(
      within(scoped).getByRole("combobox", {
        name: "Search this conversation",
      }),
      "shortcuts",
    );
    expect(
      within(scoped).queryByRole("group", { name: "Settings" }),
    ).toBeNull();
    await user.click(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Search Buzz" });
    expect(
      within(within(dialog).getByRole("group", { name: "Settings" })).getByRole(
        "option",
        { name: /^Shortcuts/ },
      ),
    ).toHaveTextContent("Buzz");
    expect(retainVisibility).toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("settings", {
      section: "shortcuts",
    });
    await vi.waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(release).toHaveBeenCalled();
    // A community section names only its section; select() adds the
    // selected community's scope.
    await user.click(screen.getByRole("button", { name: "Search Buzz" }));
    // Search reopens on the kept text, selected, so typing replaces it.
    const field = await screen.findByRole("combobox", { name: "Search Buzz" });
    await vi.waitFor(() => expect(field).toHaveFocus());
    await user.keyboard("local settings");
    await user.click(screen.getByRole("option", { name: /^Local settings/ }));
    expect(select).toHaveBeenLastCalledWith("settings", {
      section: "local-settings",
    });
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("finds and opens saved conversations while the community is unreachable or still connecting", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const viewer = keypair(),
    relay = keypair();
  // Every relay read fails, as it does for a saved session.
  const query = vi.fn(async () => {
    throw new Error("Reconnect to update saved conversations.");
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
    },
    {
      cachedOnly: true,
      prepared: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: [
              roster(relay, "alpha", [viewer.pubkey]),
              metadata(relay, "alpha", "Alpha", 1_700_000_000),
              roster(relay, "beta", [viewer.pubkey]),
              metadata(relay, "beta", "Beta", 1_700_000_100),
            ],
          },
        }),
        read: async () => [],
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  await owner.restore();
  // The live session that replaces it, whose reads stay pending.
  const live = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  let connection: RelaySnapshot = {
    status: "error",
    error: "Relay broker session is malformed",
    cached: true,
    generation: 1,
    scope: "s",
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  // Retrying publishes connecting at once, as the relay service does.
  const retry = vi.fn(() => {
    connection = { ...connection, status: "connecting" };
    for (const listener of listeners) listener();
  });
  const open = vi.fn(async () => {});
  const community = { selected: "wss://relay.example", viewer: viewer.pubkey };
  const navigation = {
    entry: { target: { kind: "conversation", channelId: "alpha" } },
  };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => navigation,
      open,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => connection,
        retry,
      },
    },
  } as unknown as SearchServices;
  vi.useFakeTimers();
  try {
    render(
      <PageSearch
        pages={[
          {
            key: "buzz.channels/channels",
            pluginId: "buzz.channels",
            id: "channels",
            title: "Channels",
            revision: "bundled",
            component: () => null,
          },
        ]}
        onSelect={vi.fn()}
        services={services}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
    const dialog = screen.getByRole("dialog", { name: "Search Buzz" });
    const field = within(dialog).getByRole("combobox", { name: "Search Buzz" });
    // Recent activity lists the saved conversations.
    const recent = within(dialog).getByRole("group", {
      name: "Recent activity",
    });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((option) => option.textContent)
        .sort(),
    ).toEqual(["AlphaConversation", "BetaConversation"]);
    // A saved session has no message scope or open-channel view to offer.
    expect(within(dialog).queryByText(/^Search in Alpha/)).toBeNull();
    expect(within(dialog).queryByRole("tab", { name: "Channels" })).toBeNull();
    // The author picker offers only people already known, and says the
    // people search that needs the relay waits for the connection.
    for (const text of ["from:al", "in:@al", "in:beta from:al"]) {
      fireEvent.change(field, { target: { value: text } });
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(
        within(dialog).getByText("Connect to this community to search people."),
      ).toBeVisible();
    }
    expect(query).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "beta" } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(within(dialog).getByRole("option", { name: /^Beta/ })).toBeVisible();
    expect(within(dialog).queryByText("No matching pages.")).toBeNull();
    const savedNotice = within(dialog).getByText(
      "Only saved conversations are searched while this community is disconnected.",
    );
    expect(savedNotice).toBeVisible();
    // Lookups that need the relay wait for it, so nothing offers a Retry that
    // cannot succeed; the connection's own Retry is the way back.
    expect(query).not.toHaveBeenCalled();
    expect(
      within(dialog)
        .getAllByRole("button", { name: /^Retry/ })
        .map((button) => button.textContent),
    ).toEqual(["Retry connection"]);
    const retryButton = within(dialog).getByRole("button", {
      name: "Retry connection",
    });
    // The notice and its Retry stay below the results, outside their
    // scrollport, so a long list of rows can't push them out of view.
    const results = dialog.querySelector(".search-palette-scroll");
    expect(results).toContainElement(
      within(dialog).getByRole("option", { name: /^Beta/ }),
    );
    expect(results).not.toContainElement(savedNotice);
    expect(results).not.toContainElement(retryButton);
    retryButton.focus();
    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledOnce();
    // The button goes as the retry starts; focus stays with the field.
    expect(field).toHaveFocus();

    // While a launch is still connecting, the same results say why.
    expect(within(dialog).getByRole("option", { name: /^Beta/ })).toBeVisible();
    const connectingNotice = within(dialog).getByText(
      "Only saved conversations are searched until this community connects.",
    );
    expect(connectingNotice).toBeVisible();
    expect(results).not.toContainElement(connectingNotice);
    expect(within(dialog).queryByRole("button", { name: /^Retry/ })).toBeNull();

    fireEvent.click(within(dialog).getByRole("option", { name: /^Beta/ }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "conversation", channelId: "beta" }),
    );
    expect(query).not.toHaveBeenCalled();

    // Search scoped to a conversation is unchanged with a saved copy: it
    // waits for the connection without the saved or connecting line.
    const apple = isApplePlatform(navigator.platform);
    fireEvent.keyDown(window, { key: "f", metaKey: apple, ctrlKey: !apple });
    const scoped = screen.getByRole("dialog", {
      name: "Search this conversation",
    });
    fireEvent.change(within(scoped).getByRole("combobox"), {
      target: { value: "beta" },
    });
    expect(
      within(scoped).getByText("Connect to this community to search messages."),
    ).toBeVisible();
    expect(within(scoped).queryByText(/^Only saved conversations/)).toBeNull();
    expect(within(scoped).queryByText(/^Connecting/)).toBeNull();

    // Once the session is live, the author picker waits for the relay rather
    // than repeating the saved session's answer.
    fireEvent.click(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Search Buzz" }), {
      target: { value: "from:al" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      screen.getByText("Connect to this community to search people."),
    ).toBeVisible();
    connection = {
      status: "ready",
      generation: 1,
      scope: "s",
      session: live.session,
    };
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(screen.getByText("Searching people…")).toBeVisible();
    expect(
      screen.queryByText("Connect to this community to search people."),
    ).toBeNull();
  } finally {
    vi.useRealTimers();
    cleanup();
    live.dispose();
    owner.dispose();
    bindings.dispose();
    await root.fiber.dispose();
  }
});
