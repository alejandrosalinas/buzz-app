// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSectionRow,
  SidebarSections,
} from "./sidebar-sections-service";
import { SidebarContributionSection } from "./SidebarContributionSection";
import { ChannelSidebarDnd } from "./ChannelSidebarDnd";

const target: OpenTarget = { version: 1, kind: "home" };
const row = {
  id: "item",
  label: "Useful item",
  badge: "New",
  count: 2,
  status: "Active",
};

/** A navigator whose open entry is `current`. */
const navigatorAt = (current: OpenTarget, open = vi.fn()) =>
  ({
    open,
    subscribe: () => () => {},
    snapshot: () => ({ entry: { target: current } }),
  }) as unknown as Navigation;

function ThrowingIcon(): never {
  throw new Error("fixture icon failed");
}

function makeEntry(
  id: string,
  rows: RegisteredSidebarSection["rows"],
): RegisteredSidebarSection {
  return {
    version: 1,
    id,
    title: id === "good" ? "Good section" : "Broken section",
    icon: "★",
    rows,
    select: () => target,
    key: `fixture/${id}`,
    pluginId: "fixture",
    revision: "one",
  };
}

afterEach(cleanup);

it("isolates a contribution render failure and keeps sibling section actions usable", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = {
    ...makeEntry("broken", {
      snapshot: () => [row],
      subscribe: () => () => {},
    }),
    icon: <ThrowingIcon />,
  };
  const action = vi.fn().mockRejectedValue(new Error("fixture action failed"));
  let goodRows: readonly SidebarSectionRow[] = [row];
  const rowListeners = new Set<() => void>();
  const good: RegisteredSidebarSection = {
    ...makeEntry("good", {
      snapshot: () => goodRows,
      subscribe(listener) {
        rowListeners.add(listener);
        return () => rowListeners.delete(listener);
      },
    }),
    actions: [
      {
        id: "new",
        label: "Create item",
        icon: <span aria-hidden="true">+</span>,
        onSelect: action,
      },
    ],
  };
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => [broken, good],
    subscribe: () => () => {},
    register: () => {},
  };
  const open = vi.fn().mockResolvedValue({ status: "opened" });
  const navigator = navigatorAt(target, open);

  render(
    <ChannelSidebarDnd
      writable={false}
      onMove={() => {}}
      onReorder={() => {}}
      overlay={() => null}
    >
      {[broken, good].map((entry, index) => (
        <SidebarContributionSection
          key={entry.key}
          entry={entry}
          registry={registry}
          navigator={navigator}
          target={target}
          open
          onToggle={() => {}}
          groupIndex={index}
          reorderable={false}
          move={{}}
        />
      ))}
    </ChannelSidebarDnd>,
  );

  expect(screen.getByText(/Broken section is unavailable/)).toHaveTextContent(
    "Other sidebar sections remain available.",
  );
  const rowButton = screen.getByRole("button", { name: /Useful item/ });
  const user = userEvent.setup();
  await user.click(rowButton);
  expect(open).toHaveBeenCalledWith(target);
  expect(screen.getByText("New · 2 · Active")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Create item" }));
  expect(action).toHaveBeenCalledOnce();
  expect(
    await screen.findByText("This sidebar action couldn’t finish."),
  ).toBeInTheDocument();
  act(() => {
    goodRows = [row, { id: "later", label: "Later item" }];
    for (const listener of rowListeners) listener();
  });
  expect(screen.getByRole("button", { name: "Later item" })).toBeTruthy();
  expect(consoleError).toHaveBeenCalled();
});

