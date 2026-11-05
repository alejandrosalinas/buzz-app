import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { provideNetworkDiagnostics } from "./network-service";
import { networkRecorder, DEFAULT_CAPTURE_RESET } from "./network-diagnostics";
import { networkMetrics } from "./network-metrics";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));
const contexts: Context[] = [];
function context() {
  const ctx = new Context();
  contexts.push(ctx);
  provideNetworkDiagnostics(ctx);
  return ctx;
}
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "network_diagnostics_read" ? { archive } : undefined,
  );
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  networkRecorder.setEnabled(false);
  networkMetrics.setEnabled(false);
  networkMetrics.reset();
  networkRecorder.clear();
  networkRecorder.configure("info", DEFAULT_CAPTURE_RESET);
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});
const archive = { path: "/app-data/network/session.jsonl", error: null };

it("does no diagnostic IPC or timer work without an installed capture consumer, including teardown", async () => {
  vi.useFakeTimers();
  const ctx = context();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(networkRecorder.collecting()).toBe(false);
  expect(networkMetrics.enabled()).toBe(false);
  await ctx.fiber.dispose();
  expect(invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shares the requested reset deadline with native capture without extending it after a delayed acknowledgement", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const ctx = context();
  await ctx.networkDiagnostics.setEnabled(true);
  await ctx.networkDiagnostics.setLevel("debug");
  expect(ctx.networkDiagnostics.snapshot().expiresAt).toBeUndefined();
  await ctx.networkDiagnostics.setAutoReset({ enabled: true, minutes: 2 });
  expect(ctx.networkDiagnostics.snapshot().expiresAt).toBe(121_000);
  expect(invoke).toHaveBeenLastCalledWith("network_diagnostics_configure", {
    level: "debug",
    enabled: true,
    resetAt: 121_000,
  });
  await ctx.networkDiagnostics.setAutoReset({ enabled: false, minutes: 2 });
  expect(ctx.networkDiagnostics.snapshot().expiresAt).toBeUndefined();
  await ctx.networkDiagnostics.setAutoReset({ enabled: true, minutes: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      command === "network_diagnostics_configure" &&
      (args as { level: string }).level === "trace"
    ) {
      started();
      await gate;
    }
    if (command === "network_diagnostics_read") return { archive };
  });
  const trace = ctx.networkDiagnostics.setLevel("trace");
  try {
    await dispatched;
    expect(invoke).toHaveBeenCalledWith("network_diagnostics_configure", {
      level: "trace",
      enabled: true,
      resetAt: 121_000,
    });
    vi.setSystemTime(121_001);
  } finally {
    release();
  }
  await trace;
  expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
  await expect(
    ctx.networkDiagnostics.setAutoReset({ enabled: true, minutes: 0 }),
  ).rejects.toThrow("positive whole number");
});

it("serializes native level changes and fails a save without claiming detailed capture", async () => {
  const ctx = context();
  await ctx.networkDiagnostics.setEnabled(true);
  await ctx.networkDiagnostics.clear();
  vi.mocked(invoke).mockClear();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke)
    .mockImplementationOnce(() => gate)
    .mockResolvedValueOnce(undefined);
  const capture = ctx.networkDiagnostics.setLevel("debug");
  const stop = ctx.networkDiagnostics.setLevel("info");
  try {
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
  } finally {
    release();
  }
  await Promise.all([capture, stop]);
  expect(invoke).toHaveBeenNthCalledWith(2, "network_diagnostics_configure", {
    level: "info",
    enabled: true,
    resetAt: null,
  });
  expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
  vi.mocked(invoke).mockRejectedValueOnce("private native error");
  await expect(ctx.networkDiagnostics.setLevel("trace")).rejects.toBe(
    "private native error",
  );
  expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
  await ctx.fiber.dispose();
});

