// @vitest-environment jsdom
const emptyTyping: never[] = [];
const emptyProfiles = new Map();
import "@testing-library/jest-dom/vitest";
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
import { createAgentLibrary } from "../agents/library";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import { DayDivider } from "./MessageTimestamp";
import { ThreadPanel } from "./ThreadPanel";

vi.mock("./use-reading", () => ({
  Reading: () => null,
  readingPositioned: () => {},
}));
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useProfileGeneration: () => 0, useRowProfiles: () => profiles };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    row,
    onReply,
    layout,
    compactAvatar,
    stackPrevious,
    stackNext,
    day,
    repliedAgents,
    stoppedRequest,
    recordedActivity,
  }: MessageRowProps) => (
    <article
      data-message-id={row.id}
      data-request={recordedActivity?.requestId}
      data-replied-agents={repliedAgents?.join(",")}
      data-stopped-request={stoppedRequest?.id}
      data-layout={layout}
      data-stack-previous={stackPrevious || undefined}
      data-stack-next={stackNext || undefined}
      data-compact-avatar={compactAvatar}
    >
      {day && <DayDivider createdAt={row.createdAt} />}
      <span>{row.content}</span>
      <a href="https://example.com">Link in {row.content}</a>
      <button type="button" onClick={() => onReply?.(row.id)}>
        Reply to {row.content}
      </button>
    </article>
  ),
}));
// A background send keeps the onSend from the render where Send happened.
let heldSend: ((id: string) => void) | undefined;
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({
    replyContext,
    replyParentId,
    onSend,
    disabled,
  }: MessageComposerProps) => (
    <section aria-label="Composer" data-parent={replyParentId}>
      {replyContext}
      <button type="button" disabled={disabled} onClick={() => onSend?.("new")}>
        Send fixture reply
      </button>
      <button type="button" onClick={() => (heldSend = onSend)}>
        Send fixture upload
      </button>
    </section>
  ),
}));
// jsdom has no layout observer; browser resize behavior is covered in Playwright.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
function row(id: string, replyParentId?: string): ChannelMessage {
  return {
    id,
    replyParentId,
    channelId: "c",
    authorId: "a".repeat(64),
    content: id,
    createdAt: 1,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
}
/** The top-level branch panel a displayed reply sits in. */
function branchOf(text: string) {
  const branch = screen
    .getByText(text)
    .closest('[data-depth="0"]') as HTMLElement | null;
  if (!branch) throw new Error(`${text} is not in a branch`);
  return branch;
}
function setup(messageId = "root") {
  let snapshot: ThreadSnapshot = {
    root: row("root"),
    replies: [
      row("parent", "root"),
      row("child", "parent"),
      row("grandchild", "child"),
    ],
    status: "ready",
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const listeners = new Set<() => void>();
  const view = {
    snapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh: async () => {},
    loadMore: async () => {},
    dispose: () => {},
  };
  const session = {
    thread: () => view,
    profiles: {
      ensure: async () => {},
      subscribe: () => () => {},
      snapshot: () => emptyProfiles,
    },
    typing: { subscribe: () => () => {}, snapshot: () => emptyTyping },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry: () => {} },
    media: () => undefined,
    unread: {
      subscribe: () => () => {},
      snapshot: () => undefined,
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  render(
    <ThreadPanel
      session={session}
      scope="test"
      channelName="C"
      channelId="c"
      messageId={messageId}
      close={() => {}}
      onOpenLink={() => false}
    />,
  );
  return {
    setRoot(root: ChannelMessage | undefined) {
      act(() => {
        snapshot = { ...snapshot, root };
        for (const fn of listeners) fn();
      });
    },
    update(replies: ChannelMessage[]) {
      act(() => {
        snapshot = { ...snapshot, replies };
        for (const fn of listeners) fn();
      });
    },
  };
}
it("binds a flattened update to the request it claims in another reply level", () => {
  const h = setup();
  const agent = "b".repeat(64);
  const update = (id: string): ChannelMessage => ({
    ...row(id, "root"),
    threadRootId: "root",
    authorId: agent,
    audience: "agents",
  });
  h.update([
    update("old"),
    { ...row("follow-up", "old"), threadRootId: "root" },
    // Its send names the nested follow-up, but its reply link is the root.
    { ...update("current"), request: "follow-up" },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: /^Show activity history:/ }),
  );
  const article = (text: string) => screen.getByText(text).closest("article");
  expect(article("current")).toHaveAttribute("data-request", "follow-up");
  expect(article("old")).toHaveAttribute("data-request", "root");
});
it("keeps a stopped note on the agent's latest reply that a collapsed branch cannot hide", () => {
  const h = setup();
  const agent = "b".repeat(64);
  const reply = (id: string, parent: string) => ({
    ...row(id, parent),
    authorId: agent,
    agentEnvelope: true as const,
  });
  h.update([reply("answer", "root"), reply("aside", "answer")]);
  const article = (text: string) => screen.getByText(text).closest("article");
  expect(article("root")).toHaveAttribute("data-replied-agents", agent);
  expect(article("answer")).toHaveAttribute("data-stopped-request", "root");
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(article("aside")).not.toHaveAttribute("data-stopped-request");
  expect(article("answer")).toHaveAttribute("data-stopped-request", "root");
});
it("shows automatic failure captions beside their request while ordinary replies stay nested", () => {
  const h = setup();
  const failure: ChannelMessage = {
    ...row("failure", "parent"),
    notice: "execution-failure",
  };
  h.update([row("parent", "root"), failure, row("child", "parent")]);
  expect(screen.getByText("failure")).toBeVisible();
  expect(
    screen.queryByText("Earlier reply unavailable in loaded history."),
  ).not.toBeInTheDocument();
  expect(screen.getByText("failure").closest("article")).not.toHaveAttribute(
    "data-compact-avatar",
    "true",
  );
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("child")).toBeVisible();
  expect(screen.getByText("failure")).toBeVisible();
});
it.each(["first update", "second update", "failure"])(
  "preserves activity grouping and reachable replies when someone replies to %s",
  (parent) => {
    const h = setup();
    const agent = "b".repeat(64);
    const update = (id: string): ChannelMessage => ({
      ...row(id, "root"),
      threadRootId: "root",
      authorId: agent,
      audience: "agents",
    });
    const failure: ChannelMessage = {
      ...row("failure", "root"),
      threadRootId: "root",
      authorId: agent,
      agentEnvelope: true,
      notice: "execution-failure",
    };
    const history = [update("first update"), update("second update"), failure];
    h.update(history);
    const disclosure = () =>
      screen.queryByRole("button", { name: /^Show activity history:/ });
    expect(disclosure()).toBeVisible();
    expect(screen.queryByText("first update")).not.toBeInTheDocument();
    expect(screen.queryByText("failure")).not.toBeInTheDocument();

    h.update([
      ...history,
      { ...row("follow-up", parent), threadRootId: "root" },
    ]);
    if (parent === "failure") {
      expect(disclosure()).toBeVisible();
      expect(screen.queryByText("first update")).not.toBeInTheDocument();
      expect(screen.getByText("failure")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: /^Show activity history:/ }),
      );
    } else {
      // Coordination rows with children must still expose their own branch.
      expect(disclosure()).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("failure")).toHaveLength(1);
    expect(screen.getByText("first update")).toBeVisible();
    expect(screen.getByText("second update")).toBeVisible();
    expect(screen.queryByText("follow-up")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
    expect(screen.getByText("follow-up")).toBeVisible();
    if (parent === "failure") {
      fireEvent.click(
        screen.getByRole("button", { name: /^Collapse activity history:/ }),
      );
      expect(screen.getByText("failure")).toBeVisible();
      expect(screen.getByText("follow-up")).toBeVisible();
      expect(screen.queryByText("first update")).not.toBeInTheDocument();
    }
    h.update(history);
    expect(disclosure()).toBeVisible();
    expect(screen.queryByText("failure")).not.toBeInTheDocument();
  },
);
it("moves a follow-up outcome to its latest reply within an expanded branch", () => {
  const h = setup();
  const agent = "b".repeat(64);
  const reply = (id: string) => ({
    ...row(id, "follow-up"),
    authorId: agent,
    agentEnvelope: true as const,
  });
  h.update([
    row("branch", "root"),
    row("follow-up", "branch"),
    reply("answer"),
    reply("latest-answer"),
  ]);
  expect(screen.queryByText("follow-up")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 3 replies" }));
  const article = (text: string) => screen.getByText(text).closest("article");
  expect(article("follow-up")).toHaveAttribute("data-replied-agents", agent);
  expect(article("answer")).not.toHaveAttribute("data-stopped-request");
  expect(article("latest-answer")).toHaveAttribute(
    "data-stopped-request",
    "follow-up",
  );
  expect(article("branch")).not.toHaveAttribute("data-replied-agents");
});
it("expands a one-level branch by keyboard and focuses the first child", async () => {
  setup();
  const user = userEvent.setup();
  const expand = screen.getByRole("button", { name: "View 2 replies" });
  expand.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("child").closest("article")).toHaveFocus();
  expect(expand).not.toBeInTheDocument();
  // A reply to a nested reply continues the branch instead of nesting again.
  expect(screen.getByText("grandchild")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^View \d+ repl/ }),
  ).not.toBeInTheDocument();
});

