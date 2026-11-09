// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { StrictMode } from "react";
import { localAgentsFixture } from "../../features/agents/local-testing";
import type { RelaySession } from "../../features/relay/session";
import { MentionPicker } from "./MentionPicker";
import { MentionCompletion } from "./MentionCompletion";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import type {
  ComposerCompletion,
  ComposerObservation,
} from "../../features/conversation/contracts";
import type { CompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { Contribution } from "../../plugins/contributions";
import { mentionQuery } from "./mention-query";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import type { CompletionResult } from "../../features/conversation/contracts";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import type { LocalAgentsSnapshot } from "../../features/agents/local";
import {
  followupDraft,
  type MentionRecipient,
} from "../../features/messages/mention-draft";
import { createMessages } from "../../features/relay/messages";
import type { Outbox } from "../../features/relay/outbox";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { profileTarget } from "../../features/profiles/target";
import { npubEncode } from "nostr-tools/nip19";
import { fetchMentionDirectoryPage } from "./useMentionDirectory";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import {
  resolveSpaceMention,
  type SpaceMentionResolution,
} from "./resolve-space-mention";
import { MENTION_RESOLVE_TIMEOUT_MS } from "../../features/conversation/completion";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import type { RelayEvent } from "../../features/relay/events";
import {
  PROFILE_CACHE_BASE,
  PROFILE_CACHE_MAX,
} from "../../features/relay/budget";
import {
  keypair,
  profile,
  unsignedProfiles,
} from "../../features/relay/testing";
// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
// A person row's accessible name is its label then its detail line (no key).
// The lines are separate elements, so the gap between them may be empty.
const rowName = (label: string, detail = "") => {
  const escapeText = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Agent rows also announce "Agent" after the name.
  return new RegExp(
    `^${escapeText(label)}(?:\\s*Agent)?\\s*${escapeText(detail)}$`,
  );
};
// Which of these labelled rows are shown, in the order they appear.
const rowsInOrder = (labels: readonly string[]) =>
  labels
    .flatMap((label) =>
      screen
        .queryAllByRole("button", { name: rowName(label) })
        .map((button) => ({ button, label })),
    )
    .sort((a, b) =>
      a.button.compareDocumentPosition(b.button) &
      Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    )
    .map(({ label }) => label);
function setup(parent: boolean | null = true, archived = false) {
  const key = "b".repeat(64),
    member = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: key, name: "Outside agent" }],
  }));
  const list = {
    status: "ready",
    channels:
      parent === null
        ? []
        : [
            {
              id: "parent",
              channelType: parent ? "stream" : "solo",
              members: [member],
              archived,
            },
          ],
  };
  const profiles = new Map([[member, { name: "Member" }]]);
  const listeners = new Set<() => void>();
  let archiveSnapshot: ReturnType<RelaySession["archives"]["snapshot"]> = {
    status: "ready",
    archived: [],
  };
  const setArchived = (archived: string[]) => {
    archiveSnapshot = { status: "ready", archived };
    for (const listener of listeners) listener();
  };
  const session = {
    unread: undefined,
    directMessages: {
      people: vi.fn(async () => ({ people: [], hasMore: false })),
    },
    archives: {
      snapshot: () => archiveSnapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
      refresh: async () => {},
      state: (pubkey: string) =>
        archiveSnapshot.status !== "ready"
          ? ("unknown" as const)
          : archiveSnapshot.archived.includes(pubkey)
            ? ("archived" as const)
            : ("not-archived" as const),
    },
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    names: {
      subscribe: () => () => {},
      snapshot: () => 0,
      resolve: (_key: string, fallback: string) => fallback,
      scope: () => () => undefined,
    },
    agentLibrary: library.queries,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    media: () => undefined,
  } as unknown as RelaySession;
  return { session, library, key, member, profiles, setArchived };
}
it("uses the same alphabetical and prefix ordering for typed and button mentions", async () => {
  const test = setup();
  const keys = ["c", "d", "e"].map((key) => key.repeat(64));
  const names = ["Zoe", "Adam Avery", "Avery"];
  const profiles = new Map(
    keys.map((key, index) => [key, { name: names[index] ?? key }]),
  );
  const list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      { id: "parent", name: "Parent", channelType: "stream", members: keys },
    ],
  };
  const session = {
    ...test.session,
    channels: { ...test.session.channels, list: () => list },
    profiles: { ...test.session.profiles, snapshot: () => profiles },
  } satisfies RelaySession;
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const completionNames = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    );
  await waitFor(() =>
    expect(completionNames()).toEqual(["Adam Avery", "Avery", "Zoe"]),
  );
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 6, query: "avery" }}
    />,
  );
  await waitFor(() =>
    expect(completionNames()).toEqual(["Avery", "Adam Avery"]),
  );
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const pickerNames = () => rowsInOrder(names);
  expect(pickerNames()).toEqual(["Adam Avery", "Avery", "Zoe"]);
  await user.type(screen.getByRole("searchbox"), "avery");
  expect(pickerNames()).toEqual(["Avery", "Adam Avery"]);
  test.library.dispose();
});
it("offers outside agents in the Solo chat mention picker while ordinary channel pickers keep their roster", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: /^Outside agent/ }),
  ).not.toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(await outsideRow());
  expect(select).toHaveBeenCalledWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  view.unmount();
  test.library.dispose();
});
it("marks agents, not people, in both mention menus", async () => {
  const test = setup();
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={test.session}
      scope="test"
      channelId="parent"
      inviteAgents
      observation={{ revision: 1, text: "@", start: 1, end: 1 }}
      query={{ start: 0, end: 1, query: "" }}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        ({ label, agent }) => [label, agent],
      ),
    ).toEqual([
      ["Member", false],
      ["Outside agent", true],
    ]),
  );
  view.unmount();
  render(
    <MentionPicker
      scope="test"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    await screen.findByRole("button", {
      name: /^Outside agent\s*Agent\s*Adds to channel when you send$/,
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /^Member$/ })).toBeVisible();
  test.library.dispose();
});
it.each(["completion", "picker"] as const)(
  "updates remote %s cues from the shared inventory without changing recipients",
  async (surface) => {
    const test = setup();
    const lifetime = new AbortController();
    const owner = "f".repeat(64);
    const relayUrl = "https://relay.example";
    const remote = {
      pubkey: "c".repeat(64),
      name: "Cloud agent",
      owner,
      relayUrl,
      runtime: "block.builderlab/builderlab",
    };
    const local = { ...remote, pubkey: "d".repeat(64), name: "Device agent" };
    const channel = test.session.channels.list().channels[0];
    if (!channel) throw new Error("Missing fixture channel");
    Object.assign(channel, {
      members: [test.member, remote.pubkey],
    });
    const native = localAgentsFixture([local]);
    native.set({ hosted: [remote] });
    const agentChoices = createAgentChoices({
      scope: `${relayUrl}:${owner}`,
      library: test.library.queries,
      native,
      signal: lifetime.signal,
    });
    const publish = vi.fn();
    const select = vi.fn(() => true);
    const session = { ...test.session, agentChoices };
    const view = render(
      surface === "completion" ? (
        <MentionCompletion
          session={session}
          scope="test"
          channelId="parent"
          inviteAgents
          observation={{ revision: 1, text: "@", start: 1, end: 1 }}
          query={{ start: 0, end: 1, query: "" }}
          publish={publish}
        />
      ) : (
        <MentionPicker
          session={session}
          scope="test"
          channelId="parent"
          inviteAgents
          disabled={false}
          select={select}
        />
      ),
    );
    const item = (key: string) =>
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.find(
        (row) => row.id === key,
      );
    try {
      if (surface === "picker")
        await userEvent
          .setup()
          .click(screen.getByRole("button", { name: "Mention a member" }));
      if (surface === "completion") {
        await waitFor(() => expect(item(remote.pubkey)?.detail).toBe("Remote"));
        expect(item(remote.pubkey)?.edit).toEqual({
          mention: { pubkey: remote.pubkey, name: remote.name },
        });
        expect(item(local.pubkey)?.detail).toBe("Adds to channel");
        await waitFor(() =>
          expect(item(test.key)?.detail).toBe("Adds to channel"),
        );
      } else {
        expect(
          await screen.findByRole("button", {
            name: rowName(remote.name, "Remote"),
          }),
        ).toBeVisible();
        expect(
          screen.getByRole("button", {
            name: rowName(local.name, "Adds to channel when you send"),
          }),
        ).toBeVisible();
        expect(
          await screen.findByRole("button", {
            name: rowName("Outside agent", "Adds to channel when you send"),
          }),
        ).toBeVisible();
      }
      act(() =>
        native.set({ hosted: [{ ...remote, runtime: "other/provider" }] }),
      );
      if (surface === "completion")
        await waitFor(() => expect(item(remote.pubkey)?.detail).toBe("Remote"));
      else {
        await userEvent.setup().click(
          await screen.findByRole("button", {
            name: rowName(remote.name, "Remote"),
          }),
        );
        expect(select).toHaveBeenCalledWith({
          pubkey: remote.pubkey,
          name: remote.name,
        });
      }
    } finally {
      view.unmount();
      lifetime.abort();
      test.library.dispose();
    }
  },
);

function renderAudiencePicker(
  test: ReturnType<typeof setup>,
  recipients: readonly { pubkey: string; name: string }[],
) {
  const only = vi.fn(),
    toggle = vi.fn(),
    focusDraft = vi.fn(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      audience={{ recipients, named: false, only, toggle }}
      select={select}
      focusDraft={focusDraft}
    />,
  );
  return { view, only, toggle, focusDraft, select };
}
const outsideRow = () =>
  screen.findByRole("button", {
    name: rowName("Outside agent", "Adds to channel when you send"),
  });

it("an agents-only audience pill replaces the mention button and never inserts a mention", async () => {
  const test = setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view, select } = renderAudiencePicker(test, [agent]);
  const pill = screen.getByRole("button", {
    name: "Sending to Outside agent. Change agents",
  });
  expect(screen.queryByRole("button", { name: "Mention a member" })).toBeNull();
  await userEvent.setup().click(pill);
  await outsideRow();
  expect(select).not.toHaveBeenCalled();
  view.unmount();
  test.library.dispose();
});

it("clicking an agent row in the pill menu toggles that agent and keeps the menu open", async () => {
  const test = setup(),
    user = userEvent.setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view, only, toggle } = renderAudiencePicker(test, []);
  await user.click(screen.getByRole("button", { name: "Choose agent" }));
  await user.click(await outsideRow());
  expect(toggle).toHaveBeenCalledExactlyOnceWith(agent);
  expect(only).not.toHaveBeenCalled();
  expect(screen.getByRole("searchbox")).toBeInTheDocument();
  view.unmount();
  test.library.dispose();
});

it("with one agent addressed, its row shows a check and is pressed, not filled", async () => {
  const test = setup(),
    user = userEvent.setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view } = renderAudiencePicker(test, [agent]);
  await user.click(
    screen.getByRole("button", {
      name: "Sending to Outside agent. Change agents",
    }),
  );
  const row = await outsideRow();
  expect(row).not.toHaveAttribute("data-selected");
  expect(row).toHaveAttribute("aria-pressed", "true");
  expect(row.querySelector("svg")).not.toBeNull();
  view.unmount();
  test.library.dispose();
});

it("with several agents addressed, the pill is a menu button and each addressed row shows a check", async () => {
  const test = setup(),
    user = userEvent.setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view } = renderAudiencePicker(test, [
    agent,
    { pubkey: "c".repeat(64), name: "Another" },
  ]);
  await user.click(
    screen.getByRole("button", {
      name: "Sending to Outside agent, Another. Change agents",
    }),
  );
  const row = await outsideRow();
  expect(row).not.toHaveAttribute("data-selected");
  expect(row).toHaveAttribute("aria-pressed", "true");
  expect(row.querySelector("svg")).not.toBeNull();
  view.unmount();
  test.library.dispose();
});

it("picking an addressed row while several agents are addressed toggles it", async () => {
  const test = setup(),
    user = userEvent.setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view, toggle } = renderAudiencePicker(test, [
    agent,
    { pubkey: "c".repeat(64), name: "Another" },
  ]);
  await user.click(
    screen.getByRole("button", {
      name: "Sending to Outside agent, Another. Change agents",
    }),
  );
  await user.click(await outsideRow());
  expect(toggle).toHaveBeenCalledExactlyOnceWith(agent);
  expect(screen.getByRole("searchbox")).toBeInTheDocument();
  view.unmount();
  test.library.dispose();
});

it("closing the pill menu resumes typing in the draft, unless the click went elsewhere", async () => {
  const test = setup(),
    user = userEvent.setup();
  const { view, focusDraft } = renderAudiencePicker(test, []);
  const pill = screen.getByRole("button", { name: "Choose agent" });
  await user.click(pill);
  await outsideRow();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  await waitFor(() => expect(focusDraft).toHaveBeenCalledOnce());
  await user.click(pill);
  await outsideRow();
  await user.click(document.body);
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  expect(focusDraft).toHaveBeenCalledOnce();
  view.unmount();
  test.library.dispose();
});

it("the pill changing shape while its menu is open leaves focus in the menu", async () => {
  const test = setup(),
    user = userEvent.setup(),
    focusDraft = vi.fn();
  const picker = (recipients: readonly { pubkey: string; name: string }[]) => (
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      audience={{ recipients, named: false, only: vi.fn(), toggle: vi.fn() }}
      select={() => true}
      focusDraft={focusDraft}
    />
  );
  const agent = { pubkey: test.key, name: "Outside agent" };
  const view = render(picker([agent]));
  await user.click(
    screen.getByRole("button", {
      name: "Sending to Outside agent. Change agents",
    }),
  );
  await outsideRow();
  view.rerender(picker([agent, { pubkey: "c".repeat(64), name: "Another" }]));
  await outsideRow();
  expect(focusDraft).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(focusDraft).toHaveBeenCalledOnce());
  view.unmount();
  test.library.dispose();
});

it("the pill menu highlights a row only while the pointer is on it", async () => {
  const test = setup(),
    user = userEvent.setup();
  const { view } = renderAudiencePicker(test, []);
  await user.click(screen.getByRole("button", { name: "Choose agent" }));
  const row = await outsideRow();
  expect(row).not.toHaveAttribute("data-highlighted");
  const move = (clientX: number) =>
    fireEvent.pointerMove(row, { pointerType: "mouse", clientX, clientY: 4 });
  move(4);
  move(6);
  expect(row).toHaveAttribute("data-highlighted");
  // Rows are the list's id plus their key; leave the list itself.
  const list = document.getElementById(row.id.replace(/-person:.*$/, ""));
  if (!list) throw new Error("Missing choice list");
  fireEvent.pointerLeave(list, { pointerType: "mouse" });
  expect(row).not.toHaveAttribute("data-highlighted");
  view.unmount();
  test.library.dispose();
});

