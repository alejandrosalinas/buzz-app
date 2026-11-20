// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { formatFullTimestamp } from "../../shared/datetime";
import { RelayedRunPreview } from "./RelayedRunPreview";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const subscribe = () => () => {};
const profiles = new Map<string, Profile>([
  ["zerk", { name: "Zerk", isAgent: true }],
  ["mira", { name: "Mira", isAgent: true }],
]);
const session = {
  viewer: "owner",
  channels: {
    list: () => ({
      status: "ready",
      channels: [
        { id: "source", name: "rebase", channelType: "stream" },
        { id: "direct", name: "Alice", channelType: "dm" },
      ],
    }),
    subscribeList: subscribe,
  },
  messages: {},
  profiles: { snapshot: () => profiles, subscribe },
} as unknown as RelaySession;

function relayed(
  id: string,
  agent: string,
  text: string,
  channelId?: string,
): ChannelMessage {
  return {
    id,
    channelId: "here",
    threadRootId: id,
    authorId: "owner",
    createdAt: 1_000,
    content: `Relayed for ${agent}\n\n${text}`,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
    relayedFrom: {
      agent,
      verified: true,
      notice: `Relayed for ${agent}`,
      ...(channelId ? { channelId } : {}),
    },
  };
}

function preview(rows: ChannelMessage[]) {
  return render(
    <RelayedRunPreview
      run={{ ids: rows.map((row) => row.id), relayed: rows }}
      session={session}
      profiles={profiles}
      media={() => undefined}
      expanded={false}
      onToggle={() => {}}
      renderHistory={(row) => row.id}
      onOpenLink={() => false}
    />,
  );
}

it("leads with the latest message and how many more came from its one chat", () => {
  const view = preview([
    relayed("a", "mira", "Starting on the row", "source"),
    relayed("b", "zerk", "Rebase on main first", "source"),
  ]);
  const trigger = screen.getByRole("button", {
    name: /^Show 2 messages from #rebase by Zerk and Mira\. Latest, Zerk: Rebase on main first, /,
  });
  expect(trigger).toBeVisible();
  // Its time is hidden from assistive technology, so the label reads the date.
  expect(
    trigger
      .getAttribute("aria-label")
      ?.endsWith(`, ${formatFullTimestamp(1_000)}`),
  ).toBe(true);
  expect(screen.getByRole("link", { name: /rebase/ })).toBeVisible();
  expect(view.container).toHaveTextContent("Rebase on main first");
  expect(view.container).toHaveTextContent("+1");
  expect(view.container).not.toHaveTextContent("Relayed for");
  expect(view.container).not.toHaveTextContent("other chats");
});

it("names other chats when its messages came from more than one", () => {
  const view = preview([
    relayed("a", "mira", "Starting on the row", "source"),
    relayed("b", "zerk", "Rebase on main first", "elsewhere"),
  ]);
  expect(
    screen.getByRole("button", {
      name: /^Show 2 messages from other chats by Zerk and Mira\./,
    }),
  ).toBeVisible();
  expect(view.container).toHaveTextContent("from other chats");
  expect(screen.queryByRole("link")).toBeNull();
});

it("names the one chat once, not on each line inside", () => {
  const first = relayed("a", "zerk", "One", "source");
  const rows = [first, relayed("b", "zerk", "Two", "source")];
  const sameSource = (view: ReturnType<typeof render>) =>
    view.container.querySelector("[data-same-source]");
  const view = render(
    <RelayedRunPreview
      run={{ ids: ["a", "b"], relayed: rows }}
      session={session}
      profiles={profiles}
      media={() => undefined}
      expanded
      onToggle={() => {}}
      renderHistory={(row) => row.id}
      onOpenLink={() => false}
    />,
  );
  expect(sameSource(view)).toHaveTextContent("ab");
  // Opened, the line keeps only its chat; each line below names its sender.
  expect(
    screen.getByRole("button", { name: /^Collapse 2 messages from #rebase/ }),
  ).toBeVisible();
  expect(view.container).toHaveTextContent(/^ZFrom#rebase/);
  expect(view.container).not.toHaveTextContent("Zerk");
  expect(view.container).not.toHaveTextContent("+1");
  view.rerender(
    <RelayedRunPreview
      run={{
        ids: ["a", "b"],
        relayed: [first, relayed("b", "zerk", "Two", "elsewhere")],
      }}
      session={session}
      profiles={profiles}
      media={() => undefined}
      expanded
      onToggle={() => {}}
      renderHistory={(row) => row.id}
      onOpenLink={() => false}
    />,
  );
  expect(sameSource(view)).toBeNull();
});

it("marks a direct message's from, which a narrow conversation keeps", () => {
  const view = preview([
    relayed("a", "mira", "Starting on the row", "direct"),
    relayed("b", "zerk", "Rebase on main first", "direct"),
  ]);
  expect(
    screen.getByRole("button", {
      name: /^Show 2 messages from Alice by Zerk and Mira\./,
    }),
  ).toBeVisible();
  expect(
    view.container.querySelector('[data-relayed-from="dm"]'),
  ).toHaveTextContent("from");
});

it("renames a mounted group's latest date when the time zone changes", async () => {
  const NativeFormat = Intl.DateTimeFormat;
  let timeZone = "Europe/London";
  function dateTimeFormat(
    locale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new NativeFormat(locale ?? "en-US", { timeZone, ...options });
  }
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(dateTimeFormat);
  // Memoized, like a timeline row whose parent does not re-render.
  const Row = memo(function Row() {
    return (
      <RelayedRunPreview
        run={{
          ids: ["a", "b"],
          relayed: [
            relayed("a", "zerk", "One", "source"),
            relayed("b", "mira", "Two", "source"),
          ],
        }}
        session={session}
        profiles={profiles}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
        renderHistory={(row) => row.id}
        onOpenLink={() => false}
      />
    );
  });
  render(<Row />);
  const name = () =>
    screen
      .getByRole("button", { name: /^Show 2 messages/ })
      .getAttribute("aria-label");
  expect(name()).toMatch(/GMT|BST/);
  await Promise.resolve();
  timeZone = "America/Los_Angeles";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(name()).toMatch(/PDT|PST/);
});