it("collapses an open branch from its thread line, reopens it and collapses again", async () => {
  setup();
  const user = userEvent.setup();
  for (let pass = 0; pass < 2; pass++) {
    await user.click(screen.getByRole("button", { name: "View 2 replies" }));
    expect(screen.getByText("child")).toBeVisible();
    const collapse = screen.getByRole("button", { name: "Collapse 2 replies" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(screen.queryByText("child")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View 2 replies" }),
    ).toHaveFocus();
  }
});

it("collapsing one branch leaves its open sibling branch open", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("other", "root"),
    row("nephew", "other"),
  ]);
  for (const view of screen.getAllByRole("button", { name: "View 1 reply" }))
    fireEvent.click(view);
  const [collapse] = screen.getAllByRole("button", {
    name: "Collapse 1 reply",
  });
  if (collapse) fireEvent.click(collapse);
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(screen.getByText("nephew")).toBeVisible();
});

it("moves focus from a removed collapse control to its branch's message, then the history", async () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  screen.getByRole("button", { name: "Collapse 2 replies" }).focus();
  await act(async () => h.update([row("parent", "root")]));
  expect(screen.getByText("parent").closest("article")).toHaveFocus();

  h.update([row("parent", "root"), row("child", "parent")]);
  screen.getByRole("button", { name: "Collapse 1 reply" }).focus();
  await act(async () => h.update([]));
  expect(screen.getByLabelText("Thread messages")).toHaveFocus();
});
it("retains expansion and parent identity through live zero-to-one child transitions", () => {
  const h = setup();
  h.update([row("parent", "root")]);
  const parent = screen.getByText("parent").closest("article");
  const reply = screen.getByRole("button", { name: "Reply to parent" });
  reply.focus();
  h.update([row("parent", "root"), row("child", "parent")]);
  expect(reply).toHaveFocus();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  reply.focus();
  h.update([row("parent", "root")]);
  h.update([row("parent", "root"), row("new", "parent")]);
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  expect(screen.getByText("new")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "View 1 reply" }),
  ).not.toBeInTheDocument();
});
it.each([
  { childDay: 20, peerDay: 20, closedDays: [], openDays: [] },
  {
    childDay: 20,
    peerDay: 21,
    closedDays: ["2026-10-21"],
    openDays: ["2026-10-21"],
  },
  {
    childDay: 21,
    peerDay: 20,
    closedDays: [],
    openDays: ["2026-10-21", "2026-10-20"],
  },
  {
    childDay: 21,
    peerDay: 21,
    closedDays: ["2026-10-21"],
    openDays: ["2026-10-21"],
  },
])(
  "uses visible message dates around a reply branch (child $childDay, peer $peerDay)",
  async ({ childDay, peerDay, closedDays, openDays }) => {
    const h = setup();
    const at = (day: number, minute: number) =>
      new Date(2026, 9, day, 13, minute).getTime() / 1000;
    h.setRoot({ ...row("root"), createdAt: at(20, 25) });
    h.update([
      { ...row("parent", "root"), createdAt: at(20, 28) },
      { ...row("child", "parent"), createdAt: at(childDay, 29) },
      { ...row("peer", "root"), createdAt: at(peerDay, 30) },
    ]);
    const days = () =>
      Array.from(document.querySelectorAll("[data-day]"), (divider) =>
        divider.getAttribute("data-day"),
      );
    expect(screen.queryByText("child")).not.toBeInTheDocument();
    expect(days()).toEqual(closedDays);
    // A reply summary still separates bubble groups, even within the same day.
    expect(screen.getByText("peer").closest("article")).toHaveAttribute(
      "data-layout",
      "thread",
    );
    const expand = screen.getByRole("button", { name: "View 1 reply" });
    expand.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(screen.getByText("child").closest("article")).toHaveFocus();
    expect(days()).toEqual(openDays);
  },
);
it("targets a child, cancels on repeated Reply, resets after send and reveals the own branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  const composer = screen.getByLabelText("Composer");
  expect(composer).toHaveAttribute("data-parent", "parent");
  expect(
    within(composer).getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  expect(composer).not.toHaveAttribute("data-parent");
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("new", "parent")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(composer).not.toHaveAttribute("data-parent");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});
it("continues a branch when replying to a nested reply", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  fireEvent.click(screen.getByRole("button", { name: "Reply to child" }));
  expect(screen.getByLabelText("Composer")).toHaveAttribute(
    "data-parent",
    "child",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("grandchild", "child"),
    row("new", "child"),
  ]);
  const branch = branchOf("new");
  expect(branch).toBe(branchOf("child"));
  for (const id of ["child", "grandchild", "new"])
    expect(screen.getByText(id).closest("[data-depth]")).toHaveAttribute(
      "data-depth",
      "1",
    );
  expect(
    [...branch.querySelectorAll<HTMLElement>("[data-message-id]")].map(
      (row) => row.dataset.messageId,
    ),
  ).toEqual(["parent", "child", "grandchild", "new"]);
  expect(
    screen.queryByRole("button", { name: /^View \d+ repl/ }),
  ).not.toBeInTheDocument();
});
it("keeps a reply target chosen while a background send is still publishing", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send fixture upload" }));
  fireEvent.click(screen.getByRole("button", { name: "Reply to child" }));
  const composer = screen.getByLabelText("Composer");
  expect(composer).toHaveAttribute("data-parent", "child");
  act(() => heldSend?.("new"));
  expect(composer).toHaveAttribute("data-parent", "child");
});
it("reveals all available ancestors for a selected descendant, including late history", () => {
  const h = setup("grandchild");
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing")]);
  expect(
    screen.getByText("Earlier reply unavailable in loaded history."),
  ).toBeVisible();
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing"), row("missing", "root")]);
  expect(screen.getByText("grandchild")).toBeVisible();
  expect(
    screen.queryByText("Earlier reply unavailable in loaded history."),
  ).not.toBeInTheDocument();
  // A deep reply whose chain arrives late still lands in the top-level branch.
  h.update([
    row("missing", "root"),
    row("grandchild", "missing"),
    row("deeper", "grandchild"),
  ]);
  expect(screen.getByText("deeper")).toBeVisible();
  expect(branchOf("deeper")).toBe(branchOf("grandchild"));
  expect(screen.getByText("missing").closest("[data-depth]")).toHaveAttribute(
    "data-depth",
    "0",
  );
});
it("does not silently retarget a deleted parent to the root", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  h.update([]);
  expect(
    screen.getByText("Reply target is no longer available."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply target" }));
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeEnabled();
});

it("starts replies with a full author header and only groups replies within the time window", () => {
  const h = setup();
  const root = document.querySelector('[data-message-id="root"]');
  const parent = () => screen.getByText("parent").closest("article");
  const peer = () => screen.getByText("peer").closest("article");
  expect(parent()).toHaveAttribute("data-layout", "thread");
  expect(parent()).not.toHaveAttribute("data-stack-previous");
  expect(root).not.toHaveAttribute("data-stack-next");

  // The divider breaks the root's bubble group, not the groups among replies.
  h.update([row("parent", "root"), { ...row("peer", "root"), createdAt: 301 }]);
  expect(peer()).toHaveAttribute("data-layout", "continuation");
  expect(peer()).toHaveAttribute("data-stack-previous", "true");
  expect(parent()).toHaveAttribute("data-stack-next", "true");
  expect(root).not.toHaveAttribute("data-stack-next");

  h.update([row("parent", "root"), { ...row("peer", "root"), createdAt: 302 }]);
  expect(peer()).toHaveAttribute("data-layout", "thread");
  expect(peer()).not.toHaveAttribute("data-stack-previous");
  expect(parent()).not.toHaveAttribute("data-stack-next");
  h.update([
    row("parent", "root"),
    { ...row("peer", "root"), authorId: "b".repeat(64) },
  ]);
  expect(peer()).toHaveAttribute("data-layout", "thread");
  expect(peer()).not.toHaveAttribute("data-stack-previous");
  expect(parent()).not.toHaveAttribute("data-stack-next");
});
it("keeps ordinary replies flat and visible when nested branches open or new replies arrive", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
  ]);
  const history = screen.getByRole("region", { name: "Thread messages" });
  expect(
    within(history).queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  const parent = screen.getByText("parent").closest("li");
  const peer = screen.getByText("peer").closest("li");
  expect(parent?.parentElement).toBe(peer?.parentElement);
  expect(parent?.parentElement?.parentElement).toBe(
    history.querySelector("[data-thread-rows]"),
  );
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("child")).toBeVisible();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
    row("new", "root"),
  ]);
  for (const id of ["parent", "peer", "new", "child"])
    expect(screen.getByText(id)).toBeVisible();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});
