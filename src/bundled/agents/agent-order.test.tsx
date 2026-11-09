// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import { readView, writeView } from "../../shared/view-state";
import { moveAgent, useAgentOrder } from "./agent-order";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("keeps the saved order after a failed save, retries, and reconciles removed agents", () => {
  const scope = "https://relay.example:owner";
  const ada = { pubkey: "1".repeat(64), name: "Ada" } as Agent;
  const bo = { pubkey: "2".repeat(64), name: "Bo" } as Agent;
  const next = { pubkey: "3".repeat(64), name: "New" } as Agent;
  writeView(scope, "agents:order", { malformed: true });
  const { result, rerender } = renderHook(
    ({ agents }) => useAgentOrder(scope, agents),
    { initialProps: { agents: [ada, bo] } },
  );
  expect(result.current.ordered).toEqual([ada, bo]);
  act(() => result.current.save([ada, bo]));
  const moved = moveAgent(result.current.ordered, 0, 1);
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    act(() => result.current.save(moved));
    expect(result.current.error).toContain("order couldn't be saved");
    expect(result.current.ordered).toEqual([ada, bo]);
  } finally {
    storage.mockRestore();
  }
  act(() => result.current.save(moved));
  expect(result.current.error).toBe("");
  expect(result.current.ordered).toEqual([bo, ada]);
  rerender({ agents: [bo, next] });
  expect(result.current.ordered).toEqual([bo, next]);
});

it.each([
  ["before", ["H", "A", "B"], ["H", "B", "A", "N"]],
  ["between", ["A", "H", "B"], ["B", "H", "A", "N"]],
  ["after", ["A", "B", "H"], ["B", "A", "H", "N"]],
])(
  "preserves temporarily absent agents %s a reordered subset",
  (_, initial, expected) => {
    const scope = "https://relay.example:owner";
    const a = { pubkey: "1".repeat(64), name: "A" } as Agent;
    const b = { pubkey: "2".repeat(64), name: "B" } as Agent;
    const h = {
      pubkey: "3".repeat(64),
      name: "H",
      place: "elsewhere",
    } as Agent;
    const n = { pubkey: "4".repeat(64), name: "N" } as Agent;
    const keys = new Map(
      [a, b, h, n].map((agent) => [agent.name, agent.pubkey]),
    );
    writeView(
      scope,
      "agents:order",
      initial.map((name) => keys.get(name)),
    );
    const { result, rerender, unmount } = renderHook(
      ({ agents }) => useAgentOrder(scope, agents),
      { initialProps: { agents: [a, b] } },
    );
    act(() => result.current.save([b, a]));
    const returning = [a, h, b, n];
    rerender({ agents: returning });
    expect(result.current.ordered.map((agent) => agent.name)).toEqual(expected);
    unmount();
    const restored = renderHook(() => useAgentOrder(scope, returning));
    expect(restored.result.current.ordered.map((agent) => agent.name)).toEqual(
      expected,
    );
    // A subsequent move still retains the absent slot and appends a new key once.
    restored.unmount();
    const partial = renderHook(() => useAgentOrder(scope, [a, b, n]));
    act(() => partial.result.current.save([b, a, n]));
    expect(readView(scope, "agents:order", [])).toEqual(
      expected.map((name) => keys.get(name)),
    );
  },
);
