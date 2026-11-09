import { expect, it } from "vitest";
import {
  agentCardRoute,
  agentProviderRoute,
  agentProviderTarget,
  agentRoute,
  agentTarget,
  availableAgentProviderRoute,
  historyRoute,
  historyTarget,
  teamRoute,
} from "./routes";

it("admits provider-shaped routes and preserves the Agents page scope", () => {
  const route = { provider: "test/echo" };
  expect(agentProviderRoute(route)).toBe("test/echo");
  expect(availableAgentProviderRoute(route)).toBe(true);
  expect(availableAgentProviderRoute({ provider: "test/gone" })).toBe(true);
  for (const invalid of [
    null,
    "test/echo",
    { provider: "echo" },
    { provider: "test/echo", extra: true },
  ] as const)
    expect(agentProviderRoute(invalid)).toBeUndefined();

  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const opened = agentProviderTarget(base, "test/echo");
  expect(opened).toEqual({
    ...base,
    route: { version: 1, params: route },
  });
  expect(agentProviderTarget(opened)).toEqual(base);
});

it("admits an agent of yours to open, by its key", () => {
  const pubkey = "a".repeat(64);
  expect(agentRoute(agentTarget(pubkey).route.params)).toBe(pubkey);
  expect(availableAgentProviderRoute({ agent: pubkey })).toBe(true);
  for (const invalid of [
    { agent: "Ada" },
    { agent: pubkey, provider: "test/echo" },
    { agent: 1 },
  ] as const)
    expect(agentRoute(invalid)).toBeUndefined();
  expect(agentProviderRoute({ agent: pubkey })).toBeUndefined();
});

it("validates a version locator without treating it as authority or accepting extra route fields", () => {
  const base = { ...agentTarget("a".repeat(64)), scope: null };
  const selected = { side: "settings", id: "b".repeat(64) } as const;
  const opened = historyTarget(base, { agent: "a".repeat(64) }, selected);
  expect(agentRoute(opened.route?.params)).toBe("a".repeat(64));
  expect(historyRoute(opened.route?.params, agentRoute)).toEqual(selected);
  expect(historyTarget(opened, { agent: "a".repeat(64) })).toEqual(
    historyTarget(base, { agent: "a".repeat(64) }),
  );
  expect(availableAgentProviderRoute(opened.route?.params ?? null)).toBe(true);
  for (const revision of [
    "settings/bad",
    `memory/${"b".repeat(64)}`,
    "instructions/",
  ]) {
    expect(agentRoute({ agent: "a".repeat(64), revision })).toBeUndefined();
  }
  expect(
    agentRoute({
      agent: "a".repeat(64),
      revision: `settings/${"b".repeat(64)}`,
      extra: true,
    }),
  ).toBeUndefined();
});

it("admits an agent card to start an agent from, by its id", () => {
  expect(agentCardRoute({ card: "tinker" })).toBe("tinker");
  expect(availableAgentProviderRoute({ card: "av_x-1" })).toBe(true);
  for (const invalid of [
    { card: "" },
    { card: "../x" },
    { card: 1 },
    { card: "tinker", extra: true },
  ] as const) {
    expect(agentCardRoute(invalid)).toBeUndefined();
    expect(availableAgentProviderRoute(invalid)).toBe(false);
  }
});

it("admits team routes and their version addresses", () => {
  const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const selected = { side: "instructions", id: "a".repeat(64) } as const;
  const target = historyTarget(base, { team: id }, selected);
  expect(teamRoute(target.route?.params)).toBe(id);
  expect(historyRoute(target.route?.params, teamRoute)).toEqual(selected);
  expect(availableAgentProviderRoute({ team: id })).toBe(true);
  for (const invalid of [{ team: "x" }, { team: id, extra: 1 }])
    expect(teamRoute(invalid)).toBeUndefined();
  expect(teamRoute({ agent: "a".repeat(64) })).toBeUndefined();
});
