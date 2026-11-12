// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  profileActivityViewTarget,
  claimProfileTranscript,
  profileTranscriptRequest,
} from "../profiles/target";
import { ActivityIndicatorPresentation } from "../conversation/typing-presentation";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import {
  activityPresentation,
  useActivityPresentation,
} from "./activity-presentation";
import type { ChannelMessage } from "../relay/contracts";
import { TypingIndicator } from "./TypingIndicator";

import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
import {
  agent,
  human,
  other,
  root,
  secondRoot,
  fixture,
  entry,
  type Snapshot,
} from "./typing-indicator-testing";
// Transcript requests live in a module-level map; each test starts clean.
afterEach(() => {
  for (const pubkey of [agent, other])
    claimProfileTranscript(profileActivityViewTarget(pubkey) ?? "");
});

it("shows an incoming typing preview without invented details, retaining navigation and focus return", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  expect(screen.getByRole("img", { name: "Agent" })).toBeVisible();
  expect(trigger.querySelector('[data-state="working"]')).not.toBeNull();
  expect(trigger).not.toHaveTextContent("Working");
  await user.hover(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Working now" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "connecting" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "interrupted" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "listening" });
  expect(within(dialog).getByText("Thread · First task")).toBeVisible();
  // The agent's row is the only way in: no separate Activity heading.
  expect(
    within(dialog).queryByRole("button", { name: "View full activity" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  );
  // The agent's one Activity destination, so an open Activity tab is reused.
  const activity = profileActivityViewTarget(agent);
  expect(open).toHaveBeenLastCalledWith(activity, {
    rootId: root,
  });
  // The click asks the profile it opens for the transcript, once.
  expect(profileTranscriptRequest(activity ?? "")).toBeDefined();
  claimProfileTranscript(activity ?? "");
  expect(trigger).toHaveFocus();
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(f.ensure).not.toHaveBeenCalled();
});

it("shows one owner-only remote hint beside the typing agent's name and follows execution changes", async () => {
  const f = fixture();
  const base = f.session.agentChoices.snapshot();
  let choices = base;
  const session = {
    ...f.session,
    agentChoices: { ...f.session.agentChoices, snapshot: () => choices },
  };
  const typing = (pubkey = agent) => ({ pubkey, channelId: "channel" });
  const execution = (
    pubkey: string,
    value?: "remote" | "local",
    runtime = "block.builderlab/builderlab",
  ) => {
    choices = {
      ...base,
      identities: base.identities.map((choice) =>
        choice.pubkey === pubkey && value
          ? { ...choice, execution: value, runtime }
          : choice,
      ),
    };
    f.update([typing()]);
  };
  f.update([typing()]);
  const view = render(
    <TypingIndicator inFlow session={session} channelId="channel" />,
  );
  expect(screen.queryByText("Remote")).toBeNull();
  execution(agent, "remote");
  const hint = screen.getByText("Remote");
  expect(hint).toBeVisible();
  expect(screen.getAllByText("Remote")).toHaveLength(1);
  expect(hint.closest("strong")).toBeNull();
  expect(hint.closest("button")).toBeNull();
  expect(hint.parentElement).toHaveTextContent("Agent· Remote");
  expect(document.querySelector(".tabler-icon-cloud")).toBeNull();
  await userEvent.setup().hover(hint);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Runs remotely on Builderlab",
  );
  execution(agent, "remote", "other/provider");
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "Runs on a remote machine",
  );
  execution(agent, "local");
  expect(screen.queryByText("Remote")).toBeNull();
  execution(agent);
  expect(screen.queryByText("Remote")).toBeNull();
  // Another participant's remote execution cannot label the first agent.
  execution(other, "remote");
  f.update([typing(), typing(other)]);
  expect(screen.queryByText("Remote")).toBeNull();
  f.update([typing(other)]);
  expect(screen.getByText("Remote").parentElement).toHaveTextContent(
    "Other· Remote",
  );
  view.rerender(
    <TypingIndicator
      inFlow
      previousAuthor={other}
      session={session}
      channelId="channel"
    />,
  );
  expect(screen.queryByText("Remote")).toBeNull();
  f.update([typing("public-agent")]);
  expect(screen.queryByText("Remote")).toBeNull();
});

