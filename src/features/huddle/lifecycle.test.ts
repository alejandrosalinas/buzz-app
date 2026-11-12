import { MessageProjection } from "../relay/message-projection";
import { createRelayProfiler } from "../relay/profiling";
import { foldMessages } from "../relay/fold";
import { expect, it, vi } from "vitest";
import {
  keypair,
  signed,
  roster,
  metadata,
  scriptedTransport,
  bounds,
  flush,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession } from "../relay/session";
import { huddleDescription, huddleLifecycle } from "./lifecycle";
const parent = "00000000-0000-4000-8000-000000000001",
  room = "00000000-0000-4000-8000-000000000002";
const author = keypair(),
  relay = keypair(),
  stranger = keypair();
const event = (kind: number, key = relay, at = 20) =>
  signed(key, {
    kind,
    created_at: at,
    content: JSON.stringify({ ephemeral_channel_id: room }),
    tags: [
      ["h", parent],
      ["p", author.pubkey],
    ],
  });

it("projects actual Huddle history cards and marked room metadata through the relay session", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, parent, [author.pubkey]),
        roster(relay, room, [author.pubkey]),
        metadata(relay, parent, "Design"),
        metadata(relay, room, "Huddle", 30, [
          ["private"],
          ["about", huddleDescription(parent)],
          ["t", "stream"],
          ["P", author.pubkey],
        ]),
      ]);
    await flush();
    expect(
      owner.session.channels.list().channels.find((c) => c.id === room)?.huddle,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
      ).toBe(true),
    );
    const proofIndex = wire.pending.findIndex((r) =>
      r.filters[0]?.kinds?.includes(9007),
    );
    wire.pending.splice(proofIndex, 1)[0]?.respond([
      signed(author, {
        kind: 9007,
        created_at: 10,
        content: "",
        tags: [
          ["h", room],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", huddleDescription(parent)],
        ],
      }),
    ]);
    await flush();
    await vi.waitFor(() =>
      expect(
        owner.session.channels.list().channels.find((c) => c.id === room),
      ).toMatchObject({ huddle: true, parentChannelId: parent }),
    );
    owner.session.channels.ensure(parent);
    const head = wire.next();
    expect(head.filters[0]?.kinds).toEqual(
      expect.arrayContaining([48100, 48103]),
    );
    head.respond([
      event(48100, author, 10),
      event(48103, relay, 30),
      event(48103, stranger, 31),
      bounds(relay, parent, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.channels.window(parent).rows.map((row) => row.huddle),
    ).toEqual([{ room, state: "started", endedAt: 30 }]);
  } finally {
    owner.dispose();
  }
});

it("ignores forged participation/end and preserves an authoritative end across later joins", () => {
  const start = event(48100, author, 10),
    join = event(48101, relay, 20);
  expect(
    huddleLifecycle(
      [start, join, event(48102, stranger, 21), event(48103, stranger, 22)],
      room,
      parent,
      relay.pubkey,
    ),
  ).toEqual({
    startedAt: 10,
    endedAt: undefined,
    participants: [author.pubkey],
  });
  expect(
    huddleLifecycle(
      [event(48101, relay, 40), event(48103, relay, 30), join, start],
      room,
      parent,
      relay.pubkey,
    ).endedAt,
  ).toBe(30);
});

