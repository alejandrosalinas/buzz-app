import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay } from "./service";
import type { ReadTransport } from "./transport";
import {
  flush,
  keypair,
  metadata,
  roster,
  bounds,
  scriptedTransport,
} from "./testing";

const roots: Context[] = [];
function root() {
  const ctx = new Context();
  roots.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
});
const transport = (viewer: string): ReadTransport => ({
  viewer,
  relayAuthor: "relay",
  media: () => undefined,
  query: vi.fn(async () => []),
});
it("shares a session above plugin lifetimes, rather than one store per consumer", async () => {
  const ctx = root();
  const source = transport("viewer");
  const connect = vi.fn(async () => source);
  const data = provideRelay(ctx, connect);
  await flush();
  const received: unknown[] = [];
  const consumer = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await consumer.await();
  const other = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await other.await();
  expect(received[0]).toBe(received[1]);
  await consumer.dispose();
  expect(data.snapshot().status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(source.query).toHaveBeenCalledTimes(1);
});
it("keeps app startup demand-driven while retaining hover preparation and cached opening", async () => {
  const viewer = keypair();
  const relay = keypair();
  const h = scriptedTransport(viewer.pubkey, relay.pubkey);
  const data = provideRelay(root(), async () => h.transport);
  await flush();
  const ids = Array.from({ length: 70 }, (_, index) => `channel-${index}`);
  const discovery = ids.flatMap((id) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ]);
  h.next().respond(discovery);
  await flush();
  const channels = data.snapshot().session.channels;
  expect(channels.list().channels).toHaveLength(70);
  expect(h.pending).toHaveLength(0);
  channels.refreshList?.();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond(discovery);
  await flush();
  expect(h.pending).toHaveLength(0);

  channels.prepare?.("channel-69");
  const preparation = h.next();
  expect(preparation.filters[0]).toMatchObject({
    "#h": ["channel-69"],
    top_level: true,
  });
  preparation.respond([
    bounds(relay, "channel-69", "head", {
      has_more: false,
      next_cursor: null,
    }),
  ]);
  await flush();
  channels.ensure("channel-69");
  expect(channels.window("channel-69").status).toBe("ready");
  expect(h.pending).toHaveLength(0);
});

it("rejects an old connection result after disconnect and replacement", async () => {
  const ctx = root();
  const pending: ((transport: ReadTransport) => void)[] = [];
  const data = provideRelay(
    ctx,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await flush();
  const old = pending.shift();
  data.disconnect();
  data.retry();
  await flush();
  pending.shift()?.(transport("new"));
  await flush();
  const current = data.snapshot();
  old?.(transport("old"));
  await flush();
  expect(data.snapshot()).toBe(current);
  expect(current.viewer).toBe("new");
});
it("times out a stalled connection and releases timers on app disposal", async () => {
  vi.useFakeTimers();
  const ctx = root();
  const data = provideRelay(ctx, () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().status).toBe("error");
  data.retry();
  // The connection deadline and the wake detector.
  expect(vi.getTimerCount()).toBe(2);
  await ctx.fiber.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("reconnects a connection the federated session refused once it is signed in", async () => {
  const ctx = root();
  const connect = vi
    .fn<() => Promise<ReadTransport>>()
    .mockRejectedValueOnce(new Error("Federated sign-in is required"))
    .mockResolvedValue(transport("viewer"));
  const data = provideRelay(ctx, connect);
  await flush();
  expect(data.snapshot().status).toBe("error");
  data.reauthorize();
  await flush();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(data.snapshot().status).toBe("ready");
});
it("asks a live socket that may have died during sleep to answer", async () => {
  vi.useFakeTimers();
  const check = vi.fn();
  const source: ReadTransport = {
    ...transport("viewer"),
    subscribe: () => ({ update() {}, retry() {}, check, dispose() {} }),
  };
  const data = provideRelay(root(), async () => source);
  await vi.advanceTimersByTimeAsync(0);
  expect(data.snapshot().status).toBe("ready");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(check).not.toHaveBeenCalled();
  // Timers stop while the machine sleeps, so the clock jumps between ticks.
  vi.setSystemTime(Date.now() + 60_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(check).toHaveBeenCalledTimes(1);
});

it("turns a community refusal heard after connecting into one denied connection", async () => {
  const ctx = root();
  const listeners = new Set<(kind: "sign-in" | "access") => void>();
  const refusing = (): ReadTransport => ({
    ...transport("viewer"),
    scope: "https://relay.example",
    observeRefusal(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
  const connect = vi.fn(async () => refusing());
  const data = provideRelay(ctx, connect);
  await flush();
  expect(data.snapshot().status).toBe("ready");
  const ready = data.snapshot().session;
  for (const listener of [...listeners]) listener("sign-in");
  // A second refusal from the same connection changes nothing.
  for (const listener of [...listeners]) listener("access");
  await flush();
  expect(data.snapshot()).toMatchObject({
    status: "error",
    denied: true,
    refusal: "sign-in",
    viewer: "viewer",
    error: "Federated sign-in is required",
  });
  expect(data.snapshot().retrying).toBeUndefined();
  expect(data.snapshot().session).not.toBe(ready);
  // Nothing reconnects by itself; signing in does, and the old connection's
  // listener is gone.
  expect(connect).toHaveBeenCalledTimes(1);
  data.reauthorize();
  await flush();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(data.snapshot().status).toBe("ready");
  expect(listeners.size).toBe(1);
});