it.each([
  [{ title: "unknown", kind: "__proto__" }, "Running a tool"],
  [{ title: "unknown", kind: "constructor" }, "Running a tool"],
  [{ title: "__proto__", kind: "read" }, "Reading"],
  [{ title: "constructor", kind: "read" }, "Reading"],
] as const)(
  "renders the Working now chooser for inherited tool keys: %j",
  async (tool, label) => {
    const f = fixture(),
      user = userEvent.setup();
    const base = f.session.agentChoices.snapshot();
    let choices = {
      ...base,
      identities: base.identities.map((choice) => ({
        ...choice,
        execution: "remote" as "remote" | "local",
        runtime: "block.builderlab/builderlab",
      })),
    };
    Object.assign(f.session.agentChoices, { snapshot: () => choices });
    const now = Date.parse("2026-10-08T12:00:00Z");
    f.update([], {
      turns: [
        {
          agent,
          channelId: "channel",
          turnId: "turn",
          state: "working",
          timestamp: now,
        },
      ],
      records: [
        {
          id: "f".repeat(64),
          agent,
          createdAt: now / 1000,
          receivedAt: now,
          kind: "acp_read",
          channelIds: ["channel"],
          plaintext: JSON.stringify({
            kind: "acp_read",
            channelId: "channel",
            turnId: "turn",
            timestamp: new Date(now).toISOString(),
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "call",
                  status: "in_progress",
                  rawInput: { path: "/private/report.txt" },
                  ...tool,
                },
              },
            },
          }),
        },
      ],
    });
    render(<TypingIndicator session={f.session} channelId="channel" />);
    const trigger = screen.getByRole("button", { name: label });
    expect(trigger.querySelector(".tabler-icon-cloud")).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Working now" });
    expect(within(dialog).getByText(label, { exact: true })).toBeVisible();
    expect(
      within(dialog).queryByText("Only typing updates are reaching this app."),
    ).toBeNull();
    expect(dialog).not.toHaveTextContent("report.txt");
    await user.keyboard("{Escape}");
    choices = {
      ...choices,
      identities: choices.identities.map((choice) => ({
        ...choice,
        execution: "local",
      })),
    };
    f.update([]);
    expect(trigger.querySelector(".tabler-icon-cloud")).toBeNull();
  },
);

