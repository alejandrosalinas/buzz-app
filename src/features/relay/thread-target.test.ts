import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "./session";
import { createThreadView } from "./threads";
import { ReadError } from "./errors";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const root = message(alice, "a", "Old root", 1);
const reply = message(alice, "a", "Selected reply", 10000, [
  ["e", root.id, "", "reply"],
]);
const aux = (kind: number, target: RelayEvent, content = "", time = 10001) =>
  signed(alice, { kind, content, created_at: time, tags: [["e", target.id]] });
function setup(id = reply.id) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    traffic,
    view: owner.session.thread("a", id, { exact: true }),
  };
}
async function targetRead(
  h: ReturnType<typeof setup>,
  target = reply,
  overlays: RelayEvent[] = [],
) {
  const loading = h.view.refresh();
  h.next().respond([target]);
  await flush();
  h.next().respond(overlays);
  await flush();
  if (overlays.length) {
    h.next().respond([]);
    await flush();
  }
  return { loading };
}

it("retains the selected reply beyond traversal limits without using it as a cursor or channel history", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  h.session.channels.ensure("a");
  const head = message(alice, "a", "Head", 20000);
  h.next().respond([
    head,
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  for (const pending of h.pending.splice(0)) pending.respond([]);
  const { loading } = await targetRead(h, reply, [
    aux(40003, reply, "Edited target"),
  ]);
  h.next().respond([
    root,
    message(alice, "a", "First reply", 2, [["e", root.id, "", "reply"]]),
  ]);
  await loading;
  expect(h.view.snapshot().target).toMatchObject({
    id: reply.id,
    content: "Edited target",
  });
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "First reply",
    "Edited target",
  ]); // Unrelated top-level seed events must not become replies before root resolution.
  for (let page = 2; page <= 10; page++) {
    const more = h.view.loadMore();
    const request = h.next();
    expect(request.filters[1]?.thread_cursor).toBe(page);
    request.respond([
      root,
      message(alice, "a", `Reply ${page}`, page + 1, [
        ["e", root.id, "", "reply"],
      ]),
    ]);
    await more;
  }
  expect(h.view.snapshot()).toMatchObject({
    limited: true,
    canLoadMore: false,
    targetStatus: "ready",
    target: { id: reply.id },
  });
  expect(h.session.channels.window("a").rows.map((row) => row.id)).toEqual([
    head.id,
  ]);
});

it("admits passive label lookups in the background, so an opened thread's read starts at once", async () => {
  const h = setup();
  const linked = [1, 2, 3].map((n) =>
    message(alice, "a", `Linked ${n}`, n + 1),
  );
  const labels = linked.map((target) =>
    h.session.thread("a", target.id, { exact: true, priority: "background" }),
  );
  const held = labels.map((label) => label.refresh());
  await flush();
  const ids = () => h.pending.map((wire) => wire.filters[0]?.ids);
  // Background reads run one at a time; the other two wait their turn.
  expect(ids()).toEqual([[linked[0]?.id]]);
  expect(labels.map((label) => label.snapshot().status)).toEqual([
    "loading",
    "loading",
    "loading",
  ]);
  // The opened thread's reads are never queued behind the held label reads.
  const take = (match: (filter: ReadFilter) => boolean) => {
    const at = h.pending.findIndex(({ filters: [filter] }) =>
      filter === undefined ? false : match(filter),
    );
    const [wire] = at < 0 ? [] : h.pending.splice(at, 1);
    if (!wire) throw new Error("No matching pending query");
    return wire;
  };
  const opened = h.view.refresh();
  await flush();
  expect(ids()).toEqual([[linked[0]?.id], [reply.id]]);
  take((filter) => filter.ids?.[0] === reply.id).respond([reply]);
  await flush();
  take((filter) => filter["#e"]?.[0] === reply.id).respond([]);
  await flush();
  take((filter) => filter.ids?.[0] === root.id).respond([root]);
  await opened;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "ready",
    target: { id: reply.id },
  });
  expect(ids()).toEqual([[linked[0]?.id]]);
  for (const label of labels) label.dispose();
  await Promise.all(held);
});

