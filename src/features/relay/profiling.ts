import { networkRecorder } from "../developer/network-diagnostics.ts";
/** Bounded, payload-free timings. Event/request IDs correlate stages without logging content. */
export type RelayTiming = Readonly<{
  stage: string;
  id: string;
  start: number;
  duration: number;
  outcome: "ok" | "error" | "pending";
  count?: number;
}>;
const networkStages = new Set([
  "read.queue",
  "read.fetch",
  "read.verify",
  "http.fetch",
  "broker.sign",
  "broker.auth",
  "broker.connect",
  "broker.ttfb",
  "broker.relay",
  "broker.upstream",
]);
export function createRelayProfiler(now = () => performance.now()) {
  const active = new Map<
    number,
    { stage: string; id: string; start: number; count?: number }
  >();
  let sequence = 0;
  const timings: RelayTiming[] = [];
  // This profiler also owns local projections keyed by channel/event IDs.
  // Only reader-issued opaque IDs belong in network evidence.
  const isReadId = (id: string) =>
    /^read:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,16}$/.test(
      id,
    );
  const record = (sample: RelayTiming) => {
    timings.push(Object.freeze(sample));
    if (
      networkRecorder.enabled("debug") &&
      isReadId(sample.id) &&
      networkStages.has(sample.stage)
    )
      networkRecorder.record({
        level: "debug",
        event: "read.stage",
        operationId: sample.id,
        phase: sample.stage,
        outcome: sample.outcome,
        ms: sample.duration,
        count: sample.count,
      });
    if (timings.length > 2048) timings.splice(0, timings.length - 2048);
  };
  const start = (stage: string, id: string, count?: number) => {
    const began = now();
    if (
      networkRecorder.enabled("debug") &&
      isReadId(id) &&
      networkStages.has(stage)
    )
      networkRecorder.record({
        level: "debug",
        event: "read.stage-started",
        operationId: id,
        phase: stage,
        count,
      });
    const key = ++sequence;
    active.set(key, {
      stage,
      id,
      start: began,
      ...(count === undefined ? {} : { count }),
    });
    if (active.size > 2048) {
      const oldest = active.keys().next();
      if (!oldest.done) active.delete(oldest.value);
    }
    let finished = false;
    return (outcome: "ok" | "error" = "ok") => {
      if (finished) return;
      finished = true;
      active.delete(key);
      record({
        stage,
        id,
        start: began,
        duration: now() - began,
        outcome,
        ...(count === undefined ? {} : { count }),
      });
    };
  };
  return Object.freeze({
    start,
    record,
    snapshot: () =>
      Object.freeze([
        ...timings,
        ...[...active.values()].map((sample) =>
          Object.freeze({
            ...sample,
            duration: now() - sample.start,
            outcome: "pending" as const,
          }),
        ),
      ]),
    clear: () => {
      timings.length = 0;
    },
    measure<T>(stage: string, id: string, work: () => T, count?: number): T {
      const finish = start(stage, id, count);
      try {
        const result = work();
        finish();
        return result;
      } catch (error) {
        finish("error");
        throw error;
      }
    },
    async measureAsync<T>(
      stage: string,
      id: string,
      work: () => Promise<T>,
    ): Promise<T> {
      const finish = start(stage, id);
      try {
        const result = await work();
        finish();
        return result;
      } catch (error) {
        finish("error");
        throw error;
      }
    },
  });
}
export type RelayProfiler = ReturnType<typeof createRelayProfiler>;