it("shows stable agent ordering, scopes humans exactly, and clears after work stops", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const props = {
    session: f.session,
    channelId: "channel",
    openActivity: () => true,
    canOpenActivity: () => true,
  };
  f.update([entry(other, secondRoot), entry(agent), entry(human)]);
  const view = render(<TypingIndicator {...props} />);
  expect(screen.getByRole("status")).not.toHaveTextContent("Human is typing");
  const trigger = screen.getByRole("button", {
    name: "Activity: 2 agents working",
  });
  await user.hover(trigger);
  const dialog = await screen.findByRole("dialog");
  const labels = () =>
    within(dialog)
      .getAllByRole("button", { name: /^View .* activity$/ })
      .map((el) => el.getAttribute("aria-label"));
  expect(labels()).toEqual(["View Agent activity", "View Other activity"]);
  f.update([entry(human), entry(agent), entry(other, secondRoot)]);
  expect(labels()).toEqual(["View Agent activity", "View Other activity"]);
  view.rerender(<TypingIndicator {...props} threadRootId={root} />);
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  view.rerender(
    <TypingIndicator {...props} threadRootId={root} audience="agents" inFlow />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Human is typing")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  f.update([]);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a non-navigable status when the plugin is unavailable and does not close after rejected navigation", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => false);
  f.update([entry()], { status: "disabled" });
  const view = render(
    <TypingIndicator session={f.session} channelId="channel" />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  let dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  expect(within(dialog).queryByRole("button")).toBeNull();
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => false}
    />,
  );
  dialog = screen.getByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: "View Agent activity" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("never chooses one thread from simultaneous work and deduplicates public and owner evidence", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)], {
    typing: [
      {
        agent,
        channelId: "channel",
        threadRootId: root,
        working: true,
        startedAt: 1,
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const dialog = await screen.findByRole("dialog");
  // Work in two threads gives one row, opening Activity without a transcript.
  expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  await user.click(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  );
  const activity = profileActivityViewTarget(agent) ?? "";
  expect(open).toHaveBeenLastCalledWith(activity, undefined);
  expect(claimProfileTranscript(activity)).toBeUndefined();
});

it("opens activity for the composer's explicit thread", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    screen.queryByRole("button", { name: "Open thread for Agent" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "View Agent activity" }));
  const activity = profileActivityViewTarget(agent) ?? "";
  expect(open).toHaveBeenLastCalledWith(activity, { rootId: root });
  expect(claimProfileTranscript(activity)).toBeDefined();
});

it("retains one explicit live region from idle through work and back to idle", () => {
  const f = fixture();
  render(<TypingIndicator session={f.session} channelId="channel" />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(status).toHaveClass("sr-only");
  f.update([entry()]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Agent is working");
  expect(within(status).queryByRole("button")).toBeNull();
  f.update([]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps another owner's self-declared agent as ordinary typing without activity actions", () => {
  const f = fixture();
  f.update([{ pubkey: human, channelId: "channel" }]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={() => true}
      canOpenActivity={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(screen.queryByRole("button")).toBeNull();
});

it.each([null, undefined])(
  "opens channel activity from its row for root %s",
  async (threadRootId) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update(
      [],
      threadRootId === null
        ? {
            typing: [
              {
                agent,
                channelId: "channel",
                threadRootId: undefined,
                working: true,
                startedAt: 1,
              },
            ],
          }
        : {
            turns: [
              {
                agent,
                channelId: "channel",
                turnId: "unknown",
                state: "working",
                timestamp: 1,
              },
            ],
          },
    );
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={open}
        canOpenActivity={() => true}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    await user.click(
      screen.getByRole("button", { name: "View Agent activity" }),
    );
    const activity = profileActivityViewTarget(agent) ?? "";
    expect(open).toHaveBeenLastCalledWith(activity, undefined);
    // Only the channel's own known session is asked for its transcript.
    expect(claimProfileTranscript(activity) !== undefined).toBe(
      threadRootId === null,
    );
    // Opening the channel already shown would do nothing.
    expect(
      screen.queryByRole("button", { name: "Open conversation for Agent" }),
    ).toBeNull();
  },
);

it.each([
  {
    execution: undefined,
    runtime: undefined,
    status: "No current step details received.",
  },
  {
    execution: "local",
    runtime: undefined,
    status: "No current step details received.",
  },
  {
    execution: "remote",
    runtime: "block.builderlab/builderlab",
    status: "Running remotely on Builderlab…",
  },
  {
    execution: "remote",
    runtime: "other/provider",
    status: "Running on a remote machine…",
  },
] as const)(
  "opens Activity without a transcript and uses the appropriate no-step fallback: $execution / $runtime",
  async ({ execution, runtime, status }) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    const base = f.session.agentChoices;
    const choices = {
      ...base.snapshot(),
      identities: base
        .snapshot()
        .identities.map((choice) =>
          choice.pubkey === agent ? { ...choice, execution, runtime } : choice,
        ),
    };
    Object.assign(f.session, {
      agentChoices: { ...base, snapshot: () => choices },
    });
    f.update([entry()], {
      turns: [
        {
          agent,
          channelId: "channel",
          turnId: "unconfirmed",
          state: "working",
          timestamp: 1,
        },
      ],
    });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={open}
        canOpenActivity={() => true}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    expect(
      within(screen.getByRole("dialog", { name: "Working now" })).getByText(
        /Work with unconfirmed thread/,
      ),
    ).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText(status)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "View Agent activity" }),
    );
    // Unconfirmed work could be anywhere, so it opens Activity, not a transcript.
    const activity = profileActivityViewTarget(agent) ?? "";
    expect(open).toHaveBeenLastCalledWith(activity, undefined);
    expect(claimProfileTranscript(activity)).toBeUndefined();
  },
);

