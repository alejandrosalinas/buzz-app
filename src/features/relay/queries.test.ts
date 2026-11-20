import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { ReadFilter } from "./events";
import { USER_STATUS_KIND } from "./user-status-policy";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
} from "./testing";
const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
function setup() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  owners.push(owner);
  return { ...owner, ...wire, queries: owner.session };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
it.each([
  { search: "design" },
  { search: "" },
  { feed_types: ["mentions", "activity"] },
  { feed_types: [] },
])("rejects ranked observed filters without allocating views: %j", (ranked) => {
  const { queries, pending } = setup();
  const ordinary = { kinds: [9], limit: 20 };
  const filters: ReadFilter[] = [ordinary, { ...ordinary, ...ranked }];
  for (let attempt = 0; attempt < 65; attempt++)
    expect(() => queries.observe(filters)).toThrow(
      "use session.read() instead",
    );
  expect(pending).toHaveLength(0);
  const view = queries.observe([ordinary]);
  expect(view.snapshot().status).toBe("idle");
  view.dispose();
});
it.each([{ search: "design" }, { feed_types: ["mentions", "activity"] }])(
  "preserves server ranking and replacement in finite reads: %j",
  async (ranked) => {
    const { queries, next } = setup();
    const older = message(alice, "c", "design match", 10);
    const newer = message(alice, "c", "design update", 20);
    const filters: ReadFilter[] = [{ kinds: [9], limit: 20, ...ranked }];
    // Ranked messages are admitted only after channel authority is known.
    const membership = queries.read([{ kinds: [39002, 39000], limit: 2 }]);
    next().respond([
      roster(relay, "c", [viewer.pubkey]),
      metadata(relay, "c", "Design"),
    ]);
    await membership;
    const first = queries.read(filters);
    next().respond([older, newer]);
    expect((await first).map((event) => event.id)).toEqual([
      older.id,
      newer.id,
    ]);
    const refresh = queries.read(filters);
    next().respond([newer]);
    expect((await refresh).map((event) => event.id)).toEqual([newer.id]);
  },
);
it("shares profile ownership between a standalone feature and the channel timeline", async () => {
  const { queries, next, pending } = setup();
  const feature = queries.profiles.ensure([alice.pubkey]);
  const profiles = next();
  queries.channels.ensure("c");
  next().respond([
    message(alice, "c", "hello", 10),
    bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  // The feature read no status, so the timeline reads only alice's status.
  expect(pending.map((entry) => entry.filters)).toMatchObject([
    [{ kinds: [USER_STATUS_KIND], authors: [alice.pubkey] }],
  ]);
  next().respond([]);
  profiles.respond([profile(alice, { name: "Alice" })]);
  await feature;
  expect(queries.profiles.snapshot().get(alice.pubkey)?.name).toBe("Alice");
  expect(queries.channels.window("c").rows).toHaveLength(1);
  const before = queries.profiles.snapshot();
  await queries.profiles.ensure([alice.pubkey]);
  expect(queries.profiles.snapshot()).toBe(before);
  expect(pending).toHaveLength(0);
});
it("does not turn missing or failed profile reads into permanently cached placeholder profiles", async () => {
  const { queries, next, pending } = setup();
  const missing = queries.profiles.ensure([alice.pubkey]);
  next().respond([]);
  await missing;
  expect(queries.profiles.snapshot().has(alice.pubkey)).toBe(false);
  const failed = queries.profiles.ensure([alice.pubkey]);
  next().fail(new Error("offline"));
  await expect(failed).rejects.toThrow("offline");
  const retry = queries.profiles.ensure([alice.pubkey]);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  next().respond([profile(alice, { name: "Available now" })]);
  await retry;
  expect(queries.profiles.snapshot().get(alice.pubkey)?.name).toBe(
    "Available now",
  );
});
it("clearing the session cache fences pending profiles and event reads and permits new work", async () => {
  const { queries, next, clearCache } = setup();
  const profileWork = queries.profiles.ensure([alice.pubkey]);
  const eventWork = queries.read([
    { kinds: [30078], authors: [viewer.pubkey], limit: 1 },
  ]);
  const profiles = next(),
    events = next();
  const rejected = Promise.all([
    expect(profileWork).rejects.toMatchObject({ name: "AbortError" }),
    expect(eventWork).rejects.toMatchObject({ name: "AbortError" }),
  ]);
  await clearCache();
  await rejected;
  profiles.respond([profile(alice, { name: "Stale" })]);
  events.respond([]);
  await flush();
  expect(queries.profiles.snapshot().size).toBe(0);
  const fresh = queries.profiles.ensure([alice.pubkey]);
  next().respond([profile(alice, { name: "Fresh" })]);
  await fresh;
  expect(queries.profiles.snapshot().get(alice.pubkey)?.name).toBe("Fresh");
});
