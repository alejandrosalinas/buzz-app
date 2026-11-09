// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "./react";
import type { Agents } from "./service";
import {
  LIVE_READ_MS,
  STEP_READ_MS,
  TranscriptPanel,
  TURN_LIMIT,
  useLiveTranscript,
  withLatest,
} from "./TranscriptPanel";
import type { Transcript, TranscriptTurn } from "./activity-transcript";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A read whose calls each settle when the test says. */
function reads() {
  const calls: {
    key: string;
    signal: AbortSignal;
    resolve(value: string | undefined): void;
    reject(error: Error): void;
  }[] = [];
  const read = (key: string) => (signal: AbortSignal) =>
    new Promise<string | undefined>((resolve, reject) =>
      calls.push({ key, signal, resolve, reject }),
    );
  return { calls, read };
}

type Props = { key: string; again?: string; working: boolean };

function setup() {
  const steps = new Set<() => void>();
  const agents = {
    subscribeSteps: (_agent: string, listener: () => void) => {
      steps.add(listener);
      return () => void steps.delete(listener);
    },
  } as unknown as Agents;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentsContext.Provider value={agents}>{children}</AgentsContext.Provider>
  );
  const { calls, read } = reads();
  const view = renderHook(
    ({
      key,
      again = "",
      working,
    }: {
      key: string;
      again?: string;
      working: boolean;
    }) =>
      useLiveTranscript({
        // The hook only holds what it reads, so tests read strings.
        read: read(key) as unknown as (
          signal: AbortSignal,
        ) => Promise<Transcript | undefined>,
        key,
        again,
        working,
        agentKey: "agent",
      }),
    { wrapper, initialProps: { key: "a", working: false } as Props },
  );
  const step = () =>
    act(() => {
      for (const listener of steps) listener();
    });
  return { calls, view, steps, step };
}
function nth<T>(items: readonly T[], index: number) {
  const item = items[index];
  if (!item) throw new Error(`No read ${index}`);
  return item;
}
const settle = (call: { resolve(value: string): void }, value: string) =>
  act(async () => call.resolve(value));

it("reads on open and keeps its result while the next read runs", async () => {
  const { calls, view } = setup();
  expect(calls).toHaveLength(1);
  expect(view.result.current.loading).toBe(true);
  await settle(nth(calls, 0), "first");
  expect(view.result.current.shown.transcript).toBe("first");
  expect(view.result.current.loading).toBe(false);
  act(() => view.result.current.refresh());
  expect(calls).toHaveLength(2);
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.shown.transcript).toBe("first");
  await act(async () => nth(calls, 1).reject(new Error("busy")));
  expect(view.result.current.shown).toMatchObject({
    transcript: "first",
    error: "busy",
  });
});

it("keeps automatic reads quiet after the first read failed", async () => {
  const { calls, view } = setup();
  view.rerender({ key: "a", working: true });
  await act(async () => nth(calls, calls.length - 1).reject(new Error("busy")));
  expect(view.result.current.shown.error).toBe("busy");
  for (const _ of [1, 2]) {
    const before = calls.length;
    act(() => vi.advanceTimersByTime(LIVE_READ_MS));
    expect(calls).toHaveLength(before + 1);
    expect(view.result.current.loading).toBe(false);
    await act(async () => nth(calls, before).reject(new Error("busy")));
  }
  // Refresh still shows loading.
  act(() => view.result.current.refresh());
  expect(view.result.current.loading).toBe(true);
});

it("polls only while working, and stops when idle", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(1);
  // A turn starting reads at once, then on each interval.
  view.rerender({ key: "a", working: true });
  expect(calls).toHaveLength(2);
  await settle(nth(calls, 1), "b");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS));
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "c");
  // The turn ending reads once more, and the timer stops.
  view.rerender({ key: "a", working: false });
  expect(calls).toHaveLength(4);
  await settle(nth(calls, 3), "d");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(4);
});

it("never overlaps reads, and reads once more after one asked during it", async () => {
  const { calls, view, step } = setup();
  await settle(nth(calls, 0), "first");
  view.rerender({ key: "a", working: true });
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 4));
  // Automatic reads don't show as loading; Refresh does.
  expect(view.result.current.loading).toBe(false);
  step();
  act(() => view.result.current.refresh());
  expect(view.result.current.loading).toBe(true);
  expect(calls).toHaveLength(2);
  await settle(nth(calls, 1), "second");
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "third");
  expect(calls).toHaveLength(3);
  expect(view.result.current.loading).toBe(false);
});