it.each(["hover", "keyboard"])(
  "consumes %s popup Escape before the owning panel and preserves IME",
  async (mode) => {
    const f = fixture(),
      user = userEvent.setup(),
      panelKey = vi.fn();
    f.update([entry()]);
    render(
      <section aria-label="Thread" onKeyDown={panelKey}>
        <input aria-label="Composer" />
        <TypingIndicator session={f.session} channelId="channel" />
      </section>,
    );
    const input = screen.getByRole("textbox");
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    input.focus();
    if (mode === "hover") await user.hover(trigger);
    else {
      trigger.focus();
      await user.keyboard("{Enter}");
    }
    await screen.findByRole("dialog");
    panelKey.mockClear();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("dialog")).toBeVisible();
    panelKey.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelKey).not.toHaveBeenCalled();
  },
);

it("hands navigation a retained trigger instead of the disposable popup action", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const captured: (Element | null)[] = [];
  const open = vi.fn(() => {
    captured.push(document.activeElement);
    return true;
  });
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "View Agent activity" }));
  expect(captured).toEqual([trigger]);
  expect(captured[0]).toBeInTheDocument();
});

it.each(["click", "Enter", "Space"])(
  "Solo chat single-agent %s opens the popover before full Activity",
  async (activation) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update([entry()]);
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        canOpenActivity={() => true}
        openActivity={open}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    await user.hover(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Working now" }),
    ).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    if (activation === "click") await user.click(trigger);
    else {
      trigger.focus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    expect(open).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "View Agent activity" }),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      profileActivityViewTarget(agent),
      { rootId: root },
    );
    expect(
      screen.queryByRole("dialog", { name: "Working now" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  },
);

it("Solo chat multiple-agent activation keeps the chooser and unavailable Activity keeps status", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(other)]);
  const view = render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: 2 agents working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  f.update([entry()]);
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => false}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it("Solo chat ArrowDown reaches the agent row without opening Activity", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown", isComposing: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{ArrowDown}");
  const dialog = await screen.findByRole("dialog", { name: "Working now" });
  await waitFor(() => expect(dialog).toHaveFocus());
  expect(open).not.toHaveBeenCalled();
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  const activity = profileActivityViewTarget(agent) ?? "";
  expect(open).toHaveBeenCalledExactlyOnceWith(activity, { rootId: root });
  expect(claimProfileTranscript(activity)).toBeDefined();
  expect(trigger).toHaveFocus();
});