it("an own ordinary reply stays visible without opening a nested branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("child", "parent"), row("new", "root")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(screen.getByText("parent")).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("does not offer collapse controls for an empty thread", () => {
  const h = setup();
  h.update([]);
  expect(screen.getByText("root")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^View thread replies:/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});

it("keeps same-author continuation layout through pending, failed, and accepted delivery", () => {
  const h = setup("child");
  for (const delivery of ["sending", "failed", "accepted"] as const) {
    h.update([row("parent", "root"), { ...row("child", "root"), delivery }]);
    expect(screen.getByText("child").closest("article")).toHaveAttribute(
      "data-layout",
      "continuation",
    );
  }
});

it("preserves ordinary reply identity, focus and unopened nested state through root loss and return", () => {
  const h = setup();
  const parent = screen.getByText("parent").closest("article");
  const reply = screen.getByRole("button", { name: "Reply to parent" });
  reply.focus();
  h.setRoot(undefined);
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  h.setRoot(row("root"));
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
});

for (const startsWithChild of [false, true])
  it(`preserves a reply subtree when it ${startsWithChild ? "loses its last" : "gains its first"} child`, () => {
    const h = setup("parent");
    const parent = row("parent", "root");
    const child = row("child", "parent");
    h.update(startsWithChild ? [parent, child] : [parent]);
    const message = screen.getByText("parent").closest("article");
    const reply = screen.getByRole("button", { name: "Reply to parent" });
    reply.focus();
    h.update(startsWithChild ? [parent] : [parent, child]);
    expect(screen.getByText("parent").closest("article")).toBe(message);
    expect(reply).toHaveFocus();
    expect(message).toBeInTheDocument();
    if (startsWithChild)
      expect(
        screen.queryByRole("button", { name: "View 1 reply" }),
      ).not.toBeInTheDocument();
    else
      expect(
        screen.getByRole("button", { name: "View 1 reply" }),
      ).toBeVisible();
  });