it("in the pill menu, Enter on a row toggles that agent and keeps the menu open", async () => {
  const test = setup(),
    user = userEvent.setup(),
    agent = { pubkey: test.key, name: "Outside agent" };
  const { view, toggle } = renderAudiencePicker(test, []);
  await user.click(screen.getByRole("button", { name: "Choose agent" }));
  const row = await outsideRow();
  row.focus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveBeenCalledExactlyOnceWith(agent);
  expect(screen.getByRole("searchbox")).toBeInTheDocument();
  view.unmount();
  test.library.dispose();
});

it("an audience pill says so when the message's own mentions decide", async () => {
  const test = setup(false),
    user = userEvent.setup();
  const agent = { pubkey: test.key, name: "Outside agent" };
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      audience={{
        recipients: [agent],
        named: true,
        only: vi.fn(),
        toggle: vi.fn(),
      }}
      select={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", {
      name: "Sending to Outside agent. Change agents",
    }),
  );
  expect(
    await screen.findByText(
      "Your message tags Outside agent, so picks here add or remove tags.",
    ),
  ).toBeInTheDocument();
  view.unmount();
  test.library.dispose();
});

it("a disabled composer disables the audience pill", () => {
  const test = setup(false);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled
      inviteAgents
      audience={{
        recipients: [],
        named: false,
        only: vi.fn(),
        toggle: vi.fn(),
      }}
      select={() => true}
    />,
  );
  expect(screen.getByRole("button", { name: "Choose agent" })).toBeDisabled();
  view.unmount();
  test.library.dispose();
});
function completionLabels(publish: ReturnType<typeof vi.fn>) {
  return (
    publish.mock.lastCall?.[0] as CompletionResult | undefined
  )?.items.map((item) => item.label);
}
const emptyCompletion = {
  scope: "test",
  channelId: "parent",
  observation: { revision: 1, text: "@", start: 1, end: 1 },
  query: { start: 0, end: 1, query: "" },
};
it.each([false, true])(
  "waits for members before installing directory or agent choices (invite=%s)",
  async (invite) => {
    const test = setup();
    await test.library.queries.refresh();
    let list: ReturnType<RelaySession["channels"]["list"]> = {
      status: "loading",
      channels: [{ id: "parent", name: "Parent", channelType: "stream" }],
    };
    const listeners = new Set<() => void>();
    const people = vi.fn(async () => ({
      people: [{ pubkey: test.key, name: "Outside person" }],
      hasMore: false,
    }));
    const session = {
      ...test.session,
      channels: {
        ...test.session.channels,
        list: () => list,
        subscribeList(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      directMessages: { ...test.session.directMessages, people },
    };
    const publish = vi.fn();
    const view = render(
      <MentionCompletion
        {...emptyCompletion}
        session={session}
        inviteAgents={invite}
        publish={publish}
      />,
    );
    try {
      if (!invite) {
        await waitFor(() => expect(people).toHaveBeenCalledOnce());
        // Finish the directory read while membership remains held.
        await act(async () => {
          await people.mock.results[0]?.value;
        });
      }
      expect(completionLabels(publish)).toEqual([]);
      act(() => {
        list = {
          status: "ready",
          channels: [
            {
              id: "parent",
              name: "Parent",
              channelType: "stream",
              members: [test.member],
            },
          ],
        };
        for (const listener of listeners) listener();
      });
      expect(completionLabels(publish)).toEqual([
        "Member",
        invite ? "Outside agent" : "Outside person",
      ]);
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);
it("offers a known member for Tab while agents load, then appends late agents", async () => {
  const test = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async () => {
    await gate;
    return {
      definitions: [],
      identities: [{ pubkey: test.key, name: "Aaron agent" }],
    };
  });
  const library = createAgentLibrary(read);
  const session = {
    ...test.session,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  };
  const publish = vi.fn();
  const result = () => publish.mock.lastCall?.[0] as CompletionResult;
  const props = { ...emptyCompletion, session, inviteAgents: true, publish };
  const view = render(<MentionCompletion {...props} />);
  try {
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(session.agentChoices.snapshot().status).toBe("loading");
    expect(completionLabels(publish)).toEqual(["Member"]);
    expect(result().items[0]?.canSelect?.("Tab")).toBe(true);
    view.rerender(
      <MentionCompletion
        {...props}
        query={{ start: 0, end: 7, query: "Member" }}
      />,
    );
    expect(completionLabels(publish)).toEqual(["Member"]);
    expect(result().items[0]?.canSelect?.("Tab")).toBe(true);
    expect(result().spaceId).toBeUndefined();
    for (const key of [" ", ",", "’"])
      expect(result().items[0]?.canSelect?.(key), key).toBe(false);
    view.rerender(<MentionCompletion {...props} />);
    await act(async () => release());
    await waitFor(() =>
      expect(completionLabels(publish)).toEqual(["Member", "Aaron agent"]),
    );
    expect(result().items[1]?.canSelect?.("Tab")).toBe(true);
  } finally {
    await act(async () => release());
    view.unmount();
    library.dispose();
    test.library.dispose();
  }
});
it("offers the viewer's own unmanaged agent outside a stream before directory people", async () => {
  const test = setup();
  // Remote agent setup refreshes agent choices after creating the agent.
  await test.library.queries.refresh();
  const session = {
    ...test.session,
    viewer: "d".repeat(64),
    outbox: { supports: () => true },
    directMessages: {
      people: vi.fn(async () => ({
        people: [{ pubkey: "c".repeat(64), name: "Aaron", isAgent: true }],
        hasMore: false,
      })),
    },
  } as unknown as RelaySession;
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={session}
      {...emptyCompletion}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(completionLabels(publish)).toEqual([
      "Member",
      "Outside agent",
      "Aaron",
    ]),
  );
  view.unmount();
  test.library.dispose();
});
it("focuses search on open and supports clear, Escape, and outside dismissal", async () => {
  const test = setup(),
    user = userEvent.setup();
  const view = render(
    <>
      <button type="button">Outside picker</button>
      <MentionPicker
        scope="scope"
        session={test.session}
        channelId="parent"
        disabled={false}
        select={() => true}
      />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Mention a member" });
  await user.click(trigger);
  const search = screen.getByRole("searchbox", {
    name: "Search community people and agents",
  });
  await waitFor(() => expect(search).toHaveFocus());
  await user.type(search, "no matching name");
  expect(screen.getByText("No matching channel members.")).toBeVisible();
  await user.click(
    screen.getByRole("button", {
      name: "Clear search community people and agents",
    }),
  );
  expect(search).toHaveFocus();
  expect(search).toHaveValue("");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  const outside = screen.getByRole("button", { name: "Outside picker" });
  await user.click(outside);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(outside).toHaveFocus();
  view.unmount();
  test.library.dispose();
});
it("navigates namesakes with arrows and selects the highlighted exact identity with Enter", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  test.profiles.set(test.member, { name: "Outside agent" });
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  // Same name; the member row has no detail line, the outside agent does.
  const first = await screen.findByRole("button", {
    name: rowName("Outside agent"),
  });
  const last = await outsideRow();
  // Focus stays in search; the first row is highlighted before typing, and
  // the arrows wrap.
  const search = screen.getByRole("searchbox");
  expect(search).toHaveFocus();
  expect(search).toHaveAttribute("aria-activedescendant", first.id);
  expect(first).toHaveAttribute("data-selected");
  await user.keyboard("{ArrowUp}");
  expect(search).toHaveAttribute("aria-activedescendant", last.id);
  expect(first).not.toHaveAttribute("data-selected");
  await user.keyboard("{ArrowDown}");
  expect(search).toHaveAttribute("aria-activedescendant", first.id);
  await user.keyboard("{ArrowDown}");
  expect(search).toHaveAttribute("aria-activedescendant", last.id);
  expect(search).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("keeps focus on the highlighted row after Tab, for arrows and pointer", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  test.profiles.set(test.member, { name: "Outside agent" });
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  // Same name; the member row has no detail line, the outside agent does.
  const first = await screen.findByRole("button", {
    name: rowName("Outside agent"),
  });
  const last = await outsideRow();
  for (let i = 0; i < 10 && document.activeElement !== first; i += 1)
    await user.tab();
  expect(first).toHaveFocus();
  // Down on a focused row moves the highlight and focus together.
  await user.keyboard("{ArrowDown}");
  expect(last).toHaveFocus();
  expect(last).toHaveAttribute("data-selected");
  expect(first).not.toHaveAttribute("data-selected");
  // A pointer highlight moves focus too, so Enter chooses the highlighted row.
  fireEvent.pointerMove(first, { clientX: 1, clientY: 1 });
  fireEvent.pointerMove(first, { clientX: 2, clientY: 2 });
  expect(first).toHaveAttribute("data-selected");
  expect(first).toHaveFocus();
  // Leaving returns the highlight and focus to the keyboard's row together.
  const list = document.getElementById(
    first.id.slice(0, first.id.lastIndexOf("-")),
  );
  if (!list) throw new Error("Missing mention list");
  fireEvent.pointerLeave(list, { pointerType: "mouse" });
  expect(last).toHaveAttribute("data-selected");
  expect(last).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  test.library.dispose();
});

it("selects filtered results from search, ignores IME Enter, and keeps rejected selections open", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => false);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const search = screen.getByRole("searchbox");
  expect(
    screen.queryByText("Your agents are added to this channel when you send."),
  ).not.toBeInTheDocument();
  await user.type(search, "missing");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(search).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(search);
  // Public keys are not completion matches; search by the member's name.
  await user.type(search, "Member");
  // Synthetic coverage checks the guard, not native IME behavior.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(search, { key: "ArrowDown", ...composition });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Enter", ...composition });
    expect(select).not.toHaveBeenCalled();
  }
  expect(fireEvent.keyDown(search, { key: "Enter", shiftKey: true })).toBe(
    false,
  );
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.member,
    name: "Member",
  });
  expect(search).toHaveFocus();
  select.mockReturnValue(true);
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("does not keyboard-select disabled members", async () => {
  const test = setup(true, true),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const search = screen.getByRole("searchbox");
  await waitFor(() => expect(search).toHaveFocus());
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(search).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  test.library.dispose();
});
it("Solo picker discloses history access before selection", async () => {
  const test = setup(false);
  const list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      {
        id: "parent",
        name: "Solo chat",
        channelType: "solo",
        members: ["a".repeat(64)],
      },
    ],
  };
  const session = {
    ...test.session,
    channels: { ...test.session.channels, list: () => list },
  };
  const user = userEvent.setup();
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="test"
      session={session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Mention a member" }));
    const agent = await screen.findByRole("button", {
      name: rowName("Outside agent", "Adds to chat when you send"),
    });
    expect(
      screen.getByText(
        "Agents you mention join this chat when you send, with access to its history.",
      ),
    ).toBeVisible();
    expect(select).not.toHaveBeenCalled();
    await user.click(agent);
    expect(select).toHaveBeenCalledWith({
      pubkey: test.key,
      name: "Outside agent",
    });
  } finally {
    view.unmount();
    test.library.dispose();
  }
});

it.each([true, false, null])(
  "typed @ completion offers outside agents with correct admission: parent=%s",
  async (parent) => {
    const test = setup(parent);
    let result: CompletionResult | undefined;
    const publish = vi.fn((next: CompletionResult) => {
      result = next;
      return () => {};
    });
    const props = {
      session: test.session,
      scope: "test",
      channelId: "parent",
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish,
    };
    const view = render(<MentionCompletion {...props} inviteAgents />);
    await waitFor(() =>
      expect(result?.items).toEqual([
        expect.objectContaining({
          id: test.key,
          detail: parent ? "Adds to channel" : "Adds to chat",
          edit: { mention: { pubkey: test.key, name: "Outside agent" } },
        }),
      ]),
    );
    if (parent === null) {
      expect(result?.status).toBeUndefined();
      expect(result?.retry).toBeUndefined();
    }
    view.rerender(<MentionCompletion {...props} />);
    await waitFor(() => expect(result?.items).toHaveLength(0));
    view.unmount();
    test.library.dispose();
  },
);