it("folds reference-only edits and deletes of overlays before exposing the target", async () => {
  const h = setup();
  const loading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  const edit = aux(40003, reply, "Edited"),
    reaction = aux(7, reply, "+");
  const overlays = h.next();
  expect(overlays.filters[0]?.["#h"]).toBeUndefined();
  overlays.respond([edit, reaction]);
  await flush();
  expect(h.view.snapshot().target).toBeUndefined();
  h.next().respond([aux(5, reaction)]);
  await flush();
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot().target).toMatchObject({
    content: "Edited",
    reactions: [],
  });
  h.traffic.receive([aux(5, edit)]);
  expect(h.view.snapshot().target?.content).toBe(reply.content);
  h.traffic.receive([aux(5, reply)]);
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("keeps an accessible reply when the original is unavailable, without a composer root", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  h.next().respond([]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    root: undefined,
    targetStatus: "ready",
    target: { id: reply.id },
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([reply.id]);
  // A sibling reply arriving later stays hidden: only the target shows.
  h.traffic.receive([
    message(alice, "a", "Sibling reply", 10002, [["e", root.id, "", "reply"]]),
  ]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([reply.id]);
});

it("keeps a fetched root in the existing thread surface", async () => {
  const h = setup(root.id);
  const { loading } = await targetRead(h, root);
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    root: { id: root.id },
    target: { id: root.id },
    targetStatus: "ready",
  });
});

it("distinguishes absent targets and failed lookup, then permits explicit retry", async () => {
  const h = setup();
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().targetStatus).toBe("unavailable");
  const failed = h.view.refresh();
  h.next().fail(new Error("offline"));
  await failed;
  expect(h.view.snapshot().targetStatus).toBe("error");
  await flush();
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot().target?.id).toBe(reply.id);
});

it("rejects a capped raw overlay response before visibility filtering hides its size", async () => {
  const h = setup();
  const reading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  const other = message(alice, "private", "Hidden", 2);
  h.next().respond(
    Array.from({ length: 500 }, (_, i) => aux(7, other, `${i}`)),
  );
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "error",
    target: undefined,
  });
});