it("keeps failed header-action feedback visible while the section is collapsed", async () => {
  const action = vi.fn().mockRejectedValue(new Error("fixture action failed"));
  const rows: readonly SidebarSectionRow[] = [];
  const entry: RegisteredSidebarSection = {
    ...makeEntry("good", {
      snapshot: () => rows,
      subscribe: () => () => {},
    }),
    actions: [
      {
        id: "new",
        label: "Create item",
        icon: <span aria-hidden="true">+</span>,
        onSelect: action,
      },
    ],
  };
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => [entry],
    subscribe: () => () => {},
    register: () => {},
  };

  render(
    <ChannelSidebarDnd
      writable={false}
      onMove={() => {}}
      onReorder={() => {}}
      overlay={() => null}
    >
      <SidebarContributionSection
        entry={entry}
        registry={registry}
        navigator={navigatorAt(target)}
        target={target}
        open={false}
        onToggle={() => {}}
        groupIndex={0}
        reorderable={false}
        move={{}}
      />
    </ChannelSidebarDnd>,
  );

  const sectionTitle = screen.getByText("Good section");
  expect(sectionTitle.closest("details")).not.toHaveAttribute("open");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Create item" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This sidebar action couldn’t finish.",
  );
  expect(sectionTitle.closest("details")).not.toHaveAttribute("open");
});

it("selects an unscoped page row in its current community only", () => {
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const current: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "fixture.pages",
    pageId: "board",
    scope,
  };
  const rows: readonly SidebarSectionRow[] = [
    { id: "current", label: "Current community page" },
    { id: "personal", label: "Personal page" },
    { id: "other", label: "Other community page" },
  ];
  const destinations: Record<string, OpenTarget> = {
    current: {
      version: 1,
      kind: "page",
      pluginId: current.pluginId,
      pageId: current.pageId,
    },
    personal: {
      version: 1,
      kind: "page",
      pluginId: current.pluginId,
      pageId: current.pageId,
      scope: null,
    },
    other: {
      version: 1,
      kind: "page",
      pluginId: current.pluginId,
      pageId: current.pageId,
      scope: { ...scope, communityOrigin: "https://other.example" },
    },
  };
  const entry: RegisteredSidebarSection = {
    ...makeEntry("good", {
      snapshot: () => rows,
      subscribe: () => () => {},
    }),
    select: (item) => {
      const destination = destinations[item.id];
      if (!destination) throw new Error("Missing fixture destination");
      return destination;
    },
  };
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => [entry],
    subscribe: () => () => {},
    register: () => {},
  };

  render(
    <ChannelSidebarDnd
      writable={false}
      onMove={() => {}}
      onReorder={() => {}}
      overlay={() => null}
    >
      <SidebarContributionSection
        entry={entry}
        registry={registry}
        navigator={navigatorAt(target)}
        target={current}
        open
        onToggle={() => {}}
        groupIndex={0}
        reorderable={false}
        move={{}}
      />
    </ChannelSidebarDnd>,
  );

  expect(
    screen.getByRole("button", { name: "Current community page" }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("button", { name: "Personal page" }),
  ).not.toHaveAttribute("aria-current");
  expect(
    screen.getByRole("button", { name: "Other community page" }),
  ).not.toHaveAttribute("aria-current");
});