it.each([
  "Member prose",
  "Member](nostr:npub1d6t84ajeg9skp2609l2k6axgcme8x7g7u7luj352r03hcwreg7lqnxcsex) whats your name",
])(
  "hides recovery UI for completed mention query %s while keeping valid-query recovery",
  async (staleQuery) => {
    const test = setup();
    const choices = {
      ...test.session.agentChoices.snapshot(),
      status: "error" as const,
      error: "Agent directory unavailable",
      pending: false,
    };
    const session = {
      ...test.session,
      agentChoices: {
        ...test.session.agentChoices,
        snapshot: () => choices,
      },
    };
    let result: CompletionResult | undefined;
    const props = {
      session,
      scope: "test",
      channelId: "parent",
      observation: {
        revision: 1,
        text: `@${staleQuery}`,
        start: staleQuery.length + 1,
        end: staleQuery.length + 1,
      },
      query: { start: 0, end: staleQuery.length + 1, query: staleQuery },
      publish: (next: CompletionResult) => {
        result = next;
        return () => {};
      },
    };
    const view = render(<MentionCompletion {...props} />);
    try {
      // Community lookup now owns an asynchronous loading state. Only its
      // completed empty result can refute prose and retire unrelated recovery.
      await waitFor(() => expect(result?.status).toBeUndefined());
      expect(result?.items).toHaveLength(0);
      expect(result?.retry).toBeUndefined();

      view.rerender(
        <MentionCompletion
          {...props}
          observation={{ revision: 2, text: "@Mem", start: 4, end: 4 }}
          query={{ start: 0, end: 4, query: "Mem" }}
        />,
      );
      await waitFor(() =>
        expect(result?.status).toBe("Could not load agents. Retry to refresh."),
      );
      expect(result?.items).toHaveLength(1);
      expect(result?.retry).toEqual(expect.any(Function));
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);

it.each([
  ["a member who never set a name", false, undefined],
  [
    "a names read that failed",
    true,
    "Could not load some names. Retry to refresh.",
  ],
])("reports %s only when it failed", async (_case, fails, status) => {
  const test = setup();
  const nameless = "c".repeat(64);
  const channel = test.session.channels.list().channels[0];
  if (channel) Object.assign(channel, { members: [test.member, nameless] });
  const ensure = vi.fn(async () => {
    if (fails) throw new Error("relay unavailable");
  });
  const session = {
    ...test.session,
    profiles: { ...test.session.profiles, ensure },
  } as RelaySession;
  let result: CompletionResult | undefined;
  const view = render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Mem", start: 4, end: 4 }}
      query={{ start: 0, end: 4, query: "Mem" }}
      publish={(next: CompletionResult) => {
        result = next;
        return () => {};
      }}
    />,
  );
  try {
    await waitFor(() => expect(ensure).toHaveBeenCalled());
    await waitFor(() => {
      expect(result?.items).toHaveLength(1);
      expect(result?.status).toBe(status);
    });
    if (fails) expect(result?.retry).toEqual(expect.any(Function));
    else expect(result?.retry).toBeUndefined();
  } finally {
    view.unmount();
    test.library.dispose();
  }
});

it.each(["after", "before"] as const)(
  "keeps a failed names read and its Retry across keystrokes that remount the provider (%s it fails)",
  async (order) => {
    const test = setup();
    const nameless = "c".repeat(64);
    const channel = test.session.channels.list().channels[0];
    if (channel) Object.assign(channel, { members: [test.member, nameless] });
    let fail: (() => void) | undefined;
    let fails = true;
    const ensure = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!fails) return resolve();
          fail = () => reject(new Error("relay unavailable"));
        }),
    );
    const session = {
      ...test.session,
      profiles: { ...test.session.profiles, ensure },
    } as RelaySession;
    let result: CompletionResult | undefined;
    // The host keys each keystroke's provider by revision: a new mount.
    const typed = (revision: number, query: string) => (
      <MentionCompletion
        key={revision}
        session={session}
        scope="test"
        channelId="parent"
        observation={{
          revision,
          text: `@${query}`,
          start: query.length + 1,
          end: query.length + 1,
        }}
        query={{ start: 0, end: query.length + 1, query }}
        publish={(next: CompletionResult) => {
          result = next;
          return () => {};
        }}
      />
    );
    const failed = "Could not load some names. Retry to refresh.";
    const view = render(typed(1, "M"));
    try {
      await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
      if (order === "after") {
        await act(async () => fail?.());
        await waitFor(() => expect(result?.status).toBe(failed));
        view.rerender(typed(2, "Me"));
      } else {
        view.rerender(typed(2, "Me"));
        await act(async () => fail?.());
      }
      await waitFor(() => expect(result?.status).toBe(failed));
      expect(result?.retry).toEqual(expect.any(Function));
      // Typing does not reread the failed names; only Retry does.
      view.rerender(typed(3, "Mem"));
      await waitFor(() => expect(result?.status).toBe(failed));
      expect(ensure).toHaveBeenCalledTimes(1);
      fails = false;
      await act(async () => result?.retry?.());
      await waitFor(() => expect(result?.status).toBeUndefined());
      expect(result?.retry).toBeUndefined();
      expect(ensure).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);

it.each(["loaded by another reader", "removed from the channel"] as const)(
  "reports a failed names read only for members still unresolved (%s)",
  async (recovery) => {
    const test = setup();
    const unread = "c".repeat(64);
    const channel = test.session.channels.list().channels[0];
    if (channel) Object.assign(channel, { members: [test.member, unread] });
    // The cached member is never read; the batch fails for the unread one.
    let profiles = new Map(test.profiles);
    const listeners = new Set<() => void>();
    const ensure = vi.fn(async () => {
      throw new Error("relay unavailable");
    });
    const session = {
      ...test.session,
      profiles: {
        ...test.session.profiles,
        snapshot: () => profiles,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ensure,
      },
    } as RelaySession;
    let result: CompletionResult | undefined;
    const typed = (revision: number, query: string) => (
      <MentionCompletion
        key={revision}
        session={session}
        scope="test"
        channelId="parent"
        observation={{
          revision,
          text: `@${query}`,
          start: query.length + 1,
          end: query.length + 1,
        }}
        query={{ start: 0, end: query.length + 1, query }}
        publish={(next: CompletionResult) => {
          result = next;
          return () => {};
        }}
      />
    );
    const view = render(typed(1, "M"));
    try {
      await waitFor(() =>
        expect(result?.status).toBe(
          "Could not load some names. Retry to refresh.",
        ),
      );
      act(() => {
        if (recovery === "loaded by another reader") {
          profiles = new Map([...profiles, [unread, { name: "Una" }]]);
          for (const listener of listeners) listener();
        } else if (channel) Object.assign(channel, { members: [test.member] });
      });
      // Every later keystroke remounts; none brings the warning back.
      view.rerender(typed(2, "Me"));
      view.rerender(typed(3, "Mem"));
      await waitFor(() => expect(result?.status).toBeUndefined());
      expect(result?.retry).toBeUndefined();
      expect(ensure).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);

// Exercise selection, wire text/p tags, and sent rendering, not an already-bound @name.
it.each(["picker", "completion"] as const)(
  "%s keeps local display labels out of serialized mentions",
  async (surface) => {
    const test = setup();
    const profiles = new Map([[test.key, { name: "Mic" }]]);
    const library = createAgentLibrary(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Legacy Mic" }],
    }));
    let state: LocalAgentsSnapshot = {
      status: "ready",
      agents: [
        {
          pubkey: test.key,
          relayUrl: "wss://here.example",
          name: "Native Mic",
          owner: "aa".repeat(32),
        },
      ],
    };
    const listeners = new Set<() => void>();
    const provider = createAgentDirectory({
      snapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: async () => {},
    });
    const session = {
      ...test.session,
      agentLibrary: library.queries,
      agentChoices: createAgentChoices({
        scope: "test",
        library: library.queries,
        signal: new AbortController().signal,
      }),
      profiles: { ...test.session.profiles, snapshot: () => profiles },
    };
    const names = bindNames(
      { ...session, relayUrl: "wss://here.example" },
      {
        snapshot: () => [provider],
        subscribe: () => () => {},
      },
    );
    session.names = names;
    const user = userEvent.setup();
    let selected: MentionRecipient | undefined;
    let result: CompletionResult | undefined;
    const select = (recipient: MentionRecipient) => {
      selected = recipient;
      return true;
    };
    const publish = (next: CompletionResult) => {
      result = next;
      return () => {};
    };
    try {
      const menu = render(
        surface === "picker" ? (
          <MentionPicker
            scope="test"
            session={session}
            channelId="parent"
            disabled={false}
            inviteAgents
            select={select}
          />
        ) : (
          <MentionCompletion
            session={session}
            scope="test"
            channelId="parent"
            inviteAgents
            observation={{ revision: 1, text: "@Native", start: 7, end: 7 }}
            query={{ start: 0, end: 7, query: "Native" }}
            publish={publish}
          />
        ),
      );
      if (surface === "picker") {
        await user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        await user.click(
          await screen.findByRole("button", {
            name: rowName("Native Mic", "Adds to channel when you send"),
          }),
        );
      } else {
        await waitFor(() => expect(result?.items[0]?.label).toBe("Native Mic"));
        const edit = result?.items[0]?.edit;
        if (!edit || !("mention" in edit))
          throw new Error("Missing mention choice");
        select(edit.mention);
      }
      menu.unmount();
      if (!selected) throw new Error("No selected recipient");
      expect(selected).toEqual({ pubkey: test.key, name: "Legacy Mic" });
      const draft = followupDraft([selected]);
      const send = vi.fn<Outbox["send"]>(() => "sent");
      const messages = createMessages(
        { supports: () => true, send } as unknown as Outbox,
        "viewer",
        () => undefined,
        () => [],
        () => {},
      );
      messages.send(
        "parent",
        draft.text,
        draft.recipients.map((item) => item.pubkey),
      );
      const wire = send.mock.calls[0]?.[0];
      if (!wire) throw new Error("No outgoing message");
      expect(wire).toEqual({
        kind: 9,
        content: "@Legacy Mic",
        tags: [
          ["h", "parent"],
          ["p", test.key],
        ],
      });
      const open = vi.fn(() => true);
      const view = render(
        <MessageMarkdown
          session={session}
          row={{
            id: "sent",
            channelId: "parent",
            authorId: "viewer",
            content: wire.content,
            createdAt: 1,
            mentions: wire.tags
              .filter(([tag]) => tag === "p")
              .map(([, key]) => key ?? ""),
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          participantProfiles={profiles}
          directory={{
            profiles,
            channels: [],
            named: [],
            agents: library.queries.snapshot().identities,
          }}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
        />,
      );
      const button = screen.getByRole("button", {
        name: "View Native Mic profile",
      });
      act(() => {
        const agent = state.agents[0];
        if (!agent) throw new Error("Missing local agent");
        state = { ...state, agents: [{ ...agent, name: "Renamed Mic" }] };
        for (const listener of listeners) listener();
      });
      expect(
        screen.getByRole("button", { name: "View Renamed Mic profile" }),
      ).toBe(button);
      await user.click(button);
      expect(open).toHaveBeenCalledWith(profileTarget(test.key));
      view.unmount();
    } finally {
      names.dispose();
      library.dispose();
      test.library.dispose();
    }
  },
);

// Component lifecycle demand, not browser geometry: real source capabilities and
// remounts reproduce completion producers being replaced as the query changes.
it.each([false, true])(
  "completion remounts preserve warm evidence (invite=%s)",
  async (inviteAgents) => {
    const test = setup();
    const native = localAgentsFixture([
      {
        pubkey: "ab".repeat(32),
        name: "Fixture agent",
        relayUrl: "wss://relay.example.test",
        owner: "aa".repeat(32),
      },
    ]);
    const read = vi.fn(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Outside agent" }],
    }));
    const library = createAgentLibrary(read);
    const lifetime = new AbortController();
    const session = {
      ...test.session,
      agentChoices: createAgentChoices({
        scope: `https://relay.example.test:${"aa".repeat(32)}`,
        library: library.queries,
        native,
        signal: lifetime.signal,
      }),
    };
    let result: CompletionResult | undefined;
    const props = {
      session,
      scope: "test",
      channelId: "parent",
      inviteAgents,
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish: (next: CompletionResult) => {
        result = next;
        return () => {};
      },
    };
    const tree = (key: number) => (
      <StrictMode>
        <MentionCompletion key={key} {...props} />
      </StrictMode>
    );
    const view = render(tree(0));
    try {
      if (inviteAgents)
        await waitFor(() => expect(result?.items).toHaveLength(1));
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
      const warm = session.agentChoices.snapshot();
      for (let key = 1; key <= 3; key++) {
        view.rerender(tree(key));
        await act(async () => {});
        expect(session.agentChoices.snapshot()).toBe(warm);
        expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
      }
      // An explicit library change still reaches an ordinary open completion.
      await act(async () => {
        await library.queries.refresh();
      });
      expect(session.agentChoices.snapshot().identities).toContainEqual(
        expect.objectContaining({ pubkey: test.key }),
      );
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 2 : 1);
    } finally {
      view.unmount();
      lifetime.abort();
      library.dispose();
      test.library.dispose();
    }
  },
);

it("opening and reopening an ordinary picker does not load the legacy library", async () => {
  const test = setup();
  const user = userEvent.setup();
  const view = render(
    <MentionPicker
      scope="test"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  try {
    for (let i = 0; i < 3; i++) {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      expect(test.library.queries.snapshot().status).toBe("idle");
    }
  } finally {
    view.unmount();
    test.library.dispose();
  }
});

it("prioritizes the viewer-owned namesake in both menus and selects the exact owner-labeled recipient", async () => {
  const test = setup();
  const viewer = "1".repeat(64),
    owner = "2".repeat(64),
    mine = "c".repeat(64);
  const profiles = new Map([
    [viewer, { name: "Logan" }],
    [owner, { name: "Wes" }],
    [mine, { name: "Honey", isAgent: true as const, ownerPubkey: viewer }],
    [test.key, { name: "Honey", isAgent: true as const, ownerPubkey: owner }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [mine, test.key] }],
  };
  const session = {
    ...test.session,
    viewer,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
      // Only attested owners are named as managers.
      owner: (key: string) => ({ [mine]: viewer, [test.key]: owner })[key],
    },
    channels: { ...test.session.channels, list: () => list },
  };
  const provider = createAgentDirectory();
  const library = createAgentLibrary(undefined);
  const names = bindNames(
    { viewer, profiles: session.profiles, agentLibrary: library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  const completion = render(
    <MentionCompletion
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      observation={{ revision: 1, text: "@hon", start: 4, end: 4 }}
      query={{ start: 0, end: 4, query: "hon" }}
      publish={publish}
    />,
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      ({ id, agent, detail }) => [id, agent, detail],
    ),
  ).toEqual([
    [mine, true, undefined],
    [test.key, true, "Managed by Wes"],
  ]);
  completion.unmount();
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "hon");
  // Someone else's agent also says who manages it; your own does not.
  const wes = await screen.findByRole("button", {
    name: rowName("Wes’s Honey", "Managed by Wes"),
  });
  const own = screen.getByRole("button", { name: rowName("Honey") });
  expect(
    own.compareDocumentPosition(wes) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(wes);
  expect(select).toHaveBeenCalledWith({ pubkey: test.key, name: "Honey" });
  view.unmount();
  names.dispose();
  library.dispose();
  test.library.dispose();
});

it("names a manager only once ownership is attested and the owner has a real name", async () => {
  const test = setup();
  const viewer = "1".repeat(64),
    owner = "2".repeat(64),
    unnamed = "3".repeat(64),
    other = "e".repeat(64);
  const profiles = new Map([
    [viewer, { name: "Logan" }],
    [owner, { name: "Wes" }],
    [unnamed, { name: unnamed.slice(0, 10), nameIsFallback: true as const }],
    [test.key, { name: "Honey", isAgent: true as const, ownerPubkey: owner }],
    [other, { name: "Bee", isAgent: true as const, ownerPubkey: unnamed }],
  ]);
  const listeners = new Set<() => void>();
  const attested = new Map<string, string>();
  const list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [test.key, other] }],
  };
  const session = {
    ...test.session,
    viewer,
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
      owner: (key: string) => attested.get(key),
    },
    channels: { ...test.session.channels, list: () => list },
  };
  const view = render(
    <MentionPicker
      scope="scope"
      session={session}
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  // A self-declared owner is not a manager.
  expect(
    await screen.findByRole("button", { name: rowName("Honey") }),
  ).toBeVisible();
  expect(screen.queryByText(/Managed by/)).toBeNull();
  // Attestation settles later and notifies without a new profile snapshot.
  act(() => {
    attested.set(test.key, owner);
    attested.set(other, unnamed);
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("button", { name: rowName("Honey", "Managed by Wes") }),
  ).toBeVisible();
  // An owner without a name never shows a key fragment instead.
  expect(screen.getByRole("button", { name: rowName("Bee") })).toBeVisible();
  expect(screen.queryByText(/Managed by 3/)).toBeNull();
  view.unmount();
  test.library.dispose();
});

