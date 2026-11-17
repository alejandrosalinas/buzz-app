import { Context } from "@deepseek-ai/cordis";
import { assert, afterEach, expect, it, vi } from "vitest";
import {
  BROKER_SESSION_LIMIT,
  createCommunities,
  SESSION_LIMIT,
} from "./service";
import { createCommunityUnreads } from "../notifications/community-unread";
import { communityDestination } from "./destination";
import { localCommunityNameKey } from "./names";
import * as destinations from "./destination";
import { flush } from "../relay/testing";
import type { ReadTransport } from "../relay/transport";
import { readView, writeView } from "../../shared/view-state";

const viewer = "a".repeat(64);
const roots: Context[] = [];
const requests: string[] = [];
function setup(saved?: unknown, savedViewer = viewer, openRelay = "") {
  const storage = new Map<string, string>();
  // A string is stored verbatim so cases can pin the exact stored text.
  if (saved !== undefined)
    storage.set(
      `buzz-client.v1:${savedViewer}`,
      typeof saved === "string" ? saved : JSON.stringify(saved),
    );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input.endsWith("/identity")) return Response.json({ viewer });
      if (input.endsWith("/session")) {
        const destination = input.split("/")[3];
        assert.exists(destination);
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: communityDestination(decodeURIComponent(destination)).url,
        });
      }
      return Response.json([]);
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(ctx, true, undefined, openRelay);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  requests.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("opens an identity without touching a community and saves a local profile independently", async () => {
  const client = setup();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  client.saveProfile({ name: "Local name", picture: "" });
  expect(client.snapshot().profile.name).toBe("Local name");
  expect(requests).toHaveLength(1);
});
it("retains separate sessions on A→B→A, and personal space does not reset them", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const a = client.relay.snapshot();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Different", picture: "" },
  );
  await flush();
  const b = client.relay.snapshot();
  expect(a.session).not.toBe(b.session);
  expect(a.scope).not.toBe(b.scope);
  client.select(null);
  expect(client.relay.snapshot().status).toBe("disconnected");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(a);
  client.select("secondary");
  expect(client.relay.snapshot()).toBe(b);
  expect(client.snapshot().profile.name).toBe("Local");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(2);
});
it("does not reuse another identity's memberships; draft and view keys include community and identity", async () => {
  const client = setup(
    {
      profile: { name: "Someone else", picture: "" },
      memberships: [{ id: "primary", name: "Primary" }],
      selected: "primary",
    },
    "c".repeat(64),
  );
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(client.snapshot().profile.name).toBe("");
  writeView("community-a:identity-a", "draft:same-channel", "draft A");
  writeView("community-b:identity-a", "draft:same-channel", "draft B");
  expect(readView("community-a:identity-a", "draft:same-channel", "")).toBe(
    "draft A",
  );
  expect(readView("community-b:identity-a", "draft:same-channel", "")).toBe(
    "draft B",
  );
  expect(readView("community-a:identity-b", "draft:same-channel", "")).toBe("");
});
it("restores only the selected membership on launch", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  await flush();
  expect(client.snapshot().selected).toBe("secondary");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/secondary/session",
  ]);
});

it("opens a joined community without selecting it, and never one that is not joined", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  await flush();
  const primary = client.open("primary");
  await flush();
  expect(client.snapshot().selected).toBe("secondary");
  expect(primary?.snapshot().status).toBe("ready");
  expect(client.open("primary")).toBe(primary);
  expect(client.open("https://unjoined.example.test")).toBeUndefined();
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/secondary/session",
    "/api/relay/primary/session",
  ]);
});
/** A native client over a modeled host registry: one socket per connected
 * transport until its scope aborts it, refused past `SESSION_LIMIT`. */
