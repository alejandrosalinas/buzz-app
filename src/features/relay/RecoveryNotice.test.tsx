// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ReadError } from "./errors";
import {
  createRecovery,
  RECOVERY_NOTICE_DELAY_MS,
  type RecoverySource,
  type RecoveryStatus,
} from "./recovery";
import { RecoveryNotice, useReauthorizedRetry } from "./RecoveryNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REFUSED = new Error("Federated sign-in is required");

function mount() {
  const recovery = createRecovery([]);
  const retry = vi.fn();
  const { result } = renderHook(() => useReauthorizedRetry(recovery, retry));
  const signIn = () => act(() => recovery.retryAll());
  return { recovery, retry, hook: result.current, signIn };
}

it("retries once a sign-in refusal of a read sent before sign-in", () => {
  const t = mount();
  const failed = t.hook.begin();
  act(() => failed(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
  t.signIn();
  t.signIn();
  expect(t.retry).toHaveBeenCalledTimes(1);
});

it("retries a refusal that lands after sign-in from a read sent before it", () => {
  const t = mount();
  const failed = t.hook.begin();
  t.signIn();
  act(() => failed(REFUSED));
  expect(t.retry).toHaveBeenCalledTimes(1);
});

it("leaves a read begun after sign-in alone when it is refused", () => {
  const t = mount();
  t.signIn();
  const failed = t.hook.begin();
  act(() => failed(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
});

it("does not retry failures sign-in cannot clear", () => {
  const t = mount();
  for (const problem of [
    new Error("not-found"),
    new Error("Permission denied"),
    new ReadError("invalid-response", "Relay response exceeds the read budget"),
  ]) {
    const failed = t.hook.begin();
    act(() => failed(problem));
  }
  t.signIn();
  expect(t.retry).not.toHaveBeenCalled();
});

it("does not spend a sign-in that landed while healthy on a later failure", () => {
  const t = mount();
  t.signIn();
  const failed = t.hook.begin();
  act(() => failed(new Error("not-found")));
  const refused = t.hook.begin();
  act(() => refused(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
});

it("stays quiet for the notice delay, then shows one buttonless notice until recovery settles", async () => {
  vi.useFakeTimers();
  let status: RecoveryStatus = "settled";
  const listeners = new Set<() => void>();
  const source: RecoverySource = {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
  };
  const set = (next: RecoveryStatus) =>
    act(() => {
      status = next;
      for (const listener of [...listeners]) listener();
    });
  const recovery = createRecovery([source]);
  render(
    <ToastProvider>
      <RecoveryNotice recovery={recovery} />
    </ToastProvider>,
  );
  set("failed");
  // A wake from sleep or a short outage stays silent for 30 seconds.
  expect(RECOVERY_NOTICE_DELAY_MS).toBe(30_000);
  await act(() => vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS - 1));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1));
  // Sonner mounts the card on its next frame.
  await act(() => vi.advanceTimersByTimeAsync(100));
  const notice = screen.getByRole("dialog", {
    name: "Buzz is having trouble connecting",
  });
  expect(notice).toHaveAccessibleDescription("Retrying automatically.");
  // Recovery retries on its own; there is nothing to press or dismiss.
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  set("settled");
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  recovery.dispose();
});