it("keeps an outside namesake discoverable and qualifies the actual choice set", async () => {
  const test = setup();
  const member = "a".repeat(64),
    outside = test.key,
    unrelated = "d".repeat(64);
  const profiles = new Map(
    [member, outside, unrelated].map((key) => [
      key,
      { name: "Larry", isAgent: true as const },
    ]),
  );
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: outside, name: "Larry" }],
  }));
  const session = {
    ...test.session,
    agentLibrary: library.queries,
    agentChoices: createAgentChoices({
      scope: "scope",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    profiles: { ...test.session.profiles, snapshot: () => profiles },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    await screen.findByRole("button", { name: rowName("Larry") }),
  ).toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  // Namesakes are qualified; only the outside agent has a detail line.
  const outsideButton = await screen.findByRole("button", {
    name: /^Larry · \S+?\s*Adds to channel when you send$/,
  });
  expect(
    screen.getByRole("button", { name: /^Larry · \S+$/ }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Larry/ })).toHaveLength(2);
  await user.click(outsideButton);
  expect(select).toHaveBeenCalledWith({ pubkey: outside, name: "Larry" });
  view.unmount();
  names.dispose();
  library.dispose();
  test.library.dispose();
});

it("discovers outside humans from the selected directory in both menus, not cached profiles", async () => {
  const t = setup();
  const outsider = { pubkey: "e".repeat(64), name: "Outside human" };
  const cached = "f".repeat(64);
  const people = vi.fn(async () => ({ people: [outsider], hasMore: false }));
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const profiles = new Map([[cached, { name: "Cache only" }]]);
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Outside", start: 8, end: 8 }}
      query={{ start: 0, end: 8, query: "Outside" }}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        (item) => item.id,
      ),
    ).toEqual([outsider.pubkey]),
  );
  expect(people).toHaveBeenCalledWith("Outside", 1, expect.any(AbortSignal));
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  const row = await screen.findByRole("button", {
    name: rowName(outsider.name, "Not in channel"),
  });
  expect(row).not.toHaveTextContent(outsider.pubkey);
  expect(
    screen.queryByRole("button", { name: new RegExp(cached) }),
  ).not.toBeInTheDocument();
});

it("qualifies outside directory namesakes that have no cached profile", async () => {
  const t = setup();
  const member = "a".repeat(64);
  const people = vi.fn(async () => ({
    people: [
      { pubkey: "e".repeat(64), name: "Larry" },
      { pubkey: "f".repeat(64), name: "Larry", isAgent: true as const },
    ],
    hasMore: false,
  }));
  const profiles = new Map([[member, { name: "Larry" }]]);
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: t.library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  render(
    <MentionCompletion
      session={{ ...session, names }}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Larr", start: 5, end: 5 }}
      query={{ start: 0, end: 5, query: "Larr" }}
      publish={publish}
    />,
  );
  const labels = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    ) ?? [];
  await waitFor(() => expect(labels()).toHaveLength(3));
  expect(new Set(labels()).size).toBe(3);
  expect(labels()).not.toContain("Larry");
  names.dispose();
});

it("never expands Solo chat candidates from the community directory", async () => {
  vi.useFakeTimers();
  const t = setup();
  const people = vi.fn(async () => ({
    people: [{ pubkey: "e".repeat(64), name: "Outside" }],
    hasMore: false,
  }));
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "parent",
        name: "Conversation",
        channelType: "solo" as const,
        members: ["a".repeat(64)],
      },
    ],
  };
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    channels: { ...t.session.channels, list: () => list },
  };
  // Neither surface passes inviteAgents, like a Solo chat media comment.
  const publish = vi.fn();
  render(
    <>
      <MentionPicker
        session={session}
        scope="test"
        channelId="parent"
        disabled={false}
        select={() => true}
      />
      <MentionCompletion
        session={session}
        scope="test"
        channelId="parent"
        observation={{ revision: 1, text: "@Out", start: 4, end: 4 }}
        publish={publish}
        query={{ start: 0, end: 4, query: "Out" }}
      />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Mention a member" }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Out" },
  });
  // Past the directory delay, so a search would have started.
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
  expect(people).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /Outside/ }),
  ).not.toBeInTheDocument();
  const result = publish.mock.lastCall?.[0] as CompletionResult | undefined;
  expect(result?.items.map((item) => item.label) ?? []).not.toContain(
    "Outside",
  );
  expect(result?.status).toBeUndefined();
});

it("offers outside directory people in a DM, like a channel", async () => {
  const t = setup();
  const outside = { pubkey: "e".repeat(64), name: "Outside" };
  const people = vi.fn(async () => ({ people: [outside], hasMore: false }));
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "dm",
        name: "Conversation",
        channelType: "dm" as const,
        members: [t.member],
        participants: [t.member],
      },
    ],
  };
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    channels: { ...t.session.channels, list: () => list },
  };
  const publish = vi.fn();
  render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="dm"
      observation={{ revision: 1, text: "@Out", start: 4, end: 4 }}
      publish={publish}
      query={{ start: 0, end: 4, query: "Out" }}
    />,
  );
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        (item) => item.label,
      ),
    ).toEqual(["Outside"]),
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items[0]
      ?.detail,
  ).toBe("Not in DM · Will not be notified");
});

it("labels outside directory people in the DM toolbar picker", async () => {
  const t = setup();
  const people = vi.fn(async () => ({
    people: [{ pubkey: "e".repeat(64), name: "Outside" }],
    hasMore: false,
  }));
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "dm",
        name: "Conversation",
        channelType: "dm" as const,
        members: [t.member],
        participants: [t.member],
      },
    ],
  };
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    channels: { ...t.session.channels, list: () => list },
  };
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="dm"
      disabled={false}
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  const row = await screen.findByRole("button", { name: /Outside/ });
  expect(row).toHaveTextContent("Not in DM · Will not be notified");
});

it("shows local rows before the directory, appends outside rows, and reuses settled pages", async () => {
  vi.useFakeTimers();
  const t = setup();
  const lara = { pubkey: "e".repeat(64), name: "Lara" };
  const larry = { pubkey: "f".repeat(64), name: "Larry Outside" };
  const pages = new Map<
    string,
    (value: {
      people: { pubkey: string; name: string }[];
      hasMore: boolean;
    }) => void
  >();
  const people = vi.fn(
    (query: string) =>
      new Promise<{
        people: { pubkey: string; name: string }[];
        hasMore: boolean;
      }>((resolve) => pages.set(query, resolve)),
  );
  const profiles = new Map([[t.member, { name: "Larkin" }]]);
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@La", start: 3, end: 3 },
    publish,
  };
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const labels = () => last()?.items.map((item) => item.label);
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 3, query: "La" }} />,
  );
  // The member is usable before the network search starts or settles.
  expect(labels()).toEqual(["Larkin"]);
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(1);
  // A truncated page: a longer query cannot be read out of it, so it searches.
  await act(async () =>
    pages.get("La")?.({ people: [lara, larry], hasMore: true }),
  );
  expect(labels()).toEqual(["Larkin", "Lara", "Larry Outside"]);
  expect(last()?.status).toBeUndefined();
  // A new query keeps still-matching people from the last page while it loads.
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 4, query: "Larr" }}
    />,
  );
  expect(labels()).toEqual(["Larry Outside"]);
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
  const newer = { pubkey: "d".repeat(64), name: "Larry Newer" };
  await act(async () =>
    pages.get("Larr")?.({ people: [newer, larry], hasMore: false }),
  );
  // Appended below, never inserted above a visible row.
  expect(labels()).toEqual(["Larry Outside", "Larry Newer"]);
  // Returning to a settled query is instant and does not read again.
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 3, query: "La" }} />,
  );
  expect(labels()).toEqual(["Larkin", "Lara", "Larry Outside"]);
  expect(last()?.status).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
});

it("waits for a typing pause before reading the directory", async () => {
  const t = setup();
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@Out", start: 4, end: 4 },
    publish: vi.fn(),
  };
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 2, query: "O" }} />,
  );
  for (const query of ["Ou", "Out"])
    view.rerender(
      <MentionCompletion {...props} query={{ start: 0, end: 4, query }} />,
    );
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  expect(people).toHaveBeenCalledWith("Out", 1, expect.any(AbortSignal));
});

it("ignores a late directory result after the query changes and retries the current failure", async () => {
  const t = setup();
  let release = (_result: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => {};
  const old = new Promise<{
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }>((resolve) => {
    release = resolve;
  });
  const people = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      people: [{ pubkey: "e".repeat(64), name: "New person" }],
      hasMore: false,
    });
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@Old", start: 4, end: 4 },
    publish,
  };
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "Old" }} />,
  );
  // Directory reads wait for a typing pause, so let the old query start first.
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "New" }} />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.status,
    ).toMatch(/Could not search community/),
  );
  await act(async () =>
    release({
      people: [{ pubkey: "f".repeat(64), name: "Old person" }],
      hasMore: false,
    }),
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items,
  ).toEqual([]);
  act(() => {
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.retry?.();
  });
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        (item) => item.label,
      ),
    ).toEqual(["New person"]),
  );
});

it("keeps installed rows and fresh authorization through rename, removal, arrivals and archive Retry", async () => {
  const test = setup();
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  let profiles = new Map([
    [a, { name: "Alpha" }],
    [b, { name: "Beta" }],
    [c, { name: "Aaron Bee" }],
  ]);
  let list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [a, b] }],
  };
  let archive = { status: "ready" as const, archived: [] as string[] };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const refresh = vi.fn(async () => {
    for (const fn of listeners) fn();
  });
  const session = {
    ...test.session,
    channels: {
      ...test.session.channels,
      list: () => list,
      subscribeList: subscribe,
    },
    profiles: { ...test.session.profiles, snapshot: () => profiles, subscribe },
    archives: {
      snapshot: () => archive,
      subscribe,
      state: (key: string) =>
        archive.archived.includes(key) ? "archived" : "not-archived",
      ensure: async () => {},
      refresh,
      writable: false,
      supported: true,
      consent: vi.fn(),
      request: vi.fn(),
    },
  } as RelaySession;
  let result: CompletionResult | undefined;
  const publish = (value: CompletionResult) => {
    result = value;
    return () => {};
  };
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  const original = result?.items[0];
  act(() => {
    profiles = new Map([
      [a, { name: "Zeta" }],
      [b, { name: "Beta" }],
      [c, { name: "Aaron Bee" }],
    ]);
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  expect(result?.items[0]?.label).toBe("Zeta");
  expect(result?.items[0]?.edit).toEqual({
    mention: { pubkey: a, name: "Zeta" },
  });
  act(() => {
    list = {
      ...list,
      channels: [{ id: "parent", name: "Parent", members: [b, c] }],
    };
    // Selection sees the new source even before subscriber callbacks/render.
    expect(original?.canSelect?.("Enter")).toBe(false);
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  expect(result?.items[0]?.disabled).toBeTruthy();
  act(() => {
    archive = { ...archive, archived: [b] };
    for (const fn of listeners) fn();
  });
  expect(result?.items[1]?.disabled).toBe("Archived");
  await act(() => refresh());
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 2, query: "a" }} />,
  );
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 8, query: "Aaron B" }}
    />,
  );
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  act(() => {
    list = {
      ...list,
      channels: [{ id: "parent", name: "Parent", members: [] }],
    };
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  expect(result?.items[0]?.disabled).toBeTruthy();
  view.unmount();
  test.library.dispose();
});

it("retains button rows while disabling an archived member, then hides it on reopen", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  let archive = { status: "ready" as const, archived: [] as string[] };
  const listeners = new Set<() => void>();
  const session = {
    ...test.session,
    archives: {
      snapshot: () => archive,
      state: (key: string) =>
        archive.archived.includes(key) ? "archived" : "not-archived",
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      ensure: async () => {},
      refresh: async () => {},
      writable: false,
      supported: true,
      consent: vi.fn(),
      request: vi.fn(),
    },
  } as RelaySession;
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const row = screen.getByRole("button", { name: rowName("Member") });
  act(() => {
    archive = { ...archive, archived: ["a".repeat(64)] };
    for (const fn of listeners) fn();
  });
  expect(row).toBeDisabled();
  await user.click(row);
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: /^Member/ }),
  ).not.toBeInTheDocument();
  test.library.dispose();
});

it("offers usable partial agent choices without waiting for another source", async () => {
  const test = setup();
  const snapshot = {
    ...test.session.agentChoices.snapshot(),
    status: "ready" as const,
    pending: true,
    complete: false,
    identities: [
      { pubkey: "f".repeat(64), name: "Ready Agent", managed: true },
    ],
  };
  const session = {
    ...test.session,
    agentChoices: { ...test.session.agentChoices, snapshot: () => snapshot },
  };
  const view = render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    await screen.findByRole("button", {
      name: rowName("Ready Agent", "Adds to channel when you send"),
    }),
  ).toBeEnabled();
  view.unmount();
  test.library.dispose();
});

it("archived identities leave completion and return on unarchive; the viewer is never hidden from themself", async () => {
  const test = setup();
  const publish = vi.fn();
  const rows = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => [item.label, item.disabled],
    );
  const props = (query: string) => ({
    scope: "test",
    channelId: "parent",
    observation: {
      revision: 1,
      text: `@${query}`,
      start: query.length + 1,
      end: query.length + 1,
    },
    query: { start: 0, end: query.length + 1, query },
    publish,
  });
  const view = render(
    <MentionCompletion session={test.session} {...props("")} />,
  );
  expect(rows()).toEqual([["Member", undefined]]);
  // A shown row stays in place but cannot be chosen; the next query drops it.
  act(() => test.setArchived([test.member]));
  expect(rows()).toEqual([["Member", "Archived"]]);
  view.rerender(<MentionCompletion session={test.session} {...props("M")} />);
  expect(rows()).toEqual([]);
  // Unarchive returns the row on the next query; installed rows never grow.
  act(() => test.setArchived([]));
  view.rerender(<MentionCompletion session={test.session} {...props("Me")} />);
  expect(rows()).toEqual([["Member", undefined]]);
  act(() => test.setArchived([test.member]));
  view.rerender(
    <MentionCompletion
      session={{ ...test.session, viewer: test.member }}
      {...props("Mem")}
    />,
  );
  expect(rows()).toEqual([["Member", undefined]]);
  test.library.dispose();
});

