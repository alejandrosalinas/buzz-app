// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { clientMetrics } from "./client-metrics";
import { registerPerformanceTool } from "./performance-tool";
import {
  createRuntimePerformance,
  runtimePerformance,
} from "./runtime-performance";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("returns bounded numeric evidence through the production agent tool, even with dev metrics off", async () => {
  let tool!: AddedTool;
  let changed!: () => void;
  const unsubscribe = vi.fn();
  const lifetime = new AbortController();
  registerPerformanceTool(
    {
      addTool: (value) => {
        tool = value;
      },
      subscribe: (listener) => {
        changed = listener;
        return unsubscribe;
      },
    },
    lifetime.signal,
  );
  expect(clientMetrics.enabled).toBe(false);
  const pending = tool.call({} as BuzzClient, {}, { duration_ms: 1000 });
  for (let index = 0; index < 100000; index++) {
    clientMetrics.cpu("fold", 2, 3);
    changed();
  }
  clientMetrics.query("private-community", {
    ms: 7,
    bytes: 19,
    priority: "background",
    ok: false,
  });
  const body = {
    secret: "message body and credentials must stay out of reports",
  };
  expect(runtimePerformance.serializeMcpReply(body)).toBe(JSON.stringify(body));
  await vi.advanceTimersByTimeAsync(1000);
  const encoded = (await pending) as string;
  const report = JSON.parse(encoded);
  expect(report.work.fold).toEqual({
    count: 100000,
    items: 300000,
    totalMs: 200000,
    maxMs: 2,
  });
  expect(report.reads).toEqual({
    count: 1,
    totalMs: 7,
    maxMs: 7,
    codeUnits: 19,
    background: 1,
    failed: 1,
  });
  expect(report.agentUpdates).toBe(100000);
  expect(report.mcpReplies).toMatchObject({
    count: 1,
    codeUnits: JSON.stringify(body).length,
    failed: 0,
  });
  expect(report.mainThread.longTasks).toMatchObject({
    supported: false,
    reason: expect.any(String),
  });
  expect(report.elapsedMs).toBe(1000);
  expect(encoded.length).toBeLessThan(2500);
  expect(encoded).not.toContain(body.secret);
  expect(encoded).not.toContain("private-community");
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const next = runtimePerformance.capture(1000, () => () => {});
  await vi.advanceTimersByTimeAsync(1000);
  const empty = JSON.parse(JSON.stringify(await next));
  expect(empty.sessionId).toBe(report.sessionId);
  expect(empty.agentUpdates).toBe(0);
  expect(empty.work.fold.count).toBe(0);
  expect(empty.mcpReplies.count).toBe(0);
});

it.each(["request", "plugin"])(
  "cancels a %s capture, releases its resources and admits the next call",
  async (source) => {
    const metrics = createRuntimePerformance();
    const request = new AbortController();
    const plugin = new AbortController();
    const unsubscribe = vi.fn();
    const capture = metrics.capture(10000, () => unsubscribe, [
      request.signal,
      plugin.signal,
    ]);
    expect(() => metrics.capture(1000, () => () => {})).toThrow(
      "already running",
    );
    const rejected = expect(capture).rejects.toBe("stopped");
    (source === "request" ? request : plugin).abort("stopped");
    await rejected;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const next = metrics.capture(1000, () => unsubscribe);
    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  },
);

it("excludes hidden timer time and resets the visible baseline on return", async () => {
  const metrics = createRuntimePerformance();
  const pending = metrics.capture(1000, () => () => {});
  await vi.advanceTimersByTimeAsync(250);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(600);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(150);
  const report = JSON.parse(JSON.stringify(await pending));
  expect(report.visibility).toMatchObject({ visibleMs: 400, hiddenMs: 600 });
  expect(report.mainThread.timerLag).toMatchObject({ count: 0, samples: 3 });
});

it("reports a delayed main-thread sample and the actual elapsed interval", async () => {
  const now = performance.now.bind(performance);
  let delay = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + delay);
  const pending = createRuntimePerformance().capture(1000, () => () => {});
  await vi.advanceTimersByTimeAsync(100);
  delay = 200;
  await vi.advanceTimersByTimeAsync(900);
  const report = JSON.parse(JSON.stringify(await pending));
  expect(report.elapsedMs).toBe(1200);
  expect(report.mainThread.timerLag).toMatchObject({
    count: 1,
    totalMs: 200,
    maxMs: 200,
  });
});

it("records an overdue visible sample when the deadline runs before the interval", async () => {
  const now = performance.now.bind(performance);
  let stalled = false;
  vi.spyOn(performance, "now").mockImplementation(
    () => now() + (stalled ? 400 : 0),
  );
  const pending = createRuntimePerformance().capture(1050, () => () => {});
  await vi.advanceTimersByTimeAsync(1000);
  stalled = true;
  await vi.advanceTimersByTimeAsync(50);
  const report = JSON.parse(JSON.stringify(await pending));
  expect(report.elapsedMs).toBe(1450);
  expect(report.mainThread.timerLag).toMatchObject({
    count: 1,
    totalMs: 350,
    maxMs: 350,
    samples: 11,
  });
});

it.each([0, 999, 10001, 1.5, "1000", null, NaN])(
  "refuses invalid duration %s before subscribing",
  (duration) => {
    const subscribe = vi.fn();
    expect(() =>
      runtimePerformance.capture(duration as number, subscribe),
    ).toThrow("duration_ms");
    expect(subscribe).not.toHaveBeenCalled();
  },
);

it("releases a failed setup and preserves JSON encoding failures", async () => {
  const metrics = createRuntimePerformance();
  await expect(
    metrics.capture(1000, () => {
      throw new Error("subscription unavailable");
    }),
  ).rejects.toThrow("subscription unavailable");
  const pending = metrics.capture(1000, () => () => {});
  expect(() => metrics.serializeMcpReply(1n)).toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  const report = JSON.parse(JSON.stringify(await pending));
  expect(report.mcpReplies).toMatchObject({
    count: 1,
    failed: 1,
    codeUnits: 0,
  });
  expect(vi.getTimerCount()).toBe(0);
});