it("starts a nested branch with an author header even when the author matches its parent", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});

it("groups same-parent siblings but restores the author after an expanded branch", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("sibling", "parent"),
    row("peer", "root"),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
  expect(screen.getByText("child").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
  expect(screen.getByText("sibling").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  expect(screen.getByText("peer").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});

it("returns focus to the parent when the newly revealed focused child is deleted", async () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child").closest("article")).toHaveFocus();
  await act(async () => h.update([row("parent", "root")]));
  expect(screen.getByText("parent").closest("article")).toHaveFocus();
});

it("uses compact avatars only below ordinary thread replies", () => {
  setup("grandchild");
  for (const id of ["root", "parent"]) {
    expect(screen.getByText(id).closest("article")).not.toHaveAttribute(
      "data-compact-avatar",
      "true",
    );
  }
  for (const id of ["child", "grandchild"]) {
    expect(screen.getByText(id).closest("article")).toHaveAttribute(
      "data-compact-avatar",
      "true",
    );
  }
});

for (const focused of ["row", "button", "link"] as const) {
  for (const nested of [false, true]) {
    it(`recovers a deleted ${focused} to ${nested ? "its parent" : "tabbable history"}`, async () => {
      const h = setup(nested ? "child" : "parent");
      const id = nested ? "child" : "parent";
      const message = screen.getByText(id).closest("article");
      const target = nested
        ? screen.getByText("parent").closest("article")
        : screen.getByRole("region", { name: "Thread messages" });
      if (focused === "button")
        screen.getByRole("button", { name: `Reply to ${id}` }).focus();
      else if (focused === "link")
        screen.getByRole("link", { name: `Link in ${id}` }).focus();
      else if (message) {
        // Match the programmatic row focus used by exact-link navigation.
        message.tabIndex = -1;
        message.focus();
      }
      expect(message?.contains(document.activeElement)).toBe(true);
      const remaining = nested ? [row("parent", "root")] : [];
      await act(async () => h.update(remaining));
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute("tabindex", nested ? "-1" : "0");
      h.update([...remaining, row("arrival", "root")]);
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute("tabindex", nested ? "-1" : "0");
    });
  }
}

it("does not steal focus moved after removal but before queued recovery", async () => {
  const h = setup("child");
  const child = screen.getByRole("button", { name: "Reply to child" });
  child.focus();
  const send = screen.getByRole("button", { name: "Send fixture reply" });
  h.update([row("parent", "root")]);
  expect(child.isConnected).toBe(false);
  expect(document.body).toHaveFocus();
  send.focus();
  await act(async () => {});
  expect(send).toHaveFocus();
});