it("skips disabled startup and forwards evicted client records, and waits for enqueue acknowledgement before export", async () => {
  networkRecorder.setEnabled(false);
  networkRecorder.record({ level: "warn", event: "startup" });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "network_diagnostics_read" ? { archive } : undefined,
  );
  const ctx = context();
  await ctx.networkDiagnostics.setEnabled(true);
  await ctx.networkDiagnostics.setLevel("debug");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "network_diagnostics_read") return { archive };
    if (command === "network_diagnostics_append") await gate;
    if (command === "network_diagnostics_export")
      return "/Downloads/full-session.diagnostics.json";
  });
  for (let i = 0; i < 2100; i++)
    networkRecorder.record({ level: "debug", event: "ws.frame" });
  const exported = ctx.networkDiagnostics.export();
  try {
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([name, args]) =>
              name === "network_diagnostics_append" &&
              (args as { events: { event: string }[] }).events[0]?.event ===
                "ws.frame",
          ),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "network_diagnostics_export"),
    ).toBe(false);
  } finally {
    release();
  }
  expect(await exported).toEqual({
    path: "/Downloads/full-session.diagnostics.json",
  });
  const saved = vi
    .mocked(invoke)
    .mock.calls.flatMap(([name, args]) =>
      name === "network_diagnostics_append"
        ? (args as { events: { event: string }[] }).events
        : [],
    );
  expect(saved).toHaveLength(2100);
  expect(saved[0]?.event).toBe("ws.frame");
  expect(ctx.networkDiagnostics.snapshot().dropped).toBe(600);
  let finishExport!: (path: string) => void;
  const heldExport = new Promise<string>((resolve) => {
    finishExport = resolve;
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "network_diagnostics_read") return { archive };
    if (command === "network_diagnostics_export") return heldExport;
  });
  const secondExport = ctx.networkDiagnostics.export();
  try {
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("network_diagnostics_export"),
    );
    networkRecorder.record({ level: "warn", event: "during-export" });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("network_diagnostics_append", {
        events: [expect.objectContaining({ event: "during-export" })],
      }),
    );
  } finally {
    finishExport("/Downloads/second.json");
  }
  await secondExport;
  await ctx.fiber.dispose();
  const calls = vi.mocked(invoke).mock.calls.length;
  networkRecorder.record({ level: "warn", event: "after-disposal" });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(calls);
});

it("reports incomplete capture after IPC failure until a successful clear, and preserves browser exports", async () => {
  const ctx = context();
  await ctx.networkDiagnostics.setEnabled(true);
  await ctx.networkDiagnostics.setLevel("info");
  vi.mocked(invoke).mockRejectedValueOnce("private storage error");
  networkRecorder.record({ level: "warn", event: "failure" });
  await expect(ctx.networkDiagnostics.export()).rejects.toThrow(
    "Session capture is incomplete",
  );
  expect(ctx.networkDiagnostics.snapshot().archive?.error).not.toContain(
    "private storage error",
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([name]) => name === "network_diagnostics_export"),
  ).toBe(false);
  await ctx.networkDiagnostics.clear();
  expect(ctx.networkDiagnostics.snapshot()).toMatchObject({
    events: [],
    archive: { error: null },
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "network_diagnostics_read") return { archive };
    if (command === "network_diagnostics_export")
      return "/Downloads/recovered.json";
  });
  expect(await ctx.networkDiagnostics.export()).toEqual({
    path: "/Downloads/recovered.json",
  });
  let finishClear!: () => void;
  const clearing = new Promise<void>((resolve) => {
    finishClear = resolve;
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "network_diagnostics_read") return { archive };
    if (command === "network_diagnostics_clear") await clearing;
  });
  const clear = ctx.networkDiagnostics.clear();
  networkRecorder.record({ level: "warn", event: "before-clear-start" });
  try {
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("network_diagnostics_clear"),
    );
    networkRecorder.record({ level: "warn", event: "during-clear" });
  } finally {
    finishClear();
  }
  await clear;
  const clearIndex = vi
    .mocked(invoke)
    .mock.calls.findIndex(([name]) => name === "network_diagnostics_clear");
  const beforeIndex = vi
    .mocked(invoke)
    .mock.calls.findIndex(
      ([name, args]) =>
        name === "network_diagnostics_append" &&
        (args as { events: { event: string }[] }).events.some(
          (event) => event.event === "before-clear-start",
        ),
    );
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(clearIndex);
  expect(ctx.networkDiagnostics.snapshot().events).toEqual([
    expect.objectContaining({ event: "during-clear" }),
  ]);
  expect(invoke).toHaveBeenCalledWith("network_diagnostics_append", {
    events: [expect.objectContaining({ event: "during-clear" })],
  });
  await ctx.fiber.dispose();
  networkRecorder.clear();
  vi.mocked(isTauri).mockReturnValue(false);
  const browser = context();
  await browser.networkDiagnostics.setEnabled(true);
  networkRecorder.record({ level: "warn", event: "browser-event" });
  expect(await browser.networkDiagnostics.export()).toMatchObject({
    report: {
      host: "browser",
      native: null,
      client: { events: [{ event: "browser-event" }] },
    },
  });
  await browser.fiber.dispose();
});

