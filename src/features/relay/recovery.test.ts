import { networkRecorder } from "../developer/network-diagnostics";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createRecovery,
  RECOVERY_DELAYS_MS,
  RECOVERY_NOTICE_DELAY_MS,
  reauthorizedOnce,
  type RelayRecovery,
  type RecoveryStatus,
} from "./recovery";

function source(initial: RecoveryStatus = "settled") {
  let status = initial;
  const listeners = new Set<() => void>();
  const retry = vi.fn(() => set("busy"));
  function set(next: RecoveryStatus) {
    status = next;
    for (const listener of [...listeners]) listener();
  }
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry,
    set,
  };
}
beforeEach(() => {
  networkRecorder.setEnabled(true);
  vi.useFakeTimers();
});
afterEach(() => {
  networkRecorder.configure("info");
  networkRecorder.clear();
  vi.useRealTimers();
});

it("retries a failed read forever with a capped delay", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  expect(recovery.snapshot()).toEqual({
    recovering: true,
    attempt: 0,
    shown: false,
    reauthorized: 0,
  });
  const delays = [...RECOVERY_DELAYS_MS, 30_000, 30_000, 30_000];
  for (const [index, delay] of delays.entries()) {
    vi.advanceTimersByTime(delay - 1);
    expect(read.retry).toHaveBeenCalledTimes(index);
    vi.advanceTimersByTime(1);
    expect(read.retry).toHaveBeenCalledTimes(index + 1);
    // The notice stays up while the retry runs, then the read fails again.
    expect(recovery.snapshot().recovering).toBe(true);
    read.set("failed");
  }
  recovery.dispose();
});

it("retries only the failed sources and clears once every source settles", () => {
  const failed = source();
  const healthy = source();
  const recovery = createRecovery([failed, healthy]);
  failed.set("failed");
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  expect(failed.retry).toHaveBeenCalledTimes(1);
  expect(healthy.retry).not.toHaveBeenCalled();
  expect(recovery.snapshot()).toEqual({
    recovering: true,
    attempt: 1,
    shown: false,
    reauthorized: 0,
  });
  failed.set("settled");
  expect(recovery.snapshot()).toEqual({
    recovering: false,
    attempt: 0,
    shown: false,
    reauthorized: 0,
  });
  vi.advanceTimersByTime(60_000);
  expect(failed.retry).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it("shows the notice only once recovery lasts the notice delay", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  vi.advanceTimersByTime(RECOVERY_NOTICE_DELAY_MS - 1);
  // The first retry ran and still hangs: the notice timer does not wait on it.
  expect(read.retry).toHaveBeenCalledTimes(1);
  expect(read.status()).toBe("busy");
  expect(recovery.snapshot().shown).toBe(false);
  vi.advanceTimersByTime(1);
  expect(recovery.snapshot()).toMatchObject({ recovering: true, shown: true });
  read.set("settled");
  expect(recovery.snapshot().shown).toBe(false);

  // A failure that a retry fixes before the delay never shows the notice.
  read.set("failed");
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  read.set("settled");
  vi.advanceTimersByTime(60_000);
  expect(recovery.snapshot().shown).toBe(false);
  // The next failure gets the full delay again.
  read.set("failed");
  vi.advanceTimersByTime(RECOVERY_NOTICE_DELAY_MS - 1);
  expect(recovery.snapshot().shown).toBe(false);
  vi.advanceTimersByTime(1);
  expect(recovery.snapshot().shown).toBe(true);
  recovery.dispose();
});

it("retryNow skips the wait and restarts the delay sequence", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  for (const delay of RECOVERY_DELAYS_MS.slice(0, 4)) {
    vi.advanceTimersByTime(delay);
    read.set("failed");
  }
  expect(recovery.snapshot().attempt).toBe(4);
  recovery.retryNow();
  expect(read.retry).toHaveBeenCalledTimes(5);
  read.set("failed");
  expect(recovery.snapshot().attempt).toBe(0);
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  expect(read.retry).toHaveBeenCalledTimes(6);
  recovery.dispose();
});

