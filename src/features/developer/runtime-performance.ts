/** One on-demand page capture. Only numeric aggregates survive a callback. */
type Total = { count: number; totalMs: number; maxMs: number };
const total = (): Total => ({ count: 0, totalMs: 0, maxMs: 0 });
const add = (entry: Total, value: number) => {
  entry.count++;
  entry.totalMs += value;
  entry.maxMs = Math.max(entry.maxMs, value);
};
const lagThresholdMs = 50;
const workStages = ["fold", "verify.read", "verify.restore"] as const;
type WorkStage = (typeof workStages)[number];

export function createRuntimePerformance() {
  let sessionId: string | undefined;
  let active: ReturnType<typeof counters> | undefined;
  const counters = () => ({
    work: Object.fromEntries(
      workStages.map((stage) => [stage, { ...total(), items: 0 }]),
    ) as Record<WorkStage, Total & { items: number }>,
    reads: { ...total(), codeUnits: 0, failed: 0, background: 0 },
    mcpReplies: { ...total(), codeUnits: 0, failed: 0 },
  });
  return {
    work(stage: string, ms: number, count: number) {
      if (!active || !workStages.includes(stage as WorkStage)) return;
      const entry = active.work[stage as WorkStage];
      add(entry, ms);
      entry.items += count;
    },
    read(input: { ms: number; bytes: number; ok: boolean; priority: string }) {
      if (!active) return;
      add(active.reads, input.ms);
      active.reads.codeUnits += input.bytes;
      if (!input.ok) active.reads.failed++;
      if (input.priority === "background") active.reads.background++;
    },
    /** Same serialization as the transport, with no second payload traversal. */
    serializeMcpReply(value: unknown) {
      const current = active;
      if (!current) return JSON.stringify(value);
      const start = performance.now();
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
        return encoded;
      } finally {
        add(current.mcpReplies, performance.now() - start);
        if (encoded === undefined) current.mcpReplies.failed++;
        else current.mcpReplies.codeUnits += encoded.length;
      }
    },
    capture(
      durationMs: number,
      subscribe: (changed: () => void) => () => void,
      signals: readonly AbortSignal[] = [],
    ) {
      if (
        !Number.isInteger(durationMs) ||
        durationMs < 1000 ||
        durationMs > 10000
      )
        throw new Error("duration_ms must be an integer from 1000 to 10000.");
      if (active) throw new Error("A performance snapshot is already running.");
      for (const signal of signals) signal.throwIfAborted();
      if (typeof document === "undefined")
        throw new Error("Performance snapshots require the Buzz app page.");
      sessionId ??= crypto.randomUUID();
      const current = counters();
      active = current;
      const start = performance.now();
      const startedAt = new Date().toISOString();
      const lag = total();
      const longTasks = total();
      let updates = 0;
      let visibleMs = 0;
      let visibilityAt = start;
      let hidden = document.hidden;
      let expected = start + 100;
      let samples = 0;
      const supported =
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask");
      return new Promise<object>((resolve, reject) => {
        const cleanups: (() => void)[] = [];
        const visibility = () => {
          const at = performance.now();
          if (!hidden) visibleMs += at - visibilityAt;
          visibilityAt = at;
          hidden = document.hidden;
          expected = at + 100;
        };
        const sampleLag = (at: number) => {
          if (hidden) return;
          samples++;
          const delay = at - expected;
          if (delay >= lagThresholdMs) add(lag, delay);
        };
        const finish = (failure?: { reason: unknown }) => {
          if (active !== current) return;
          const end = performance.now();
          // The deadline can run before an interval delayed by the same stall.
          if (!failure && end - expected >= lagThresholdMs) sampleLag(end);
          active = undefined;
          for (const cleanup of cleanups.reverse()) cleanup();
          if (!hidden) visibleMs += end - visibilityAt;
          if (failure) return reject(failure.reason);
          resolve({
            version: 1,
            sessionId,
            startedAt,
            requestedMs: durationMs,
            elapsedMs: end - start,
            visibility: {
              visibleMs,
              hiddenMs: end - start - visibleMs,
              end: document.visibilityState,
            },
            mainThread: {
              timerLag: {
                ...lag,
                intervalMs: 100,
                samples,
                thresholdMs: lagThresholdMs,
              },
              longTasks: {
                supported,
                ...(supported
                  ? longTasks
                  : { reason: "Engine does not expose longtask entries." }),
              },
            },
            agentUpdates: updates,
            ...current,
            unsupported: [
              "process CPU",
              "heap bytes",
              "layout time",
              "style time",
              "all JavaScript time",
              "JSON outside plugin MCP replies",
              "subscriber count",
            ],
          });
        };
        try {
          cleanups.push(
            subscribe(() => {
              updates++;
            }),
          );
          document.addEventListener("visibilitychange", visibility);
          cleanups.push(() =>
            document.removeEventListener("visibilitychange", visibility),
          );
          const timer = setInterval(() => {
            const at = performance.now();
            sampleLag(at);
            expected = at + 100;
          }, 100);
          cleanups.push(() => clearInterval(timer));
          if (supported) {
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (entry.startTime >= start) add(longTasks, entry.duration);
              }
            });
            observer.observe({ type: "longtask" });
            cleanups.push(() => observer.disconnect());
          }
          for (const signal of signals) {
            const cancel = () => finish({ reason: signal.reason });
            signal.addEventListener("abort", cancel, { once: true });
            cleanups.push(() => signal.removeEventListener("abort", cancel));
          }
          for (const signal of signals) signal.throwIfAborted();
          const deadline = setTimeout(() => finish(), durationMs);
          cleanups.push(() => clearTimeout(deadline));
        } catch (error) {
          finish({ reason: error });
        }
      });
    },
  };
}

export const runtimePerformance = createRuntimePerformance();