it("closes prose after an unknown name without status or recovery, and skips searches a complete empty prefix refutes", async () => {
  const t = setup();
  const people = vi.fn(async (query: string) => ({
    people: query.startsWith("Ou")
      ? [{ pubkey: "e".repeat(64), name: "Outside" }]
      : [],
    hasMore: false,
  }));
  const uncached = new Map();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    // A failed names read offers recovery for prose to retire.
    profiles: {
      ...t.session.profiles,
      snapshot: () => uncached,
      ensure: async () => {
        throw new Error("relay unavailable");
      },
    },
  };
  const publish = vi.fn();
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const complete = (query: string) => (
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{
        revision: 1,
        text: `@${query}`,
        start: query.length + 1,
        end: query.length + 1,
      }}
      query={{ start: 0, end: query.length + 1, query }}
      publish={publish}
    />
  );
  const view = render(complete("Zed"));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.retry).toBeDefined());
  for (const prose of ["Zed ", "Zed is", "Zed is typing"]) {
    view.rerender(complete(prose));
    await waitFor(() => expect(last()).toEqual({ items: [] }));
  }
  expect(people).toHaveBeenCalledTimes(1);
  view.rerender(complete("Out"));
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith("Out", 1, expect.any(AbortSignal)),
  );
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Outside"]),
  );
  // The complete page for `Out` already answers every query extending it:
  // `Outside ` is its one name plus a trailing space, prose, with no read.
  view.rerender(complete("Outside "));
  await waitFor(() => expect(last()).toEqual({ items: [] }));
  expect(people).toHaveBeenCalledTimes(2);
});

function directoryCompletion(people: RelaySessionPeople) {
  const t = setup();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const publish = vi.fn();
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const complete = (query: string) => (
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{
        revision: 1,
        text: `@${query}`,
        start: query.length + 1,
        end: query.length + 1,
      }}
      query={{ start: 0, end: query.length + 1, query }}
      publish={publish}
    />
  );
  return { last, complete, session };
}
type RelaySessionPeople = (
  query: string,
) => Promise<{ people: { pubkey: string; name: string }[]; hasMore: boolean }>;

it("keeps already-read directory people at one character without searching", async () => {
  vi.useFakeTimers();
  const people = vi.fn<RelaySessionPeople>(async () => ({
    people: [
      { pubkey: "e".repeat(64), name: "Mark Outsider" },
      { pubkey: "f".repeat(64), name: "Zed Outsider" },
    ],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete(""));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledExactlyOnceWith("", 1, expect.anything());
  // One character is too short to search: the listing stays, filtered.
  view.rerender(complete("m"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(1);
  const labels = last()?.items.map((item) => item.label);
  expect(labels).toContain("Mark Outsider");
  expect(labels).not.toContain("Zed Outsider");
  expect(last()?.status).not.toBe("Searching community…");
  view.rerender(complete("ma"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenLastCalledWith("ma", 1, expect.anything());
});

it("Space does not select a one-character name a truncated listing could continue", async () => {
  vi.useFakeTimers();
  const people = vi.fn<RelaySessionPeople>(async () => ({
    people: [{ pubkey: "e".repeat(64), name: "Q" }],
    hasMore: true,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete(""));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  view.rerender(complete("q"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(last()?.items.map((item) => item.label)).toContain("Q");
  // An unread page may hold "Q Smith", and no search for `q` ran.
  expect(last()?.spaceId).toBeUndefined();
  expect(people).toHaveBeenCalledTimes(1);
});

it("answers a longer query from the complete page already read for its prefix, with no read and no typing pause", async () => {
  vi.useFakeTimers();
  const people = vi.fn<RelaySessionPeople>(async () => ({
    people: [
      { pubkey: "e".repeat(64), name: "Mary Jane" },
      { pubkey: "f".repeat(64), name: "Mark" },
    ],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("Mar"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(1);
  expect(last()?.items.map((item) => item.label)).toEqual([
    "Mark",
    "Mary Jane",
  ]);
  // Every match for `Mary J` is on the complete page for `Mar`: the page is
  // settled on the keystroke, so the multi-word query is admitted at once.
  view.rerender(complete("Mary J"));
  expect(last()?.items.map((item) => item.label)).toEqual(["Mary Jane"]);
  expect(last()?.status).toBeUndefined();
  expect(last()?.spacePending).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(1);
  // Space decides over the derived page, as over the page itself.
  view.rerender(complete("Mary Jane"));
  expect(last()?.spaceId).toBe("e".repeat(64));
  expect(last()?.spacePending).toBeUndefined();
  expect(people).toHaveBeenCalledTimes(1);
});

it("still searches a longer query when the page read for its prefix was truncated", async () => {
  vi.useFakeTimers();
  const people = vi.fn<RelaySessionPeople>(async (query) => ({
    people: [{ pubkey: "e".repeat(64), name: "Mary Jane" }],
    hasMore: query === "Mar",
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("Mar"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(last()?.status).toBeUndefined();
  // A truncated page may have left a match out: it answers only its own query.
  view.rerender(complete("Mary J"));
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
  expect(people).toHaveBeenLastCalledWith("Mary J", 1, expect.any(AbortSignal));
  expect(last()?.status).toBeUndefined();
  expect(last()?.items.map((item) => item.label)).toEqual(["Mary Jane"]);
});

it("does not answer a name search from the listing read for an empty query", async () => {
  vi.useFakeTimers();
  const people = vi.fn<RelaySessionPeople>(async () => ({
    people: [{ pubkey: "e".repeat(64), name: "Mira Everly" }],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  // A pause on `@` lists the community; fewer than 15 profiles completes it.
  const view = render(complete(""));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledExactlyOnceWith(
    "",
    1,
    expect.any(AbortSignal),
  );
  // The listing is a prefix of every query but is not a name search: a
  // member who joins or renames after it must still be found by name.
  view.rerender(complete("mi"));
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
  expect(people).toHaveBeenLastCalledWith("mi", 1, expect.any(AbortSignal));
  expect(last()?.items.map((item) => item.label)).toEqual(["Mira Everly"]);
  // The finished name search still answers the queries extending it.
  view.rerender(complete("mir"));
  expect(last()?.status).toBeUndefined();
  expect(last()?.items.map((item) => item.label)).toEqual(["Mira Everly"]);
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
});

it("a retry searches afresh when a complete page for a prefix of the query was cached meanwhile", async () => {
  const people = vi
    .fn<RelaySessionPeople>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      people: [{ pubkey: "e".repeat(64), name: "Mira Everly" }],
      hasMore: false,
    });
  const { last, complete, session } = directoryCompletion(people);
  render(complete("mira e"));
  await waitFor(() =>
    expect(last()?.status).toBe(
      "Could not search community people. Retry to refresh.",
    ),
  );
  // Another consumer of the session (a thread composer, or the pending-
  // mention resolver) reads the complete page for `mira` meanwhile.
  await fetchMentionDirectoryPage(session, "mira", AbortSignal.timeout(1000));
  expect(people).toHaveBeenCalledTimes(2);
  // Retry asked for a read: it must not derive from that page, which the
  // chooser could not show, but read `mira e` again and render its page.
  act(() => last()?.retry?.());
  await waitFor(() => expect(people).toHaveBeenCalledTimes(3));
  expect(people).toHaveBeenLastCalledWith("mira e", 1, expect.any(AbortSignal));
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Mira Everly"]),
  );
  expect(last()?.status).toBeUndefined();
  expect(last()?.retry).toBeUndefined();
});

it("scopes a retry to its query: later queries derive from a cached prefix page and a refuted prefix again, while that query still reads afresh", async () => {
  vi.useFakeTimers();
  const offline = new Error("offline");
  const people = vi
    .fn<RelaySessionPeople>()
    .mockRejectedValueOnce(offline)
    .mockRejectedValueOnce(offline)
    .mockImplementation(async (query) => ({
      people: query.startsWith("mira")
        ? [{ pubkey: "e".repeat(64), name: "Mira Everly" }]
        : query.startsWith("lu")
          ? [{ pubkey: "f".repeat(64), name: "Lucy Lu" }]
          : [],
      hasMore: false,
    }));
  const { last, complete, session } = directoryCompletion(people);
  const failed = "Could not search community people. Retry to refresh.";
  // The picker keeps one hook mounted across openings: one instance sees
  // every query of the session.
  const view = render(complete("mira e"));
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(last()?.status).toBe(failed);
  // Still offline: the retry fails too and Retry stays offered.
  act(() => last()?.retry?.());
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(2);
  expect(last()?.status).toBe(failed);
  // Other consumers of the session settle complete `lu` and `mira` pages and
  // then an empty `zed` search meanwhile (a read clears the refuted prefix,
  // so the empty search comes last).
  const signal = new AbortController().signal;
  await fetchMentionDirectoryPage(session, "lu", signal);
  await fetchMentionDirectoryPage(session, "mira", signal);
  await fetchMentionDirectoryPage(session, "zed", signal);
  expect(people).toHaveBeenCalledTimes(5);
  // The retry was `mira e`'s. `lucy` is answered from the `lu` page on the
  // keystroke, and `zedd` is refuted by the empty `zed` search; neither reads.
  view.rerender(complete("lucy"));
  expect(last()?.status).toBeUndefined();
  expect(last()?.items.map((item) => item.label)).toEqual(["Lucy Lu"]);
  view.rerender(complete("zedd"));
  expect(last()?.status).not.toBe("Searching community…");
  expect(last()?.items).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(5);
  // Back on `mira e`, the asked-for read is still owed: its failure and
  // Retry stand, and a second Retry reads `mira e` afresh rather than
  // deriving it from the complete `mira` page.
  view.rerender(complete("mira e"));
  expect(last()?.status).toBe(failed);
  act(() => last()?.retry?.());
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(people).toHaveBeenCalledTimes(6);
  expect(people).toHaveBeenLastCalledWith("mira e", 1, expect.any(AbortSignal));
  expect(last()?.status).toBeUndefined();
  expect(last()?.items.map((item) => item.label)).toEqual(["Mira Everly"]);
});

it("an empty partial-key search does not refute an exact-key lookup, which lists only the key's owner", async () => {
  const key = "9".repeat(64);
  const people = vi.fn(async (query: string) => ({
    people: query === key ? [{ pubkey: key, name: "Keyholder" }] : [],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("9".repeat(10)));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.items).toEqual([]));
  view.rerender(complete(key));
  // The empty partial-key page does not refute the exact-key author lookup.
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith(key, 1, expect.any(AbortSignal)),
  );
  // A complete key matches its owner; the partial key above matched no one.
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Keyholder"]),
  );
});

it("a failed multi-word directory search keeps its error and retry", async () => {
  const people = vi
    .fn<RelaySessionPeople>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      people: [{ pubkey: "f".repeat(64), name: "Mary Jane" }],
      hasMore: false,
    });
  const { last, complete } = directoryCompletion(people);
  render(complete("Mary J"));
  await waitFor(() =>
    expect(last()?.status).toBe(
      "Could not search community people. Retry to refresh.",
    ),
  );
  act(() => last()?.retry?.());
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Mary Jane"]),
  );
});

it("a fresh search for a refuted name searches again, and non-word text refutes nothing", async () => {
  let published = false;
  const people = vi.fn(async (query: string) => ({
    people: [
      ...(published && query.startsWith("Zed")
        ? [{ pubkey: "9".repeat(64), name: "Zed" }]
        : []),
      ...(query.startsWith("🐝 B")
        ? [{ pubkey: "8".repeat(64), name: "🐝 Buzz Bot" }]
        : []),
    ],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("Zed"));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.items).toEqual([]));
  view.unmount();
  published = true;
  const fresh = render(complete("Zed"));
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Zed"]),
  );
  fresh.rerender(complete("🐝"));
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith("🐝", 1, expect.any(AbortSignal)),
  );
  await waitFor(() => expect(last()?.items).toEqual([]));
  fresh.rerender(complete("🐝 B"));
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["🐝 Buzz Bot"]),
  );
});

it("uses base matches and visible lexical ties for Fizz in both chooser surfaces", async () => {
  const test = setup();
  const rows = [
    { key: "3".repeat(64), name: "Fast Fizz", label: "Fast Fizz" },
    { key: "0".repeat(64), name: "Fizz", label: "baxen’s Fizz · oncp" },
    { key: "4".repeat(64), name: "Fizz", label: "baxen’s Fizz · s03j" },
    { key: "5".repeat(64), name: "Fizz", label: "Kenny Lopez’s Fizz" },
    { key: "b".repeat(64), name: "Fizz", label: "baxen’s Fizz · 4prr" },
    { key: "c".repeat(64), name: "Fizz", label: "baxen’s Fizz · 06pl" },
  ];
  const profiles = new Map(
    rows.map((row) => [row.key, { name: row.name, isAgent: true as const }]),
  );
  const list = {
    status: "ready" as const,
    channels: [
      { id: "parent", name: "Parent", members: rows.map((row) => row.key) },
    ],
  };
  const names = test.session.names;
  if (!names) throw new Error("Missing fixture name service");
  const session = {
    ...test.session,
    profiles: { ...test.session.profiles, snapshot: () => profiles },
    channels: { ...test.session.channels, list: () => list },
    names: {
      ...names,
      resolve: (key: string) => rows.find((row) => row.key === key)?.label,
      scope: () => (key: string) => {
        const name = rows.find((row) => row.key === key)?.label;
        return name ? { name, source: "agent-directory" as const } : undefined;
      },
    },
  } satisfies RelaySession;
  const expected = [rows[5], rows[4], rows[1], rows[2], rows[3], rows[0]].map(
    (row) => row?.label,
  );
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@fizz", start: 5, end: 5 }}
      query={{ start: 0, end: 5, query: "fizz" }}
      publish={publish}
    />,
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    ),
  ).toEqual(expected);
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "fizz");
  expect(rowsInOrder(rows.map((row) => row.label))).toEqual(expected);
  test.library.dispose();
});

it("completes a full public key only to its owner in either menu, never a partial key", async () => {
  const test = setup();
  const key =
    "150b20bdf6130418df9239dd1bd082c71612c8d653b47c277200365b9be215dc";
  const honey = "f".repeat(64);
  const unnamed = "e".repeat(64);
  const profiles = new Map([
    [key, { name: "Bad Janet" }],
    [honey, { name: "Honey" }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [
      { id: "parent", name: "Parent", members: [key, honey, unnamed] },
    ],
  };
  const session = {
    ...test.session,
    profiles: { ...test.session.profiles, snapshot: () => profiles },
    channels: { ...test.session.channels, list: () => list },
  } satisfies RelaySession;
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@h", start: 2, end: 2 },
    query: { start: 0, end: 2, query: "h" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const ids = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.id,
    );
  expect(ids()).toEqual([honey]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 65, query: key }} />,
  );
  expect(ids()).toEqual([key]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "eee" }} />,
  );
  expect(ids()).toEqual([]);
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "h");
  expect(screen.queryByRole("button", { name: /^Bad Janet/ })).toBeNull();
  expect(screen.getByRole("button", { name: rowName("Honey") })).toBeVisible();
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), key);
  expect(
    screen.getByRole("button", { name: rowName("Bad Janet") }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: rowName("Honey") })).toBeNull();
  test.library.dispose();
});

