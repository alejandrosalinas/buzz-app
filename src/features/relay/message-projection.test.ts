import { expect, it } from "vitest";
import { MessageProjection } from "./message-projection";
import type { OutgoingEvent } from "./outbox";
import { createRelayProfiler } from "./profiling";
import { keypair, message, signed } from "./testing";

const relay = keypair(),
  alice = keypair(),
  bob = keypair(),
  carol = keypair();
const channel = "c";
const projection = () =>
  new MessageProjection(channel, relay.pubkey, createRelayProfiler());
const root = message(alice, channel, "root", 10);
const total = (
  descendant_count: number,
  created_at: number,
  participants: readonly string[] = [alice.pubkey],
) =>
  signed(relay, {
    kind: 39005,
    created_at,
    tags: [
      ["e", root.id],
      ["d", root.id],
      ["h", channel],
    ],
    content: JSON.stringify({ descendant_count, participants }),
  });
const thread = (rows: ReturnType<MessageProjection["reconcile"]>) => {
  const row = rows.find((item) => item.id === root.id);
  return [row?.replyCount, row?.participants];
};

it("keeps the root's own row when a broadcast reply sorts before it", () => {
  let reply = root;
  for (let n = 0; reply === root || reply.id > root.id; n++)
    reply = message(bob, channel, `re ${n}`, root.created_at, [
      ["e", root.id, "", "reply"],
      ["broadcast", "1"],
    ]);
  const rows = projection().reconcile(
    [root, reply],
    [{ event: reply, delivery: "sending" }],
  );
  expect(rows.map((row) => row.id)).toEqual([reply.id, root.id]);
  expect(rows[1]?.content).toBe("root");
  expect(thread(rows)).toEqual([1, [bob.pubkey]]);
  expect(rows[0]?.replyCount).toBe(0);
});

it("layers a reply on the summary until a newer summary observed after it settles counts it", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const send = (delivery: OutgoingEvent["delivery"]): OutgoingEvent[] => [
    { event: reply, delivery },
  ];
  const p = projection();
  const first = total(2, 20);
  expect(thread(p.reconcile([root, first], []))).toEqual([2, [alice.pubkey]]);
  expect(thread(p.reconcile([root, first, reply], send("sending")))).toEqual([
    3,
    [bob.pubkey, alice.pubkey],
  ]);
  // Someone else's reply committed meanwhile. Whether its summary counts the
  // outstanding send is undecidable (clocks never settle it), so the reply
  // stays on top until the send settles; then the relay's number stands and
  // the relay's follow-up for the send restores it.
  const meanwhile = total(3, 21, [alice.pubkey, carol.pubkey]);
  const events = [root, first, reply, meanwhile];
  expect(thread(p.reconcile(events, send("sending")))).toEqual([
    4,
    [bob.pubkey, alice.pubkey, carol.pubkey],
  ]);
  expect(thread(p.reconcile(events, send("accepted")))).toEqual([
    3,
    [alice.pubkey, carol.pubkey],
  ]);
  // A stale page overlay landing after the live summary changes nothing.
  const stale = total(1, 19);
  expect(thread(p.reconcile([...events, stale], send("accepted")))).toEqual([
    3,
    [alice.pubkey, carol.pubkey],
  ]);
  const counted = total(4, 22, [alice.pubkey, carol.pubkey, bob.pubkey]);
  expect(thread(p.reconcile([...events, stale, counted], []))).toEqual([
    4,
    [alice.pubkey, carol.pubkey, bob.pubkey],
  ]);
  // Once counted, the relay alone speaks for the reply.
  const fewer = total(3, 23, [alice.pubkey, carol.pubkey]);
  expect(thread(p.reconcile([...events, stale, counted, fewer], []))).toEqual([
    3,
    [alice.pubkey, carol.pubkey],
  ]);
});

it("counts a reply once when it arrives with the summary that already covers it", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  // A history page: stored replies and their query-time overlay land together.
  expect(
    thread(
      projection().reconcile([root, reply, total(1, 20, [bob.pubkey])], []),
    ),
  ).toEqual([1, [bob.pubkey]]);
  // An outstanding send landing with an older summary stays on top of it.
  expect(
    thread(
      projection().reconcile(
        [root, total(1, 20), reply],
        [{ event: reply, delivery: "sending" }],
      ),
    ),
  ).toEqual([2, [bob.pubkey, alice.pubkey]]);
});