it("keeps one stable card for a retained start/end pair and an end-only fallback", () => {
  const start = event(48100, author, 10),
    end = event(48103, relay, 20);
  for (const events of [
    [start, end],
    [end, start],
  ]) {
    const rows = foldMessages(parent, relay.pubkey, events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(start.id);
    expect(huddleLifecycle(events, room, parent, relay.pubkey).endedAt).toBe(
      20,
    );
  }
  expect(foldMessages(parent, relay.pubkey, [end])).toMatchObject([
    { id: end.id, huddle: { state: "ended" } },
  ]);
  const otherParent = { ...start, tags: [["h", "another-parent"]] };
  expect(foldMessages(parent, relay.pubkey, [otherParent, end])).toHaveLength(
    1,
  );
  const deleted = signed(author, {
    kind: 5,
    tags: [["e", start.id]],
    created_at: 30,
    content: "",
  });
  expect(
    foldMessages(parent, relay.pubkey, [start, end, deleted]),
  ).toMatchObject([{ id: end.id }]);
});

it("updates an already-visible start when its authoritative end arrives", () => {
  const start = event(48100, author, 10);
  const end = event(48103, relay, 20);
  const projection = new MessageProjection(
    parent,
    relay.pubkey,
    createRelayProfiler(),
  );
  const previous = projection.reconcile([start], []);
  const next = projection.reconcile([start, end], []);
  expect(next).toHaveLength(1);
  expect(next[0]?.id).toBe(previous[0]?.id);
  expect(next[0]).not.toBe(previous[0]);
  expect(next[0]?.huddle?.endedAt).toBe(20);
  expect(projection.reconcile([start, end], [])).toBe(next);
});

it.each([author, relay])(
  "retains valid creator or relay ends in batch and incremental folds",
  (ender) => {
    const start = event(48100, author, 10);
    const end = event(48103, ender, 20);
    expect(
      foldMessages(parent, relay.pubkey, [end, start])[0]?.huddle?.endedAt,
    ).toBe(20);
    const projection = new MessageProjection(
      parent,
      relay.pubkey,
      createRelayProfiler(),
    );
    expect(projection.reconcile([end], [])).toHaveLength(
      ender === relay ? 1 : 0,
    );
    const rows = projection.reconcile([end, start], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.huddle?.endedAt).toBe(20);
  },
);

it("rejects unrelated, premature and unmatched creator ends", () => {
  const start = event(48100, author, 10);
  for (const end of [event(48103, stranger, 20), event(48103, author, 5)]) {
    expect(
      foldMessages(parent, relay.pubkey, [start, end])[0]?.huddle?.endedAt,
    ).toBeUndefined();
  }
  expect(
    foldMessages(parent, relay.pubkey, [event(48103, author, 20)]),
  ).toEqual([]);
  const otherStart = event(48100, stranger, 15);
  expect(
    foldMessages(parent, relay.pubkey, [
      start,
      otherStart,
      event(48103, stranger, 20),
    ])[0]?.huddle?.endedAt,
  ).toBeUndefined();
});

it("collapses repeated starts to the canonical card", () => {
  const start = event(48100, author, 10);
  const later = event(48100, author, 15);
  const end = event(48103, relay, 20);
  const rows = foldMessages(parent, relay.pubkey, [later, end, start]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: start.id, huddle: { endedAt: 20 } });
});

it("resolves missing metadata for an already authorized Huddle", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  try {
    owner.session.channels.ensureList();
    wire.next().respond([roster(relay, room, [author.pubkey])]);
    await vi.waitFor(() =>
      expect(
        owner.session.channels.list().channels.some((c) => c.id === room),
      ).toBe(true),
    );
    // Complete the initial metadata read without a result.
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    wire.next().respond([]);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    const retry = owner.session.channels.resolve?.([room]);
    await vi.waitFor(() =>
      expect(
        wire.pending.some((r) => r.filters[0]?.kinds?.includes(39000)),
      ).toBe(true),
    );
    const index = wire.pending.findIndex((r) =>
      r.filters[0]?.kinds?.includes(39000),
    );
    wire.pending
      .splice(index, 1)[0]
      ?.respond([
        roster(relay, room, [author.pubkey]),
        metadata(relay, room, "Huddle", 30, [
          ["private"],
          ["about", huddleDescription(parent)],
          ["t", "stream"],
          ["P", author.pubkey],
        ]),
      ]);
    await retry;
    await vi.waitFor(() =>
      expect(
        wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
      ).toBe(true),
    );
    wire.next().respond([
      signed(author, {
        kind: 9007,
        created_at: 10,
        content: "",
        tags: [
          ["h", room],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", huddleDescription(parent)],
        ],
      }),
    ]);
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(room)?.huddle).toBe(true),
    );
  } finally {
    owner.dispose();
  }
});

it("fetches creation evidence for many channels in one filter after startup membership commits", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  const rooms = Array.from(
    { length: 5 },
    (_, i) => `00000000-0000-4000-8000-00000000000${i + 2}`,
  );
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond(
        rooms.flatMap((id) => [
          roster(relay, id, [author.pubkey]),
          metadata(relay, id, "Huddle", 30, [
            ["t", "stream"],
            ["P", author.pubkey],
            ["private"],
            ["about", huddleDescription(parent)],
          ]),
        ]),
      );
    await vi.waitFor(() =>
      expect(
        wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
      ).toBe(true),
    );
    const index = wire.pending.findIndex((r) =>
      r.filters[0]?.kinds?.includes(9007),
    );
    const request = wire.pending.splice(index, 1)[0];
    if (!request) throw new Error("Missing receipt request");
    expect(request.filters).toHaveLength(1);
    expect(request.filters[0]).toMatchObject({
      authors: [author.pubkey],
      limit: 10,
    });
    expect(new Set(request.filters[0]?.["#h"])).toEqual(new Set(rooms));
    request.respond(
      rooms.map((id) =>
        signed(author, {
          kind: 9007,
          created_at: 10,
          content: "",
          tags: [
            ["h", id],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ["about", huddleDescription(parent)],
          ],
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        owner.session.channels.list().channels.filter((c) => c.huddle),
      ).toHaveLength(5),
    );
  } finally {
    owner.dispose();
  }
});