it("retains target tombstones across sparse refresh and shared-cache eviction", async () => {
  const h = setup();
  const edit = aux(40003, reply, "Edited");
  const { loading } = await targetRead(h, reply, [edit]);
  h.next().respond([root]);
  await loading;
  h.traffic.receive(
    Array.from({ length: 140 }, (_, i) =>
      message(alice, "b", `${i}${"x".repeat(65536)}`, i + 20),
    ),
  );
  h.traffic.receive([aux(5, edit)]);
  expect(h.view.snapshot().target?.content).toBe(reply.content);
  h.traffic.receive([aux(5, reply)]);
  const again = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await again;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("seeds already observed tombstones rather than resurrecting a selected row", async () => {
  const h = setup();
  h.view.dispose();
  h.traffic.receive([reply, aux(5, reply)]);
  const view = h.session.thread("a", reply.id, { exact: true });
  const reading = view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await reading;
  expect(view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("revokes the channel after a denied reference-only read and fences late access-lost results", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const reading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().fail(new ReadError("denied", "denied"));
  await reading;
  expect(h.session.channels.list().channels).toEqual([]);
  expect(h.view.snapshot().target).toBeUndefined();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 11)]);
  expect(
    h.session.channels.list().channels.map((channel) => channel.id),
  ).toEqual(["a"]);
  const retry = h.view.refresh();
  // The shared scheduler yields to the host after a failed transport read.
  await flush();
  h.next().respond([reply]);
  await flush();
  const held = h.next();
  h.traffic.receive([roster(relay, "a", [], 12)]);
  expect(held.signal?.aborted).toBe(true);
  held.respond([]);
  await retry;
  expect(h.view.snapshot().target).toBeUndefined();
});

it("disposes held exact reads and purges loaded targets on cache clear", async () => {
  const h = setup();
  const reading = h.view.refresh();
  const held = h.next();
  h.view.dispose();
  expect(held.signal?.aborted).toBe(true);
  held.respond([reply]);
  await reading;
  expect(h.view.snapshot().target).toBeUndefined();
  const next = setup();
  const { loading } = await targetRead(next);
  next.next().respond([root]);
  await loading;
  await next.clearCache();
  expect(next.view.snapshot().target).toBeUndefined();
});

it("seeds a retained deletion after its selected target was evicted from the shared cache", async () => {
  const h = setup();
  h.view.dispose();
  h.traffic.receive([reply]);
  const noise = Array.from({ length: 140 }, (_, i) =>
    message(alice, "b", `${i}${"x".repeat(65536)}`, i + 20),
  );
  h.traffic.receive(noise.slice(0, 100));
  // Still-resolvable deletion is newer in the LRU than its original content.
  h.traffic.receive([aux(5, reply)]);
  h.traffic.receive(noise.slice(100)); // >8 MiB evicts the target, not this tombstone.
  const view = h.session.thread("a", reply.id, { exact: true });
  const reading = view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]); // Sparse relay read omits the already-observed deletion.
  await flush();
  const tombstones = h.next();
  expect(tombstones.filters[0]?.kinds).toEqual([5, 9005]);
  tombstones.respond([]);
  await reading;
  expect(view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("retains verified rows throughout repair and keeps valid context when the selected reply is deleted", async () => {
  const h = setup();
  const sibling = message(alice, "a", "Sibling", 2, [
    ["e", root.id, "", "reply"],
  ]);
  const { loading } = await targetRead(h);
  h.next().respond([root, sibling]);
  await loading;
  const repairing = h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "loading",
    root: { id: root.id },
    target: { id: reply.id },
    targetStatus: "ready",
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([
    sibling.id,
    reply.id,
  ]);
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([root, sibling]);
  await repairing;
  h.traffic.receive([aux(5, reply)]);
  expect(h.view.snapshot()).toMatchObject({
    root: { id: root.id },
    target: undefined,
    targetStatus: "unavailable",
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([sibling.id]);
});

for (const outcome of ["deleted", "failed", "live withdrawal"] as const) {
  it(`keeps the last safe selected fold through held repair overlays: ${outcome}`, async () => {
    const h = setup();
    const { loading } = await targetRead(h);
    h.next().respond([root]);
    await loading;
    const repair = h.view.refresh();
    h.next().respond([reply]);
    await flush();
    const edit = aux(40003, reply, "Unsafe intermediate edit");
    h.next().respond([edit]);
    await flush();
    const held = h.next();
    expect(held.filters[0]?.kinds).toEqual([5, 9005]);
    expect(h.view.snapshot().target?.content).toBe(reply.content);
    expect(h.view.snapshot().replies[0]?.content).toBe(reply.content);
    if (outcome === "failed") held.fail(new Error("offline"));
    else {
      if (outcome === "live withdrawal") {
        h.traffic.receive([aux(5, edit)]); // Resolve against staged evidence without exposing it.
        h.traffic.receive([aux(5, reply)]);
        expect(h.view.snapshot().target).toBeUndefined();
      }
      held.respond([aux(5, edit)]);
      await flush();
      if (outcome !== "live withdrawal") h.next().respond([root]);
    }
    await repair;
    if (outcome === "live withdrawal") {
      expect(h.view.snapshot().targetStatus).toBe("unavailable");
    } else {
      expect(h.view.snapshot().target?.content).toBe(reply.content);
      expect(h.view.snapshot().replies[0]?.content).toBe(reply.content);
    }
  });
}

it("never retains a selected reply rejected by the shared dual-channel access gate", async () => {
  const denied = message(alice, "a", "Forbidden dual-tag reply", 3, [
    ["h", "b"],
    ["e", root.id, "", "reply"],
  ]);
  const h = setup(denied.id);
  h.traffic.receive([
    roster(relay, "a", [viewer.pubkey]),
    roster(relay, "b", []),
  ]);
  const reading = h.view.refresh();
  h.next().respond([denied]);
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
    replies: [],
  });
  expect(h.pending).toHaveLength(0); // No overlay/traversal can authorize rejected content.
  h.traffic.receive([root]);
  expect(h.view.snapshot().target).toBeUndefined();
  expect(h.view.snapshot().replies).toEqual([]);
});

it("retargets a root-opened reader without reloading its history or replacing its rows", async () => {
  const h = setup(root.id);
  h.view.dispose();
  h.traffic.receive([root]);
  const view = h.session.thread("a", root.id);
  const initial = view.refresh();
  h.next().respond([root]);
  await initial;
  const before = view.snapshot();
  const selecting = view.retarget(reply.id, new AbortController().signal);
  expect(view.snapshot()).toBe(before);
  const request = h.next();
  expect(request.filters).toEqual([{ ids: [reply.id], "#h": ["a"], limit: 1 }]);
  request.respond([reply]);
  await flush();
  h.next().respond([aux(40003, reply, "Retargeted reply")]);
  await flush();
  h.next().respond([]);
  expect(await selecting).toBe("selected");
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id },
    targetStatus: "ready",
    target: { id: reply.id, content: "Retargeted reply" },
  });
  expect(view.snapshot().root).toBe(before.root);
  expect(h.pending).toHaveLength(0);
});