it("keeps still-matching directory people across the inline host's per-keystroke remount", async () => {
  // jsdom has no layout; the host positions its popup with these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const t = setup();
  const larry = { pubkey: "f".repeat(64), name: "Larry Outside" };
  const lara = { pubkey: "e".repeat(64), name: "Lara" };
  const resolvers = new Map<
    string,
    (value: { people: (typeof larry)[]; hasMore: boolean }) => void
  >();
  const people = vi.fn(
    (query: string) =>
      new Promise<{ people: (typeof larry)[]; hasMore: boolean }>((resolve) =>
        resolvers.set(query, resolve),
      ),
  );
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  } as unknown as RelaySession;
  // The real mention provider behind the real host, which keys each provider
  // mount by observation revision and query.
  const provider: Contribution<ComposerCompletion> = {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  };
  const providers = [provider];
  const registry = { snapshot: () => providers, subscribe: () => () => {} };
  // The host reads only its attributes and position; valid() is stubbed.
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = (observation: ComposerObservation) =>
    ({
      observation,
      valid: () => true,
      observe: () => {},
      invalidate: () => {},
      keys: { current: undefined },
      composing: { current: false },
    }) as unknown as CompletionEditor;
  const host = (revision: number, text: string) => (
    <ComposerCompletions
      registry={registry}
      editor={editor({ revision, text, start: text.length, end: text.length })}
      input={{ current: input }}
      replace={() => true}
      resolved={{ text, recipients: [] }}
      session={session}
      scope="test"
      channelId="parent"
    />
  );
  const options = () =>
    screen.queryAllByRole("option").map((option) => option.textContent);
  const view = render(host(1, "@La"));
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("La", 1, expect.anything()),
  );
  // A truncated page, so the longer query below searches rather than reads it.
  await act(async () =>
    resolvers.get("La")?.({ people: [lara, larry], hasMore: true }),
  );
  await waitFor(() =>
    expect(options()).toEqual([
      expect.stringContaining("Lara"),
      expect.stringContaining("Larry Outside"),
    ]),
  );
  // Each keystroke remounts the provider. The still-matching person stays
  // while the new search waits and loads; the non-matching one leaves.
  view.rerender(host(2, "@Lar"));
  view.rerender(host(3, "@Larr"));
  expect(options()).toEqual([expect.stringContaining("Larry Outside")]);
  expect(screen.getByRole("status")).toHaveTextContent("Searching community…");
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("Larr", 1, expect.anything()),
  );
  expect(options()).toEqual([expect.stringContaining("Larry Outside")]);
  // A different `@` token is a new chooser lifetime and starts clean.
  view.rerender(host(4, "@Larr @Bo"));
  expect(options()).toEqual([]);
  input.remove();
  vi.unstubAllGlobals();
});

it("the persistent toolbar picker reads an empty search again after close and reopen", async () => {
  let published = false;
  const people = vi.fn(async () => ({
    people: published ? [{ pubkey: "9".repeat(64), name: "Zed" }] : [],
    hasMore: false,
  }));
  const t = setup();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Mention a member" });
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), "Zed");
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("Zed", 1, expect.any(AbortSignal)),
  );
  const calls = people.mock.calls.length;
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  published = true;
  // The picker stays mounted while closed, so this is the same hook instance.
  await user.click(trigger);
  const search = screen.getByRole("searchbox");
  if ((search as HTMLInputElement).value !== "Zed") {
    await user.clear(search);
    await user.type(search, "Zed");
  }
  await waitFor(() => expect(people.mock.calls.length).toBeGreaterThan(calls));
  expect(people).toHaveBeenLastCalledWith("Zed", 1, expect.any(AbortSignal));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: rowName("Zed", "Not in channel") }),
    ).toBeTruthy(),
  );
  t.library.dispose();
});

it("names the choice set only while the picker is shown, and qualifies namesakes in both menus", async () => {
  const t = setup();
  const member = "a".repeat(64),
    namesake = "c".repeat(64);
  const profiles = new Map([
    [member, { name: "Larry" }],
    [namesake, { name: "Larry" }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "parent",
        name: "Parent",
        channelType: "stream" as const,
        members: [member, namesake],
      },
    ],
  };
  const session = {
    ...t.session,
    profiles: { ...t.session.profiles, snapshot: () => profiles },
    channels: { ...t.session.channels, list: () => list },
  };
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: t.library.queries },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const scope = vi.spyOn(names, "scope");
  const labels = [member, namesake].map(
    (key) => `Larry · ${npubEncode(key).slice(-4)}`,
  );
  const picker = (disabled: boolean) => (
    <MentionPicker
      scope="test"
      session={{ ...session, names }}
      channelId="parent"
      disabled={disabled}
      select={() => true}
    />
  );
  const view = render(picker(false));
  view.rerender(picker(false));
  expect(scope).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  for (const label of labels)
    expect(
      await screen.findByRole("button", { name: rowName(label) }),
    ).toBeInTheDocument();
  view.rerender(picker(true));
  scope.mockClear();
  view.rerender(picker(true));
  expect(scope).not.toHaveBeenCalled();
  view.unmount();
  const publish = vi.fn();
  render(
    <MentionCompletion
      session={{ ...session, names }}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Larry", start: 6, end: 6 }}
      query={{ start: 0, end: 6, query: "Larry" }}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items
        .map((item) => item.label)
        .sort(),
    ).toEqual([...labels].sort()),
  );
  names.dispose();
  t.library.dispose();
});

it.each([false, true])(
  "shows agent loading only without retained mention choices (warm=%s)",
  async (warm) => {
    const test = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = !warm;
    const read = vi.fn(async () => {
      if (held) await gate;
      return {
        definitions: [],
        identities: [{ pubkey: test.key, name: "Outside agent" }],
      };
    });
    const library = createAgentLibrary(read);
    if (warm) await library.queries.refresh();
    const session = {
      ...test.session,
      agentChoices: createAgentChoices({
        scope: "test",
        library: library.queries,
        signal: new AbortController().signal,
      }),
    };
    const view = render(
      <MentionPicker
        session={session}
        scope="test"
        channelId="parent"
        disabled={false}
        inviteAgents
        select={() => true}
      />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Mention a member" }));
      if (warm) {
        await outsideRow();
        held = true;
        act(() => {
          void session.agentChoices.refresh();
        });
      }
      await waitFor(() => expect(read).toHaveBeenCalledTimes(warm ? 2 : 1));
      expect(session.agentChoices.snapshot().status).toBe("loading");
      if (warm) {
        expect(
          screen.getByRole("button", { name: rowName("Member") }),
        ).toBeVisible();
        expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
      } else {
        // A cold agent read does not hide the already-known channel member.
        expect(
          screen.getByRole("button", { name: rowName("Member") }),
        ).toBeVisible();
        expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
      }
      await act(async () => release());
      await waitFor(() =>
        expect(session.agentChoices.snapshot().status).toBe("ready"),
      );
      expect(await outsideRow()).toBeEnabled();
      expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
    } finally {
      await act(async () => release());
      view.unmount();
      library.dispose();
      test.library.dispose();
    }
  },
);