it.each(["missing", "failed", "legacy"])(
  "preserves access and resolves parent proof after %s discovery",
  async (result) => {
    const name = result === "legacy" ? `huddle-${room.slice(0, 8)}` : "Huddle";
    const wire = scriptedTransport(author.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const elapsed = performance.now.bind(performance);
    let clock: { mockRestore(): void } | undefined;
    try {
      owner.session.channels.ensureList();
      wire
        .next()
        .respond([
          roster(relay, room, [author.pubkey]),
          metadata(relay, room, name, 30, [
            ["ttl", "3600"],
            ["t", "stream"],
            ["P", author.pubkey],
            ["private"],
            ["about", huddleDescription(parent)],
          ]),
        ]);
      await vi.waitFor(() =>
        expect(
          wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
        ).toBe(true),
      );
      const index = wire.pending.findIndex((r) =>
        r.filters[0]?.kinds?.includes(9007),
      );
      const request = wire.pending.splice(index, 1)[0];
      if (result === "failed") request?.fail(new Error("Receipt unavailable"));
      else request?.respond([]);
      await flush();
      expect(owner.session.channels.get?.(room)).toMatchObject({
        id: room,
        name,
      });
      expect(owner.session.channels.get?.(room)?.huddle).toBe(
        result === "legacy" ? true : undefined,
      );
      expect(
        owner.session.channels.get?.(room)?.parentChannelId,
      ).toBeUndefined();
      // Writer resolution must revisit the same metadata version and await proof.
      const strong = async (fail: boolean) => {
        let settled = false;
        const resolution = owner.session.channels
          .resolve?.([room], {
            consistency: "strong",
          })
          .then(
            () => {
              settled = true;
              return undefined;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
        await vi.waitFor(() =>
          expect(
            wire.pending.some((r) => r.filters[0]?.kinds?.includes(39000)),
          ).toBe(true),
        );
        const metadataIndex = wire.pending.findIndex((r) =>
          r.filters[0]?.kinds?.includes(39000),
        );
        if (result === "missing") {
          // The background miss backs off; past its longest jittered wait, a
          // newer live version reads again, and wins while the writer
          // metadata read is held.
          clock = vi
            .spyOn(performance, "now")
            .mockImplementation(() => elapsed() + 90_000);
          live.receive([
            metadata(relay, room, "Renamed", 31, [
              ["t", "stream"],
              ["P", author.pubkey],
              ["private"],
              ["about", huddleDescription(parent)],
            ]),
          ]);
          await vi.waitFor(() =>
            expect(
              wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
            ).toBe(true),
          );
          const background = wire.pending.findIndex((r) =>
            r.filters[0]?.kinds?.includes(9007),
          );
          wire.pending.splice(background, 1)[0]?.respond([]);
          await flush();
        }
        wire.pending
          .splice(metadataIndex, 1)[0]
          ?.respond([
            roster(relay, room, [author.pubkey]),
            metadata(relay, room, name, 30, [
              ["ttl", "3600"],
              ["t", "stream"],
              ["P", author.pubkey],
              ["private"],
              ["about", huddleDescription(parent)],
            ]),
          ]);
        await vi.waitFor(() =>
          expect(
            wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
          ).toBe(true),
        );
        const proofIndex = wire.pending.findIndex((r) =>
          r.filters[0]?.kinds?.includes(9007),
        );
        const proof = wire.pending.splice(proofIndex, 1)[0];
        expect(proof?.filters[0]?.consistency).toBe("strong");
        expect(settled).toBe(false);
        if (fail)
          proof?.fail(new Error("Writer receipt temporarily unavailable"));
        else
          proof?.respond([
            signed(author, {
              kind: 9007,
              created_at: 10,
              content: "",
              tags: [
                ["h", room],
                ["visibility", "private"],
                ["channel_type", "stream"],
                ["about", huddleDescription(parent)],
              ],
            }),
          ]);
        return resolution;
      };
      if (result === "failed") expect(await strong(true)).toBeInstanceOf(Error);
      expect(await strong(false)).toBeUndefined();
      expect(owner.session.channels.get?.(room)).toMatchObject({
        huddle: true,
        parentChannelId: parent,
      });
    } finally {
      owner.dispose();
      clock?.mockRestore();
    }
  },
);

it("does not publish late creation evidence after session disposal", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  owner.session.channels.ensureList();
  wire
    .next()
    .respond([
      roster(relay, room, [author.pubkey]),
      metadata(relay, room, "Huddle", 30, [
        ["t", "stream"],
        ["P", author.pubkey],
        ["private"],
      ]),
    ]);
  await vi.waitFor(() =>
    expect(wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007))).toBe(
      true,
    ),
  );
  const index = wire.pending.findIndex((r) =>
    r.filters[0]?.kinds?.includes(9007),
  );
  const request = wire.pending.splice(index, 1)[0];
  if (!request) throw new Error("Missing receipt request");
  owner.dispose();
  expect(request.signal?.aborted).toBe(true);
  request.respond([
    signed(author, {
      kind: 9007,
      created_at: 10,
      content: "",
      tags: [
        ["h", room],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", huddleDescription(parent)],
      ],
    }),
  ]);
  await flush();
  expect(owner.session.channels.list().channels.some((c) => c.huddle)).toBe(
    false,
  );
});

