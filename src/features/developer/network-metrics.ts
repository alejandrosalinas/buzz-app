/** Fixed five-second buckets; no retained frame/request samples or payloads. */
const COUNTERS = [
  "connects",
  "reconnects",
  "restored",
  "renewals",
  "manual",
  "connectFailed",
  "connectOk",
  "connectCancelled",
  "disconnects",
  "probeSent",
  "probeAnswered",
  "probeTimeout",
  "probeDeferred",
  "probeCancelled",
  "readOk",
  "readFailed",
  "readDeadline",
  "readCancelled",
  "requestOk",
  "requestFailed",
  "requestCancelled",
  "publishOk",
  "publishFailed",
  "publishCancelled",
  "txFrames",
  "rxFrames",
  "txBytes",
  "rxBytes",
] as const;
export type MetricCounter = (typeof COUNTERS)[number];
const LATENCIES = [
  "opening",
  "authentication",
  "ready",
  "rtt",
  "publicationAck",
  "http",
  "subscriptionFirst",
  "subscriptionEose",
] as const;
type Latency = (typeof LATENCIES)[number];
const BOUNDS = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  30000,
  90000,
  Infinity,
];
const WIDTH = COUNTERS.length + LATENCIES.length * (BOUNDS.length + 2);
const offset = new Map(COUNTERS.map((key, i) => [key, i]));
export type Traffic = {
  txFrames: number;
  rxFrames: number;
  txBytes: number;
  rxBytes: number;
};
export type NativeTraffic = {
  relay: string;
  session: Traffic;
  minute: Traffic;
  fiveMinutes: Traffic;
};
export type MetricWindow = {
  seconds: number;
  counts: Record<MetricCounter, number>;
  latency: Record<
    Latency,
    {
      count: number;
      mean: number | null;
      p50: number | null;
      p95: number | null;
    }
  >;
};
export type RelayMetrics = {
  relay: string;
  active: number;
  connecting: number;
  authenticated: number;
  inFlight: number;
  nativeTraffic: boolean;
  session: MetricWindow;
  minute: MetricWindow;
  fiveMinutes: MetricWindow;
};
type State = {
  totals: Float64Array;
  buckets: ({ tick: number; values: Float64Array } | undefined)[];
};
const label = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return "unknown-relay";
  }
};
const empty = (): State => ({
  totals: new Float64Array(WIDTH),
  buckets: Array.from({ length: 60 }),
});