it("counts stored and other users' replies only through the relay's summary", () => {
  const stored = [1, 2, 3].map((n) =>
    message(bob, channel, `old ${n}`, 10 + n, [["e", root.id, "", "reply"]]),
  );
  const covering = total(3, 20, [alice.pubkey, bob.pubkey]);
  // Opening the thread retains replies the root's retained summary already counts.
  const p = projection();
  expect(thread(p.reconcile([root, covering], []))).toEqual([
    3,
    [alice.pubkey, bob.pubkey],
  ]);
  expect(thread(p.reconcile([root, covering, ...stored], []))).toEqual([
    3,
    [alice.pubkey, bob.pubkey],
  ]);
  // Another user's live reply waits for the relay's follow-up summary.
  const live = message(carol, channel, "new", 21, [
    ["e", root.id, "", "reply"],
  ]);
  expect(thread(p.reconcile([root, covering, ...stored, live], []))).toEqual([
    3,
    [alice.pubkey, bob.pubkey],
  ]);
  const next = total(4, 22, [alice.pubkey, bob.pubkey, carol.pubkey]);
  expect(
    thread(p.reconcile([root, covering, ...stored, live, next], [])),
  ).toEqual([4, [alice.pubkey, bob.pubkey, carol.pubkey]]);
  // A restored thread whose replies land before the channel page shows the
  // relay's count once the page's summary arrives, not twice.
  const reload = projection();
  expect(thread(reload.reconcile([root, ...stored], []))).toEqual([0, []]);
  expect(thread(reload.reconcile([root, ...stored, covering], []))).toEqual([
    3,
    [alice.pubkey, bob.pubkey],
  ]);
});

it("counts a send once when its summary lands before the publish receipt", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const send = (delivery: OutgoingEvent["delivery"]): OutgoingEvent[] => [
    { event: reply, delivery },
  ];
  const events = [root, total(2, 20), reply];
  const counting = total(3, 21, [alice.pubkey, bob.pubkey]);
  const vouched = () => {
    const p = projection();
    expect(thread(p.reconcile(events, send("sending")))).toEqual([
      3,
      [bob.pubkey, alice.pubkey],
    ]);
    // The relay spawns the summary before it answers the publish, so the
    // counting summary can beat the receipt; the send stays on top meanwhile,
    // its author leading though the relay already lists them.
    expect(thread(p.reconcile([...events, counting], send("sending")))).toEqual(
      [4, [bob.pubkey, alice.pubkey]],
    );
    return p;
  };
  // Settling the send reconciles it with no further summary, even unanswered.
  for (const delivery of ["accepted", "seen", "unknown"] as const)
    expect(
      thread(vouched().reconcile([...events, counting], send(delivery))),
    ).toEqual([3, [alice.pubkey, bob.pubkey]]);
});

it("lets a counting summary speak for a send whose publish receipt was lost", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const send = (delivery: OutgoingEvent["delivery"]): OutgoingEvent[] => [
    { event: reply, delivery },
  ];
  const first = total(2, 20);
  const counting = total(3, 21, [alice.pubkey, bob.pubkey]);
  const events = [root, first, reply, counting];
  const sent = () => {
    const p = projection();
    p.reconcile([root, first], []);
    expect(thread(p.reconcile([root, first, reply], send("sending")))).toEqual([
      3,
      [bob.pubkey, alice.pubkey],
    ]);
    return p;
  };
  // A reconnect's top-level page brings the counting summary but never the
  // reply's echo. The receipt is lost after that summary lands...
  const after = sent();
  expect(thread(after.reconcile(events, send("sending")))).toEqual([
    4,
    [bob.pubkey, alice.pubkey],
  ]);
  // ...or before it.
  const before = sent();
  expect(
    thread(before.reconcile([root, first, reply], send("unknown"))),
  ).toEqual([3, [bob.pubkey, alice.pubkey]]);
  // Either way the relay's number stands, through a retry too. A retry the
  // relay turns away lands back on unknown, never failed, so nothing re-counts
  // what the relay does not hold...
  for (const p of [after, before])
    for (const delivery of [
      "unknown",
      "sending",
      "unknown",
      "sending",
      "accepted",
    ] as const)
      expect(thread(p.reconcile(events, send(delivery)))).toEqual([
        3,
        [alice.pubkey, bob.pubkey],
      ]);
  // ...and a retry that commits is counted once, by the relay's follow-up.
  const counted = total(4, 22, [alice.pubkey, bob.pubkey]);
  for (const p of [after, before])
    expect(thread(p.reconcile([...events, counted], send("accepted")))).toEqual(
      [4, [alice.pubkey, bob.pubkey]],
    );
});