async function nativeAtLimit() {
  const nativeViewer = "c".repeat(64);
  const ids = Array.from(
    { length: SESSION_LIMIT + 2 },
    (_, i) => `https://c${i}.example.test`,
  );
  const saved = {
    profile: { name: "Native", picture: "" },
    memberships: ids.map((id) => ({ id, name: id })),
    selected: ids[0],
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === `buzz-client.v1:${nativeViewer}` ? JSON.stringify(saved) : null,
    setItem: vi.fn(),
  });
  const held = new Set<string>();
  const refused: string[] = [];
  const connect = vi.fn(
    (id: string, signal: AbortSignal) =>
      new Promise<ReadTransport>((_resolve, reject) => {
        if (held.size >= SESSION_LIMIT) {
          refused.push(id);
          return reject(new Error("Native sockets are busy"));
        }
        held.add(id);
        signal.addEventListener(
          "abort",
          () => {
            held.delete(id);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const ctx = new Context();
  roots.push(ctx);
  const client = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(nativeViewer),
    connect,
  );
  await flush();
  const id = (index: number) => ids[index] as string;
  // Startup badges on c1–c8; visits fill all but the reserved last socket.
  const badges = ids.slice(1, 9).map((each) => client.open(each, true));
  for (const each of ids.slice(9, SESSION_LIMIT - 1)) client.select(each);
  client.select(id(0));
  await flush();
  expect(badges.every(Boolean)).toBe(true);
  expect(held.size).toBe(SESSION_LIMIT - 1);
  return { client, id, held, refused, connect, badges };
}
it("a badge never takes the last native socket, which other work still gets", async () => {
  const { client, id, held, refused } = await nativeAtLimit();
  expect(client.open(id(SESSION_LIMIT - 1), true)).toBeUndefined();
  client.select(id(SESSION_LIMIT - 1));
  await flush();
  expect(refused).toEqual([]);
  expect(held.size).toBe(SESSION_LIMIT);
  expect(held.has(id(1))).toBe(true);
});
it("closes the oldest badge-only session, never selected or agent work, when the native socket limit is full", async () => {
  const { client, id, held, refused, badges } = await nativeAtLimit();
  const agent = client.open(id(SESSION_LIMIT - 1));
  await flush();
  expect(held.size).toBe(SESSION_LIMIT);
  const last = id(SESSION_LIMIT);
  client.select(last);
  await flush();
  await flush();
  expect(refused).toEqual([]);
  expect(held.has(last)).toBe(true);
  // Only the oldest badge-only session gave up its socket, and stays closed.
  expect(held.has(id(1))).toBe(false);
  expect(client.open(id(1), true)).toBeUndefined();
  for (const [index, each] of [2, 3, 4, 5, 6, 7, 8].entries())
    expect(client.open(id(each), true)).toBe(badges[index + 1]);
  expect(client.open(id(SESSION_LIMIT - 1))).toBe(agent);
  expect(held.has(id(0))).toBe(true);
  // Selecting the closed community connects it again, closing the next oldest.
  client.select(id(1));
  await flush();
  await flush();
  expect(refused).toEqual([]);
  expect(held.has(id(1))).toBe(true);
  expect(held.has(id(2))).toBe(false);
});
it("a listener reopening a badge on the eviction notice cannot take the freed socket", async () => {
  const { client, id, refused } = await nativeAtLimit();
  client.open(id(SESSION_LIMIT - 1));
  await flush();
  // The unread projection reopens every eligible badge whenever notified.
  const reopened: unknown[] = [];
  client.subscribe(() =>
    reopened.push(client.open(id(SESSION_LIMIT + 1), true)),
  );
  client.select(id(SESSION_LIMIT));
  await flush();
  await flush();
  expect(reopened[0]).toBeUndefined();
  expect(refused).toEqual([]);
});
it("an agent reopening its community on the eviction notice reuses the stored session", async () => {
  const { client, id, refused, connect } = await nativeAtLimit();
  client.open(id(SESSION_LIMIT - 1));
  await flush();
  const agent = id(SESSION_LIMIT);
  const inner: unknown[] = [];
  client.subscribe(() => inner.push(client.open(agent)));
  const outer = client.open(agent);
  await flush();
  await flush();
  expect(inner[0]).toBe(outer);
  expect(connect.mock.calls.filter(([each]) => each === agent)).toHaveLength(1);
  expect(refused).toEqual([]);
});
it("with the real unread projection, a broker selection gets one session, is never badge-only and is never evicted", async () => {
  // Startup connects c0 (selected) and one badge, c1; selecting c2 takes the
  // kept slot. c3 and c4 are opened later for their own work.
  const ids = Array.from({ length: 5 }, (_, i) => `https://c${i}.example.test`);
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: ids.map((id) => ({ id, name: id })),
    selected: ids[0],
  });
  await flush();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const unreads = createCommunityUnreads(client);
  await flush();
  const opened = (id: string, path: string) =>
    requests.filter(
      (url) => url === `/api/relay/${encodeURIComponent(id)}/${path}`,
    ).length;
  const [, badge, chosen, work, later] = ids as [
    string,
    string,
    string,
    string,
    string,
  ];
  // The badge opens after its start delay.
  await vi.waitFor(() => expect(opened(badge, "session")).toBe(1));
  expect(opened(chosen, "session")).toBe(0);
  client.select(chosen);
  await flush();
  await flush();
  const selected = client.open(chosen, true);
  expect(selected).toBeDefined();
  // A foreground open closes the only badge-only session, c1.
  expect(client.open(work)).toBeDefined();
  await flush();
  await flush();
  expect(client.open(badge, true)).toBeUndefined();
  // None is left, so nothing more is closed; a badge-only c2 would be.
  expect(client.open(later)).toBeDefined();
  await flush();
  await flush();
  expect(client.open(chosen, true)).toBe(selected);
  expect(opened(chosen, "session")).toBe(1);
  expect(opened(chosen, "stream")).toBeLessThanOrEqual(1);
  unreads.dispose();
});
it("with the real unread projection, a native selection at the full limit gets one connection, is never badge-only and is never evicted", async () => {
  const { client, id, held, refused, connect } = await nativeAtLimit();
  const unreads = createCommunityUnreads(client);
  await flush();
  const chosen = id(SESSION_LIMIT);
  client.select(chosen);
  await flush();
  await flush();
  expect(held.size).toBe(SESSION_LIMIT);
  const selected = client.open(chosen, true);
  // A foreground open at the limit closes the oldest badge, never the selection.
  expect(client.open(id(SESSION_LIMIT + 1))).toBeDefined();
  await flush();
  await flush();
  expect(refused).toEqual([]);
  expect(held.has(id(1))).toBe(false);
  expect(held.has(chosen)).toBe(true);
  expect(client.open(chosen, true)).toBe(selected);
  expect(connect.mock.calls.filter(([each]) => each === chosen)).toHaveLength(
    1,
  );
  unreads.dispose();
});
it("with the real unread projection, a joined community is never badge-only and is never evicted", async () => {
  const { client, id, held, refused } = await nativeAtLimit();
  const unreads = createCommunityUnreads(client);
  await flush();
  // Room for one more: the join's notice opens it for a badge before the join
  // acquires it.
  await client.leave(id(9), { purge: false });
  const joined = "https://joined.example.test";
  client.joined({ id: joined, name: joined }, { name: "Native", picture: "" });
  await flush();
  expect(held.has(joined)).toBe(true);
  // Every other badge-only session gives up its socket first; past them,
  // nothing is closed and the host refuses.
  const work = Array.from(
    { length: 10 },
    (_, i) => `https://w${i}.example.test`,
  );
  await client.applySync(client.snapshot().sync, work);
  for (const each of work) {
    client.open(each);
    await flush();
    await flush();
  }
  for (const each of [1, 2, 3, 4, 5, 6, 7, 8])
    expect(held.has(id(each))).toBe(false);
  expect(held.has(joined)).toBe(true);
  expect(client.snapshot().selected).toBe(joined);
  expect(refused).toEqual([work[9]]);
  unreads.dispose();
});
it("with the real unread projection, rejoining a badge-only community promotes it", async () => {
  const { client, id, held, refused } = await nativeAtLimit();
  const unreads = createCommunityUnreads(client);
  await flush();
  // c1 is the oldest badge-only session.
  client.joined({ id: id(1), name: id(1) }, { name: "Native", picture: "" });
  await flush();
  client.open(id(SESSION_LIMIT - 1));
  await flush();
  client.open(id(SESSION_LIMIT));
  await flush();
  await flush();
  expect(refused).toEqual([]);
  expect(held.has(id(1))).toBe(true);
  expect(held.has(id(2))).toBe(false);
  unreads.dispose();
});
it("reads a joined community's retained session for its viewer, and never opens one", async () => {
  const { client, id, connect } = await nativeAtLimit();
  const viewer = client.snapshot().viewer as string;
  const scope = (index: number, as = viewer) => ({
    viewer: as,
    communityOrigin: communityDestination(id(index)).url,
  });
  expect(client.retained(scope(1))).toEqual(
    client.open(id(1), true)?.snapshot(),
  );
  expect(client.retained(scope(1, "d".repeat(64)))).toBeUndefined();
  const calls = connect.mock.calls.length;
  expect(client.retained(scope(SESSION_LIMIT + 1))).toBeUndefined();
  expect(
    client.retained({ viewer, communityOrigin: "https://x.example" }),
  ).toBeUndefined();
  expect(connect.mock.calls.length).toBe(calls);
});
it("keeps badge-only sessions within the broker's session limit", async () => {
  const ids = Array.from(
    { length: BROKER_SESSION_LIMIT + 1 },
    (_, i) => `https://c${i}.example.test`,
  );
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: ids.map((id) => ({ id, name: id })),
    selected: ids[0],
  });
  await flush();
  await flush();
  // The selected community and one kept free leave room for one badge.
  const badges = ids.slice(1).map((id) => client.open(id, true));
  expect(badges.filter(Boolean)).toHaveLength(BROKER_SESSION_LIMIT - 2);
  client.select(ids[2] as string);
  // Past the limit, a selection replaces the badge-only session.
  client.select(ids[3] as string);
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  expect(client.open(ids[1] as string, true)).toBeUndefined();
});
it("a failing community does not replace its healthy sibling or the local profile", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const healthy = client.relay.snapshot();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Community", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(client.snapshot().profile.name).toBe("Local");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(healthy);
});

