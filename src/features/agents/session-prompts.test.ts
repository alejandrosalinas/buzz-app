// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sectionTitle, type TranscriptTurn } from "./activity-transcript";
import { coreMemorySection } from "../agent-harness/core-memory";
import { systemPrompt } from "../../bundled/claude-code/prompt";
import { localStore, type AgentStore } from "./store";
import {
  EACH_TURN,
  PROMPTS_BUDGET,
  removeSessionPrompts,
  sessionPrompts,
} from "./session-prompts";

const AGENT = "a".repeat(64);
const turn = (fields: Partial<TranscriptTurn>): TranscriptTurn => ({
  turnId: "t",
  channelId: null,
  threadRootId: null,
  triggeringEventIds: [],
  newSession: false,
  config: [],
  startedAt: 0,
  partial: false,
  items: [],
  ...fields,
});
const memory = () => {
  const items = new Map<string, string>();
  return localStore({
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  });
};

it("keeps every session's first save, each text once", async () => {
  const storage = memory();
  const prompts = sessionPrompts(storage, "goose", AGENT);
  const shared = [{ label: "", text: "same prompt" }];
  await Promise.all([prompts.save("one", shared), prompts.save("two", shared)]);
  await prompts.save("one", [{ label: "", text: "rebuilt later" }]);
  expect(prompts.get("one")).toEqual(shared);
  expect(prompts.get("two")).toEqual(shared);
  const [key] = storage.keys();
  expect(storage.get(key as string)?.match(/same prompt/g)).toHaveLength(1);
  // Another agent type of the same agent keeps its own.
  expect(sessionPrompts(storage, "pi", AGENT).get("one")).toBeUndefined();
});

it("adds what a kept session was sent later, and nothing to one that is not kept", async () => {
  const prompts = sessionPrompts(memory(), "codex", AGENT);
  const first = { label: "base", text: "the first prompt" };
  const later = { label: "base-section-updates later", text: "## Progress" };
  await prompts.add("one", later);
  expect(prompts.get("one")).toBeUndefined();
  await prompts.save("one", [first], { at: 1, title: "One" });
  await prompts.add("one", later);
  await prompts.add("one", { label: "empty", text: "" });
  expect(prompts.get("one")).toEqual([first, later]);
  expect(prompts.sessions()).toEqual([{ id: "one", at: 1, title: "One" }]);
  // Nor a piece that takes the session over the budget alone.
  await prompts.add("one", {
    label: "base-section-updates huge",
    text: "x".repeat(PROMPTS_BUDGET),
  });
  expect(prompts.get("one")).toEqual([first, later]);
});

it("keeps when each session started and its title, alongside ones saved without", async () => {
  const prompts = sessionPrompts(memory(), "goose", AGENT);
  await prompts.save("old", [{ label: "", text: "a" }]);
  await prompts.save("new", [{ label: "", text: "b" }], {
    at: 5,
    title: "Gander · #general",
  });
  expect(prompts.sessions()).toEqual([
    { id: "old" },
    { id: "new", at: 5, title: "Gander · #general" },
  ]);
  expect(prompts.get("new")).toEqual([{ label: "", text: "b" }]);
});

it("drops the oldest sessions to stay in budget, never cutting text", async () => {
  const prompts = sessionPrompts(memory(), "codex", AGENT);
  const big = (n: number) => `${n}`.repeat(PROMPTS_BUDGET / 3);
  for (const n of [1, 2, 3])
    await prompts.save(`s${n}`, [{ label: "", text: big(n) }]);
  expect(prompts.get("s1")).toBeUndefined();
  expect(prompts.get("s3")?.[0]?.text).toBe(big(3));
  // Too large to keep at all: marked, not truncated.
  await prompts.save("huge", [{ label: "", text: "x".repeat(PROMPTS_BUDGET) }]);
  expect(prompts.get("huge")).toBeNull();
  // A dropped session is never filled in again by reading it.
  const shown = prompts.shown([turn({ sessionId: "s1", newSession: true })]);
  expect(shown[0]?.items.some((item) => item.type === "system")).toBe(false);
});