function teamFixture(
  agents?: string[],
  options: {
    status?: "ready" | "loading" | "error";
    query?: string;
    invite?: boolean;
    dm?: boolean;
    missingRoster?: boolean;
  } = {},
) {
  const h = setup();
  let state = {
    status: options.status ?? "ready",
    entries: [
      {
        eventId: "head",
        createdAt: 1,
        record: {
          version: 1 as const,
          community: "fixture",
          deleted: false,
          value: {
            type: "team" as const,
            id: "court",
            name: "Member Team",
            agents: agents ?? [h.member, h.key],
          },
        },
      },
    ],
  };
  const listeners = new Set<() => void>();
  const channelKit: NonNullable<RelaySession["channelKit"]> = {
    available: true,
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {},
    async refresh() {},
    async save() {
      return "head";
    },
  };
  const list = {
    ...h.session.channels.list(),
    channels: h.session.channels.list().channels.map((channel) => {
      const { members, ...rest } = channel;
      return {
        ...rest,
        ...(members && !options.missingRoster ? { members } : {}),
        ...(options.dm ? { channelType: "dm" as const } : {}),
      };
    }),
  };
  const publish = vi.fn();
  const props = {
    session: {
      ...h.session,
      channelKit,
      channels: {
        ...h.session.channels,
        list: () => list,
      },
    },
    scope: "team-test",
    inviteAgents: options.invite,
    channelId: "parent",
    observation: { revision: 1, text: "@Member", start: 7, end: 7 },
    query: { start: 0, end: 7, query: options.query ?? "Member" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const result = () =>
    publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const choice = () => result()?.items.find((item) => item.id === "team:court");
  return {
    ...h,
    view,
    choice,
    result,
    change() {
      act(() => {
        state = {
          ...state,
          entries: state.entries.map((entry) => ({
            ...entry,
            eventId: "changed-head",
          })),
        };
        for (const listener of listeners) listener();
      });
    },
  };
}
it("saved teams resolve exact keys, block automatic Space and revoke a changed catalog choice", async () => {
  const h = teamFixture();
  try {
    await waitFor(() => expect(h.choice()?.disabled).toBeUndefined());
    await waitFor(() =>
      expect(h.choice()?.edit.mentions).toEqual([
        { pubkey: h.member, name: "Member" },
        { pubkey: h.key, name: "Outside agent" },
      ]),
    );
    expect(h.result()?.spaceId).toBeUndefined();
    // The team's longer name blocks every key that ends the typed name.
    const member = h.result()?.items.find((item) => item.id === h.member);
    expect(member?.canSelect?.("Enter")).toBe(true);
    for (const key of [" ", ",", "'", "’", ")"])
      expect(member?.canSelect?.(key), key).toBe(false);
    const selected = h.choice();
    if (!selected) throw new Error("Team missing");
    expect(selected.canSelect?.("Enter")).toBe(true);
    h.change();
    expect(selected.canSelect?.("Enter")).toBe(false);
    expect(h.choice()?.disabled).toContain("changed");
  } finally {
    h.view.unmount();
    h.library.dispose();
  }
});
it.each([
  { members: [] },
  { members: ["c".repeat(64)] },
  {
    members: Array.from({ length: 33 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ),
  },
])(
  "keeps empty, unavailable and oversized teams visible but disabled (%j)",
  async ({ members }) => {
    const h = teamFixture(members);
    try {
      await waitFor(() => expect(h.choice()?.disabled).toBeTruthy());
      expect(h.choice()?.canSelect?.("Enter")).toBe(false);
      expect(h.choice()?.edit.mentions).toBeUndefined();
    } finally {
      h.view.unmount();
      h.library.dispose();
    }
  },
);
it("archive changes revoke previously published team acceptance", async () => {
  const h = teamFixture();
  try {
    await waitFor(() => expect(h.choice()?.edit.mentions).toHaveLength(2));
    const selected = h.choice();
    if (!selected) throw new Error("Team missing");
    act(() => h.setArchived([h.key]));
    expect(selected.canSelect?.("Enter")).toBe(false);
    expect(h.choice()?.disabled).toContain("unavailable");
  } finally {
    h.view.unmount();
    h.library.dispose();
  }
});

it.each(["loading", "error"] as const)(
  "team catalog %s does not publish choices or Retry for ordinary prose",
  (status) => {
    const h = teamFixture(undefined, { status, query: " 5pm" });
    try {
      expect(h.result()).toEqual({ items: [] });
    } finally {
      h.view.unmount();
      h.library.dispose();
    }
  },
);
it("team loading has no Retry action and never replaces a people status", async () => {
  const loading = teamFixture(undefined, { status: "loading" });
  await waitFor(() =>
    expect(loading.result()?.status).toBe("Loading legacy teams…"),
  );
  expect(loading.result()?.retry).toBeUndefined();
  loading.view.unmount();
  loading.library.dispose();
  const missing = teamFixture(undefined, {
    status: "error",
    missingRoster: true,
  });
  expect(missing.result()?.status).toBe("Channel membership unavailable.");
  missing.view.unmount();
  missing.library.dispose();
});
it("a longer team name remains an admitted query after a person's exact name plus Space", async () => {
  const h = teamFixture(undefined, { query: "Member " });
  try {
    await waitFor(() => expect(h.choice()?.edit.mentions).toHaveLength(2));
    expect(h.result()?.items[0]).toMatchObject({
      id: h.member,
      label: "Member",
      edit: { mention: { pubkey: h.member, name: "Member" } },
    });
    expect(h.result()?.items[0]?.canSelect?.("Enter")).toBe(true);
  } finally {
    h.view.unmount();
    h.library.dispose();
  }
});
it("team rows never bypass query admission", () => {
  const h = teamFixture(undefined, { query: "Member Team " });
  try {
    expect(h.result()).toEqual({ items: [] });
  } finally {
    h.view.unmount();
    h.library.dispose();
  }
});
it.each([
  {
    options: { invite: true },
    detail: "Adds 1 to channel when you send",
  },
  { options: { dm: true }, detail: "1 not in DM · Will not be notified" },
  {
    options: {},
    detail: "1 not in channel",
  },
])(
  "team choice explains destination consequences: $detail",
  async ({ options, detail }) => {
    const h = teamFixture(undefined, options);
    try {
      await waitFor(() => expect(h.choice()?.detail).toContain(detail));
    } finally {
      h.view.unmount();
      h.library.dispose();
    }
  },
);
type DirectoryPage = {
  people: { pubkey: string; name: string; isAgent?: true }[];
  hasMore: boolean;
};
/** Other members map to a profile name, or null for a profile still loading. */
function spaceFixture(
  memberName: string,
  others: Record<string, string | null> = {},
  options: { query?: string; dm?: boolean; teams?: readonly string[] } = {},
) {
  const h = setup();
  h.profiles.set(h.member, { name: memberName });
  for (const [key, name] of Object.entries(others))
    if (name !== null) h.profiles.set(key, { name });
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "parent",
        channelType: options.dm ? ("dm" as const) : ("stream" as const),
        members: [h.member, ...Object.keys(others)],
      },
    ],
  };
  const query = options.query ?? "jose";
  let finish: (value: DirectoryPage) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const people = vi.fn(
    () =>
      new Promise<DirectoryPage>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  // The real naming policy, so namesakes get the labels users see.
  const names = bindNames(
    { profiles: h.session.profiles, agentLibrary: h.library.queries },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  const result = () =>
    publish.mock.lastCall?.[0] as CompletionResult | undefined;
  // Legacy catalog teams with these names, each of the member alone.
  const catalog = {
    status: "ready" as const,
    entries: (options.teams ?? []).map((name, index) => ({
      eventId: `team-${index}`,
      createdAt: 1,
      record: {
        version: 1 as const,
        community: "fixture",
        deleted: false,
        value: {
          type: "team" as const,
          id: `team-${index}`,
          name,
          agents: [h.member],
        },
      },
    })),
  };
  const channelKit: NonNullable<RelaySession["channelKit"]> = {
    available: true,
    snapshot: () => catalog,
    subscribe: () => () => {},
    ensure() {},
    async refresh() {},
    async save() {
      return "head";
    },
  };
  const session = {
    ...h.session,
    names,
    ...(options.teams ? { channelKit } : {}),
    channels: { ...h.session.channels, list: () => list },
    directMessages: { ...h.session.directMessages, people },
  } as unknown as RelaySession;
  const end = query.length + 1;
  const view = render(
    <MentionCompletion
      session={session}
      scope="space-test"
      channelId="parent"
      observation={{ revision: 1, text: `@${query}`, start: end, end }}
      query={{ start: 0, end, query }}
      publish={publish}
    />,
  );
  return {
    ...h,
    session,
    people,
    result,
    finish: (page: DirectoryPage) => act(async () => finish(page)),
    fail: () => act(async () => fail(new Error("offline"))),
    canSpace: (id: string) =>
      result()
        ?.items.find((item) => item.id === id)
        ?.canSelect?.(" "),
    dispose() {
      view.unmount();
      names.dispose();
      h.library.dispose();
    },
  };
}
const outsideJose = "f".repeat(64);
const otherMember = "d".repeat(64);
it.each([
  { people: [], hasMore: false },
  { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: false },
  { people: [], hasMore: true },
  "error" as const,
])(
  "Space selects a unique exact member name without waiting for the directory (%j)",
  async (page) => {
    const h = spaceFixture("José");
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
      );
      // Typing straight on from the name must not race the directory search.
      expect(h.result()?.spaceId).toBe(h.member);
      expect(h.canSpace(h.member)).toBe(true);
      await (page === "error" ? h.fail() : h.finish(page));
      // Directory namesakes and failures cannot unsettle a member's name.
      await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
      expect(h.canSpace(h.member)).toBe(true);
    } finally {
      h.dispose();
    }
  },
);
it.each([
  { case: "a member namesake", others: { [otherMember]: "Jose" } },
  { case: "a member's longer name", others: { [otherMember]: "Jose Luis" } },
  // Its name may be "Jose"; only the directory can say before profiles load.
  { case: "an unnamed member", others: { [otherMember]: null } },
])("Space leaves a member's name as prose beside $case", async ({ others }) => {
  const h = spaceFixture("José", others);
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
    );
    await waitFor(() =>
      expect(h.result()?.items.some((item) => item.id === h.member)).toBe(true),
    );
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.canSpace(h.member)).toBe(false);
    await h.finish({
      people: [{ pubkey: otherMember, name: others[otherMember] ?? "Jose" }],
      hasMore: false,
    });
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.canSpace(h.member)).toBe(false);
  } finally {
    h.dispose();
  }
});
it("Space keeps a member's name when an identically named outside namesake is qualified", async () => {
  const h = spaceFixture("Jose");
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
    );
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose" }],
      hasMore: false,
    });
    // Both now show `Jose · <key suffix>`; a suffix is not a longer name.
    await waitFor(() =>
      expect(
        h.result()?.items.find((item) => item.id === outsideJose)?.label,
      ).toMatch(/^Jose · /),
    );
    expect(
      h.result()?.items.find((item) => item.id === h.member)?.label,
    ).toMatch(/^Jose · /);
    expect(h.result()?.spaceId).toBe(h.member);
    expect(h.canSpace(h.member)).toBe(true);
    expect(h.canSpace(outsideJose)).toBe(false);
  } finally {
    h.dispose();
  }
});
it("Space selects a member by a pasted npub beside a namesake, without waiting for the directory", async () => {
  const query = npubEncode("a".repeat(64));
  const h = spaceFixture("Jose", { [otherMember]: "Jose" }, { query });
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith(query, 1, expect.anything()),
    );
    // A key has no namesakes: only its owner is listed, and Space selects it.
    await waitFor(() =>
      expect(h.result()?.items.map((item) => item.id)).toEqual([h.member]),
    );
    expect(h.result()?.spaceId).toBe(h.member);
    expect(h.canSpace(h.member)).toBe(true);
  } finally {
    h.dispose();
  }
});
it.each([
  { case: "that name", suffix: "" },
  { case: "a longer name", suffix: " Crew" },
])(
  "Space selects a member by a pasted npub beside a saved team with $case",
  async ({ suffix }) => {
    const query = npubEncode("a".repeat(64));
    const h = spaceFixture("Jose", {}, { query, teams: [query + suffix] });
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith(query, 1, expect.anything()),
      );
      // A key is not a name: the team neither matches it nor declines Space.
      await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
      expect(h.result()?.items.map((item) => item.id)).toEqual([h.member]);
      expect(h.canSpace(h.member)).toBe(true);
    } finally {
      h.dispose();
    }
  },
);
it("Space selects someone outside the channel by a pasted npub once the directory finds them", async () => {
  const query = npubEncode(outsideJose);
  const h = spaceFixture("Jose", {}, { query });
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith(query, 1, expect.anything()),
    );
    expect(h.result()?.items.some((item) => item.id === outsideJose)).toBe(
      false,
    );
    expect(h.result()?.spaceId).toBeUndefined();
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose" }],
      hasMore: false,
    });
    await waitFor(() => expect(h.result()?.spaceId).toBe(outsideJose));
    expect(h.result()?.items.map((item) => item.id)).toEqual([outsideJose]);
    expect(h.canSpace(outsideJose)).toBe(true);
  } finally {
    h.dispose();
  }
});
it.each([
  { name: "Jose", namesake: false, space: true },
  { name: "Jose", namesake: true, space: true },
  { name: "Jose (agent)", namesake: false, space: false },
])(
  "Space distinguishes an agent qualifier from the real name (%j)",
  async ({ name, namesake, space }) => {
    const h = spaceFixture("Jose");
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
      );
      expect(h.result()?.spaceId).toBe(h.member);
      await h.finish({
        people: [
          { pubkey: outsideJose, name, isAgent: true },
          ...(namesake
            ? [{ pubkey: "e".repeat(64), name, isAgent: true as const }]
            : []),
        ],
        hasMore: false,
      });
      await waitFor(() =>
        expect(
          h.result()?.items.find((item) => item.id === outsideJose)?.label,
        ).toMatch(namesake ? /^Jose \(agent\) · / : /^Jose \(agent\)$/),
      );
      expect(h.result()?.spaceId).toBe(space ? h.member : undefined);
      expect(h.canSpace(h.member)).toBe(space);
      expect(h.canSpace(outsideJose)).toBe(false);
    } finally {
      h.dispose();
    }
  },
);
it("Space leaves a member's name as prose once the directory finds a longer outside name", async () => {
  const h = spaceFixture("Jose");
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
    );
    // A longer outside name cannot block before the directory reports it.
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: false,
    });
    await waitFor(() =>
      expect(h.result()?.items.some((item) => item.id === outsideJose)).toBe(
        true,
      ),
    );
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.canSpace(h.member)).toBe(false);
  } finally {
    h.dispose();
  }
});
it.each([
  {
    page: { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: false },
    space: true,
  },
  {
    page: { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: true },
    space: false,
  },
  {
    page: {
      people: [
        { pubkey: outsideJose, name: "Jose" },
        { pubkey: "e".repeat(64), name: "José" },
      ],
      hasMore: false,
    },
    space: false,
  },
])(
  "Space waits for the full directory before it selects an outside name (%j)",
  async ({ page, space }) => {
    const h = spaceFixture("Member");
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
      );
      expect(h.result()?.spaceId).toBeUndefined();
      await h.finish(page);
      await waitFor(() =>
        expect(h.result()?.items.some((item) => item.id === outsideJose)).toBe(
          true,
        ),
      );
      expect(h.result()?.spaceId).toBe(space ? outsideJose : undefined);
      expect(h.canSpace(outsideJose)).toBe(space);
    } finally {
      h.dispose();
    }
  },
);
const outsideNamesake = { pubkey: "e".repeat(64), name: "José" };
it.each([
  { case: "no match", page: { people: [], hasMore: false } },
  {
    case: "a namesake",
    page: {
      people: [{ pubkey: outsideJose, name: "Jose" }, outsideNamesake],
      hasMore: false,
    },
  },
  {
    case: "a longer name",
    page: {
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: false,
    },
  },
  {
    case: "more pages",
    page: { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: true },
  },
  { case: "a failed search", page: "error" as const },
])(
  "Space may hold an outside name as pending only until the directory settles with $case",
  async ({ page }) => {
    const h = spaceFixture("Member");
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith("jose", 1, expect.anything()),
      );
      // Undecided, not declined: the search is still running.
      expect(h.result()?.spaceId).toBeUndefined();
      expect(h.result()?.spacePending?.name).toBe("jose");
      await (page === "error" ? h.fail() : h.finish(page));
      await waitFor(() => expect(h.result()?.spacePending).toBeUndefined());
      expect(h.result()?.spaceId).toBeUndefined();
    } finally {
      h.dispose();
    }
  },
);
it("Space holds nothing once it can decide", async () => {
  const h = spaceFixture("José");
  try {
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    expect(h.result()?.spacePending).toBeUndefined();
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose" }],
      hasMore: false,
    });
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    expect(h.result()?.spacePending).toBeUndefined();
  } finally {
    h.dispose();
  }
});
it("Space is declined, not pending, beside a loaded name that continues the query", async () => {
  const h = spaceFixture("Mira Example", {}, { query: "mira" });
  try {
    await waitFor(() =>
      expect(h.people).toHaveBeenCalledWith("mira", 1, expect.anything()),
    );
    await waitFor(() =>
      expect(h.result()?.items.some((item) => item.id === h.member)).toBe(true),
    );
    // The read is in flight, but `Mira Example` continues `mira` whatever it
    // finds: Space is prose now and `@mira Example ` can still select it.
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.result()?.spacePending).toBeUndefined();
    await h.finish({ people: [], hasMore: false });
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.result()?.spacePending).toBeUndefined();
  } finally {
    h.dispose();
  }
});
it.each(["jose ", "jose,", "", "jose luis"])(
  "Space never holds %j as a pending mention",
  async (query) => {
    const h = spaceFixture("Member", {}, { query });
    try {
      await waitFor(() =>
        expect(h.people).toHaveBeenCalledWith(query, 1, expect.anything()),
      );
      expect(h.result()).toBeDefined();
      expect(h.result()?.spacePending).toBeUndefined();
    } finally {
      h.dispose();
    }
  },
);
it("a saved team with the name never leaves Space pending", async () => {
  // No roster: nothing local decides, and the directory search is running.
  const h = teamFixture(undefined, { missingRoster: true });
  try {
    await waitFor(() => expect(h.result()).toBeDefined());
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.result()?.spacePending).toBeUndefined();
  } finally {
    h.view.unmount();
    h.library.dispose();
  }
});
it("Space holds an agent's name while an invite scope's inventory loads, and the resolver selects it once loaded", async () => {
  const test = setup(false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async () => {
    await gate;
    return {
      definitions: [],
      identities: [{ pubkey: test.key, name: "Aaron" }],
    };
  });
  const library = createAgentLibrary(read);
  const session = {
    ...test.session,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  };
  const publish = vi.fn();
  const result = () => publish.mock.lastCall?.[0] as CompletionResult;
  const view = render(
    <MentionCompletion
      {...emptyCompletion}
      session={session}
      inviteAgents
      observation={{ revision: 1, text: "@Aaron", start: 6, end: 6 }}
      query={{ start: 0, end: 6, query: "Aaron" }}
      publish={publish}
    />,
  );
  try {
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(result().spaceId).toBeUndefined();
    expect(result().spacePending?.name).toBe("Aaron");
    const pending = result().spacePending?.resolve(
      new AbortController().signal,
    );
    await act(async () => release());
    await expect(pending).resolves.toEqual({ pubkey: test.key, name: "Aaron" });
    // The resolver joined the read in flight rather than starting another.
    expect(read).toHaveBeenCalledOnce();
    await waitFor(() => expect(result().spaceId).toBe(test.key));
    expect(result().spacePending).toBeUndefined();
  } finally {
    await act(async () => release());
    view.unmount();
    library.dispose();
    test.library.dispose();
  }
});
const resolver = (
  h: { session: RelaySession },
  signal = new AbortController().signal,
) =>
  resolveSpaceMention(
    h.session,
    { channelId: "parent", selected: [] },
    "jose",
    signal,
  );