it("keeps local actions and completed joins usable when storage writes fail", async () => {
  const client = setup();
  await flush();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage quota exceeded");
  });
  client.saveProfile({ name: "Local", picture: "" });
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Remote", picture: "" },
  );
  await flush();
  expect(client.snapshot()).toMatchObject({
    profile: { name: "Local" },
    selected: "primary",
    memberships: [{ id: "primary" }],
  });
  expect(client.relay.snapshot().status).toBe("ready");
  client.select(null);
  expect(client.snapshot().selected).toBeNull();
});

it("ignores invalid and duplicate memberships without discarding a valid local profile", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      null,
      { id: "primary", name: "Primary" },
      { id: "primary", name: "Duplicate" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  expect(client.snapshot().profile.name).toBe("Local");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "secondary",
  ]);
  expect(client.snapshot().selected).toBe("secondary");
});

it("persists arbitrary canonical origins, preserves legacy aliases, and restores only the selected one", async () => {
  const client = setup();
  await flush();
  for (const id of [
    "primary",
    "wss://THIRD.example:443/",
    "https://fourth.example",
    "wss://fifth.example:8443",
  ]) {
    client.joined({ id, name: id }, { name: "Local", picture: "" });
    await flush();
  }
  client.joined(
    { id: "https://third.example/", name: "Third renamed" },
    { name: "Other", picture: "" },
  );
  await flush();
  expect(client.snapshot().memberships).toHaveLength(4);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(client.relay.snapshot().scope).toContain("https://third.example");
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  assert.exists(persisted);
  const saved = JSON.parse(persisted);
  requests.length = 0;
  const restored = setup(saved);
  await flush();
  await flush();
  expect(restored.snapshot()).toMatchObject({ ...saved, status: "ready" });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  expect(requests.indexOf("/api/relay/register")).toBeLessThan(
    requests.indexOf("/api/relay/https%3A%2F%2Fthird.example/session"),
  );
});