it("keeps conversation-level rows selected through in-conversation navigation", () => {
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const conversation: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
  };
  const message: OpenTarget = {
    ...conversation,
    messageId: "b".repeat(64),
  };
  const rows: readonly SidebarSectionRow[] = [
    { id: "conversation", label: "Conversation" },
    { id: "message", label: "Exact message" },
    { id: "other-channel", label: "Other conversation" },
    { id: "other-community", label: "Other community" },
  ];
  const destinations: Record<string, OpenTarget> = {
    conversation,
    message,
    "other-channel": { ...conversation, channelId: "beta" },
    "other-community": {
      ...conversation,
      scope: { ...scope, communityOrigin: "https://other.example" },
    },
  };
  const entry: RegisteredSidebarSection = {
    ...makeEntry("good", { snapshot: () => rows, subscribe: () => () => {} }),
    select: (item) => {
      const destination = destinations[item.id];
      if (!destination) throw new Error("Missing fixture destination");
      return destination;
    },
  };
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => [entry],
    subscribe: () => () => {},
    register: () => {},
  };
  // One navigator for the whole test: its open entry changes through its
  // listener, as a thread open does, without the sidebar rendering.
  let open: OpenTarget = message;
  const listeners = new Set<() => void>();
  const navigator = {
    open: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({ entry: { target: open } }),
  } as unknown as Navigation;
  const navigate = (next: OpenTarget) =>
    act(() => {
      open = next;
      for (const listener of listeners) listener();
    });
  const renderSection = (target: OpenTarget) => (
    <ChannelSidebarDnd
      writable={false}
      onMove={() => {}}
      onReorder={() => {}}
      overlay={() => null}
    >
      <SidebarContributionSection
        entry={entry}
        registry={registry}
        navigator={navigator}
        target={target}
        open
        onToggle={() => {}}
        groupIndex={0}
        reorderable={false}
        move={{}}
      />
    </ChannelSidebarDnd>
  );

  const { rerender } = render(renderSection(message));
  const conversationRow = () =>
    screen.getByRole("button", { name: "Conversation" });
  const exactMessageRow = () =>
    screen.getByRole("button", { name: "Exact message" });

  expect(conversationRow()).toHaveAttribute("aria-current", "page");
  expect(exactMessageRow()).toHaveAttribute("aria-current", "page");

  // The shell's sidebar target names only the conversation; the open entry
  // still selects the exact message. Under Settings, the target stands.
  rerender(renderSection(conversation));
  expect(conversationRow()).toHaveAttribute("aria-current", "page");
  expect(exactMessageRow()).toHaveAttribute("aria-current", "page");
  // Leaving and returning to the message does not render the sidebar.
  navigate(conversation);
  expect(exactMessageRow()).not.toHaveAttribute("aria-current");
  navigate(message);
  expect(exactMessageRow()).toHaveAttribute("aria-current", "page");
  navigate({ version: 1, kind: "settings" });
  expect(conversationRow()).toHaveAttribute("aria-current", "page");
  expect(exactMessageRow()).not.toHaveAttribute("aria-current");

  navigate({ ...message, panel: "members" });
  rerender(renderSection({ ...message, panel: "members" }));
  expect(conversationRow()).toHaveAttribute("aria-current", "page");
  expect(exactMessageRow()).not.toHaveAttribute("aria-current");

  navigate({ ...conversation, messageId: "c".repeat(64) });
  rerender(renderSection({ ...conversation, messageId: "c".repeat(64) }));
  expect(conversationRow()).toHaveAttribute("aria-current", "page");
  expect(exactMessageRow()).not.toHaveAttribute("aria-current");

  rerender(
    renderSection({
      ...conversation,
      scope: { ...scope, communityOrigin: "https://other.example" },
    }),
  );
  expect(conversationRow()).not.toHaveAttribute("aria-current");
  expect(exactMessageRow()).not.toHaveAttribute("aria-current");
  expect(
    screen.getByRole("button", { name: "Other conversation" }),
  ).not.toHaveAttribute("aria-current");
  expect(
    screen.getByRole("button", { name: "Other community" }),
  ).toHaveAttribute("aria-current", "page");
});

it("preserves the receiver for an external row store", () => {
  const store: RegisteredSidebarSection["rows"] & {
    rows: readonly SidebarSectionRow[];
    listeners: Set<() => void>;
  } = {
    rows: [row],
    listeners: new Set(),
    snapshot() {
      return this.rows;
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };
  const entry = makeEntry("good", store);
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => [entry],
    subscribe: () => () => {},
    register: () => {},
  };

  render(
    <ChannelSidebarDnd
      writable={false}
      onMove={() => {}}
      onReorder={() => {}}
      overlay={() => null}
    >
      <SidebarContributionSection
        entry={entry}
        registry={registry}
        navigator={navigatorAt(target)}
        target={target}
        open
        onToggle={() => {}}
        groupIndex={0}
        reorderable={false}
        move={{}}
      />
    </ChannelSidebarDnd>,
  );

  expect(screen.getByRole("button", { name: /Useful item/ })).toBeVisible();
  act(() => {
    store.rows = [row, { id: "later", label: "Later item" }];
    for (const listener of store.listeners) listener();
  });
  expect(screen.getByRole("button", { name: "Later item" })).toBeVisible();
});