it("keeps a shown notice up through retryNow until every source settles", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  // Before the notice delay a manual or signal retry stays quiet.
  recovery.retryNow();
  expect(recovery.snapshot().shown).toBe(false);
  read.set("failed");
  vi.advanceTimersByTime(RECOVERY_NOTICE_DELAY_MS);
  expect(recovery.snapshot().shown).toBe(true);
  // Retry now restarts the delay but must not hide the notice and its
  // focused button while the retried read is still running.
  recovery.retryNow();
  expect(recovery.snapshot()).toMatchObject({
    attempt: 0,
    shown: true,
    reauthorized: 0,
  });
  read.set("failed");
  expect(recovery.snapshot().shown).toBe(true);
  recovery.retryNow();
  read.set("settled");
  expect(recovery.snapshot()).toEqual({
    recovering: false,
    attempt: 0,
    shown: false,
    reauthorized: 0,
  });
  recovery.dispose();
});

it("retryNow does no work while every source is healthy", () => {
  const read = source();
  const recovery = createRecovery([read]);
  recovery.retryNow();
  expect(read.retry).not.toHaveBeenCalled();
  recovery.dispose();
});

it("dispose stops pending retries and the notice", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  recovery.dispose();
  vi.advanceTimersByTime(120_000);
  expect(read.retry).not.toHaveBeenCalled();
  expect(recovery.snapshot().shown).toBe(false);
});

it("retries settled sources too when asked to retry all", () => {
  const denied = source("settled");
  const failed = source("failed");
  const recovery = createRecovery([denied, failed]);
  recovery.retryAll();
  expect(denied.retry).toHaveBeenCalledTimes(1);
  expect(failed.retry).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it("reopens once, only after credentials change since the request was sent", () => {
  let reauthorized = 2;
  const listeners = new Set<() => void>();
  const recovery = {
    snapshot: () => ({ reauthorized }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayRecovery;
  const retry = vi.fn();
  reauthorizedOnce(recovery, 2, retry);
  for (const listener of [...listeners]) listener();
  expect(retry).not.toHaveBeenCalled();
  reauthorized = 3;
  for (const listener of [...listeners]) listener();
  for (const listener of [...listeners]) listener();
  expect(retry).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});

it("records late retry callbacks and their trigger within one recovery episode", () => {
  networkRecorder.clear();
  const pending = new Map<object, { callback: () => void; delay: number }>();
  const timers = {
    setTimeout(callback: () => void, delay: number) {
      const handle = {};
      pending.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle as object);
    },
  };
  const read = source();
  const recovery = createRecovery([read], timers, {
    relay: "https://relay.test",
    connection: "test-session",
  });
  try {
    read.set("failed");
    const scheduled = networkRecorder
      .snapshot()
      .events.find((event) => event.event === "recovery.retry-scheduled");
    expect(scheduled?.operationId).toMatch(/^recovery:/);
    expect(scheduled?.dueAt).toBe(Date.now() + 1000);
    const retry = [...pending.values()].find((timer) => timer.delay === 1000);
    expect(retry).toBeDefined();
    vi.advanceTimersByTime(26_000);
    retry?.callback();
    expect(read.retry).toHaveBeenCalledTimes(1);
    expect(networkRecorder.snapshot().events).toContainEqual(
      expect.objectContaining({
        event: "recovery.retry-fired",
        operationId: scheduled?.operationId,
        latenessMs: 25_000,
      }),
    );
    recovery.retryNow(undefined, "wake-gap");
    expect(networkRecorder.snapshot().events).toContainEqual(
      expect.objectContaining({
        event: "recovery.retry-now",
        operationId: scheduled?.operationId,
        detail: "wake-gap",
      }),
    );
    read.set("settled");
    expect(networkRecorder.snapshot().events).toContainEqual(
      expect.objectContaining({
        event: "recovery",
        operationId: scheduled?.operationId,
        outcome: "settled",
      }),
    );
    read.set("failed");
    expect(
      networkRecorder
        .snapshot()
        .events.filter((event) => event.event === "recovery.retry-scheduled")
        .at(-1)?.operationId,
    ).not.toBe(scheduled?.operationId);
  } finally {
    recovery.dispose();
  }
});