it.each([
  {
    case: "a unique outside name",
    page: { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: false },
    recipient: { pubkey: outsideJose, name: "Jose" },
  },
  {
    case: "a namesake",
    page: {
      people: [{ pubkey: outsideJose, name: "Jose" }, outsideNamesake],
      hasMore: false,
    },
    recipient: null,
  },
  {
    // Only a longer name kept it from selecting: the host may extend the chip.
    case: "a longer name",
    page: {
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: false,
    },
    recipient: { continued: ["Jose Luis"] },
  },
  {
    case: "a longer name on a truncated page",
    page: {
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: true,
    },
    recipient: null,
  },
  {
    case: "more pages",
    page: { people: [{ pubkey: outsideJose, name: "Jose" }], hasMore: true },
    recipient: null,
  },
  { case: "a failed search", page: "error" as const, recipient: null },
])(
  "the resolver settles an outside name once the directory reports $case",
  async ({ page, recipient }) => {
    const h = spaceFixture("Member");
    try {
      await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
      const pending = resolver(h);
      // The chooser's read is in flight and uncached; the resolver reads at
      // once, with no typing pause.
      await waitFor(() => expect(h.people).toHaveBeenCalledTimes(2));
      await (page === "error" ? h.fail() : h.finish(page));
      expect(outcomeOf(await pending)).toEqual(recipient);
    } finally {
      h.dispose();
    }
  },
);
it("the resolver leaves a one-character outside name unread and unselected", async () => {
  const h = spaceFixture("Member");
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    const calls = h.people.mock.calls.length;
    await expect(
      resolveSpaceMention(
        h.session,
        { channelId: "parent", selected: [] },
        "q",
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    expect(h.people).toHaveBeenCalledTimes(calls);
  } finally {
    h.dispose();
  }
});
/** A resolution for assertions: the recipient, null, or the continuing names. */
const outcomeOf = (outcome: SpaceMentionResolution | undefined) =>
  outcome && "continued" in outcome
    ? { continued: outcome.continued.map((c) => c.name) }
    : outcome;
const continuedOf = (outcome: SpaceMentionResolution) => {
  if (!outcome || !("continued" in outcome))
    throw new Error(`Not continued: ${JSON.stringify(outcome)}`);
  return outcome.continued;
};
it("the resolver's continuing names each resolve under the same rule over the page already read", async () => {
  const h = spaceFixture("Member");
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    const pending = resolver(h);
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(2));
    const garcia = { pubkey: "e".repeat(64), name: "Jose Luis Garcia" };
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose Luis" }, garcia],
      hasMore: false,
    });
    const continued = continuedOf(await pending);
    expect(continued.map((c) => c.name)).toEqual([
      "Jose Luis",
      "Jose Luis Garcia",
    ]);
    const signal = new AbortController().signal;
    // `Jose Luis` is itself continued; the longest name selects.
    expect(outcomeOf(await continued[0]?.resolve(signal))).toEqual({
      continued: ["Jose Luis Garcia"],
    });
    await expect(continued[1]?.resolve(signal)).resolves.toEqual(garcia);
    await expect(
      continued[1]?.resolve(AbortSignal.abort()),
    ).resolves.toBeNull();
    // Every name that equals or continues a longer name is on the page for
    // its prefix, so no further read is needed.
    expect(h.people).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});
it("the resolver's continuing name in a DM resolves to prose when it is an outsider", async () => {
  const h = spaceFixture("Member", {}, { dm: true });
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    const pending = resolver(h);
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(2));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: false,
    });
    const continued = continuedOf(await pending);
    expect(continued.map((c) => c.name)).toEqual(["Jose Luis"]);
    await expect(
      continued[0]?.resolve(new AbortController().signal),
    ).resolves.toBeNull();
  } finally {
    h.dispose();
  }
});
it("the resolver continues a roster name into the roster's longer name without the directory", async () => {
  const h = spaceFixture("Jose");
  try {
    const luis = { pubkey: outsideJose, name: "Jose Luis" };
    const scope = {
      channelId: "parent",
      roster: { recipients: [{ pubkey: h.member, name: "Josefa" }, luis] },
      selected: [],
    };
    const signal = new AbortController().signal;
    const continued = continuedOf(
      await resolveSpaceMention(h.session, scope, "jose", signal),
    );
    expect(continued.map((c) => c.name)).toEqual(["Jose Luis"]);
    await expect(continued[0]?.resolve(signal)).resolves.toEqual(luis);
    expect(h.people).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
it("the resolver reads a page the chooser already settled from the shared cache", async () => {
  const h = spaceFixture("Member");
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose" }],
      hasMore: false,
    });
    await expect(resolver(h)).resolves.toEqual({
      pubkey: outsideJose,
      name: "Jose",
    });
    expect(h.people).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});
it("the resolver reads a longer name's page out of the complete page for its prefix without another read", async () => {
  const h = spaceFixture("Member");
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose Luis" }],
      hasMore: false,
    });
    // The chooser's complete page for `jose` holds every match for `jose luis`.
    await expect(
      resolveSpaceMention(
        h.session,
        { channelId: "parent", selected: [] },
        "jose luis",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ pubkey: outsideJose, name: "Jose Luis" });
    expect(h.people).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});
it("the resolver returns a DM outsider to prose rather than promise a notification", async () => {
  const h = spaceFixture("Member", {}, { dm: true });
  try {
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
    const pending = resolver(h);
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(2));
    await h.finish({
      people: [{ pubkey: outsideJose, name: "Jose" }],
      hasMore: false,
    });
    await expect(pending).resolves.toBeNull();
  } finally {
    h.dispose();
  }
});
it("the resolver settles to prose when its chip is gone before the directory answers", async () => {
  const h = spaceFixture("Member");
  try {
    const controller = new AbortController();
    const pending = resolver(h, controller.signal);
    await waitFor(() => expect(h.people).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).resolves.toBeNull();
  } finally {
    h.dispose();
  }
});
it("the resolver settles to prose for a chip already gone, even where Space could decide at once", async () => {
  const h = spaceFixture("Jose");
  try {
    // A roster scope with an exact local match awaits nothing before it picks.
    const scope = {
      channelId: "parent",
      roster: { recipients: [{ pubkey: h.member, name: "Jose" }] },
      selected: [],
    };
    await expect(
      resolveSpaceMention(h.session, scope, "jose", AbortSignal.abort()),
    ).resolves.toBeNull();
    await expect(
      resolveSpaceMention(
        h.session,
        scope,
        "jose",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ pubkey: h.member, name: "Jose" });
  } finally {
    h.dispose();
  }
});
it("the resolver gives up at the wait bound", async () => {
  vi.useFakeTimers();
  const h = spaceFixture("Member");
  try {
    const pending = resolver(h);
    await vi.advanceTimersByTimeAsync(MENTION_RESOLVE_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  } finally {
    h.dispose();
  }
});
/**
 * A real profile directory, so a member read that settles or fails is evidence
 * the chooser sees. The directory search never settles: only step 1 of the
 * Space rule can select here.
 */
function unnamedMemberFixture() {
  const h = setup();
  const named = keypair();
  const reads: {
    authors: readonly string[];
    resolve: (events: RelayEvent[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  const directory = createProfileDirectory({
    read: (filters) =>
      new Promise<RelayEvent[]>((resolve, reject) => {
        reads.push({ authors: filters[0]?.authors ?? [], resolve, reject });
      }),
  });
  directory.accept([profile(named, { name: "José" })]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "parent",
        channelType: "stream" as const,
        members: [named.pubkey, otherMember],
      },
    ],
  };
  const names = bindNames(
    { profiles: directory.queries, agentLibrary: h.library.queries },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  const result = () =>
    publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const view = render(
    <MentionCompletion
      session={
        {
          ...h.session,
          profiles: directory.queries,
          names,
          channels: { ...h.session.channels, list: () => list },
          directMessages: {
            ...h.session.directMessages,
            people: () => new Promise<DirectoryPage>(() => {}),
          },
        } as unknown as RelaySession
      }
      scope="space-test"
      channelId="parent"
      observation={{ revision: 1, text: "@jose", start: 5, end: 5 }}
      query={{ start: 0, end: 5, query: "jose" }}
      publish={publish}
    />,
  );
  return {
    member: named.pubkey,
    reads,
    directory,
    result,
    canSpace: (id: string) =>
      result()
        ?.items.find((item) => item.id === id)
        ?.canSelect?.(" "),
    dispose() {
      view.unmount();
      names.dispose();
      directory.dispose();
      h.library.dispose();
    },
  };
}
it("Space selects a member's name once a read finds no profile for another member", async () => {
  const h = unnamedMemberFixture();
  try {
    await waitFor(() =>
      expect(h.reads.map((read) => read.authors)).toEqual([[otherMember]]),
    );
    await waitFor(() =>
      expect(h.result()?.items.some((item) => item.id === h.member)).toBe(true),
    );
    // While its read is in flight the other member may still be a namesake.
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.canSpace(h.member)).toBe(false);
    await act(async () => h.reads[0]?.resolve([]));
    // Known unnamed: no name to be a namesake, and no directory wait.
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    expect(h.canSpace(h.member)).toBe(true);
  } finally {
    h.dispose();
  }
});
it("Space holds a member's name while another member's read is in flight, and the resolver selects it once the read settles", async () => {
  const h = unnamedMemberFixture();
  try {
    await waitFor(() =>
      expect(h.reads.map((read) => read.authors)).toEqual([[otherMember]]),
    );
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.result()?.spacePending?.name).toBe("jose");
    const pending = h
      .result()
      ?.spacePending?.resolve(new AbortController().signal);
    await act(async () => h.reads[0]?.resolve([]));
    // Known unnamed: the member's exact name selects without the directory.
    await expect(pending).resolves.toEqual({ pubkey: h.member, name: "José" });
    // The resolver joined the read in flight rather than issuing another.
    expect(h.reads).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
it("Space keeps waiting after a member's profile read fails until a retry settles it", async () => {
  const h = unnamedMemberFixture();
  try {
    await waitFor(() => expect(h.reads).toHaveLength(1));
    await act(async () => h.reads[0]?.reject(new Error("offline")));
    // A failed read is not evidence that the member has no name.
    expect(h.directory.queries.unnamed?.()).toEqual(new Set());
    expect(h.result()?.spaceId).toBeUndefined();
    expect(h.canSpace(h.member)).toBe(false);
    act(() => h.result()?.retry?.());
    await waitFor(() => expect(h.reads).toHaveLength(2));
    expect(h.reads[1]?.authors).toEqual([otherMember]);
    await act(async () => h.reads[1]?.resolve([]));
    await waitFor(() => expect(h.result()?.spaceId).toBe(h.member));
    expect(h.canSpace(h.member)).toBe(true);
  } finally {
    h.dispose();
  }
});

function rosterFixture(
  members: readonly string[],
  second: readonly string[] = [],
  answer: (authors: readonly string[]) => RelayEvent[] = () => [],
) {
  const h = setup();
  const reads: { authors: readonly string[] }[] = [];
  const directory = createProfileDirectory({
    read: async (filters) => {
      const authors = filters[0]?.authors ?? [];
      reads.push({ authors });
      return answer(authors);
    },
  });
  const list = {
    status: "ready" as const,
    channels: [
      { id: "parent", channelType: "stream" as const, members },
      { id: "second", channelType: "stream" as const, members: second },
    ],
  };
  const names = bindNames(
    { profiles: directory.queries, agentLibrary: h.library.queries },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const session = {
    ...h.session,
    profiles: directory.queries,
    names,
    channels: { ...h.session.channels, list: () => list },
    directMessages: {
      ...h.session.directMessages,
      people: () => new Promise<DirectoryPage>(() => {}),
    },
  } as unknown as RelaySession;
  const mount = (channelId = "parent") =>
    render(
      <MentionCompletion
        session={session}
        scope="space-test"
        channelId={channelId}
        observation={{ revision: 1, text: "@jo", start: 3, end: 3 }}
        query={{ start: 0, end: 3, query: "jo" }}
        publish={vi.fn()}
      />,
    );
  return {
    reads,
    directory,
    mount,
    requested: () => new Set(reads.flatMap((read) => read.authors)),
    dispose() {
      names.dispose();
      directory.dispose();
      h.library.dispose();
    },
  };
}

it("loads an open channel's whole roster when it reserves room past the base", async () => {
  const roster = unsignedProfiles(1100).map((event) => event.pubkey);
  const h = rosterFixture(roster);
  const release = h.directory.queries.reserve?.(roster.length);
  try {
    const view = h.mount();
    await waitFor(() => expect(h.requested().size).toBe(1100));
    view.unmount();
  } finally {
    release?.();
    h.dispose();
  }
});

it("keeps the base cache for other names when a roster passes the cap", async () => {
  const roster = unsignedProfiles(11_000, "M");
  const byKey = new Map(roster.map((event) => [event.pubkey, event]));
  const h = rosterFixture(
    roster.map((event) => event.pubkey),
    [],
    (authors) => authors.flatMap((id) => byKey.get(id) ?? []),
  );
  const others = unsignedProfiles(PROFILE_CACHE_BASE, "O");
  h.directory.accept(others);
  const release = h.directory.queries.reserve?.(roster.length);
  try {
    expect(h.directory.queries.limit?.()).toBe(PROFILE_CACHE_MAX);
    const view = h.mount();
    await waitFor(() =>
      expect(h.requested().size).toBe(PROFILE_CACHE_MAX - PROFILE_CACHE_BASE),
    );
    await waitFor(() =>
      expect(h.directory.queries.snapshot().size).toBe(PROFILE_CACHE_MAX),
    );
    // The roster used only its reserved room: no other name was evicted.
    expect(
      others.every((event) => h.directory.queries.snapshot().has(event.pubkey)),
    ).toBe(true);
    view.unmount();
  } finally {
    release?.();
    h.dispose();
  }
});

it("loads a second large channel's whole roster after the first one's", async () => {
  const first = unsignedProfiles(1500, "A").map((event) => event.pubkey);
  const second = unsignedProfiles(1500, "B").map((event) => event.pubkey);
  const h = rosterFixture(first, second);
  let release = h.directory.queries.reserve?.(first.length);
  try {
    let view = h.mount();
    await waitFor(() => expect(h.requested().size).toBe(1500));
    view.unmount();
    // Navigating swaps one equal reservation for the other: nothing shrinks
    // or evicts, so only this roster's own requests may use its allowance.
    release?.();
    release = h.directory.queries.reserve?.(second.length);
    view = h.mount("second");
    await waitFor(() =>
      expect(second.every((id) => h.requested().has(id))).toBe(true),
    );
    view.unmount();
  } finally {
    release?.();
    h.dispose();
  }
});

it("asks again for a member's name after the cache evicted it, but not for a known-unnamed one", async () => {
  const member = keypair();
  const ghost = keypair();
  const h = rosterFixture([member.pubkey, ghost.pubkey]);
  try {
    h.directory.accept([profile(member, { name: "Jo" })]);
    let view = h.mount();
    // The read finds no profile for the ghost, so it is known unnamed.
    await waitFor(() =>
      expect(h.directory.queries.unnamed?.().has(ghost.pubkey)).toBe(true),
    );
    view.unmount();
    expect(h.requested().has(member.pubkey)).toBe(false);
    expect(h.reads).toHaveLength(1);
    // Unrelated profiles push the member out of the 1,024-entry base.
    h.directory.accept(unsignedProfiles(1024, "Other "));
    expect(h.directory.queries.snapshot().has(member.pubkey)).toBe(false);
    view = h.mount();
    await waitFor(() => expect(h.requested().has(member.pubkey)).toBe(true));
    view.unmount();
    expect(
      h.reads.filter((read) => read.authors.includes(ghost.pubkey)),
    ).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
