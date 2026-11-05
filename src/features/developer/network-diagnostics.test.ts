import { createRelayProfiler } from "../relay/profiling";
import { beforeEach, afterEach, expect, it } from "vitest";
import {
  createNetworkRecorder,
  DEFAULT_CAPTURE_RESET,
  networkRecorder,
} from "./network-diagnostics";
import { logSocketFrame } from "./traffic";

beforeEach(() => networkRecorder.setEnabled(true));

afterEach(() => {
  networkRecorder.clear();
  networkRecorder.configure("info", DEFAULT_CAPTURE_RESET);
});

it("changes capture immediately, expires detailed capture, and preserves lifecycle history under a frame flood", () => {
  let now = 1000;
  const recorder = createNetworkRecorder(() => now);
  recorder.record({ level: "info", event: "socket.retry" });
  recorder.record({ level: "debug", event: "hidden" });
  expect(recorder.snapshot().events.map((event) => event.event)).toEqual([
    "socket.retry",
  ]);
  recorder.configure("trace", { enabled: true, minutes: 15 });
  for (let i = 0; i < 1600; i++)
    recorder.record({ level: "debug", event: "ws.frame" });
  expect(recorder.snapshot().events).toHaveLength(1501);
  expect(recorder.snapshot().events[0]?.event).toBe("socket.retry");
  expect(recorder.snapshot().dropped).toBe(100);
  now += 15 * 60_000 - 1;
  expect(recorder.enabled("trace")).toBe(true);
  now++;
  recorder.record({ level: "debug", event: "after-expiry" });
  expect(recorder.snapshot().level).toBe("info");
  expect(
    recorder.snapshot().events.some((event) => event.event === "after-expiry"),
  ).toBe(false);
  recorder.configure("silent");
  recorder.record({ level: "error", event: "off" });
  expect(
    recorder.snapshot().events.some((event) => event.event === "off"),
  ).toBe(false);
  recorder.clear();
  expect(recorder.snapshot()).toMatchObject({ dropped: 0, events: [] });
});

it.each(["debug", "trace"] as const)(
  "keeps %s until changed unless the user opts into a reset",
  (level) => {
    let now = 1000;
    const recorder = createNetworkRecorder(() => now);
    recorder.configure(level);
    now += 2 * 60 * 60_000;
    expect(recorder.snapshot()).toMatchObject({
      level,
      expiresAt: undefined,
      autoReset: { enabled: false, minutes: 15 },
    });
    recorder.configure(level, { enabled: true, minutes: 2 });
    now += 119_999;
    expect(recorder.enabled(level)).toBe(true);
    recorder.configure(level, { enabled: false, minutes: 2 });
    now += 120_000;
    expect(recorder.enabled(level)).toBe(true);
    recorder.configure(level, { enabled: true, minutes: 3 });
    now += 179_999;
    expect(recorder.enabled(level)).toBe(true);
    now++;
    expect(recorder.snapshot()).toMatchObject({
      level: "info",
      expiresAt: undefined,
      autoReset: { enabled: true, minutes: 3 },
    });
  },
);

it("captures protocol evidence without credentials, content, URL secrets, or untrusted refusal text", () => {
  networkRecorder.configure("trace");
  for (const frame of [
    ["AUTH", "secret-challenge"],
    [
      "EVENT",
      "sub",
      {
        id: "abc",
        kind: 9,
        content: "secret-message",
        tags: [["h", "secret-channel"]],
        sig: "secret-signature",
      },
    ],
    ["CLOSED", "sub", "restricted: secret-refusal\nforged log"],
  ])
    logSocketFrame("relay.test", "←", JSON.stringify(frame), frame);
  const request = [
    "REQ",
    "sub",
    {
      kinds: [9],
      authors: ["secret-author"],
      "#h": ["secret-channel"],
      search: "secret-search",
    },
  ];
  logSocketFrame("relay.test", "→", JSON.stringify(request), request);
  networkRecorder.record({
    level: "warn",
    event: "http",
    relay:
      "https://user:secret-password@relay.test/private?token=secret-token#secret-fragment",
    reason: "restricted: secret-refusal\nforged log",
  });
  const report = JSON.stringify(networkRecorder.snapshot());
  expect(report).not.toContain("secret-");
  expect(report).not.toContain("forged log");
  expect(report).toContain("relay.test");
  expect(report).toContain('"reason":"restricted"');
  expect(report).toContain('"event":"ws.filters"');
});

it("keeps safe error causes while redacting unknown text and bounding cyclic cause chains", () => {
  const recorder = createNetworkRecorder();
  recorder.configure("debug");
  const cause = new DOMException(
    "secret-token in unknown error https://user:secret-password@relay.test/?key=secret-key",
    "AbortError",
  );
  const error = new Error("secret-message", { cause });
  recorder.record({ level: "warn", event: "read", reason: error });
  expect(recorder.snapshot().events[0]?.error).toMatchObject({
    name: "Error",
    messageRedacted: true,
    cause: { name: "AbortError", code: "cancelled", messageRedacted: true },
  });
  expect(JSON.stringify(recorder.snapshot())).not.toContain("secret-");
  error.cause = error;
  recorder.record({ level: "warn", event: "read", reason: error });
  expect(recorder.snapshot().events[1]?.error?.cause).toMatchObject({
    truncated: true,
  });
});

it("keeps local projection identifiers out of network stage evidence", () => {
  networkRecorder.configure("debug");
  const profiler = createRelayProfiler();
  profiler.measure("view.reconcile", "private-channel-identifier", () => []);
  profiler.measure("read.verify", "profile-search", () => []);
  const id = "read:11111111-1111-4111-8111-111111111111:1";
  profiler.measure("broker.private_header_text", id, () => []);
  profiler.measure("read.verify", id, () => []);
  const events = networkRecorder.snapshot().events;
  expect(events.filter((event) => event.event === "read.stage")).toEqual([
    expect.objectContaining({
      operationId: id,
      phase: "read.verify",
      outcome: "ok",
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("private-channel-identifier");
  expect(JSON.stringify(events)).not.toContain("private_header_text");
  expect(profiler.snapshot()).toContainEqual(
    expect.objectContaining({ id: "private-channel-identifier" }),
  );
});
