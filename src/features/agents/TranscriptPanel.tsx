import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import activityStyles from "./ActivityLayout.module.css";
import { ActivityTranscript } from "./ActivityTranscript";
import type { Transcript, TranscriptTurn } from "./activity-transcript";
import { AgentsContext } from "./react";
import type { AgentViewProps } from "./service";

/** How long after a read an open transcript is read again while its agent
 * works. */
export const LIVE_READ_MS = 2500;
/** How long after a read a step the agent reports reads again. */
export const STEP_READ_MS = 1000;
/** Turns a merged transcript holds at most. */
export const TURN_LIMIT = 50;

/** Resolves once the window shows; rejects when `signal` aborts. */
export function whenShown(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      document.removeEventListener("visibilitychange", shows);
      signal.removeEventListener("abort", abort);
    };
    const shows = () => {
      if (document.hidden) return;
      done();
      resolve();
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    if (signal.aborted) return reject(signal.reason);
    if (!document.hidden) return resolve();
    document.addEventListener("visibilitychange", shows);
    signal.addEventListener("abort", abort, { once: true });
  });
}

type Shown<T> = Readonly<{
  key: string;
  /** null: the agent type has no transcript for it. */
  transcript?: T | null;
  error?: string;
}>;
/** A full read, or one of only the latest turns. */
type Kind = "full" | "latest";
const either = (a: Kind | undefined, b: Kind): Kind =>
  a === "full" || b === "full" ? "full" : "latest";

/** `held` with `turns` over its end, from the first of them it holds, and
 * at most {@link TURN_LIMIT} turns; undefined when it holds none of them, or
 * the turns it would replace hold a session `turns` don't. Turns older than
 * all it holds are left. */
export function withLatest<T extends Transcript>(
  held: T,
  turns: readonly TranscriptTurn[],
): T | undefined {
  if (!turns.length) return held;
  const ids = new Map(held.turns.map((turn, at) => [turn.turnId, at]));
  const from = turns.findIndex((turn) => ids.has(turn.turnId));
  if (from < 0) return undefined;
  const at = ids.get(turns[from]?.turnId ?? "") ?? 0;
  const kept = turns.slice(from);
  const sessions = new Set(kept.map((turn) => turn.sessionId));
  return held.turns.slice(at).every((turn) => sessions.has(turn.sessionId))
    ? {
        ...held,
        turns: [...held.turns.slice(0, at), ...kept].slice(-TURN_LIMIT),
      }
    : undefined;
}

/** `read` for `key`: in full on open, on `refresh`, and when `again` or
 * `working` changes; while working, `readLatest` (or `read` without it)
 * {@link LIVE_READ_MS}, or twice the read's duration if longer, after each
 * read finishes, and on the steps the agent reports, no sooner than
 * {@link STEP_READ_MS} or that after one. Latest turns that don't continue
 * the held transcript read it in full. Automatic reads wait while the window
 * is hidden and run once it shows. One read runs at a time; asking during
 * one reads once more after it, and a change of `key`, `again` or `working`
 * aborts it, hidden or not. The last result for `key` stays while the next
 * is read, never another key's. Only the first read and Refresh show as
 * loading. */
