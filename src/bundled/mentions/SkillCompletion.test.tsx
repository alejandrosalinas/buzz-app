// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import { AddressedAgentsContext } from "../../features/messages/selected-mention-context";
import { SkillCompletion, skillQuery } from "./SkillCompletion";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("matches `/` and name characters at a word start, never mid-word or past a space", () => {
  for (const text of ["/", "/re", "use /re", "(/re", "[/re", "\n/re-view"])
    expect(skillQuery(text, text.length)).toEqual({
      start: text.lastIndexOf("/"),
      end: text.length,
      query: text.slice(text.lastIndexOf("/") + 1),
    });
  for (const text of [
    "and/or",
    "https://example.org",
    "see https://example.org/a",
    "/re view",
    "/ re",
    "a/",
  ])
    expect(skillQuery(text, text.length)).toBeNull();
  // The bounded look-back starting at a `/` inside a word is no boundary.
  const word = `${"x".repeat(10)}/${"n".repeat(159)}`;
  expect(skillQuery(word, word.length)).toBeNull();
});

const viewer = "a".repeat(64);
const claude = "c".repeat(64);
const codex = "d".repeat(64);
const remote = "e".repeat(64);
const theirs = "f".repeat(64);
const person = "b".repeat(64);
const identities = [
  {
    pubkey: claude,
    name: "Claude",
    managed: true,
    execution: "local",
    type: "buzz.claude-code/claude-code",
  },
  {
    pubkey: codex,
    name: "Codex",
    managed: true,
    execution: "local",
    type: "buzz.codex/codex",
  },
  {
    pubkey: remote,
    name: "Remote",
    managed: true,
    execution: "remote",
    type: "buzz.claude-code/claude-code",
  },
  // Someone else's agent: not a managed choice on this machine.
  { pubkey: theirs, name: "Theirs", managed: false },
];
const choices = { identities, pending: false };
const session = {
  agentChoices: {
    // A stable snapshot, as the real source caches it.
    snapshot: () => choices,
    subscribe: () => () => {},
    retain: () => () => {},
    ensure: () => {},
    refresh: async () => {},
  },
} as unknown as ComposerCompletionProps["session"];
const rows = [
  {
    name: "review",
    description: "Reviews a diff",
    path: "/home/example/.claude/skills/review/SKILL.md",
    displayPath: "~/.claude/skills/review/SKILL.md",
  },
  {
    name: "write",
    description: "",
    path: "/home/example/.claude/skills/write/SKILL.md",
    displayPath: "~/.claude/skills/write/SKILL.md",
  },
];

/** One `/` query at position 0 in `channelId`'s composer, addressing
 * `addressed`. `remount` swaps in a new provider in one commit, as the host
 * does per keystroke. */
function showSkills(
  channelId: string,
  addressed: readonly string[],
  query: string,
) {
  let publish = vi.fn();
  let mounts = 0;
  const element = (text: string) => (
    <AddressedAgentsContext.Provider value={addressed}>
      <SkillCompletion
        key={mounts++}
        session={session}
        scope={`https://one.example:${viewer}`}
        channelId={channelId}
        observation={{
          revision: 0,
          text: `/${text}`,
          start: text.length + 1,
          end: text.length + 1,
        }}
        publish={publish}
        query={{ start: 0, end: text.length + 1, query: text }}
      />
    </AddressedAgentsContext.Provider>
  );
  const view = render(element(query));
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  return {
    view,
    last,
    labels: () => last()?.items.map((item) => item.label),
    remount(text: string) {
      publish = vi.fn();
      view.rerender(element(text));
    },
  };
}

it("offers the one addressed local agent's skills as chips for that agent, listed once per query", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset().mockResolvedValue(rows);
  // A mentioned person does not stop the one agent from being the target.
  const shown = showSkills("one", [person, claude], "");
  await waitFor(() => expect(shown.labels()).toEqual(["review", "write"]));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("local_skills_list", {
    roots: ["~/.claude/skills"],
  });
  expect(shown.last()?.items[0]).toMatchObject({
    id: "skill:/home/example/.claude/skills/review/SKILL.md",
    label: "review",
    edit: {
      token: {
        kind: "skill",
        id: "/home/example/.claude/skills/review/SKILL.md",
        label: "review",
        target: claude,
      },
    },
  });
  // The host remounts per keystroke; the query keeps its listing.
  shown.remount("rev");
  await waitFor(() => expect(shown.labels()).toEqual(["review"]));
  expect(invoke).toHaveBeenCalledOnce();
  // A query that names no skill is prose, as a path is.
  shown.remount("usr");
  await act(async () => {});
  expect(shown.last()).toBeUndefined();
  shown.view.unmount();

  vi.mocked(invoke).mockClear();
  const other = showSkills("two", [codex], "");
  await waitFor(() => expect(other.labels()).toEqual(["review", "write"]));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("local_skills_list", {
    roots: ["$CODEX_HOME/skills", "~/.agents/skills"],
  });
  expect(other.last()?.items[0]?.edit).toMatchObject({
    token: { target: codex },
  });
  other.view.unmount();
});

it("lists nothing unless one addressed agent is the viewer's own local Claude or Codex agent", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset().mockResolvedValue(rows);
  for (const addressed of [
    [],
    [person],
    [remote],
    [theirs],
    ["9".repeat(64)],
  ]) {
    const shown = showSkills("none", addressed, "");
    await act(async () => {});
    expect(shown.last()).toBeUndefined();
    shown.view.unmount();
  }
  expect(invoke).not.toHaveBeenCalled();

  // Several agents ask for one.
  const several = showSkills("several", [claude, codex], "");
  await waitFor(() =>
    expect(several.last()).toEqual({
      items: [],
      status: "Mention one agent to choose a skill.",
    }),
  );
  several.view.unmount();
  expect(invoke).not.toHaveBeenCalled();

  // A browser build never lists.
  vi.mocked(isTauri).mockReturnValue(false);
  const browser = showSkills("browser", [claude], "");
  await act(async () => {});
  expect(browser.last()).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});

it("shows a failed listing with Retry, which lists again", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke)
    .mockReset()
    .mockRejectedValueOnce(new Error("Listing skills took too long"))
    .mockResolvedValue(rows);
  const shown = showSkills("retry", [claude], "");
  await waitFor(() =>
    expect(shown.last()?.status).toBe("Listing skills took too long"),
  );
  expect(shown.last()?.items).toEqual([]);
  act(() => shown.last()?.retry?.());
  await waitFor(() => expect(shown.labels()).toEqual(["review", "write"]));
  expect(invoke).toHaveBeenCalledTimes(2);
});