it("normalizes old and new stored spellings without duplicates or unsafe automatic connections", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "WSS://PRIMARY.EXAMPLE:443/", name: "Duplicate" },
      { id: "wss://THIRD.example/", name: "Third" },
      { id: "https://third.example", name: "Duplicate third" },
      { id: "http://unsafe.example", name: "Unsafe" },
      { id: "https://user:secret@unsafe.example", name: "Credentials" },
    ],
    selected: "wss://THIRD.example:443/",
  });
  await flush();
  await flush();
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "https://third.example",
  ]);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  const before = client.snapshot();
  expect(() =>
    client.joined(
      { id: "https://bad.example/path", name: "Bad" },
      { name: "Other", picture: "" },
    ),
  ).toThrow();
  expect(client.snapshot()).toBe(before);
});

it("does not acquire a session after rejected registration and registers again on retry", async () => {
  const client = setup();
  await flush();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Registration rejected" }, { status: 403 }),
  );
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(0);
  client.relay.retry();
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  expect(
    requests.filter(
      (url) => url.endsWith("/register") || url.endsWith("/session"),
    ),
  ).toEqual([
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
});

it("selects alternate URL spellings through the canonical retained session", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  const original = client.relay.snapshot();
  const connections = requests.filter((url) => url.endsWith("/session")).length;
  client.select(null);
  expect(client.relay.selected?.()).toBeUndefined();
  client.select(" WSS://THIRD.example:443/ ");
  expect(client.snapshot().selected).toBe("https://third.example");
  // Plugins follow the selection by the origin its connection names.
  expect(client.relay.selected?.()).toBe(original.origin);
  expect(client.relay.snapshot()).toBe(original);
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(
    connections,
  );
});