it("forgets a summary observed before a failed attempt so the retry still counts", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const send = (delivery: OutgoingEvent["delivery"]): OutgoingEvent[] => [
    { event: reply, delivery },
  ];
  const p = projection();
  const events = [root, total(2, 20), reply];
  expect(thread(p.reconcile(events, send("sending")))).toEqual([
    3,
    [bob.pubkey, alice.pubkey],
  ]);
  const meanwhile = total(3, 21, [alice.pubkey, carol.pubkey]);
  const observed = [...events, meanwhile];
  expect(thread(p.reconcile(observed, send("sending")))).toEqual([
    4,
    [bob.pubkey, alice.pubkey, carol.pubkey],
  ]);
  // The relay never committed the failed attempt: no summary so far counts it.
  for (const delivery of ["failed", "sending", "accepted"] as const)
    expect(thread(p.reconcile(observed, send(delivery)))).toEqual([
      4,
      [bob.pubkey, alice.pubkey, carol.pubkey],
    ]);
  const counted = total(4, 22, [alice.pubkey, carol.pubkey, bob.pubkey]);
  expect(thread(p.reconcile([...observed, counted], send("accepted")))).toEqual(
    [4, [alice.pubkey, carol.pubkey, bob.pubkey]],
  );
});

it("does not layer a reply restored from the journal on a summary that counts it", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const covering = total(3, 20, [alice.pubkey, bob.pubkey]);
  // A confirmed (seen) or unknown restored delivery may have committed, so the
  // root's retained summary speaks for it.
  for (const delivery of ["seen", "unknown"] as const) {
    const p = projection();
    expect(thread(p.reconcile([root, covering], []))).toEqual([
      3,
      [alice.pubkey, bob.pubkey],
    ]);
    expect(
      thread(
        p.reconcile([root, covering, reply], [{ event: reply, delivery }]),
      ),
    ).toEqual([3, [alice.pubkey, bob.pubkey]]);
  }
});

it("keeps a rejected reply restored from the journal layered until its retry is counted", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const send = (delivery: OutgoingEvent["delivery"]): OutgoingEvent[] => [
    { event: reply, delivery },
  ];
  const covering = total(3, 20, [alice.pubkey, carol.pubkey]);
  const p = projection();
  expect(thread(p.reconcile([root, covering], []))).toEqual([
    3,
    [alice.pubkey, carol.pubkey],
  ]);
  // The relay never committed a rejected send, so its row restores uncounted.
  const events = [root, covering, reply];
  expect(thread(p.reconcile(events, send("failed")))).toEqual([
    4,
    [bob.pubkey, alice.pubkey, carol.pubkey],
  ]);
  // Retry publishes the same event; the summary retained before it cannot vouch.
  for (const delivery of ["sending", "accepted", "seen"] as const)
    expect(thread(p.reconcile(events, send(delivery)))).toEqual([
      4,
      [bob.pubkey, alice.pubkey, carol.pubkey],
    ]);
  const counted = total(4, 21, [alice.pubkey, carol.pubkey, bob.pubkey]);
  expect(thread(p.reconcile([...events, counted], send("seen")))).toEqual([
    4,
    [alice.pubkey, carol.pubkey, bob.pubkey],
  ]);
});

it("drops a rejected reply restored from the journal when it is dismissed", () => {
  const reply = message(bob, channel, "re", 11, [["e", root.id, "", "reply"]]);
  const covering = total(3, 20, [alice.pubkey, carol.pubkey]);
  const p = projection();
  expect(
    thread(
      p.reconcile(
        [root, covering, reply],
        [{ event: reply, delivery: "failed" }],
      ),
    ),
  ).toEqual([4, [bob.pubkey, alice.pubkey, carol.pubkey]]);
  expect(thread(p.reconcile([root, covering], []))).toEqual([
    3,
    [alice.pubkey, carol.pubkey],
  ]);
});

it("refolds a relayed row when the named agent's verified owner changes", () => {
  let owner: string | undefined;
  const view = new MessageProjection(
    channel,
    relay.pubkey,
    createRelayProfiler(),
    undefined,
    undefined,
    (pubkey) => (pubkey === bob.pubkey ? owner : undefined),
  );
  const relayed = message(alice, channel, "Notice\n\nText", 10, [
    ["relayed-from", bob.pubkey],
  ]);
  expect(view.reconcile([relayed], [])[0]?.relayedFrom?.verified).toBe(false);
  owner = alice.pubkey;
  expect(view.reconcile([relayed], [])[0]?.relayedFrom?.verified).toBe(true);
});
