// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { RelayedRunPreview } from "./RelayedRunPreview";

stubAvatarBrowserApis();
afterEach(cleanup);

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
      channels: [{ id: "source", name: "rebase", channelType: "stream" }],
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
  expect(
    screen.getByRole("button", {
      name: /^Show 2 messages from #rebase by Zerk and Mira\. Latest, Zerk: Rebase on main first, /,
    }),
  ).toBeVisible();
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