it("reads for the agent's steps a second after a read, only while working", async () => {
  const { calls, view, steps, step } = setup();
  await settle(nth(calls, 0), "a");
  expect(steps.size).toBe(0);
  view.rerender({ key: "a", working: true });
  // A step during a read waits a second after it finishes.
  step();
  await settle(nth(calls, 1), "b");
  // Steps inside that second make one read.
  step();
  act(() => vi.advanceTimersByTime(STEP_READ_MS - 1));
  step();
  expect(calls).toHaveLength(2);
  act(() => vi.advanceTimersByTime(1));
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "c");
  // Well after a read, a step reads at once.
  act(() => vi.advanceTimersByTime(STEP_READ_MS));
  step();
  expect(calls).toHaveLength(4);
  await settle(nth(calls, 3), "d");
  view.rerender({ key: "a", working: false });
  expect(steps.size).toBe(0);
});

it("does not poll while the window is hidden", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  view.rerender({ key: "a", working: true });
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(1);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toHaveLength(2);
  hidden.mockRestore();
});

it("ignores a slow read that finishes after switching conversations", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  act(() => view.result.current.refresh());
  view.rerender({ key: "b", working: false });
  expect(nth(calls, 1).signal.aborted).toBe(true);
  expect(view.result.current.shown.transcript).toBeUndefined();
  await settle(nth(calls, 1), "late a");
  expect(view.result.current.shown.transcript).toBeUndefined();
  await settle(nth(calls, 2), "b");
  expect(view.result.current.shown.transcript).toBe("b");
});

it("waits while hidden to run a read queued during another", async () => {
  const { calls, view, step } = setup();
  await settle(nth(calls, 0), "a");
  view.rerender({ key: "a", working: true });
  step();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await settle(nth(calls, 1), "b");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(2);
  expect(view.result.current.loading).toBe(false);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toHaveLength(3);
  hidden.mockRestore();
});

it("aborts a pending read when the agent goes idle, and reads in full at once", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  view.rerender({ key: "a", working: true });
  expect(calls).toHaveLength(2);
  view.rerender({ key: "a", working: false });
  expect(nth(calls, 1).signal.aborted).toBe(true);
  expect(calls).toHaveLength(3);
  expect(view.result.current.shown.transcript).toBe("a");
  await settle(nth(calls, 2), "final");
  expect(view.result.current.shown.transcript).toBe("final");
});

it("aborts a pending read when its inputs change while hidden, keeping what it shows", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  act(() => view.result.current.refresh());
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  view.rerender({ key: "a", again: "next", working: false });
  expect(nth(calls, 1).signal.aborted).toBe(true);
  expect(calls).toHaveLength(2);
  await settle(nth(calls, 1), "stale");
  expect(view.result.current.shown.transcript).toBe("a");
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "next");
  expect(view.result.current.shown.transcript).toBe("next");
  hidden.mockRestore();
});

it("waits twice as long as the last read took, when longer", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  view.rerender({ key: "a", working: true });
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 2));
  await settle(nth(calls, 1), "b");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 4 - 1));
  expect(calls).toHaveLength(2);
  act(() => vi.advanceTimersByTime(1));
  expect(calls).toHaveLength(3);
});

it("reads once when shown after a turn ended while hidden", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  view.rerender({ key: "a", working: true });
  await settle(nth(calls, 1), "b");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  view.rerender({ key: "a", working: false });
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(2);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toHaveLength(3);
  hidden.mockRestore();
});

it("keeps the transcript while new read inputs are read, and ignores the read they replace", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "first");
  act(() => view.result.current.refresh());
  view.rerender({ key: "a", again: "s2", working: false });
  expect(nth(calls, 1).signal.aborted).toBe(true);
  expect(view.result.current.shown.transcript).toBe("first");
  await settle(nth(calls, 1), "stale");
  expect(view.result.current.shown.transcript).toBe("first");
  await act(async () => nth(calls, 2).reject(new Error("gone")));
  expect(view.result.current.shown).toMatchObject({
    transcript: "first",
    error: "gone",
  });
  view.rerender({ key: "a", again: "s3", working: false });
  await settle(nth(calls, 3), "second");
  expect(view.result.current.shown).toEqual({ key: "a", transcript: "second" });
});

it("shows a missing transcript as null", async () => {
  const { calls, view } = setup();
  await act(async () => nth(calls, 0).resolve(undefined));
  expect(view.result.current.shown.transcript).toBeNull();
});