it("preserves unresolved saved aliases across profile saves and reloads without connecting", async () => {
  const membership = {
    id: "unconfigured-old",
    name: "Saved community",
    icon: "https://images.example/icon.png",
  };
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  };
  const client = setup(saved);
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(() => client.select(membership.id)).toThrow();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted).toEqual({
    ...saved,
    profile: { name: "After", picture: "" },
    sync: { known: [], outbox: [] },
  });
  const reloaded = setup(persisted);
  await flush();
  reloaded.saveProfile({ name: "After reload", picture: "" });
  const again = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(again.memberships).toEqual([membership]);
  expect(again.selected).toBe(membership.id);
  expect(requests).toEqual(["/api/relay/identity", "/api/relay/identity"]);
  // Model a restart with the original deployment mapping restored.
  const resolve = destinations.communityDestination;
  const aliases = destinations.parseCommunityAliases(
    '{"unconfigured-old":"https://restored.example"}',
  );
  vi.spyOn(destinations, "communityDestination").mockImplementation((value) =>
    resolve(value, aliases),
  );
  const restored = setup(again);
  await flush();
  expect(restored.snapshot()).toMatchObject({
    memberships: [membership],
    selected: membership.id,
  });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/unconfigured-old/session",
  ]);
  expect(restored.relay.snapshot().scope).toBe(
    `https://restored.example:${viewer}`,
  );
});

it("retains unresolved memberships but honors an explicit Personal selection or a new join", async () => {
  const membership = { id: "unconfigured-old", name: "Saved community" };
  const client = setup({
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  });
  await flush();
  client.select(null);
  let persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([membership]);
  expect(persisted.selected).toBeNull();
  client.joined(
    { id: "primary", name: "New community" },
    { name: "After", picture: "" },
  );
  await flush();
  persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "primary", name: "New community" },
    membership,
  ]);
  expect(persisted.selected).toBe("primary");
  expect(requests.some((url) => url.includes("unconfigured-old"))).toBe(false);
});

it("keeps only valid unique unresolved aliases and never carries them to another identity", async () => {
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [
      { id: "unconfigured-old", name: "Saved" },
      { id: "unconfigured-old", name: "Duplicate" },
      { id: "bad/id", name: "Invalid" },
      { id: "https://user:secret@private.example", name: "Invalid" },
      { id: "constructor", name: "Invalid" },
      { id: "prototype", name: "Invalid" },
      { id: "__proto__", name: "Invalid" },
    ],
    selected: "constructor",
  };
  const client = setup(saved);
  await flush();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "unconfigured-old", name: "Saved" },
  ]);
  expect(persisted.selected).toBeNull();
  const other = setup(saved, "c".repeat(64));
  await flush();
  other.saveProfile({ name: "Other", picture: "" });
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
      .memberships,
  ).toEqual([]);
});

it("opens the configured relay for an identity without a saved record and remembers it", async () => {
  const client = setup(undefined, viewer, "https://third.example");
  await flush();
  await flush();
  const membership = { id: "https://third.example", name: "third.example" };
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    profile: { name: "", picture: "" },
    memberships: [membership],
    selected: membership.id,
  });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  assert.exists(persisted);
  expect(JSON.parse(persisted)).toEqual({
    profile: { name: "", picture: "", about: "" },
    memberships: [membership],
    selected: membership.id,
    sync: { known: [], outbox: [] },
  });
  // A configured alias for the relay origin is honored like any other join.
  const aliased = setup(undefined, "c".repeat(64), "wss://primary.example");
  await flush();
  expect(aliased.snapshot().memberships).toEqual([
    { id: "primary", name: "primary.example" },
  ]);
  expect(aliased.snapshot().selected).toBe("primary");
});

