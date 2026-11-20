import { expect, it, vi } from "vitest";
import type { JsonValue, OpenTarget } from "../navigation/targets";
import {
  conversationTarget,
  isChannelRoute,
  matchesConversation,
  newMessage,
  newMessageTarget,
  nextMessageIntent,
  soloDraft,
  soloDraftTarget,
  resumeSoloDraftTarget,
} from "./routes";

const viewer = "c".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.test" };
const partition = `https://relay.test:${viewer}`;
const agent = "a".repeat(64);
it("New resumes the current ordinary draft only in its own scope and workspace", () => {
  const target = soloDraftTarget(partition, { project: "work", agent });
  expect(resumeSoloDraftTarget(partition, target)).toBe(target);
  expect(resumeSoloDraftTarget(partition, target, "work")).toBe(target);
  expect(resumeSoloDraftTarget(partition, target, "other")).toEqual(
    soloDraftTarget(partition, { project: "other" }),
  );
  expect(resumeSoloDraftTarget(`https://other.test:${viewer}`, target)).toEqual(
    soloDraftTarget(`https://other.test:${viewer}`),
  );
  const region = soloDraftTarget(partition, {
    region: "buzz.region:example:tasks",
  });
  expect(resumeSoloDraftTarget(partition, region)).toEqual(
    soloDraftTarget(partition),
  );
});
it("matches reopened conversations only in the original community and viewer", () => {
  const target = conversationTarget(partition, "chat");
  expect(matchesConversation(target, partition, "chat")).toBe(true);
  expect(matchesConversation(target, partition, "other")).toBe(false);
  expect(
    matchesConversation(target, `https://other.test:${viewer}`, "chat"),
  ).toBe(false);
  expect(
    matchesConversation(target, `https://relay.test:${"d".repeat(64)}`, "chat"),
  ).toBe(false);
  expect(
    matchesConversation(soloDraftTarget(partition), partition, "chat"),
  ).toBe(false);
  expect(matchesConversation(undefined, partition, "chat")).toBe(false);
});
const page = (
  pluginId: string,
  pageId: string,
  params?: JsonValue,
): OpenTarget => ({
  version: 1,
  kind: "page",
  pluginId,
  pageId,
  scope,
  ...(params === undefined ? {} : { route: { version: 1, params } }),
});

it("accepts empty, new-message and Solo draft destinations", () => {
  expect(isChannelRoute("empty")).toBe(true);
  expect(isChannelRoute("new-message")).toBe(true);
  expect(soloDraft({ kind: "solo-draft" })).toEqual({});
  expect(soloDraft({ kind: "solo-draft", project: "p", agent })).toEqual({
    project: "p",
    agent,
  });
});

it("addresses a New message draft to one person by key", () => {
  expect(newMessage("new-message")).toEqual({});
  const target = newMessageTarget(scope, agent, 1700000000000);
  const params = target.kind === "page" ? target.route?.params : undefined;
  expect(newMessage(params)).toEqual({
    intent: { to: agent, at: 1700000000000 },
  });
  expect(isChannelRoute(params ?? null)).toBe(true);
  for (const invalid of [
    { kind: "new-message" },
    { kind: "new-message", to: agent },
    { kind: "new-message", to: "not-a-key", at: 1 },
    { kind: "new-message", to: agent.toUpperCase(), at: 1 },
    { kind: "new-message", to: agent, at: 1, text: "private draft" },
    { kind: "new-message", to: [agent], at: 1 },
    { kind: "new-message", to: agent, at: 0 },
    { kind: "new-message", to: agent, at: 1.5 },
    { kind: "new-message", to: agent, at: "1" },
  ]) {
    expect(newMessage(invalid), JSON.stringify(invalid)).toBeUndefined();
    expect(isChannelRoute(invalid)).toBe(false);
  }
});

it("orders each new choice after the last, even when the clock moves back", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
  const first = nextMessageIntent();
  now.mockReturnValue(1_000);
  const second = nextMessageIntent();
  const third = nextMessageIntent();
  expect(first).toBeGreaterThanOrEqual(5_000);
  expect(second).toBe(first + 1);
  expect(third).toBe(second + 1);
  now.mockRestore();
});