it("logs a failed save without throwing", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failing: AgentStore = {
    ...memory(),
    set: async () => {
      throw new Error("disk full");
    },
  };
  await expect(
    sessionPrompts(failing, "pi", AGENT).save("s", [{ label: "", text: "t" }]),
  ).resolves.toBeUndefined();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it("removes an agent's prompts of every type, and only that agent's", async () => {
  const storage = memory();
  const other = "b".repeat(64);
  const part = [{ label: "", text: "t" }];
  for (const type of ["goose", "pi"]) {
    await sessionPrompts(storage, type, AGENT).save("s", part);
    await sessionPrompts(storage, type, other).save("s", part);
  }
  await removeSessionPrompts(storage, AGENT);
  for (const type of ["goose", "pi"]) {
    expect(sessionPrompts(storage, type, AGENT).get("s")).toBeUndefined();
    expect(sessionPrompts(storage, type, other).get("s")).toEqual(part);
  }
});

it("titles known sections readably and shows unknown tags as they are", () => {
  expect(sectionTitle("community-repositories")).toBe("Repositories folder");
  expect(sectionTitle("agent-instructions")).toBe("Agent instructions");
  expect(sectionTitle("some-new-tag")).toBe("some-new-tag");
  expect(sectionTitle("constructor")).toBe("constructor");
});

it("shows a Codex prompt as Base and the first turn's tagged context", async () => {
  const prompts = sessionPrompts(memory(), "codex", AGENT);
  const context =
    "You are X (pubkey p).\nCurrent Buzz custom instructions replace all prior Buzz custom instructions.\n<agent-instructions>\nBe kind.\n</agent-instructions>\n\nCurrent core memory replaces all prior core memory.\n<core-memory>\nm\n</core-memory>\n\n<community-repositories>\nr\n</community-repositories>";
  await prompts.save("s1", [
    { label: "base", text: "You are X.\nBase text." },
    { label: EACH_TURN, text: context },
  ]);
  const [shown] = prompts.shown([turn({ sessionId: "s1", newSession: true })]);
  expect(shown?.items[0]).toMatchObject({
    type: "system",
    sections: [
      { tag: "base", body: "You are X.\nBase text." },
      { tag: "agent-instructions", body: "Be kind." },
      { tag: "core-memory", body: "m" },
      { tag: "community-repositories", body: "r" },
    ],
  });
  expect(prompts.get("s1")?.[1]?.text).toBe(context);
});

it("shows a Pi prompt as the full system prompt's tagged sections", async () => {
  const prompts = sessionPrompts(memory(), "pi", AGENT);
  await prompts.save("s1", [
    {
      label: "instructions",
      text: systemPrompt({
        scope: "thread",
        cwd: "/w",
        repositories: "<community-repositories>\nr\n</community-repositories>",
        agent: { name: "X", pubkey: "p" },
        instructions: "Be kind.",
        team: "<team>\nt\n</team>",
      }),
    },
    { label: "core memory", text: coreMemorySection("m") },
  ]);
  const [shown] = prompts.shown([turn({ sessionId: "s1", newSession: true })]);
  const item = shown?.items[0];
  expect(
    item?.type === "system" && item.sections.map((section) => section.tag),
  ).toEqual([
    "identity",
    "base",
    "workspace",
    "community-repositories",
    "agent-instructions",
    "team",
    "core-memory",
  ]);
});

it("drops damaged saved sessions and keeps their neighbors", () => {
  const storage = memory();
  void storage.set(
    `buzz.session-prompts.v1:goose:${AGENT}`,
    JSON.stringify({
      version: 1,
      texts: ["hello"],
      sessions: [
        ["legacy", [["", 0]]],
        ["started", null, { at: 5, title: "Gander · #general" }],
        ["badStart", [], { at: "later", title: "x" }],
        ["badPlace", [], { at: 1, title: "x", conversation: 7 }],
        ["far", [], { at: 1e20, title: "x", conversation: null }],
        ["timer", [], { at: 2, title: "t", conversation: null }],
        ["badParts", { 0: ["", 0] }],
        [7, []],
        ["x".repeat(300), []],
        ["legacy", []],
        null,
      ],
    }),
  );
  const prompts = sessionPrompts(storage, "goose", AGENT);
  expect(prompts.sessions()).toEqual([
    { id: "legacy" },
    { id: "started", at: 5, title: "Gander · #general" },
    { id: "timer", at: 2, title: "t", conversation: null },
  ]);
  expect(prompts.get("legacy")).toEqual([{ label: "", text: "hello" }]);
});