it("limits advisory creation proof to streams in the background and keeps writer resolution foreground", async () => {
  const types = ["dm", "forum", "system", "stream"];
  const events = types.flatMap((type) => [
    roster(relay, type, [author.pubkey]),
    signed(relay, {
      kind: 39000,
      created_at: 30,
      content: "",
      tags: [
        ["d", type],
        ["name", type],
        ["t", type],
        ["P", author.pubkey],
      ],
    }),
  ]);
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const query = vi.fn<typeof wire.transport.query>(async (filters) =>
    events.filter((event) =>
      filters.some(
        (filter) =>
          filter.kinds?.includes(event.kind) &&
          (!filter["#d"] ||
            filter["#d"].includes(
              event.tags.find(([key]) => key === "d")?.[1] ?? "",
            )),
      ),
    ),
  );
  const owner = createRelaySession({ ...wire.transport, query });
  try {
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await vi.waitFor(() =>
      expect(
        query.mock.calls.some(([filters]) => filters[0]?.kinds?.includes(9007)),
      ).toBe(true),
    );
    await flush();
    const proofs = () =>
      query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(9007));
    expect(proofs()).toHaveLength(1);
    expect(proofs()[0]?.[0]).toEqual([
      { kinds: [9007], authors: [author.pubkey], "#h": ["stream"], limit: 2 },
    ]);
    expect(proofs()[0]?.[3]).toBe("background");
    await owner.session.channels.resolve?.(["stream"], {
      consistency: "strong",
    });
    expect(proofs()).toHaveLength(2);
    expect(proofs()[1]?.[0][0]?.consistency).toBe("strong");
    expect(proofs()[1]?.[3]).toBe("foreground");
    expect(owner.session.channels.get?.("stream")?.huddle).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("keeps completed creation reads for retained channels while retrying aborted proof work", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const ids = Array.from({ length: 5 }, (_, i) => `proof-${i}`);
  const records = ids.map((id) =>
    metadata(relay, id, id, 30, [
      ["t", "stream"],
      ["P", author.pubkey],
      ["private"],
    ]),
  );
  const proof = async () => {
    await vi.waitFor(() =>
      expect(
        wire.pending.some((r) => r.filters[0]?.kinds?.includes(9007)),
      ).toBe(true),
    );
    const index = wire.pending.findIndex((r) =>
      r.filters[0]?.kinds?.includes(9007),
    );
    const request = wire.pending.splice(index, 1)[0];
    if (!request) throw new Error("Missing proof read");
    return request;
  };
  try {
    live.receive([
      ...ids.map((id) => roster(relay, id, [author.pubkey], 20)),
      ...records.slice(0, 4),
    ]);
    const complete = await proof();
    expect(complete.filters.map((f) => f["#h"])).toEqual([ids.slice(0, 4)]);
    complete.respond([]);
    await flush();
    live.receive(records.slice(4));
    const pending = await proof();
    expect(pending.filters[0]?.["#h"]).toEqual(["proof-4"]);
    live.receive([roster(relay, "proof-0", [], 40)]);
    await flush();
    expect(owner.session.channels.get?.("proof-0")).toBeUndefined();
    expect(pending.signal?.aborted).toBe(true);
    live.receive(records.slice(1));
    const retry = await proof();
    expect(retry.filters.map((f) => f["#h"])).toEqual([["proof-4"]]);
    retry.respond([]);
    await flush();
    live.receive(records.slice(1));
    await flush();
    expect(
      wire.pending.filter((r) => r.filters[0]?.kinds?.includes(9007)),
    ).toHaveLength(0);
    live.receive([
      roster(relay, "proof-0", [author.pubkey], 41),
      ...records.slice(0, 1),
    ]);
    const rejoined = await proof();
    expect(rejoined.filters.map((f) => f["#h"])).toEqual([["proof-0"]]);
    rejoined.respond([]);
  } finally {
    owner.dispose();
  }
});