it("does no native work while disabled and starts/stops collection with plugin activation", async () => {
  networkRecorder.setEnabled(false);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "network_diagnostics_read" ? { archive } : undefined,
  );
  const ctx = context();
  networkRecorder.record({ level: "warn", event: "disabled-error" });
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
  await ctx.networkDiagnostics.setEnabled(true);
  expect(invoke).toHaveBeenCalledWith("network_diagnostics_configure", {
    level: "info",
    enabled: true,
    resetAt: null,
  });
  networkRecorder.record({ level: "warn", event: "enabled-error" });
  await ctx.networkDiagnostics.setEnabled(false);
  const count = vi.mocked(invoke).mock.calls.length;
  networkRecorder.record({ level: "warn", event: "disabled-again" });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(
    ctx.networkDiagnostics.snapshot().events.map((event) => event.event),
  ).toEqual(["enabled-error"]);
  await ctx.fiber.dispose();
});

it("keeps collection disabled when a pending Debug acknowledgement arrives after disable", async () => {
  const ctx = context();
  await ctx.networkDiagnostics.setEnabled(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finishDisable!: () => void;
  const disabled = new Promise<void>((resolve) => {
    finishDisable = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "network_diagnostics_read") return { archive };
    if (
      command === "network_diagnostics_configure" &&
      (args as { level: string }).level === "debug"
    )
      await gate;
    if (
      command === "network_diagnostics_configure" &&
      !(args as { enabled: boolean }).enabled
    )
      await disabled;
  });
  const debug = ctx.networkDiagnostics.setLevel("debug");
  let stop: Promise<void> | undefined;
  try {
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("network_diagnostics_configure", {
        level: "debug",
        enabled: true,
        resetAt: null,
      }),
    );
    stop = ctx.networkDiagnostics.setEnabled(false);
    expect(networkRecorder.collecting()).toBe(false);
    release();
    await debug;
    // Hold native disable too: it must not mask a transient reactivation.
    expect(networkMetrics.enabled()).toBe(false);
    expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
  } finally {
    release();
    finishDisable();
  }
  await Promise.all([debug, stop]);
  expect(networkMetrics.enabled()).toBe(false);
  expect(networkRecorder.collecting()).toBe(false);
  expect(ctx.networkDiagnostics.snapshot().level).toBe("info");
});

it("leaves no summary timer when the service is disposed during its initial native refresh", async () => {
  vi.useFakeTimers();
  const ctx = context();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "network_diagnostics_read") {
      await gate;
      return { archive };
    }
  });
  const start = ctx.networkDiagnostics.setEnabled(true);
  let dispose: Promise<void> | undefined;
  try {
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("network_diagnostics_read", {
        recent: false,
      }),
    );
    dispose = ctx.fiber.dispose();
    release();
    await Promise.all([start, dispose]);
    expect(networkMetrics.enabled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await Promise.all([start, dispose]);
  }
});

it.each(["configure", "read"] as const)(
  "disposes a capture consumer during native %s without leaving producers or timers",
  async (stage) => {
    vi.useFakeTimers();
    networkRecorder.setEnabled(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (
        stage === "configure"
          ? command === "network_diagnostics_configure" &&
            (args as { enabled: boolean }).enabled
          : command === "network_diagnostics_read"
      )
        await gate;
      if (command === "network_diagnostics_read")
        return { archive: { path: null, error: null } };
    });
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    provideNetworkDiagnostics(root);
    const fiber = root
      .extend({
        pluginOwner: { id: "buzz.network-diagnostics", revision: "one" },
      })
      .plugin({
        apply(ctx) {
          ctx.effect(() => {
            void ctx.networkDiagnostics.setEnabled(true).catch(() => {});
            return () => ctx.networkDiagnostics.setEnabled(false);
          });
        },
      });
    let dispose: Promise<void> | undefined;
    try {
      // Observe the held activation before triggering disposal.
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(invoke)
            .mock.calls.some(
              ([command]) => command === `network_diagnostics_${stage}`,
            ),
        ).toBe(true),
      );
      dispose = fiber.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(networkRecorder.collecting()).toBe(false);
      release();
      await dispose;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(networkMetrics.enabled()).toBe(false);
      expect(networkRecorder.collecting()).toBe(false);
      expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
        "network_diagnostics_configure",
        ...(stage === "read" ? ["network_diagnostics_read"] : []),
        "network_diagnostics_configure",
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(vi.mocked(invoke).mock.lastCall).toEqual([
        "network_diagnostics_configure",
        { level: "info", enabled: false, resetAt: null },
      ]);
    } finally {
      release();
      await dispose;
      await root.fiber.dispose();
      networkMetrics.setEnabled(false);
      networkMetrics.reset();
      networkRecorder.clear();
      vi.useRealTimers();
      vi.resetAllMocks();
    }
  },
);