export function createNetworkMetrics(now = () => Date.now()) {
  let enabled = false,
    since: number | undefined,
    generation = 0;
  let stoppedAt: number | undefined;
  const relays = new Map<string, State>();
  const connections = new Set<{
    relay: string;
    state: "connecting" | "open" | "authenticated" | "closed";
  }>();
  const inFlight = new Map<string, number>();
  const bounded = (peer: string) =>
    relays.has(peer) || relays.size < 64 ? peer : "other-relays";
  const key = (url: string) => bounded(label(url));
  const write = (
    relay: string,
    index: number,
    amount: number,
    at = Math.floor(now() / 5000),
  ) => {
    if (!enabled) return;
    relay = bounded(relay);
    let state = relays.get(relay);
    if (!state) {
      state = empty();
      relays.set(relay, state);
    }
    const tick = at,
      slot = tick % 60;
    let bucket = state.buckets[slot];
    if (bucket?.tick !== tick) {
      bucket = { tick, values: new Float64Array(WIDTH) };
      state.buckets[slot] = bucket;
    }
    state.totals[index] = (state.totals[index] ?? 0) + amount;
    bucket.values[index] = (bucket.values[index] ?? 0) + amount;
  };
  const counter = (
    relay: string,
    name: MetricCounter,
    amount = 1,
    at?: number,
  ) => write(relay, offset.get(name) ?? 0, amount, at);
  const duration = (relay: string, name: Latency, ms: number) => {
    if (!enabled || !Number.isFinite(ms) || ms < 0) return;
    const start =
      COUNTERS.length + LATENCIES.indexOf(name) * (BOUNDS.length + 2);
    const at = Math.floor(now() / 5000);
    write(relay, start + BOUNDS.findIndex((bound) => ms <= bound), 1, at);
    write(relay, start + BOUNDS.length, ms, at);
    write(relay, start + BOUNDS.length + 1, 1, at);
  };
  const reset = () => {
    generation++;
    relays.clear();
    inFlight.clear();
    since = enabled ? now() : undefined;
    for (const c of connections)
      if (c.state !== "closed" && !relays.has(bounded(c.relay)))
        relays.set(bounded(c.relay), empty());
  };
  const window = (values: Float64Array, seconds: number): MetricWindow => {
    const counts = Object.fromEntries(
      COUNTERS.map((name, i) => [name, values[i] ?? 0]),
    ) as Record<MetricCounter, number>;
    const latency = Object.fromEntries(
      LATENCIES.map((name, i) => {
        const start = COUNTERS.length + i * (BOUNDS.length + 2),
          count = values[start + BOUNDS.length + 1] ?? 0;
        const percentile = (p: number) => {
          if (!count) return null;
          let n = 0;
          for (const [j, bound] of BOUNDS.entries()) {
            n += values[start + j] ?? 0;
            if (n >= Math.ceil(count * p))
              return Number.isFinite(bound) ? bound : null;
          }
          return null;
        };
        return [
          name,
          {
            count,
            mean: count ? (values[start + BOUNDS.length] ?? 0) / count : null,
            p50: percentile(0.5),
            p95: percentile(0.95),
          },
        ];
      }),
    ) as MetricWindow["latency"];
    return { seconds, counts, latency };
  };
  return {
    enabled: () => enabled,
    epoch: () => (enabled ? generation : undefined),
    current: (epoch: number | undefined) =>
      enabled && epoch !== undefined && epoch === generation,
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      stoppedAt = next ? undefined : now();
      if (next) reset();
    },
    reset,
    relay(url: string) {
      const relay = key(url);
      return {
        count(name: MetricCounter, amount = 1) {
          if (enabled) counter(relay, name, amount);
        },
        duration(name: Latency, ms: number) {
          if (enabled) duration(relay, name, ms);
        },
        /** Start at dispatch; only a matching response completes the sample. */
        timer(name: Latency) {
          if (!enabled) return undefined;
          const epoch = generation,
            started = performance.now();
          let finished = false;
          return () => {
            if (finished) return;
            finished = true;
            if (enabled && generation === epoch)
              duration(relay, name, performance.now() - started);
          };
        },
        frame(outgoing: boolean, bytes: number) {
          if (enabled) {
            const at = Math.floor(now() / 5000);
            counter(relay, outgoing ? "txFrames" : "rxFrames", 1, at);
            counter(relay, outgoing ? "txBytes" : "rxBytes", bytes, at);
          }
        },
        connection() {
          const connection = {
            relay,
            state: "connecting" as
              | "connecting"
              | "open"
              | "authenticated"
              | "closed",
          };
          connections.add(connection);
          return (state: typeof connection.state) => {
            connection.state = state;
            if (state === "closed") connections.delete(connection);
          };
        },
        operation(kind: "read" | "request" | "publish") {
          if (!enabled) return undefined;
          const operationRelay = bounded(relay);
          const epoch = generation;
          if (!relays.has(operationRelay)) relays.set(operationRelay, empty());
          if (kind === "request")
            inFlight.set(
              operationRelay,
              (inFlight.get(operationRelay) ?? 0) + 1,
            );
          let finished = false;
          return (outcome: "ok" | "failed" | "cancelled" | "deadline") => {
            if (finished) return;
            finished = true;
            if (!enabled || generation !== epoch) return;
            if (kind === "request")
              inFlight.set(
                operationRelay,
                Math.max(0, (inFlight.get(operationRelay) ?? 1) - 1),
              );
            counter(
              operationRelay,
              `${kind}${outcome === "ok" ? "Ok" : outcome === "cancelled" ? "Cancelled" : outcome === "deadline" && kind === "read" ? "Deadline" : "Failed"}` as MetricCounter,
            );
          };
        },
      };
    },
    snapshot(native: readonly NativeTraffic[] = []) {
      const at = enabled ? now() : (stoppedAt ?? now()),
        tick = Math.floor(at / 5000);
      const result: RelayMetrics[] = [];
      for (const connection of connections)
        if (!relays.has(bounded(connection.relay)))
          relays.set(bounded(connection.relay), empty());
      for (const traffic of native) {
        const relay = key(traffic.relay);
        if (!relays.has(relay)) relays.set(relay, empty());
      }
      for (const [relay, state] of relays) {
        const values = (ticks: number) => {
          const values = new Float64Array(WIDTH);
          for (const bucket of state.buckets)
            if (bucket && bucket.tick <= tick && bucket.tick > tick - ticks)
              for (let i = 0; i < WIDTH; i++)
                values[i] = (values[i] ?? 0) + (bucket.values[i] ?? 0);
          return values;
        };
        const age = since === undefined ? 0 : Math.max(0, (at - since) / 1000);
        const row: RelayMetrics = {
          relay,
          active: 0,
          connecting: 0,
          authenticated: 0,
          inFlight: inFlight.get(relay) ?? 0,
          nativeTraffic: false,
          session: window(state.totals, age),
          minute: window(values(12), Math.min(age, 60)),
          fiveMinutes: window(values(60), Math.min(age, 300)),
        };
        for (const connection of connections)
          if (bounded(connection.relay) === relay) {
            if (connection.state === "connecting") row.connecting++;
            else if (connection.state !== "closed") row.active++;
            if (connection.state === "authenticated") row.authenticated++;
          }
        for (const traffic of native)
          if (key(traffic.relay) === relay) {
            row.nativeTraffic = true;
            for (const range of ["session", "minute", "fiveMinutes"] as const)
              for (const count of [
                "txFrames",
                "rxFrames",
                "txBytes",
                "rxBytes",
              ] as const)
                row[range].counts[count] += traffic[range][count];
          }
        result.push(row);
      }
      return { enabled, since, at, resolutionMs: 5000, relays: result };
    },
  };
}
export const networkMetrics = createNetworkMetrics();

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
