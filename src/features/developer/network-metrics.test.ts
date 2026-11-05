import { expect, it } from "vitest";
import { createNetworkMetrics, utf8Bytes } from "./network-metrics";

it("captures an existing connection without inventing pre-enable traffic and stops on disable", () => {
  const metrics = createNetworkMetrics(() => 1000);
  const relay = metrics.relay(
    "wss://user:secret@relay.test/private?token=secret",
  );
  const state = relay.connection();
  state("authenticated");
  relay.frame(true, 100);
  expect(metrics.snapshot().relays[0]?.session.counts.txFrames).toBe(0);
  metrics.setEnabled(true);
  relay.frame(true, 6);
  relay.operation("read")?.("ok");
  expect(metrics.snapshot().relays[0]).toMatchObject({
    relay: "relay.test",
    active: 1,
    authenticated: 1,
    session: { counts: { txFrames: 1, txBytes: 6, readOk: 1 } },
  });
  metrics.setEnabled(false);
  relay.frame(true, 999);
  expect(metrics.snapshot().relays[0]?.session.counts.txFrames).toBe(1);
  expect(JSON.stringify(metrics.snapshot())).not.toContain("secret");
  state("closed");
  expect(metrics.snapshot().relays[0]?.active).toBe(0);
});

it("expires rolling buckets while retaining capture totals and histogram estimates", () => {
  let now = 5000;
  const metrics = createNetworkMetrics(() => now),
    relay = metrics.relay("wss://relay.test");
  metrics.setEnabled(true);
  relay.frame(false, 20);
  for (const ms of [10, 20, 100]) relay.duration("rtt", ms);
  now += 30_000;
  relay.frame(false, 40);
  let row = metrics.snapshot().relays[0];
  expect(row?.minute.latency.rtt).toEqual({
    count: 3,
    mean: 130 / 3,
    p50: 25,
    p95: 100,
  });
  now += 35_000;
  row = metrics.snapshot().relays[0];
  expect(row?.minute.counts.rxBytes).toBe(40);
  expect(row?.session.counts.rxBytes).toBe(60);
  now += 300_000;
  row = metrics.snapshot().relays[0];
  expect(row?.fiveMinutes.counts.rxFrames).toBe(0);
  expect(row?.session.counts.rxFrames).toBe(2);
});

it("settles operations once and ignores old completions after a new capture even at the same wall time", () => {
  const metrics = createNetworkMetrics(() => 1000),
    relay = metrics.relay("wss://relay.test");
  metrics.setEnabled(true);
  const stale = relay.operation("request");
  expect(metrics.snapshot().relays[0]?.inFlight).toBe(1);
  metrics.setEnabled(false);
  metrics.setEnabled(true);
  const current = relay.operation("request");
  stale?.("failed");
  expect(metrics.snapshot().relays[0]?.inFlight).toBe(1);
  current?.("ok");
  current?.("failed");
  relay.operation("read")?.("deadline");
  relay.operation("publish")?.("cancelled");
  expect(metrics.snapshot().relays[0]).toMatchObject({
    inFlight: 0,
    session: {
      counts: {
        requestOk: 1,
        requestFailed: 0,
        readDeadline: 1,
        publishCancelled: 1,
        publishFailed: 0,
      },
    },
  });
});

it("merges native completed-frame counters once and bounds relay cardinality", () => {
  const metrics = createNetworkMetrics(() => 1000);
  metrics.setEnabled(true);
  const traffic = { txFrames: 2, rxFrames: 3, txBytes: 20, rxBytes: 30 };
  const native = [
    {
      relay: "relay.test",
      session: traffic,
      minute: traffic,
      fiveMinutes: traffic,
    },
  ];
  expect(metrics.snapshot(native).relays[0]).toMatchObject({
    nativeTraffic: true,
    session: { counts: traffic },
  });
  expect(metrics.snapshot(native).relays[0]?.session.counts.rxFrames).toBe(3);
  for (let i = 0; i < 1000; i++)
    metrics.relay(`wss://relay-${i}.test`).count("connects");
  expect(metrics.snapshot().relays.length).toBeLessThanOrEqual(65);
  metrics.setEnabled(false);
  metrics.reset();
  const cached = Array.from({ length: 1000 }, (_, i) =>
    metrics.relay(`wss://cached-${i}.test`),
  );
  metrics.setEnabled(true);
  for (const handle of cached) handle.operation("read")?.("ok");
  expect(metrics.snapshot().relays.length).toBeLessThanOrEqual(65);
  expect(
    metrics
      .snapshot()
      .relays.reduce((n, row) => n + row.session.counts.readOk, 0),
  ).toBe(1000);
  expect(utf8Bytes("abc😀é")).toBe(9);
  expect(utf8Bytes("\ud800")).toBe(3);
});