it.each(["different", "unavailable", "error", "cancelled"] as const)(
  "keeps the existing thread unchanged when retarget is %s",
  async (outcome) => {
    const h = setup();
    const { loading } = await targetRead(h);
    h.next().respond([root]);
    await loading;
    const before = h.view.snapshot();
    const signal = new AbortController();
    const unrelated = message(alice, "a", "Another root", 90);
    const selecting = h.view.retarget(
      outcome === "different" ? unrelated.id : "c".repeat(64),
      signal.signal,
    );
    const pending = h.next();
    if (outcome === "different") {
      pending.respond([unrelated]);
    } else if (outcome === "error") pending.fail(new Error("offline"));
    else if (outcome === "cancelled") {
      signal.abort();
      pending.respond([reply]);
    } else pending.respond([]);
    expect(await selecting).toBe(outcome);
    expect(h.view.snapshot()).toBe(before);
    expect(h.pending).toHaveLength(0);
  },
);

it("the newest retarget wins and access loss fences an in-flight target", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  const one = message(alice, "a", "One", 3, [["e", root.id, "", "reply"]]);
  const two = message(alice, "a", "Two", 4, [["e", root.id, "", "reply"]]);
  const first = h.view.retarget(one.id, new AbortController().signal);
  const stale = h.next();
  const second = h.view.retarget(two.id, new AbortController().signal);
  expect(stale.signal?.aborted).toBe(true);
  stale.respond([one]);
  await flush();
  h.next().respond([two]);
  await flush();
  h.next().respond([]);
  expect(await first).toBe("cancelled");
  expect(await second).toBe("selected");
  expect(h.view.snapshot().target?.id).toBe(two.id);
  const revoked = h.view.retarget(one.id, new AbortController().signal);
  const held = h.next();
  h.traffic.receive([roster(relay, "a", [], 11)]);
  expect(held.signal?.aborted).toBe(true);
  held.respond([one]);
  expect(await revoked).toBe("cancelled");
  expect(h.view.snapshot().root).toBeUndefined();
  expect(h.view.snapshot().target).toBeUndefined();
});