it("does not seed the configured relay over a stored falsy record", async () => {
  const client = setup("null", viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe("null");
});

it("does not seed the configured relay over a stored malformed record", async () => {
  const client = setup('{"memberships":', viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(
    '{"memberships":',
  );
});

it("keeps a saved record, including Personal space, instead of the configured relay", async () => {
  const saved = {
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: null,
  };
  const client = setup(saved, viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({ ...saved, status: "ready" });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(
    JSON.stringify(saved),
  );
});

it("leave forgets the selected community: Personal space, a disposed session and purged device state", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.select("primary");
  const primaryScope = `${communityDestination("primary").url}:${viewer}`;
  const secondaryScope = `${communityDestination("secondary").url}:${viewer}`;
  writeView(primaryScope, "draft:general", "unsent");
  writeView(primaryScope, "channel", "general");
  writeView(secondaryScope, "draft:general", "kept");
  const sessions = () => requests.filter((url) => url.endsWith("/session"));
  const before = sessions().length;
  // Every store cleared, so there is nothing to report.
  expect(await client.leave("primary")).toEqual([]);
  expect(client.snapshot()).toMatchObject({
    selected: null,
    memberships: [{ id: "secondary", name: "Secondary" }],
  });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null"),
  ).toMatchObject({
    memberships: [{ id: "secondary", name: "Secondary" }],
    selected: null,
  });
  // Only the left community's partition is gone.
  expect(readView(primaryScope, "draft:general", "")).toBe("");
  expect(readView(primaryScope, "channel", "")).toBe("");
  expect(readView(secondaryScope, "draft:general", "")).toBe("kept");
  // The retained session was disposed: rejoining connects afresh.
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  expect(sessions()).toHaveLength(before + 1);
  expect(sessions().at(-1)).toBe("/api/relay/primary/session");
  expect(client.relay.snapshot().status).toBe("ready");
});

it("leave of an inactive community keeps the selection and its session; unknown ids are a no-op", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const active = client.relay.snapshot();
  await client.leave("primary");
  expect(client.snapshot()).toMatchObject({
    selected: "secondary",
    memberships: [{ id: "secondary" }],
  });
  expect(client.relay.snapshot()).toBe(active);
  const state = client.snapshot();
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  expect(await client.leave("https://unknown.example")).toEqual([]);
  expect(client.snapshot()).toBe(state);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(persisted);
});

it("leave still forgets the community when a store will not clear, and logs and returns what remained", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const origin = communityDestination("primary").url;
  localStorage.setItem(
    `buzz.quick-reactions.v1:${origin}:${viewer}`,
    '[{"emoji":"🎉","count":1,"used":1}]',
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Key enumeration is what the view and channel-setup sweeps rely on.
  const denied = new Error("denied");
  vi.spyOn(localStorage, "key").mockImplementation(() => {
    throw denied;
  });
  const failures = await client.leave("primary");
  expect(client.snapshot()).toMatchObject({ selected: null, memberships: [] });
  expect(client.relay.snapshot().status).toBe("disconnected");
  // The stores that could be cleared were; the rest are named for the caller.
  expect(
    localStorage.getItem(`buzz.quick-reactions.v1:${origin}:${viewer}`),
  ).toBeNull();
  expect(failures).toEqual([
    { store: "view state", error: denied },
    { store: "channel setups", error: denied },
  ]);
  expect(warn).toHaveBeenCalledWith(
    `Couldn't clear view state for ${origin} on this device`,
    denied,
  );
  expect(warn).toHaveBeenCalledWith(
    `Couldn't clear channel setups for ${origin} on this device`,
    denied,
  );
});

it("leave without a purge forgets the community and disposes its session but keeps its device state", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const scope = `${communityDestination("primary").url}:${viewer}`;
  writeView(scope, "draft:general", "unsent");
  writeView(scope, "channel", "general");
  localStorage.setItem(
    `buzz.quick-reactions.v1:${scope}`,
    '[{"emoji":"🎉","count":1,"used":1}]',
  );
  const sessions = () => requests.filter((url) => url.endsWith("/session"));
  const before = sessions().length;
  // The banned answer: the relay still holds the membership, so nothing keyed
  // to this origin and viewer is cleared, and there is nothing to report.
  expect(await client.leave("primary", { purge: false })).toEqual([]);
  expect(client.snapshot()).toMatchObject({ selected: null, memberships: [] });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null"),
  ).toMatchObject({ memberships: [], selected: null });
  expect(readView(scope, "draft:general", "")).toBe("unsent");
  expect(readView(scope, "channel", "")).toBe("general");
  expect(localStorage.getItem(`buzz.quick-reactions.v1:${scope}`)).not.toBe(
    null,
  );
  // The session was disposed all the same: adding the community again by its
  // URL connects afresh and finds the kept draft.
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  expect(sessions()).toHaveLength(before + 1);
  expect(client.relay.snapshot().status).toBe("ready");
  expect(readView(scope, "draft:general", "")).toBe("unsent");
});