it.each([
  { team: false, local: false },
  { team: true, local: false },
  { team: false, local: true },
  { team: true, local: true },
])(
  "keeps dots alongside visible activity and after it leaves (team=$team, local=$local)",
  ({ team, local }) => {
    const f = fixture();
    const row: ChannelMessage = {
      id: "step",
      channelId: "channel",
      authorId: agent,
      audience: "agents",
      createdAt: 100,
      content: "Checking the fix",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    };
    const { audience: _audience, ...request } = row;
    const group = activityPresentation(
      [
        { ...request, id: root, authorId: human },
        { ...row, id: "first", authorId: team ? other : agent },
        row,
      ],
      undefined,
      new Set([agent]),
    ).groups[0];
    if (!group) throw new Error("Missing activity group");
    const renderFlow = (show: boolean, previousAuthor = agent) => (
      <ActivityIndicatorPresentation>
        {show && (
          <ActivityGroupPreview
            session={f.session}
            group={group}
            profiles={new Map()}
            media={() => undefined}
            expanded={false}
            onToggle={() => {}}
          />
        )}
        <TypingIndicator
          session={f.session}
          channelId="channel"
          previousAuthor={previousAuthor}
        />
      </ActivityIndicatorPresentation>
    );
    const pulses = [
      { pubkey: agent, channelId: "channel" },
      ...(team ? [{ pubkey: other, channelId: "channel" }] : []),
    ];
    const work: NonNullable<Snapshot["local"]> = local
      ? pulses.map(({ pubkey }) => ({
          scope: "test",
          agent: pubkey,
          channelId: "channel",
          messageId: root,
          threadRootId: root,
          state: "working",
          startedAt: 1,
        }))
      : [];
    f.update(pulses, { local: work });
    const view = render(renderFlow(false));
    expect(
      screen.getByRole("button", {
        name: team ? "Activity: 2 agents working" : "Activity: Agent working",
      }),
    ).toBeVisible();
    view.rerender(renderFlow(true));
    expect(
      screen.getByRole("button", { name: /Activity: .*working/ }),
    ).toBeVisible();
    expect(
      screen.getByText(
        team ? `${agent.slice(0, 10)}: Checking the fix` : "Checking the fix",
      ),
    ).toHaveAttribute("data-active", "true");
    // Recorded ownership does not make the indicator adjacent to its author.
    view.rerender(renderFlow(true, human));
    const tail = view.container.querySelector<HTMLElement>(
      "[data-conversation-activity]",
    );
    if (!tail) throw new Error("Missing conversation activity");
    expect(within(tail).getByText("Agent", { exact: true })).toBeVisible();
    view.rerender(renderFlow(true));
    if (!local) {
      f.update([...pulses, entry(agent, secondRoot)]);
      expect(
        screen.getByRole("button", {
          name: team ? "Activity: 2 agents working" : "Activity: Agent working",
        }),
      ).toBeVisible();
      expect(
        screen.getByText(
          team ? `${agent.slice(0, 10)}: Checking the fix` : "Checking the fix",
        ),
      ).toHaveAttribute("data-active", "true");
    }
    f.update(
      [{ pubkey: agent, channelId: "channel", threadRootId: secondRoot }],
      {
        local: work
          .filter((entry) => entry.agent === agent)
          .map((entry) => ({
            ...entry,
            messageId: secondRoot,
            threadRootId: secondRoot,
          })),
      },
    );
    expect(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        team ? `${agent.slice(0, 10)}: Checking the fix` : "Checking the fix",
      ),
    ).not.toHaveAttribute("data-active");
    f.update([{ pubkey: agent, channelId: "channel" }], { local: [] });
    view.rerender(renderFlow(false));
    expect(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    ).toBeVisible();
  },
);

it("groups an in-flow typing preview without repeating the preceding agent's byline", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel" }]);
  const view = render(
    <TypingIndicator
      inFlow
      previousAuthor={agent}
      session={f.session}
      channelId="channel"
    />,
  );
  expect(screen.getByRole("img", { name: "Agent" })).toBeVisible();
  expect(screen.queryByText("Agent", { exact: true })).toBeNull();
  expect(
    view.container.querySelector("[data-agent-response-preview]"),
  ).toHaveAttribute("data-stack-previous", "true");
});

it("keeps a compact in-flow continuation's avatar as its name only, not a second group avatar", async () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel" }]);
  const root = document.documentElement;
  root.dataset.messageDensity = "compact";
  try {
    render(
      <TypingIndicator
        inFlow
        previousAuthor={agent}
        session={f.session}
        channelId="channel"
      />,
    );
    // The byline is omitted, so the avatar's label still names the row.
    const avatar = screen.getByRole("img", { name: "Agent" });
    expect(avatar.parentElement).toHaveClass("sr-only");
    act(() => {
      root.dataset.messageDensity = "default";
    });
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Agent" }).parentElement,
      ).not.toHaveClass("sr-only"),
    );
  } finally {
    delete root.dataset.messageDensity;
  }
});