it("retarget during a pending history page does not strand loading or lose the page", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  const sibling = message(alice, "a", "Sibling", 2, [
    ["e", root.id, "", "reply"],
  ]);
  h.next().respond([root, sibling]);
  await loading;
  const more = h.view.loadMore();
  const page = h.next();
  const selection = h.view.retarget(root.id, new AbortController().signal);
  expect(page.signal?.aborted).toBe(false);
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  expect(await selection).toBe("selected");
  page.respond([
    root,
    message(alice, "a", "Later", 3, [["e", root.id, "", "reply"]]),
  ]);
  await more;
  expect(h.view.snapshot().replies.some((row) => row.content === "Later")).toBe(
    true,
  );
  expect(h.view.snapshot().target?.id).toBe(root.id);
  expect(h.view.snapshot().status).toBe("ready");
});

it("a deleted new target does not replace the prior selection used by refresh", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  const deleted = message(alice, "a", "Deleted", 3, [
    ["e", root.id, "", "reply"],
  ]);
  const selecting = h.view.retarget(deleted.id, new AbortController().signal);
  h.next().respond([deleted]);
  await flush();
  h.next().respond([aux(5, deleted)]);
  await flush();
  h.next().respond([]);
  expect(await selecting).toBe("unavailable");
  expect(h.view.snapshot().target?.id).toBe(reply.id);
  const refresh = h.view.refresh();
  const target = h.next();
  expect(target.filters[0]?.ids).toEqual([reply.id]);
  target.respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([root]);
  await refresh;
  expect(h.view.snapshot().target?.id).toBe(reply.id);
});

it("a held initial traversal finishes after retarget without overwriting the selection", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  const page = h.next();
  h.traffic.receive([root]);
  const selected = h.view.retarget(root.id, new AbortController().signal);
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  expect(await selected).toBe("selected");
  expect(h.view.snapshot().status).toBe("loading");
  page.respond([root]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    target: { id: root.id },
  });
});

it("finishing an older refresh after a failed retarget keeps the previous target usable", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  const refresh = h.view.refresh();
  const oldTarget = h.next();
  const next = h.view.retarget("c".repeat(64), new AbortController().signal);
  h.next().respond([]);
  expect(await next).toBe("unavailable");
  oldTarget.respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([root]);
  await refresh;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    targetStatus: "ready",
    target: { id: reply.id },
  });
});

it("a failed retarget cannot strand a pending missing-target repair in loading", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot()).toMatchObject({
    root: { id: root.id },
    targetStatus: "unavailable",
  });
  const repair = h.view.refresh();
  const repairingTarget = h.next();
  expect(h.view.snapshot().targetStatus).toBe("loading");
  const invalid = h.view.retarget("c".repeat(64), new AbortController().signal);
  h.next().respond([]);
  expect(await invalid).toBe("unavailable");
  repairingTarget.respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([root]);
  await repair;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    targetStatus: "ready",
    target: { id: reply.id },
  });
});

// Exercise the session's real synchronous reconciliation, not a stubbed admission
// callback: a bare candidate must not leak to this or another owned reader.
it.each(["selected", "error", "cancelled"] as const)(
  "retarget holds a new candidate out of published replies through held overlays: %s",
  async (outcome) => {
    const h = setup();
    const { loading } = await targetRead(h);
    h.next().respond([root]);
    await loading;
    const other = h.session.thread("a", root.id);
    const refresh = other.refresh();
    h.next().respond([root]);
    await refresh;
    const candidate = message(alice, "a", "Bare candidate", 90, [
      ["e", root.id, "", "reply"],
    ]);
    const observed: string[] = [];
    const stop = h.view.subscribe(() => {
      const row = h.view
        .snapshot()
        .replies.find((row) => row.id === candidate.id);
      if (row) observed.push(row.content);
    });
    const cancel = new AbortController();
    const selecting = h.view.retarget(candidate.id, cancel.signal);
    h.next().respond([candidate]);
    await flush();
    const held = h.next();
    try {
      expect(h.view.snapshot().target?.id).toBe(reply.id);
      expect(
        h.view.snapshot().replies.some((row) => row.id === candidate.id),
      ).toBe(false);
      expect(
        other.snapshot().replies.some((row) => row.id === candidate.id),
      ).toBe(false);
      expect(observed).toEqual([]);
      if (outcome === "error") held.fail(new Error("overlay unavailable"));
      else if (outcome === "cancelled") {
        cancel.abort();
        held.respond([]);
      } else {
        held.respond([aux(40003, candidate, "Complete candidate")]);
        await flush();
        h.next().respond([]);
      }
      expect(await selecting).toBe(outcome);
      if (outcome === "selected") {
        expect(h.view.snapshot().target).toMatchObject({
          id: candidate.id,
          content: "Complete candidate",
        });
        expect(
          other.snapshot().replies.find((row) => row.id === candidate.id)
            ?.content,
        ).toBe("Complete candidate");
        expect(observed).not.toContain("Bare candidate");
      } else {
        expect(h.view.snapshot().target?.id).toBe(reply.id);
        expect(
          h.view.snapshot().replies.some((row) => row.id === candidate.id),
        ).toBe(false);
        expect(
          other.snapshot().replies.some((row) => row.id === candidate.id),
        ).toBe(false);
        expect(observed).toEqual([]);
      }
    } finally {
      cancel.abort();
      held.respond([]);
      await selecting;
      stop();
      other.dispose();
    }
  },
);