it("a native leave whose device record will not save throws before anything changes", async () => {
  const nativeViewer = "c".repeat(64);
  const community = "https://native.example";
  const saved = {
    profile: { name: "Native", picture: "", about: "" },
    memberships: [
      { id: community, name: "Native community" },
      { id: "https://other.example", name: "Other" },
    ],
    selected: community,
  };
  const storage = new Map([
    [`buzz-client.v1:${nativeViewer}`, JSON.stringify(saved)],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Broker must not be contacted");
    }),
  );
  // A native transport still connecting; it settles only when its scope is
  // disposed, which is exactly what this leave must not do.
  const connect = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<ReadTransport>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const ctx = new Context();
  roots.push(ctx);
  const client = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(nativeViewer),
    connect,
  );
  await flush();
  expect(client.snapshot().status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(1);
  const scope = `${community}:${nativeViewer}`;
  writeView(scope, "draft:general", "unsent");
  const snapshot = client.snapshot();
  const session = client.relay.snapshot();
  expect(session.status).toBe("connecting");
  const persisted = localStorage.getItem(`buzz-client.v1:${nativeViewer}`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = new Error("Full disk");
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw full;
  });
  // The device record is the only copy in a native build, so its save is
  // required, and it is the only step that throws. The storage error rides
  // along as the cause so the rail can name it.
  await expect(client.leave(community)).rejects.toMatchObject({
    message: "Could not save this community on this device. Try again.",
    cause: full,
  });
  // Nothing changed: the snapshot, the persisted record, the retained session
  // (still the selected community's, not the disconnected fallback), the
  // device state, and nothing was disposed or purged to warn about.
  expect(client.snapshot()).toBe(snapshot);
  expect(localStorage.getItem(`buzz-client.v1:${nativeViewer}`)).toBe(
    persisted,
  );
  expect(client.relay.snapshot()).toBe(session);
  expect(readView(scope, "draft:general", "")).toBe("unsent");
  expect(warn).not.toHaveBeenCalled();
  // The rail's promise holds: once the store saves, leaving again finishes.
  vi.mocked(localStorage.setItem).mockRestore();
  expect(await client.leave(community)).toEqual([]);
  expect(client.snapshot()).toMatchObject({
    selected: null,
    memberships: [{ id: "https://other.example" }],
  });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(readView(scope, "draft:general", "")).toBe("");
});

it("leaving the last community lands on Personal space with an empty saved record", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: "primary",
  });
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  // Alternate spellings resolve to the saved canonical id.
  await client.leave("wss://PRIMARY.example:443/");
  expect(client.snapshot()).toMatchObject({ memberships: [], selected: null });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null"),
  ).toEqual({
    profile: { name: "Local", picture: "", about: "" },
    memberships: [],
    selected: null,
    sync: {
      known: [],
      outbox: [{ url: "wss://primary.example", removed: true }],
    },
  });
});

it("join and leave each save the membership change and its upload intent in one record write", async () => {
  const client = setup();
  await flush();
  const writes = vi.spyOn(localStorage, "setItem");
  const records = () =>
    writes.mock.calls
      .filter(([key]) => key === `buzz-client.v1:${viewer}`)
      .map(([, value]) => JSON.parse(value));
  client.joined(
    { id: "wss://THIRD.example:443/", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(records()).toHaveLength(1);
  const joined = records()[0];
  expect(joined).toMatchObject({
    memberships: [{ id: "https://third.example", name: "Third" }],
    selected: "https://third.example",
    sync: {
      known: [],
      outbox: [{ url: "wss://third.example", removed: false }],
    },
  });
  writes.mockClear();
  expect(await client.leave("https://third.example")).toEqual([]);
  expect(records()).toHaveLength(1);
  const left = records()[0];
  expect(left).toMatchObject({ memberships: [], selected: null });
  // The removal replaces the add: whichever idempotent edit lands last is the
  // state, and the latest intent is what gets sent.
  expect(left.sync.outbox).toEqual([
    { url: "wss://third.example", removed: true },
  ]);
  // Joining never waits for an upload: the queued intent survives a restart as saved.
  const restored = setup(left);
  await flush();
  expect(restored.snapshot().sync).toEqual(left.sync);
  expect(restored.pendingSync()).toEqual(left.sync.outbox);
});

it("re-running a join the service already holds queues nothing; a join it does not hold queues an add", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: null,
    sync: { known: ["wss://primary.example"], outbox: [] },
  });
  await flush();
  // The dialog reaches joined() for an already_member claim too: nothing to
  // tell the service.
  client.joined({ id: "primary", name: "Primary" }, { name: "", picture: "" });
  expect(client.snapshot().selected).toBe("primary");
  expect(client.pendingSync()).toEqual([]);
  client.joined(
    { id: "https://gone.example", name: "Gone" },
    { name: "", picture: "" },
  );
  expect(client.pendingSync()).toEqual([
    { url: "wss://gone.example", removed: false },
  ]);
});