it("orders a choice after one stored by an earlier load, even when the clock moves back", async () => {
  const stored = new Map([["buzz-message-intent.v1", "9000"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  vi.resetModules();
  const fresh = await import("./new-message-route");
  const next = fresh.nextMessageIntent();
  expect(next).toBe(9_001);
  expect(stored.get("buzz-message-intent.v1")).toBe("9001");
  now.mockRestore();
  vi.unstubAllGlobals();
});

it("rejects foreign route kinds and draft payloads", () => {
  for (const params of [
    null,
    [],
    "solo-draft",
    // Inbox and Bestie are pages of their own, not Channels placeholders.
    "Inbox",
    "Bestie",
    {},
    { kind: "other" },
    { kind: "solo-draft", project: "" },
    { kind: "solo-draft", project: 1 },
    { kind: "solo-draft", agent: "not-a-key" },
    { kind: "solo-draft", text: "private draft" },
    { kind: "solo-draft", linked: "invalid" },
    { kind: "solo-draft", draft: { context: null } },
    { kind: "solo-draft", region: "buzz.region:example:tasks", draft: {} },
    {
      kind: "solo-draft",
      region: "buzz.region:example:tasks",
      draft: { key: "", context: null },
    },
    {
      kind: "solo-draft",
      region: "buzz.region:example:tasks",
      draft: { key: "bad/key", context: null },
    },
    {
      kind: "solo-draft",
      region: "buzz.region:example:tasks",
      draft: { context: null, extra: true },
    },
  ]) {
    expect(isChannelRoute(params)).toBe(false);
    expect(soloDraft(params)).toBeUndefined();
  }
});

it("retains opaque region context in a saved destination with or without a separate draft key", () => {
  for (const draft of [
    { context: null },
    { key: "item:42", context: { item: 42, flags: [true, "example"] } },
  ]) {
    const target = soloDraftTarget(partition, {
      region: "buzz.region:example:tasks",
      draft,
    });
    const saved = JSON.parse(JSON.stringify(target));
    expect(soloDraft(saved.route.params)).toEqual({
      region: "buzz.region:example:tasks",
      draft,
    });
  }
});

it("builds Solo draft destinations in the community", () => {
  expect(soloDraftTarget(partition, { agent })).toEqual(
    page("buzz.channels", "channels", { kind: "solo-draft", agent }),
  );
  expect(() => soloDraftTarget("bad")).toThrow();
});

it("keeps a region draft's label and refuses a malformed or linked one", () => {
  const region = "buzz.region:example.tasks:tasks";
  expect(soloDraft({ kind: "solo-draft", region, project: "p" })).toEqual({
    region,
    project: "p",
    draft: { context: { saved: { kind: "solo-draft", region, project: "p" } } },
  });
  for (const params of [
    { kind: "solo-draft", region: "buzz.solo" },
    { kind: "solo-draft", region: "buzz.region:Example:tasks" },
    { kind: "solo-draft", region: 1 },
    {
      kind: "solo-draft",
      region,
      linked: "00000000-0000-4000-8000-000000000000",
    },
  ])
    expect(soloDraft(params)).toBeUndefined();
});
it("retains prior region source fields as opaque unkeyed context", () => {
  const region = "buzz.region:example:tasks";
  const saved = { kind: "solo-draft", region, project: "p", mode: "example" };
  expect(soloDraft(saved)).toEqual({
    region,
    project: "p",
    draft: { context: { saved } },
  });
  expect(soloDraft({ ...saved, draft: { context: null } })).toEqual({
    region,
    project: "p",
    draft: { context: null },
  });
  for (const draft of [null, {}, { key: "", context: null }])
    expect(soloDraft({ ...saved, draft })).toBeUndefined();
  expect(
    soloDraft({ kind: "solo-draft", project: "p", mode: "example" }),
  ).toBeUndefined();
});
