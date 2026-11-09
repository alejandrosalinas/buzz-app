import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createAgentActivity } from "../agents/activity";
import { createLocalAgentActivity } from "../agents/local-activity";
import { createRelaySession } from "../relay/session";
import { keypair } from "../relay/testing";
import type { ChannelMessage } from "../relay/contracts";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import { ActivityGroupActions } from "./ActivityGroupActions";
import {
  activityPresentation,
  useActivityPresentation,
  useStableRowActivity,
} from "./activity-presentation";
import { MessageRow } from "./MessageRow";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const step: ChannelMessage = {
  id: "step",
  channelId: "channel",
  threadRootId: "request",
  replyParentId: "request",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: "Checking the layout",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
function fixture() {
  const local = createLocalAgentActivity();
  const activity = createAgentActivity(
    true,
    () => {},
    () => true,
    undefined,
    undefined,
    { source: local.reader, scope: "test" },
  );
  const release = activity.queries.activate();
  return {
    local,
    activity: activity.queries,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
it("keeps a signed failure and its history in one disclosure through completion and reload", () => {
  const f = fixture();
  const { audience: _audience, ...publicStep } = step;
  const failure: ChannelMessage = {
    ...publicStep,
    id: "failure",
    createdAt: 101,
    notice: "execution-failure",
    content: "The model could not process this image.",
  };
  const rows = [step, failure];
  function Preview({ reloaded = false }: { reloaded?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const presentation = useActivityPresentation(
      rows,
      reloaded ? undefined : f.activity,
      new Set(["agent"]),
      "request",
    );
    const group = presentation.groups[0];
    if (!group) throw new Error("Missing group");
    return (
      <ActivityGroupPreview
        group={group}
        profiles={new Map()}
        media={() => undefined}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        renderHistory={(row) => <p data-message-id={row.id}>{row.content}</p>}
      />
    );
  }
  try {
    const work = f.local.begin({
      scope: "test",
      agent: "agent",
      channelId: "channel",
      messageId: "request",
      threadRootId: "request",
    });
    work.started();
    const view = render(<Preview />);
    const toggle = screen.getByRole("button", {
      name: /Show activity history/,
    });
    fireEvent.click(toggle);
    act(() => work.finish({ ok: false, error: "Provider failed" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(screen.getAllByText(failure.content)).toHaveLength(1);
    expect(screen.getByText(step.content)).toBeVisible();
    expect(screen.getByText("Couldn’t finish")).toBeVisible();
    expect(screen.queryByText("Provider failed")).toBeNull();
    fireEvent.click(toggle);
    view.rerender(<Preview reloaded />);
    expect(screen.getByText("Couldn’t finish")).toBeVisible();
    expect(screen.queryByText(failure.content)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(failure.content)).toHaveAttribute(
      "data-message-id",
      "failure",
    );
  } finally {
    f.dispose();
  }
});

it.each(["timeline", "thread"] as const)(
  "attributes an expanded failure to its author in multi-participant %s history",
  (layout) => {
    const { audience: _audience, ...publicStep } = step;
    const helper = {
      ...step,
      id: "helper-step",
      authorId: "helper",
      content: "Helper reading files",
      createdAt: 101,
    };
    const failure: ChannelMessage = {
      ...publicStep,
      id: "failure",
      notice: "execution-failure",
      content: "Provider unavailable",
      createdAt: 102,
    };
    const profiles = new Map([
      ["agent", { name: "Agent", isAgent: true as const }],
      ["helper", { name: "Helper", isAgent: true as const }],
    ]);
    function Preview({ multiple }: { multiple: boolean }) {
      const rows = multiple ? [step, helper, failure] : [step, failure];
      const presentation = activityPresentation(
        rows,
        undefined,
        new Set(profiles.keys()),
      );
      const stable = useStableRowActivity();
      const group = presentation.groups[0];
      if (!group) throw new Error("Missing group");
      return (
        <ActivityGroupPreview
          group={group}
          profiles={profiles}
          media={() => undefined}
          layout={layout}
          expanded
          onToggle={() => {}}
          renderHistory={(row) => (
            <MessageRow
              row={row}
              recordedActivity={stable.activity(
                row.id,
                presentation.byRow.get(row.id),
                "history",
              )}
              profile={profiles.get(row.authorId)}
              layout={layout}
              stackPrevious
              stackNext
              media={() => undefined}
              onOpenLink={() => false}
              day={false}
              retry={undefined}
            />
          )}
        />
      );
    }
    const view = render(<Preview multiple />);
    const author = () => {
      const row = screen
        .getByText(failure.content)
        .closest("[data-message-id]");
      if (!row) throw new Error("Missing failure row");
      return within(row as HTMLElement).getByText("Agent", {
        selector: "strong",
      });
    };
    expect(author().closest(".sr-only")).toBeNull();
    expect(author().closest("[data-stack-previous]")).toBeNull();
    expect(author().closest("[data-stack-next]")).toBeNull();
    view.rerender(<Preview multiple={false} />);
    expect(author().closest(".sr-only")).not.toBeNull();
    view.rerender(<Preview multiple />);
    expect(author().closest(".sr-only")).toBeNull();
  },
);

it("keeps a signed failure authoritative when telemetry is uncertain and leaves passive history neutral", () => {
  const f = fixture();
  const request = "e".repeat(64);
  const update = { ...step, threadRootId: request, replyParentId: request };
  const { audience: _audience, ...publicStep } = update;
  const failure: ChannelMessage = {
    ...publicStep,
    id: "failure",
    createdAt: 101,
    notice: "execution-failure",
    content: "The selected model could not complete this request.",
  };
  const snapshot = {
    ...f.activity.snapshot(),
    turns: [
      {
        agent: "agent",
        turnId: "turn",
        channelId: "channel",
        timestamp: 0,
        state: "unknown" as const,
        triggeringEventIds: [request],
        threadRootId: request,
      },
    ],
  };
  try {
    const quiet = activityPresentation(
      [update],
      snapshot,
      new Set(["agent"]),
      request,
    ).groups[0];
    expect(quiet?.outcomes).toEqual([]);
    const group = activityPresentation(
      [update, failure],
      snapshot,
      new Set(["agent"]),
      request,
    ).groups[0];
    if (!group) throw new Error("Missing signed failure group");
    expect(group.outcomes).toEqual([
      { agent: "agent", state: "error", reason: failure.content },
    ]);
    render(
      <ActivityGroupPreview
        group={group}
        profiles={new Map()}
        media={() => undefined}
        expanded
        onToggle={() => {}}
        renderHistory={(row) => <p>{row.content}</p>}
      />,
    );
    expect(screen.getByText("Couldn’t finish")).toBeVisible();
    expect(screen.queryByText("Status unavailable")).toBeNull();
    expect(screen.getByText(failure.content)).toBeVisible();
  } finally {
    f.dispose();
  }
});

it("shows failed and stopped participants independently without attributing sibling work", () => {
  const f = fixture();
  const rows = [step, { ...step, id: "helper-step", authorId: "helper" }];
  try {
    f.local
      .begin({
        scope: "test",
        agent: "agent",
        channelId: "channel",
        messageId: "request",
        threadRootId: "request",
      })
      .finish({ ok: false, error: "Unavailable" });
    f.local
      .begin({
        scope: "test",
        agent: "helper",
        channelId: "channel",
        messageId: "request",
        threadRootId: "request",
      })
      .finish({ ok: true, stopped: true });
    f.local
      .begin({
        scope: "test",
        agent: "agent",
        channelId: "channel",
        messageId: "sibling",
        threadRootId: "request",
      })
      .started();
    const group = activityPresentation(
      rows,
      f.activity.snapshot(),
      new Set(["agent", "helper"]),
      "request",
    ).groups[0];
    if (!group) throw new Error("Missing group");
    render(
      <ActivityGroupPreview
        group={group}
        profiles={new Map()}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("Couldn’t finish")).toBeVisible();
    expect(screen.getByText("Stopped")).toBeVisible();
    expect(screen.queryByText("Checking the layout")).toBeNull();
    expect(group.working).toBe(false);
    expect(group.ids).toEqual([step.id, "helper-step"]);
  } finally {
    f.dispose();
  }
});

it.each(["signed failure", "failed update", "working update"])(
  "keeps the working participant named beside a failure when the latest row is a %s",
  (latest) => {
    const f = fixture();
    const helperStep = {
      ...step,
      id: "helper-step",
      authorId: "helper",
      createdAt: 101,
      content: "Helper reading files",
    };
    const { audience: _audience, ...publicStep } = step;
    const last: ChannelMessage =
      latest === "signed failure"
        ? {
            ...publicStep,
            id: "failure",
            createdAt: 102,
            notice: "execution-failure",
            content: "Provider unavailable",
          }
        : {
            ...(latest === "working update" ? helperStep : step),
            id: "latest-step",
            createdAt: 102,
            content:
              latest === "working update"
                ? "Helper checking results"
                : "Agent checking results",
          };
    const rows = [step, helperStep, last];
    const preview =
      latest === "working update" ? last.content : helperStep.content;
    function Preview() {
      const presentation = useActivityPresentation(
        rows,
        f.activity,
        new Set(["agent", "helper"]),
        "request",
      );
      const group = presentation.groups[0];
      if (!group) throw new Error("Missing group");
      return (
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={false}
          onToggle={() => {}}
        />
      );
    }
    try {
      f.local
        .begin({
          scope: "test",
          agent: "agent",
          channelId: "channel",
          messageId: "request",
          threadRootId: "request",
        })
        .finish({ ok: false, error: "Provider unavailable" });
      const helper = f.local.begin({
        scope: "test",
        agent: "helper",
        channelId: "channel",
        messageId: "request",
        threadRootId: "request",
      });
      helper.started();
      const view = render(<Preview />);
      expect(screen.getByText("Couldn’t finish")).toBeVisible();
      expect(screen.getByText(`helper: ${preview}`)).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(
        screen.getByRole("button", {
          name: `Show activity history: agent: Couldn’t finish; helper: still working — ${preview}`,
        }),
      ).toBeVisible();
      expect(screen.queryByText("Provider unavailable")).toBeNull();
      act(() => helper.finish({ ok: true }));
      expect(screen.getByText("Couldn’t finish")).toBeVisible();
      expect(view.container.querySelector("[data-active]")).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Show activity history: agent: Couldn’t finish",
        }),
      ).toBeVisible();
    } finally {
      f.dispose();
    }
  },
);

it.each([
  "ordinary reply",
  "unlinked",
  "other author",
  "other request",
  "other thread",
  "another day",
  "edited",
  "attachment",
])("keeps %s outside the signed failure disclosure", (variant) => {
  const { audience: _audience, ...publicStep } = step;
  const failure: ChannelMessage = {
    ...publicStep,
    id: "failure",
    createdAt: 101,
    ...(variant === "ordinary reply"
      ? {}
      : { notice: "execution-failure" as const }),
    ...(variant === "unlinked" ? { replyParentId: undefined } : {}),
    ...(variant === "other author" ? { authorId: "outside" } : {}),
    ...(variant === "other request" ? { replyParentId: "sibling" } : {}),
    ...(variant === "other thread" ? { threadRootId: "sibling" } : {}),
    ...(variant === "another day" ? { createdAt: 86501 } : {}),
    ...(variant === "edited" ? { edited: true } : {}),
    ...(variant === "attachment"
      ? {
          attachments: [
            {
              url: "https://relay.test/media/result.png",
              kind: "image" as const,
            },
          ],
        }
      : {}),
  };
  const group = activityPresentation(
    [step, failure],
    undefined,
    new Set(["agent", "outside"]),
    "request",
  ).groups[0];
  expect(group?.ids).toEqual([step.id]);
  expect(group?.outcomes).toEqual([]);
});
it("keeps a dispatch readable after its sender finishes, while the helper works and after reload", () => {
  const f = fixture();
  try {
    const dispatch = {
      ...step,
      content: "@helper check the layout",
      mentions: ["helper"],
    };
    const { audience: _audience, ...publicStep } = step;
    const rows = [
      dispatch,
      { ...publicStep, id: "reply", content: "Status update", createdAt: 101 },
    ];
    function Preview({ reloaded = false }: { reloaded?: boolean }) {
      const [expanded, setExpanded] = useState(false);
      const presentation = useActivityPresentation(
        rows,
        reloaded ? undefined : f.activity,
        new Set(["agent", "helper"]),
        "request",
      );
      const group = presentation.groups[0];
      if (!group) throw new Error("Missing activity group");
      return (
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          renderHistory={(row) => <p>{row.content}</p>}
        />
      );
    }
    const work = f.local.begin({
      scope: "test",
      agent: "agent",
      channelId: "channel",
      messageId: "request",
      threadRootId: "request",
    });
    work.started();
    const view = render(<Preview />);
    const toggle = screen.getByRole("button", {
      name: /Show activity history/,
    });
    expect(toggle).toBeVisible();
    act(() => {
      f.local
        .begin({
          scope: "test",
          agent: "helper",
          channelId: "channel",
          messageId: dispatch.id,
          threadRootId: "request",
        })
        .started();
      work.finish({ ok: true });
    });
    expect(toggle).toBeVisible();
    fireEvent.click(toggle, { detail: 0 });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(dispatch.content, { selector: "p" })).toBeVisible();
    fireEvent.click(toggle, { detail: 0 });
    view.rerender(<Preview reloaded />);
    const restored = screen.getByRole("button", {
      name: /Show activity history/,
    });
    expect(restored).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(restored, { detail: 0 });
    expect(screen.getByText(dispatch.content, { selector: "p" })).toBeVisible();
  } finally {
    f.dispose();
  }
});
it("shimmers a standalone working step and stops when that request finishes", () => {
  const f = fixture();
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  try {
    const work = f.local.begin({
      scope: "test",
      agent: "agent",
      channelId: "channel",
      messageId: "request",
      threadRootId: "request",
    });
    work.started();
    function Preview() {
      const presentation = useActivityPresentation(
        [step],
        f.activity,
        new Set(["agent"]),
        step.threadRootId,
      );
      return (
        <MessageRow
          row={step}
          recordedActivity={presentation.byRow.get(step.id)}
          session={{ ...owner.session, agentActivity: f.activity }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    }
    render(<Preview />);
    expect(screen.getByText(step.content)).toHaveAttribute(
      "data-active",
      "true",
    );
    act(() => work.finish({ ok: true }));
    expect(screen.getByText(step.content)).not.toHaveAttribute("data-active");
  } finally {
    owner.dispose();
    f.dispose();
  }
});

it("opens contained history and keeps focus on the collapse control", () => {
  const history = [
    step,
    {
      ...step,
      id: "helper-step",
      authorId: "helper",
      content: "Checking the helper layout",
    },
  ];
  const presentation = activityPresentation(
    history,
    undefined,
    new Set(["agent", "helper"]),
  );
  const group = presentation.groups[0];
  function Preview() {
    const [expanded, setExpanded] = useState(false);
    if (!group) throw new Error("Missing activity group");
    return (
      <div data-activity-history-scope="">
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          renderHistory={(row) => {
            const activity = presentation.byRow.get(row.id);
            if (!activity) throw new Error("Missing history presentation");
            return (
              <MessageRow
                key={row.id}
                row={row}
                recordedActivity={{ ...activity, container: "history" }}
                profile={undefined}
                media={() => undefined}
                onOpenLink={() => false}
                day={false}
                retry={undefined}
              />
            );
          }}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      </div>
    );
  }
  render(<Preview />);
  const toggle = screen.getByRole("button", { name: /Show activity history/ });
  fireEvent.click(toggle, { detail: 0 });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveFocus();
  expect(screen.getByText("Checking the layout")).toBeVisible();
  expect(screen.getByText("Checking the helper layout")).toBeVisible();
  fireEvent.click(toggle, { detail: 0 });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
  expect(screen.queryByText("Checking the layout")).toBeNull();
});

it("keeps the primary avatar on the activity bubble without repeating an anchored byline", () => {
  const history = [{ ...step, id: "one" }, step];
  const renderGroup = (rows: ChannelMessage[]) => {
    const group = activityPresentation(rows, undefined, new Set(["agent"]))
      .groups[0];
    if (!group) throw new Error("Missing group");
    return (
      <ActivityGroupPreview
        group={group}
        profiles={new Map([["agent", { name: "Studio assistant" }]])}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />
    );
  };
  const view = render(renderGroup(history));
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
  const { audience: _, ...reply } = step;
  view.rerender(renderGroup([{ ...reply, id: "reply" }, ...history]));
  expect(screen.queryByText("Studio assistant", { exact: true })).toBeNull();
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...step, id: "one" },
      { ...step, authorId: "helper" },
    ]),
  );
  expect(
    screen.getByRole("img", { name: "Studio assistant, helper" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Show activity history: helper:/ }),
  ).toBeVisible();
  expect(screen.getByText(/helper: Checking the layout/)).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...reply, id: "user", authorId: "human" },
      ...history,
    ]),
  );
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
});