it("applies a server list in one record write: adds under the host name, forgets nothing, keeps the selection and session", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: "primary",
  });
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  const next = {
    known: ["wss://primary.example", "wss://new.example:8443"],
    outbox: [],
  };
  const writes = vi.spyOn(localStorage, "setItem");
  await client.applySync(next, [
    "wss://new.example:8443",
    "wss://primary.example",
  ]);
  expect(
    writes.mock.calls.filter(([key]) => key === `buzz-client.v1:${viewer}`),
  ).toHaveLength(1);
  expect(client.snapshot()).toMatchObject({
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "https://new.example:8443", name: "new.example:8443" },
    ],
    selected: "primary",
    sync: next,
  });
  expect(client.relay.snapshot().status).toBe("ready");
  // The added community has no session until it is selected.
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/primary/session",
  ]);
  client.select("https://new.example:8443");
  await flush();
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(2);
});

it("a synced-in community shows the viewer's local name and reads its presentation", async () => {
  const client = setup();
  await flush();
  localStorage.setItem(
    localCommunityNameKey("https://new.example", viewer),
    "Mine",
  );
  const release = client.retainPresentation();
  await client.applySync({ known: ["wss://new.example"], outbox: [] }, [
    "wss://new.example",
  ]);
  expect(client.snapshot().memberships).toEqual([
    { id: "https://new.example", name: "new.example", localName: "Mine" },
  ]);
  await flush();
  expect(requests).toContain(
    `/api/relay/${encodeURIComponent("https://new.example")}/icon-info`,
  );
  release();
});

it("a native sync write that will not save throws before anything changes", async () => {
  const nativeViewer = "c".repeat(64);
  const storage = new Map([
    [
      `buzz-client.v1:${nativeViewer}`,
      JSON.stringify({
        profile: { name: "Native", picture: "", about: "" },
        memberships: [{ id: "https://native.example", name: "Native" }],
        selected: null,
      }),
    ],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: () => {
      throw new Error("Full disk");
    },
  });
  const ctx = new Context();
  roots.push(ctx);
  const client = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(nativeViewer),
    vi.fn(),
  );
  await flush();
  const snapshot = client.snapshot();
  await expect(
    client.applySync({ known: [], outbox: [] }, ["wss://new.example"]),
  ).rejects.toThrow("Could not save this community on this device");
  expect(client.snapshot()).toBe(snapshot);
});

it("hydrates presence intent before acquiring a retained session and keeps it across communities", async () => {
  const client = setup();
  localStorage.setItem(`buzz-presence.v1:${viewer}`, "offline");
  await flush();
  expect(client.presence.status()).toBe("offline");
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(client.presence.status()).toBe("offline");
  client.presence.setPreference("away");
  client.select("primary");
  expect(client.presence.status()).toBe("away");
  expect(localStorage.getItem(`buzz-presence.v1:${viewer}`)).toBe("away");
});

it("hydrates native public identity without contacting the development broker", async () => {
  const nativeViewer = "c".repeat(64);
  const saved = {
    profile: { name: "Native", picture: "" },
    memberships: [{ id: "https://native.example", name: "Native community" }],
    selected: "https://native.example",
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === `buzz-client.v1:${nativeViewer}` ? JSON.stringify(saved) : null,
    setItem: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Broker must not be contacted");
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  let resolve!: (viewer: string) => void;
  const ready = new Promise<string>((done) => {
    resolve = done;
  });
  const client = createCommunities(ctx, false, undefined, "", undefined, ready);
  expect(client.snapshot().status).toBe("loading");
  resolve(nativeViewer);
  await flush();
  expect(client.snapshot()).toMatchObject({
    ...saved,
    viewer: nativeViewer,
    status: "ready",
    relayAvailable: false,
  });
  client.select(saved.selected);
  client.relay.retry();
  await flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(client.relay.snapshot().status).not.toBe("ready");
});