it("keeps the shown transcript mounted while its sessions change", async () => {
  const pending: {
    resolve(value: Transcript): void;
    reject(error: Error): void;
  }[] = [];
  const read = () =>
    new Promise<Transcript | undefined>((resolve, reject) =>
      pending.push({ resolve, reject }),
    );
  const agent = { key: "agent", name: "Agent" } as Parameters<
    typeof TranscriptPanel
  >[0]["agent"];
  const panel = (readAgain: string) => (
    <div style={{ overflowY: "auto" }}>
      <TranscriptPanel
        agent={agent}
        read={read}
        readKey="conversation"
        readAgain={readAgain}
        working={false}
        reading="Reading…"
        missing="Missing"
        failed="Could not read"
      />
    </div>
  );
  const view = render(panel("s1"));
  await act(async () => pending[0]?.resolve({ turns: [] }));
  const shown = screen.getByText("No turns captured for this scope yet.");
  view.rerender(panel("s1 s2"));
  expect(shown).toBeInTheDocument();
  await act(async () => pending[1]?.reject(new Error("gone")));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not read: gone");
  expect(shown).toBeInTheDocument();
  view.rerender(panel("s1 s2 s3"));
  await act(async () => pending[2]?.resolve({ turns: [] }));
  expect(screen.queryByRole("alert")).toBeNull();
  // The same element, so it keeps the reader's place and open details.
  expect(screen.getByText("No turns captured for this scope yet.")).toBe(shown);
});

const turn = (turnId: string, text = turnId) =>
  ({
    turnId,
    startedAt: 1,
    items: [{ id: text }],
  }) as unknown as TranscriptTurn;

it("swaps the latest turns over the end of the held transcript", () => {
  const held = { turns: [turn("1"), turn("2", "open")], more: true };
  expect(withLatest(held, [turn("2", "grown"), turn("3")])).toEqual({
    turns: [turn("1"), turn("2", "grown"), turn("3")],
    more: true,
  });
  expect(withLatest(held, [])).toBe(held);
  // Turns older than all it holds are left.
  expect(withLatest(held, [turn("0"), turn("2"), turn("3")])).toEqual({
    turns: [turn("1"), turn("2"), turn("3")],
    more: true,
  });
  // It holds at most TURN_LIMIT turns.
  const full = {
    turns: Array.from({ length: TURN_LIMIT }, (_, i) => turn(String(i))),
  };
  const grown = withLatest(full, [turn(String(TURN_LIMIT - 1)), turn("new")]);
  expect(grown?.turns).toHaveLength(TURN_LIMIT);
  expect(grown?.turns.at(-1)).toEqual(turn("new"));
  // A turn it doesn't hold can't be placed.
  expect(withLatest(held, [turn("9")])).toBeUndefined();
  // Nor can turns that would cut another session's.
  const sessions = (id: string, sessionId: string) => ({
    ...turn(id),
    sessionId,
  });
  const two = { turns: [sessions("1", "A"), sessions("2", "B")] };
  expect(withLatest(two, [sessions("1", "A")])).toBeUndefined();
  expect(withLatest(two, [sessions("2", "B"), sessions("3", "B")])).toEqual({
    turns: [sessions("1", "A"), sessions("2", "B"), sessions("3", "B")],
  });
});

it("reads only the latest turns while working, and in full when they don't fit", async () => {
  const full: ((value: Transcript) => void)[] = [];
  const latest: ((value: readonly TranscriptTurn[] | undefined) => void)[] = [];
  const view = renderHook(
    ({ working }: { working: boolean }) =>
      useLiveTranscript({
        read: () =>
          new Promise<Transcript | undefined>((resolve) => full.push(resolve)),
        readLatest: () =>
          new Promise<readonly TranscriptTurn[] | undefined>((resolve) =>
            latest.push(resolve),
          ),
        key: "a",
        again: "",
        working,
        agentKey: "agent",
      }),
    { initialProps: { working: true } },
  );
  await act(async () => full[0]?.({ turns: [turn("1"), turn("2")] }));
  // The next read starts a full interval after this one finished.
  act(() => vi.advanceTimersByTime(LIVE_READ_MS - 1));
  expect(latest).toHaveLength(0);
  act(() => vi.advanceTimersByTime(1));
  expect(latest).toHaveLength(1);
  await act(async () => latest[0]?.([turn("2", "grown"), turn("3")]));
  expect(view.result.current.shown.transcript?.turns).toEqual([
    turn("1"),
    turn("2", "grown"),
    turn("3"),
  ]);
  expect(full).toHaveLength(1);
  act(() => vi.advanceTimersByTime(LIVE_READ_MS));
  await act(async () => latest[1]?.([turn("9")]));
  expect(full).toHaveLength(2);
  await act(async () => full[1]?.({ turns: [turn("9")] }));
  expect(view.result.current.shown.transcript?.turns).toEqual([turn("9")]);
  // An unmatched latest read while hidden reads in full once shown.
  act(() => vi.advanceTimersByTime(LIVE_READ_MS));
  expect(latest).toHaveLength(3);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => latest[2]?.(undefined));
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(full).toHaveLength(2);
  expect(view.result.current.loading).toBe(false);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(full).toHaveLength(3);
  expect(latest).toHaveLength(3);
});