it("uses channel-qualified names for the excerpt and participant avatars", () => {
  const primary = keypair().pubkey;
  const helper = keypair().pubkey;
  const owner = createRelaySession(null);
  const profiles = new Map([
    [primary, { name: "Honey", isAgent: true as const }],
    [helper, { name: "Honey", isAgent: true as const }],
  ]);
  const names = bindNames(
    {
      profiles: { ...owner.session.profiles, snapshot: () => profiles },
      agentLibrary: owner.session.agentLibrary,
    },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const channelList = {
    status: "ready" as const,
    channels: [
      { id: step.channelId, name: "Team", members: [primary, helper] },
    ],
  };
  const session = {
    ...owner.session,
    names,
    channels: {
      ...owner.session.channels,
      list: () => channelList,
    },
  };
  const group = activityPresentation(
    [
      { ...step, id: "first", authorId: primary },
      { ...step, id: "second", authorId: helper },
    ],
    undefined,
    new Set([primary, helper]),
  ).groups[0];
  if (!group) throw new Error("Missing group");
  const first = names.resolve(primary, "Honey", [primary, helper]);
  const second = names.resolve(helper, "Honey", [primary, helper]);
  expect(first).not.toBe(second);
  try {
    render(
      <ActivityGroupPreview
        session={session}
        group={group}
        profiles={profiles}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `Show activity history: ${second}: ${step.content}`,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: `${first}, ${second}` }),
    ).toBeVisible();
    expect(screen.getByText(`${second}: ${step.content}`)).toBeVisible();
  } finally {
    cleanup();
    names.dispose();
    owner.dispose();
  }
});

it("follows live work for collapsed request controls only once they are shown", () => {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  try {
    const subscribe = vi.fn(owner.session.agentActivity.subscribe);
    const session = {
      ...owner.session,
      agentActivity: { ...owner.session.agentActivity, subscribe },
    };
    const group = activityPresentation([step], undefined, new Set(["agent"]))
      .groups[0];
    if (!group) throw new Error("Missing activity group");
    const view = render(
      <ActivityGroupActions
        session={session}
        group={group}
        profiles={new Map()}
        returnFocus={{ current: null }}
        active={false}
      />,
    );
    expect(subscribe).not.toHaveBeenCalled();
    view.rerender(
      <ActivityGroupActions
        session={session}
        group={group}
        profiles={new Map()}
        returnFocus={{ current: null }}
        active
      />,
    );
    expect(subscribe).toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});