export function useLiveTranscript<T extends Transcript>({
  read,
  readLatest,
  key,
  again,
  working,
  agentKey,
}: {
  read: (signal: AbortSignal) => Promise<T | undefined>;
  readLatest?:
    | ((
        signal: AbortSignal,
        held: readonly TranscriptTurn[],
      ) => Promise<readonly TranscriptTurn[] | undefined>)
    | undefined;
  key: string;
  again: string;
  working: boolean;
  agentKey: string;
}) {
  const agents = useContext(AgentsContext);
  const [shown, setShown] = useState<Shown<T>>({ key });
  const held = useRef<Shown<T>>(shown);
  const [loading, setLoading] = useState(true);
  const latest = useRef({ read, readLatest, key, again, working });
  latest.current = { read, readLatest, key, again, working };
  const running = useRef<
    | { key: string; again: string; working: boolean; abort: AbortController }
    | undefined
  >(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stepTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** When the last read finished. */
  const finished = useRef(Number.NEGATIVE_INFINITY);
  /** How long the last read took, doubled. */
  const spent = useRef(0);
  /** A step was reported during the running read. */
  const stepped = useRef(false);
  /** Asked for during the running read. */
  const queued = useRef<Kind>(undefined);
  /** Asked for while the window was hidden. */
  const owed = useRef<Kind>(undefined);
  /** Starts a read, or queues one; `auto` waits for the window to show.
   * Returns whether a read started. */
  const request = useCallback(
    (auto: boolean, kind: Kind | "step" = "full"): boolean => {
      /** A reported step reads the latest turns, combining steps until
       * {@link STEP_READ_MS} after the last read finished. */
      const step = () => {
        if (running.current) {
          stepped.current = true;
          return;
        }
        stepped.current = false;
        const wait =
          finished.current + Math.max(STEP_READ_MS, spent.current) - Date.now();
        if (wait <= 0) return void request(true, "latest");
        stepTimer.current ??= setTimeout(() => {
          stepTimer.current = undefined;
          request(true, "latest");
        }, wait);
      };
      if (kind === "step") {
        step();
        return false;
      }
      if (auto && document.hidden) {
        owed.current = either(owed.current, kind);
        return false;
      }
      const { read, readLatest, key, again, working } = latest.current;
      const current = running.current;
      if (current?.key === key && current.again === again) {
        if (!auto) setLoading(true);
        queued.current = either(queued.current, kind);
        return false;
      }
      current?.abort.abort();
      clearTimeout(timer.current);
      clearTimeout(stepTimer.current);
      stepTimer.current = undefined;
      stepped.current = false;
      const abort = new AbortController();
      running.current = { key, again, working, abort };
      queued.current = undefined;
      const same = held.current.key === key;
      const prior = same ? held.current.transcript : undefined;
      // A settled read, even a failed one, keeps automatic reads quiet.
      if (!auto || (prior === undefined && !(same && held.current.error)))
        setLoading(true);
      const began = Date.now();
      const reading =
        kind === "latest" && readLatest && prior
          ? readLatest(abort.signal, prior.turns).then((turns) =>
              turns ? withLatest(prior, turns) : undefined,
            )
          : read(abort.signal).then((transcript) => transcript ?? null);
      const settle = (next: Omit<Shown<T>, "key">) => {
        if (abort.signal.aborted) return;
        running.current = undefined;
        finished.current = Date.now();
        spent.current = 2 * (finished.current - began);
        const before = held.current;
        held.current =
          next.error !== undefined && before.key === key
            ? { ...before, error: next.error }
            : { key, ...next };
        setShown(held.current);
        if (queued.current && request(true, queued.current)) return;
        setLoading(false);
        if (stepped.current) step();
        if (latest.current.working)
          timer.current = setTimeout(
            () => request(true, "latest"),
            Math.max(LIVE_READ_MS, spent.current),
          );
      };
      reading.then(
        (transcript) => {
          if (abort.signal.aborted) return;
          if (transcript !== undefined) return settle({ transcript });
          // The latest turns don't continue what it holds.
          running.current = undefined;
          if (!request(true)) setLoading(false);
        },
        (error: unknown) =>
          settle({
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return true;
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key, new read inputs, or a turn starting or ending reads again.
  useEffect(() => {
    // An obsolete read stops now, even while a hidden window defers the next.
    const current = running.current;
    if (
      current &&
      (current.key !== key ||
        current.again !== again ||
        current.working !== working)
    ) {
      current.abort.abort();
      running.current = undefined;
      queued.current = undefined;
    }
    request(true);
  }, [key, again, working]);
  useEffect(() => {
    const shows = () => {
      const kind = owed.current;
      if (document.hidden || !kind) return;
      owed.current = undefined;
      request(true, kind);
    };
    document.addEventListener("visibilitychange", shows);
    return () => {
      document.removeEventListener("visibilitychange", shows);
      clearTimeout(timer.current);
      clearTimeout(stepTimer.current);
      running.current?.abort.abort();
      running.current = undefined;
    };
  }, [request]);
  useEffect(() => {
    if (!working) {
      clearTimeout(timer.current);
      clearTimeout(stepTimer.current);
      stepTimer.current = undefined;
      return;
    }
    return agents?.subscribeSteps(agentKey, () => request(true, "step"));
  }, [working, agents, agentKey, request]);
  return {
    shown: shown.key === key ? shown : ({ key } as Shown<T>),
    loading,
    refresh: () => void request(false),
  };
}

/** One conversation's transcript as an agent type reads it, kept current
 * while the agent works, under a header whose Refresh stays in view. */
export function TranscriptPanel<T extends Transcript>({
  agent,
  read,
  readLatest,
  readKey,
  readAgain = "",
  working,
  reading,
  missing,
  failed,
  notes,
}: {
  agent: AgentViewProps["agent"];
  /** The agent type's read; resolves undefined when it has no transcript. */
  read: (signal: AbortSignal) => Promise<T | undefined>;
  /** Reads only the latest turns, oldest first, for refreshes while the agent
   * works; undefined when it can't. Without it, those read in full. */
  readLatest?: (
    signal: AbortSignal,
    held: readonly TranscriptTurn[],
  ) => Promise<readonly TranscriptTurn[] | undefined>;
  /** What `read` reads; another key never shows this one's result. */
  readKey: string;
  /** Inputs that only make `read` read again, keeping what it shows. */
  readAgain?: string;
  working: boolean;
  /** Shown before the first read settles. */
  reading: string;
  /** Shown when the agent type has no transcript for it. */
  missing: ReactNode;
  /** Leads the error, as "Could not read the … session". */
  failed: string;
  /** Shown above the oldest loaded turn. */
  notes?: (transcript: T) => ReactNode;
}) {
  const { shown, loading, refresh } = useLiveTranscript({
    read,
    readLatest,
    key: readKey,
    again: readAgain,
    working,
    agentKey: agent.key,
  });
  const { transcript, error } = shown;
  return (
    <div className={activityStyles.transcript}>
      <div className={activityStyles.transcriptHeader}>
        <InlineHeader
          title="Transcript"
          actions={
            <IconButton
              hint="familiar"
              aria-label="Refresh transcript"
              title="Refresh transcript"
              onClick={refresh}
              icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
      </div>
      <LoadingRegion
        pending={loading}
        label={transcript === undefined ? reading : "Refreshing transcript…"}
        statusVisibility={
          transcript === undefined ? "visible" : "screen-reader"
        }
        feedback={
          error !== undefined && (
            <p role="alert" className="m-0">
              {failed}: {error}
            </p>
          )
        }
      >
        {transcript ? (
          <ActivityTranscript
            transcript={transcript}
            agentName={agent.name}
            agentKey={agent.key}
            agentPicture={agent.picture}
            community={agent.relay}
            state={() => (working ? "working" : undefined)}
            before={notes?.(transcript)}
          />
        ) : (
          transcript === null && missing
        )}
      </LoadingRegion>
    </div>
  );
}