it.each(["finite", "live"] as const)(
  "retarget retains %s tombstones for selection-staged edits and reactions",
  async (delivery) => {
    const h = setup();
    const { loading } = await targetRead(h);
    h.next().respond([root]);
    await loading;
    const other = h.session.thread("a", root.id);
    const refresh = other.refresh();
    h.next().respond([root]);
    await refresh;
    const candidate = message(alice, "a", "Original candidate", 90, [
      ["e", root.id, "", "reply"],
    ]);
    const edit = aux(40003, candidate, "Withdrawn edit"),
      reaction = aux(7, candidate, "+");
    const withdrawn = [aux(5, edit), aux(5, reaction)];
    const cancel = new AbortController();
    const selecting = h.view.retarget(candidate.id, cancel.signal);
    h.next().respond([candidate]);
    await flush();
    h.next().respond([edit, reaction]);
    await flush();
    const tombstones = h.next();
    try {
      expect(tombstones.filters[0]?.["#e"]).toEqual(
        expect.arrayContaining([edit.id, reaction.id]),
      );
      if (delivery === "live") h.traffic.receive(withdrawn);
      tombstones.respond(delivery === "finite" ? withdrawn : []);
      expect(await selecting).toBe("selected");
      expect(h.view.snapshot().target).toMatchObject({
        id: candidate.id,
        content: candidate.content,
        reactions: [],
      });
      // Shared admission must carry the deletion to a reader that never saw it.
      expect(
        other.snapshot().replies.find((row) => row.id === candidate.id),
      ).toMatchObject({ content: candidate.content, reactions: [] });
    } finally {
      cancel.abort();
      tombstones.respond([]);
      await selecting;
      other.dispose();
    }
  },
);

it("a candidate rejected by final admission never establishes a thread identity", async () => {
  const thread = createThreadView({
    channelId: "a",
    messageId: reply.id,
    relayAuthor: relay.pubkey,
    reader: { read: async (filters) => (filters[0]?.ids ? [reply] : []) },
    seed: undefined,
    local: undefined,
    canAccess: () => true,
    // Pure read visibility can permit local-only evidence; final remote
    // admission is still authoritative and may reject this candidate.
    visible: (events) => events,
    admit: () => [],
    notify: (listener) => listener(),
    exact: true,
  });
  try {
    await thread.view.refresh();
    expect(thread.view.snapshot()).toMatchObject({
      targetStatus: "unavailable",
      root: undefined,
      replies: [],
    });
    thread.receive([
      root,
      message(alice, "a", "Later live reply", 10002, [
        ["e", root.id, "", "reply"],
      ]),
    ]);
    expect(thread.view.snapshot()).toMatchObject({
      root: undefined,
      target: undefined,
      replies: [],
    });
  } finally {
    thread.view.dispose();
  }
});