it("uses the agent typing bubble for a public agent outside the viewer’s choices", async () => {
  const f = fixture();
  f.update([entry("public-agent")]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Sam’s assistant working",
  });
  expect(screen.getByRole("img", { name: "Sam’s assistant" })).toBeVisible();
  expect(trigger.querySelector('[data-state="working"]')).not.toBeNull();
  await userEvent.setup().click(trigger);
  expect(
    within(await screen.findByRole("dialog")).getByText(
      "Only typing updates are reaching this app.",
    ),
  ).toBeVisible();
  for (const status of [
    "connecting",
    "interrupted",
    "disabled",
    "unavailable",
  ] as const) {
    f.update([entry("public-agent")], { status });
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Only typing updates are reaching this app.",
      ),
    ).toBeVisible();
  }
  f.update([]);
  expect(
    screen.queryByRole("button", { name: "Activity: Sam’s assistant working" }),
  ).toBeNull();
});

it.each(["done", "error", "stopped", "superseded"] as const)(
  "keeps a public agent’s %s local work terminal despite stale typing",
  (state) => {
    const f = fixture();
    const entries = [entry("public-agent"), entry(human)];
    const local = {
      agent: "public-agent",
      scope: "scope",
      channelId: "channel",
      messageId: "request",
      threadRootId: root,
      startedAt: 1,
      state: "working" as const,
    };
    f.update(entries, { local: [local] });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sam’s assistant is working",
    );
    f.update(entries, { local: [{ ...local, state }] });
    expect(
      screen.queryByRole("button", { name: /Sam’s assistant working/ }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
    expect(screen.getByRole("status")).not.toHaveTextContent("Sam’s assistant");
  },
);

it("announces split human and agent activity once from the composer", () => {
  const f = fixture();
  f.update([entry(), entry(human)]);
  render(
    <>
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        audience="agents"
        inFlow
      />
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        audience="humans"
      />
    </>,
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent is working. Human is typing",
  );
});

it.each([false, true])(
  "opens the conversation for a rootless plugin wake (stoppable=%s)",
  async (stoppable) => {
    const f = fixture();
    const user = userEvent.setup();
    const open = vi.fn(() => true);
    f.update([], {
      local: [
        {
          scope: "test",
          agent,
          channelId: "channel",
          messageId: "f".repeat(64),
          threadRootId: "f".repeat(64),
          syntheticMessage: true,
          soloChat: true,
          state: "working",
          startedAt: 1,
          ...(stoppable ? { stoppable: true } : {}),
        },
      ],
    });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        canOpenActivity={() => false}
        openActivity={open}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    await user.click(screen.getByRole("button", { name: /Open .* for Agent/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "buzz://channel/channel",
      undefined,
    );
  },
);

it("keeps dots beside a local tool step", () => {
  const f = fixture();
  f.update([], {
    local: [
      {
        scope: "test",
        agent,
        channelId: "channel",
        messageId: root,
        threadRootId: root,
        state: "working",
        startedAt: 1,
        step: { tool: "Read", target: "notes.txt" },
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
      inFlow
    />,
  );
  const trigger = screen.getByRole("button", { name: "Reading notes.txt" });
  expect(trigger).toHaveTextContent("Reading notes.txt");
  expect(trigger.querySelector('[data-state="working"]')).not.toBeNull();
});

it.each([undefined, root])(
  "lets history presenting a request's work be its one working cue, keeping other requests' cues, in scope %s",
  (threadRootId) => {
    const f = fixture();
    const work = {
      scope: "test",
      agent,
      channelId: "channel",
      messageId: root,
      threadRootId: root,
      state: "working" as const,
      startedAt: 1,
    };
    f.update([], { local: [work] });
    const row: ChannelMessage = {
      id: "step",
      channelId: "channel",
      authorId: agent,
      audience: "agents",
      ...(threadRootId ? { threadRootId } : {}),
      replyParentId: root,
      createdAt: 100,
      content: "Checking the fix",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    };
    const { audience: _audience, ...reply } = row;
    const replied = [row, { ...reply, id: "reply", content: "Still checking" }];
    const agents = new Set([agent]);
    function History({ followed }: { followed: boolean }) {
      const group = useActivityPresentation(
        followed ? replied : [row],
        f.session.agentActivity,
        agents,
      ).groups[0];
      if (!group) throw new Error("Missing activity group");
      return (
        <ActivityGroupPreview
          session={f.session}
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={false}
          onToggle={() => {}}
        />
      );
    }
    const preview = (mounted: boolean, followed = false) => (
      <ActivityIndicatorPresentation>
        {mounted && <History followed={followed} />}
        <TypingIndicator
          session={f.session}
          channelId="channel"
          threadRootId={threadRootId}
          inFlow
        />
      </ActivityIndicatorPresentation>
    );
    const cue = () =>
      screen.queryByRole("button", { name: /Activity: .*working/ });
    const dots = () => document.querySelectorAll('[data-state="working"]');
    const view = render(preview(true));
    expect(screen.getByText("Checking the fix")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(cue()).toBeNull();
    expect(dots()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Show activity history/ }),
    ).toContainElement(dots()[0] as HTMLElement);
    // The same agent's other request here has no presentation of its own.
    f.update([], {
      local: [work, { ...work, messageId: "follow-up", startedAt: 2 }],
    });
    expect(cue()).toBeVisible();
    f.update([], { local: [work] });
    expect(cue()).toBeNull();
    // Without mounted history, the conversation shows the work again.
    view.rerender(preview(false));
    expect(cue()).toBeVisible();
    view.rerender(preview(true));
    expect(cue()).toBeNull();
    // A newer message below the history leaves its dots out of view of the
    // conversation's end, so the conversation shows the work there too.
    view.rerender(preview(true, true));
    expect(cue()).toBeVisible();
    view.rerender(preview(true));
    expect(cue()).toBeNull();
    f.update([], { local: [{ ...work, state: "done" }] });
    expect(cue()).toBeNull();
    expect(dots()).toHaveLength(0);
  },
);

it("keeps a new request's thinking signal separate from old activity in the same thread", () => {
  const f = fixture();
  const old: ChannelMessage = {
    id: "old-step",
    channelId: "channel",
    authorId: agent,
    audience: "agents",
    threadRootId: root,
    replyParentId: "old-request",
    createdAt: 1,
    content: "Yesterday's work",
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
  const group = activityPresentation([old], undefined, new Set([agent]), root)
    .groups[0];
  if (!group) throw new Error("Missing old activity group");
  render(
    <ActivityIndicatorPresentation>
      <ActivityGroupPreview
        session={f.session}
        group={group}
        profiles={new Map()}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        inFlow
      />
    </ActivityIndicatorPresentation>,
  );
  const waiting = {
    scope: "test",
    agent,
    channelId: "channel",
    messageId: "new-request",
    threadRootId: root,
    state: "waiting" as const,
    startedAt: 2,
  };
  f.update([], { local: [waiting] });
  expect(
    screen
      .getByRole("button", { name: "Activity: Agent working" })
      .querySelector('[data-state="waiting"]'),
  ).not.toBeNull();
  expect(screen.getByText(old.content)).not.toHaveAttribute("data-active");
  f.update([], {
    local: [{ ...waiting, state: "working", step: { tool: "Thinking" } }],
  });
  const thinking = screen.getByRole("button", {
    name: "Thinking",
  });
  expect(thinking.querySelector('[data-state="working"]')).not.toBeNull();
  expect(screen.getByText(old.content)).not.toHaveAttribute("data-active");
  f.update([], { local: [{ ...waiting, state: "done" }] });
  expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("keeps one agent's simultaneous thread indicators independent", () => {
  const f = fixture();
  const first = {
    scope: "test",
    agent,
    channelId: "channel",
    messageId: "first-request",
    threadRootId: root,
    state: "working" as const,
    startedAt: 1,
    step: { tool: "Thinking" },
  };
  const second = {
    ...first,
    messageId: "second-request",
    threadRootId: secondRoot,
    step: { tool: "Read", target: "notes.txt" },
  };
  f.update([], { local: [first, second] });
  render(
    <ActivityIndicatorPresentation>
      <section aria-label="First thread">
        <TypingIndicator
          session={f.session}
          channelId="channel"
          threadRootId={root}
          inFlow
        />
      </section>
      <section aria-label="Second thread">
        <TypingIndicator
          session={f.session}
          channelId="channel"
          threadRootId={secondRoot}
          inFlow
        />
      </section>
    </ActivityIndicatorPresentation>,
  );
  const one = within(screen.getByRole("region", { name: "First thread" }));
  const two = within(screen.getByRole("region", { name: "Second thread" }));
  expect(one.getByRole("button", { name: "Thinking" })).toBeVisible();
  expect(one.queryByText("Reading notes.txt")).toBeNull();
  expect(two.getByRole("button", { name: "Reading notes.txt" })).toBeVisible();
  expect(two.queryByText("Thinking")).toBeNull();
  f.update([], { local: [{ ...first, state: "done" }, second] });
  expect(one.queryByRole("button")).toBeNull();
  expect(two.getByRole("button", { name: "Reading notes.txt" })).toBeVisible();
  f.update([], {
    local: [
      { ...first, state: "done" },
      { ...second, state: "done" },
    ],
  });
  expect(two.queryByRole("button")).toBeNull();
});

it("does not re-render for activity updates that leave its agents unchanged", () => {
  const f = fixture();
  const entries = [entry()];
  f.update(entries);
  const onRender = vi.fn();
  render(
    <Profiler id="typing" onRender={onRender}>
      <TypingIndicator session={f.session} channelId="channel" />
    </Profiler>,
  );
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  const renders = onRender.mock.calls.length;
  f.update(entries, { records: [], turns: [] });
  f.update(entries, { records: [], turns: [] });
  expect(onRender).toHaveBeenCalledTimes(renders);
  f.update([...entries, entry(other, secondRoot)]);
  expect(
    screen.getByRole("button", { name: "Activity: 2 agents working" }),
  ).toBeVisible();
});

it("updates the open chooser when only an agent's activity changes", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const now = Date.parse("2026-10-08T12:00:00Z");
  const turns = [
    {
      agent,
      channelId: "channel",
      turnId: "turn",
      state: "working" as const,
      timestamp: now,
    },
  ];
  f.update([], { turns });
  render(<TypingIndicator session={f.session} channelId="channel" />);
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Working now" });
  expect(within(dialog).queryByText("Reading")).toBeNull();
  // Same agent and turn; only the tool it is running changes.
  f.update([], {
    turns,
    records: [
      {
        id: "f".repeat(64),
        agent,
        createdAt: now / 1000,
        receivedAt: now,
        kind: "acp_read",
        channelIds: ["channel"],
        plaintext: JSON.stringify({
          kind: "acp_read",
          channelId: "channel",
          turnId: "turn",
          timestamp: new Date(now).toISOString(),
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call",
                status: "in_progress",
                title: "read",
                kind: "read",
              },
            },
          },
        }),
      },
    ],
  });
  expect(within(dialog).getByText("Reading", { exact: true })).toBeVisible();
});
