import { CanvasConflictError } from "./canvas-conflict";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { createChannelKit } from "./capability";
import {
  CANVAS_HISTORY_PAGE,
  CANVAS_MAX_EVENT_BYTES,
  CANVAS_READ_BYTES,
} from "./canvas-limits";
import { byteSize } from "../relay/budget";
import { createRelayReader, RELAY_READ_BYTES } from "../relay/reader";
import {
  coordinate,
  KIT_TAG,
  type KitRecord,
  type PayloadRecord,
} from "./model";
import { flush, keypair, metadata, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { ReadError } from "../relay/errors";
import {
  createOutbox,
  PublishRejected,
  type Outbox,
  type OutgoingEvent,
} from "../relay/outbox";
import type { RelayWriter } from "../relay/transport";
import type { RelayReader } from "../relay/reader";

const viewer = keypair();
const community = "https://relay.example.test";
const channel = "11111111-1111-4111-8111-111111111111";
const record: KitRecord = {
  version: 1,
  community,
  deleted: false,
  value: { type: "team", id: "team", name: "Team", agents: [] },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const events: RelayEvent[] = [];
  const pending: OutgoingEvent[] = [];
  const controller = new AbortController();
  let time = 1_700_000_000;
  const outbox: Outbox = {
    snapshot: () => pending,
    subscribe: () => () => {},
    observeDismiss: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    recovery: async () => undefined,
    recover: async () => {},
    acknowledge: async () => {},
    supports: () => true,
    send: vi.fn((value) => {
      const event = signed(viewer, { ...value, created_at: time++ });
      events.push(event);
      return event.id;
    }),
    dismiss: vi.fn(async () => {}),
    retry: vi.fn(),
  };
  const reader: RelayReader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
    ),
  };
  const delivered = vi.fn(async () => {});
  const canWrite = vi.fn(() => true);
  const host = {
    prepare: vi.fn(
      async (value: KitRecord | PayloadRecord, _signal: AbortSignal) =>
        JSON.stringify(value),
    ),
    decode: vi.fn(async (rows: readonly RelayEvent[]) =>
      rows.map((event) => ({
        eventId: event.id,
        record: JSON.parse(event.content),
      })),
    ),
  };
  const kit = createChannelKit({
    host,
    reader,
    outbox,
    local: outbox,
    ready: Promise.resolve(),
    viewer: viewer.pubkey,
    community,
    signal: controller.signal,
    canWrite,
    delivered,
  });
  return {
    ...kit,
    events,
    pending,
    outbox,
    controller,
    reader,
    host,
    delivered,
    canWrite,
  };
}
it("saves scoped private recipe intent, confirms the exact event, and rejects stale replacements", async () => {
  const f = fixture();
  const id = await f.capability.save(record.value, undefined);
  expect(f.events[0]?.tags).toEqual([
    ["d", coordinate(record)],
    ["t", KIT_TAG],
  ]);
  expect(f.host.prepare).toHaveBeenCalledWith(record, f.controller.signal);
  expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
  await expect(f.capability.save(record.value, undefined)).rejects.toThrow(
    /changed/,
  );
  expect(f.outbox.send).toHaveBeenCalledTimes(1);
});
it.each(["head read", "encryption"] as const)(
  "cancels recipe preparation during %s without enqueueing a durable write",
  async (stage) => {
    const f = fixture();
    const operation = new AbortController();
    let reached!: (signal: AbortSignal | undefined) => void;
    const entered = new Promise<AbortSignal | undefined>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (stage === "head read")
      vi.mocked(f.reader.read).mockImplementationOnce(
        async (_filters, options) => {
          reached(options?.signal);
          await gate; // Deliberately ignore abort to probe the post-await fence.
          return [];
        },
      );
    else
      f.host.prepare.mockImplementationOnce(async (value, signal) => {
        reached(signal);
        await gate;
        return JSON.stringify(value);
      });
    const saving = f.capability.save(
      record.value,
      undefined,
      false,
      operation.signal,
    );
    const rejected = expect(saving).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      const signal = await entered;
      operation.abort();
      expect(signal?.aborted).toBe(true);
      release();
      await rejected;
      expect(f.outbox.send).not.toHaveBeenCalled();
      if (stage === "head read") expect(f.host.prepare).not.toHaveBeenCalled();
      // A cancelled preparation must release the existing save guard.
      await f.capability.save(record.value, undefined);
      expect(f.outbox.send).toHaveBeenCalledOnce();
    } finally {
      release();
      f.controller.abort();
    }
  },
);
const other: KitRecord = {
  ...record,
  value: { type: "team", id: "other", name: "Other", agents: [] },
};
it("saves another record during a save, never the same record twice", async () => {
  const f = fixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparing = false;
  f.host.prepare.mockImplementationOnce(async (value) => {
    preparing = true;
    await gate;
    return JSON.stringify(value);
  });
  const first = f.capability.save(record.value, undefined);
  try {
    await vi.waitFor(() => expect(preparing).toBe(true));
    await expect(f.capability.save(record.value, undefined)).rejects.toThrow(
      "already in progress",
    );
    const id = await f.capability.save(other.value, undefined);
    expect(f.capability.snapshot().entries.map((e) => e.eventId)).toEqual([id]);
  } finally {
    release();
  }
  await first;
  expect(f.outbox.send).toHaveBeenCalledTimes(2);
});
it("reads a save back after a catalog read that began before its confirmation", async () => {
  const f = fixture();
  const read = vi.mocked(f.reader.read);
  const answer = read.getMockImplementation();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  read.mockImplementation(async (filters, options) => {
    const events = (await answer?.(filters, options)) ?? [];
    if (!held && filters.some((filter) => filter["#t"])) {
      held = true;
      await gate; // Answer with the catalog as it was when the read began.
    }
    return events;
  });
  const first = f.capability.save(record.value, undefined);
  try {
    await vi.waitFor(() => expect(held).toBe(true));
    const second = f.capability.save(other.value, undefined);
    // The final head read precedes the trailing catalog refresh.
    await vi.waitFor(() =>
      expect(
        read.mock.calls.filter(
          ([filters]) => filters[0]?.["#d"]?.[0] === coordinate(other),
        ),
      ).toHaveLength(2),
    );
    await flush();
    release();
    const ids = await Promise.all([first, second]);
    expect(f.capability.snapshot().entries.map((e) => e.eventId)).toEqual(
      expect.arrayContaining(ids),
    );
  } finally {
    release();
  }
});
it("caller cancellation after enqueue does not retract or interrupt durable delivery", async () => {
  const f = fixture();
  const operation = new AbortController();
  const send = f.outbox.send;
  f.outbox.send = vi.fn((intent) => {
    const id = send(intent);
    operation.abort();
    return id;
  });
  try {
    const id = await f.capability.save(
      record.value,
      undefined,
      false,
      operation.signal,
    );
    expect(operation.signal.aborted).toBe(true);
    expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
    expect(f.outbox.dismiss).not.toHaveBeenCalled();
  } finally {
    f.controller.abort();
  }
});
it("keeps drafts safe from stale Canvas, unresolved writes and access loss", async () => {
  const f = fixture();
  const head = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Old",
  });
  f.events.push(head);
  await expect(f.canvas.save(channel, "New", undefined)).rejects.toThrow(
    CanvasConflictError,
  );
  f.pending.push({ event: head, delivery: "unknown" });
  await expect(f.canvas.save(channel, "New", head.id)).rejects.toThrow(
    /unresolved/,
  );
  f.pending.length = 0;
  f.canWrite.mockReturnValue(false);
  await expect(f.canvas.save(channel, "New", head.id)).rejects.toThrow(
    /unavailable/,
  );
  expect(f.outbox.send).not.toHaveBeenCalled();
  f.canWrite.mockReturnValue(true);
  f.events.length = 0;
  const saved = await f.canvas.save(channel, "New", undefined);
  expect(saved.content).toBe("New");
  expect(f.outbox.send).toHaveBeenCalledWith({
    kind: 40100,
    tags: [
      ["h", channel],
      ["expected-revision", "none"],
    ],
    content: "New",
  });
});
it("never re-signs an expired uncertain operation and clears candidates on retirement", async () => {
  const f = fixture();
  const old = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Old",
  });
  f.pending.push({ event: old, delivery: "unknown" });
  await expect(f.confirm(old.id)).rejects.toThrow(/too old/);
  expect(f.delivered).not.toHaveBeenCalled();
  expect(f.outbox.send).not.toHaveBeenCalled();
  await f.capability.save(record.value, undefined);
  f.controller.abort();
  expect(f.capability.snapshot()).toEqual({
    status: "unavailable",
    entries: [],
  });
  await expect(f.capability.save(record.value, undefined)).rejects.toThrow();
});
it("marks a relay outage as transient so recovery can retry it", async () => {
  const f = fixture();
  vi.mocked(f.reader.read).mockRejectedValueOnce(
    new ReadError("unavailable", "Relay request failed (502)", 502),
  );
  await f.capability.refresh();
  expect(f.capability.snapshot()).toMatchObject({
    status: "error",
    transient: true,
  });
  await f.capability.refresh();
  expect(f.capability.snapshot().status).toBe("ready");
  expect(f.capability.snapshot().transient).toBeUndefined();
});
it("fails visibly rather than exposing a partial or mismatched catalog", async () => {
  const f = fixture();
  const event = signed(viewer, {
    kind: 30078,
    content: JSON.stringify(record),
    tags: [
      ["d", coordinate(record)],
      ["t", KIT_TAG],
    ],
  });
  f.events.push(...Array(500).fill(event));
  await f.capability.refresh();
  expect(f.capability.snapshot().error).toMatch(/read limit/);
  // Rereading the same catalog cannot fix this: automatic recovery skips it.
  expect(f.capability.snapshot().transient).toBeUndefined();
  expect(f.host.decode).not.toHaveBeenCalled();
  f.events.splice(1);
  f.host.decode.mockResolvedValue([]);
  await f.capability.refresh();
  expect(f.capability.snapshot().error).toMatch(/Incomplete/);
  expect(f.capability.snapshot().entries).toEqual([]);
});

it("ignores retired personal groups without rejecting the catalog", async () => {
  const f = fixture();
  const kitEvent = (content: unknown, d: string) =>
    signed(viewer, {
      kind: 30078,
      content: JSON.stringify(content),
      tags: [
        ["d", d],
        ["t", KIT_TAG],
      ],
    });
  f.events.push(
    kitEvent(record, coordinate(record)),
    kitEvent(
      {
        version: 1,
        community,
        deleted: false,
        value: { type: "groups", id: "personal", groups: [], assignments: {} },
      },
      `${KIT_TAG}:${encodeURIComponent(community)}:groups:personal`,
    ),
  );
  await f.capability.refresh();
  expect(f.capability.snapshot()).toMatchObject({
    status: "ready",
    entries: [{ record }],
  });
  expect(f.host.decode).toHaveBeenCalledWith(
    [expect.objectContaining({ id: f.events[0]?.id })],
    expect.any(AbortSignal),
  );
});

it.each(["recipe", "Canvas"])(
  "waits for the session outbox to hydrate before admitting a replacement %s save",
  async (kind) => {
    const relay = keypair();
    const prior = signed(
      viewer,
      kind === "recipe"
        ? {
            kind: 30078,
            content: "encrypted prior recipe",
            tags: [
              ["d", coordinate(record)],
              ["t", KIT_TAG],
            ],
          }
        : { kind: 40100, content: "Prior Canvas", tags: [["h", channel]] },
    );
    let hydrate: (rows: readonly OutgoingEvent[]) => void = () => {};
    const hydration = new Promise<readonly OutgoingEvent[]>((resolve) => {
      hydrate = resolve;
    });
    const events = [
      metadata(relay, channel, "Channel"),
      roster(relay, channel, [viewer.pubkey]),
    ];
    const sign = vi.fn<RelayWriter["sign"]>(async (template) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const prepare = vi.fn(async () => "encrypted replacement");
    const storageSave = vi.fn();
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: community,
        media: () => undefined,
        query: async (filters) =>
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        channelKit: { prepare, decode: async () => [] },
        writer: { kinds: [30078, 40100], sign, publish },
      },
      { outboxStorage: { load: () => hydration, save: storageSave } },
    );
    try {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find((row) => row.id === channel)?.members,
        ).toContain(viewer.pubkey),
      );
      vi.useFakeTimers();
      const saving =
        kind === "recipe"
          ? owner.session.channelKit.save(record.value, undefined)
          : owner.session.canvas.save(channel, "Replacement", undefined);
      const rejected = expect(saving).rejects.toThrow(/unresolved/);
      // Drain read/admission microtasks while storage is explicitly held. No timer
      // delay can stand in for hydration, and no replacement intent may be queued.
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.session.outbox?.snapshot()).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
      hydrate([{ event: prior, signed: prior, delivery: "unknown" }]);
      await rejected;
      expect(
        owner.session.outbox?.snapshot().map((row) => row.event.id),
      ).toEqual([prior.id]);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      // Discovery queues the outbox's existing access-evidence purge behind
      // hydration. It may persist, but must preserve only the prior intent.
      await vi.advanceTimersByTimeAsync(0);
      for (const [rows] of storageSave.mock.calls)
        expect(rows).toEqual([
          { event: prior, signed: prior, delivery: "unknown" },
        ]);
    } finally {
      hydrate([]);
      owner.dispose();
    }
  },
);

it("keeps display-only Canvas reads replica-eligible without weakening editor reads", async () => {
  const f = fixture();
  await f.canvas.read(channel, { strong: false });
  expect(f.reader.read).toHaveBeenLastCalledWith(
    [{ kinds: [40100], "#h": [channel], limit: 1 }],
    { signal: f.controller.signal, fresh: true },
  );
  await f.canvas.read(channel);
  expect(f.reader.read).toHaveBeenLastCalledWith(
    [{ kinds: [40100], "#h": [channel], limit: 1, consistency: "strong" }],
    { signal: f.controller.signal, fresh: true },
  );
});

it.each<[string, number, string[][]]>([
  ["wrong kind", 9, [["h", channel]]],
  ["wrong channel", 40100, [["h", "22222222-2222-4222-8222-222222222222"]]],
  ["missing channel", 40100, []],
  ["missing channel value", 40100, [["h"]]],
  [
    "duplicate channel",
    40100,
    [
      ["h", channel],
      ["h", channel],
    ],
  ],
  [
    "ambiguous channel",
    40100,
    [
      ["h", channel],
      ["h", "elsewhere"],
    ],
  ],
  ["channel tag extra field", 40100, [["h", channel, "extra"]]],
])(
  "ignores %s as a Canvas head and rejects it in history",
  async (_problem, kind, tags) => {
    const f = fixture();
    const valid = signed(viewer, {
      kind: 40100,
      tags: [
        ["h", channel],
        ["client-id", "canvas"],
      ],
      content: "Current Canvas",
      created_at: 100,
    });
    const unrelated = signed(viewer, {
      kind,
      tags,
      content: "Unrelated owner-signed text",
      created_at: 101,
    });
    // A relay may return authentic events outside the requested coordinates.
    vi.mocked(f.reader.read).mockResolvedValueOnce([unrelated]);
    expect(await f.canvas.read(channel)).toBeUndefined();
    vi.mocked(f.reader.read).mockResolvedValueOnce([valid, unrelated]);
    expect(await f.canvas.read(channel)).toEqual(valid);
    vi.mocked(f.reader.read).mockResolvedValueOnce([unrelated]);
    await expect(f.canvas.history(channel)).rejects.toThrow(
      /invalid or non-advancing/,
    );
  },
);

it.each([false, true])(
  "carries a strong-read revision precondition for existing=%s",
  async (existing) => {
    const f = fixture();
    const before = signed(viewer, {
      kind: 40100,
      tags: [["h", channel]],
      content: "Before",
      created_at: 100,
    });
    if (existing) f.events.push(before);
    const base = await f.canvas.read(channel);
    const saved = await f.canvas.save(channel, "After", base?.id);
    expect(saved.tags).toContainEqual([
      "expected-revision",
      existing ? before.id : "none",
    ]);
    for (const [filters] of vi.mocked(f.reader.read).mock.calls)
      expect(filters.every((filter) => filter.consistency === "strong")).toBe(
        true,
      );
  },
);

it.each(["failed", "unknown"] as const)(
  "cleans up only proven CAS refusal, not %s uncertainty",
  async (delivery) => {
    const f = fixture();
    vi.mocked(f.outbox.send).mockImplementation((value) => {
      const event = signed(viewer, {
        ...value,
        created_at: Math.floor(Date.now() / 1000),
      });
      f.pending.push({
        event,
        delivery,
        error: "conflict: the relay state changed",
      });
      return event.id;
    });
    f.delivered.mockRejectedValue(
      new Error("conflict: the relay state changed"),
    );
    const save = f.canvas.save(channel, "Draft", undefined);
    await expect(save).rejects.toThrow(
      delivery === "failed" ? /Canvas changed.*draft is kept/ : /conflict:/,
    );
    if (delivery === "failed") {
      expect(f.outbox.dismiss).toHaveBeenCalledWith(f.pending[0]?.event.id);
      expect(f.delivered).not.toHaveBeenCalled();
    } else expect(f.outbox.dismiss).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "an intervening relay head survives a stale save (existing=%s), then a reviewed save succeeds",
  async (existing) => {
    const f = fixture();
    let head: RelayEvent | undefined = existing
      ? signed(viewer, {
          kind: 40100,
          tags: [["h", channel]],
          content: "Before",
          created_at: 100,
        })
      : undefined;
    const before = head;
    const winner = signed(viewer, {
      kind: 40100,
      tags: [["h", channel]],
      content: "Other editor",
      created_at: 101,
    });
    let race = true;
    const filtersSeen: ReadFilter[][] = [];
    const reader: RelayReader = {
      read: vi.fn(async (filters: readonly ReadFilter[]) => {
        filtersSeen.push([...filters]);
        return head &&
          filters.some((filter) => matchesEvent(head as RelayEvent, filter))
          ? [head]
          : [];
      }),
    };
    const publish = vi.fn(async (event: RelayEvent) => {
      if (race) {
        head = winner;
        race = false;
      }
      if (
        event.tags.find(([name]) => name === "expected-revision")?.[1] !==
        (head?.id ?? "none")
      )
        throw new PublishRejected("conflict: the relay state changed");
      head = event;
    });
    const owner = createOutbox(
      viewer.pubkey,
      {
        kinds: [40100],
        sign: async (event) => signed(viewer, event),
        publish,
      },
      { load: () => [], save() {} },
    );
    const kit = createChannelKit({
      host: undefined,
      reader,
      outbox: owner.outbox,
      local: owner.local,
      ready: owner.outbox.ready(),
      viewer: viewer.pubkey,
      community,
      signal: f.controller.signal,
      canWrite: () => true,
      delivered: async (id) => {
        await vi.waitFor(() =>
          expect(
            owner.outbox.snapshot().find((item) => item.event.id === id)
              ?.delivery,
          ).not.toBe("sending"),
        );
        const item = owner.outbox
          .snapshot()
          .find((item) => item.event.id === id);
        if (item?.delivery === "failed" || item?.delivery === "unknown")
          throw new Error(item.error);
      },
    });
    try {
      await expect(
        kit.canvas.save(channel, "Stale draft", before?.id),
      ).rejects.toThrow(CanvasConflictError);
      expect(head).toBe(winner);
      expect(owner.outbox.snapshot()).toEqual([]);
      const saved = await kit.canvas.save(channel, "Reviewed draft", winner.id);
      expect(saved.content).toBe("Reviewed draft");
      expect(head?.id).toBe(saved.id);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(
        filtersSeen.flat().every((filter) => filter.consistency === "strong"),
      ).toBe(true);
    } finally {
      owner.dispose();
      f.controller.abort();
    }
  },
);

it("retains an uncertain Canvas after lost ACK and CAS-refused exact retry, blocking replacement", async () => {
  const f = fixture();
  const before = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Before",
    created_at: 100,
  });
  const winner = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Other editor",
    created_at: 101,
  });
  let head = before;
  const reader: RelayReader = {
    // No exact-ID confirmation is available for the uncertain publication.
    read: async (filters) =>
      filters.some((filter) => !filter.ids) ? [head] : [],
  };
  const sign = vi.fn(async (event: Parameters<RelayWriter["sign"]>[0]) =>
    signed(viewer, event),
  );
  const publish = vi
    .fn(async (_event: RelayEvent) => {})
    .mockRejectedValueOnce(new Error("Lost ACK"))
    .mockRejectedValueOnce(
      new PublishRejected("conflict: the relay state changed"),
    );
  const storage = { load: () => [], save: vi.fn() };
  const owner = createOutbox(
    viewer.pubkey,
    { kinds: [40100], sign, publish },
    storage,
  );
  const dismiss = vi.fn(owner.outbox.dismiss);
  const delivered = async (id: string) => {
    await vi.waitFor(() =>
      expect(
        owner.outbox.snapshot().find((item) => item.event.id === id)?.delivery,
      ).toBe("unknown"),
    );
    throw new Error(
      owner.outbox.snapshot().find((item) => item.event.id === id)?.error,
    );
  };
  const kit = createChannelKit({
    host: undefined,
    reader,
    outbox: { ...owner.outbox, dismiss },
    local: owner.local,
    ready: owner.outbox.ready(),
    viewer: viewer.pubkey,
    community,
    signal: f.controller.signal,
    canWrite: () => true,
    delivered,
  });
  try {
    await expect(
      kit.canvas.save(channel, "My draft", before.id),
    ).rejects.toThrow("Lost ACK");
    const original = publish.mock.calls[0]?.[0];
    expect(original).toBeDefined();
    if (!original) throw new Error("Missing initial publication");
    expect(original.tags).toContainEqual(["expected-revision", before.id]);
    expect(owner.outbox.snapshot()[0]).toMatchObject({
      signed: original,
      delivery: "unknown",
    });
    head = winner;
    owner.outbox.retry(original.id);
    await vi.waitFor(() =>
      expect(owner.outbox.snapshot()[0]).toMatchObject({
        delivery: "unknown",
        error: "Retry blocked: conflict: the relay state changed",
      }),
    );
    // Canvas cleanup must respect the outbox's earlier uncertain dispatch,
    // even though this later attempt was definitively refused.
    await expect(kit.confirm(original.id)).rejects.toThrow(
      "Retry blocked: conflict:",
    );
    await expect(
      kit.canvas.save(channel, "Reviewed draft", winner.id),
    ).rejects.toThrow(/unresolved Canvas save/);
    expect(dismiss).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls.map(([event]) => event)).toEqual([
      original,
      original,
    ]);
    expect(storage.save).toHaveBeenLastCalledWith([
      expect.objectContaining({ signed: original, delivery: "unknown" }),
    ]);
    expect(head).toBe(winner);
  } finally {
    owner.dispose();
    f.controller.abort();
  }
});

it("pages retained Canvas history across equal timestamps without changing the strong head contract", async () => {
  const f = fixture();
  const total = 2 * CANVAS_HISTORY_PAGE + 2;
  for (let i = 0; i < total; i++)
    f.events.push(
      signed(viewer, {
        kind: 40100,
        tags: [["h", channel]],
        content: i === 0 ? "" : `Revision ${i}`,
        created_at: 1700000000 - Math.floor(i / 30),
      }),
    );
  vi.mocked(f.reader.read).mockImplementation(async (filters) =>
    filters.flatMap((filter) =>
      f.events
        .filter((event) => matchesEvent(event, filter))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit),
    ),
  );
  const first = await f.canvas.history(channel);
  const second = await f.canvas.history(channel, first.next);
  const third = await f.canvas.history(channel, second.next);
  expect([
    first.revisions.length,
    second.revisions.length,
    third.revisions.length,
  ]).toEqual([CANVAS_HISTORY_PAGE, CANVAS_HISTORY_PAGE, 2]);
  const revisions = [
    ...first.revisions,
    ...second.revisions,
    ...third.revisions,
  ];
  expect(new Set(revisions.map((row) => row.id)).size).toBe(total);
  expect(revisions).toEqual(
    [...f.events].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    ),
  );
  expect(revisions.some((row) => row.content === "")).toBe(true);
  expect(third.next).toBeUndefined();
  expect(f.reader.read).toHaveBeenNthCalledWith(
    1,
    [
      {
        kinds: [40100],
        "#h": [channel],
        limit: CANVAS_HISTORY_PAGE,
        consistency: "strong",
      },
    ],
    { signal: f.controller.signal, fresh: true },
  );
  expect(f.reader.read).toHaveBeenNthCalledWith(
    2,
    [
      {
        kinds: [40100],
        "#h": [channel],
        limit: CANVAS_HISTORY_PAGE,
        until: first.revisions.at(-1)?.created_at,
        before_id: first.revisions.at(-1)?.id,
      },
    ],
    { signal: f.controller.signal, fresh: true },
  );
  expect(await f.canvas.read(channel)).toEqual(first.revisions[0]);
  expect(f.outbox.send).not.toHaveBeenCalled();
});
it("reads a full History page of the largest escaped Canvas events within the read budget", async () => {
  const f = fixture();
  const largest = (i: number) => {
    const base = {
      kind: 40100,
      tags: [["h", channel]],
      created_at: 1700000000 - i,
    };
    const overhead = byteSize(signed(viewer, { ...base, content: "" }));
    // Each quote serializes as two bytes.
    const quotes = Math.floor((CANVAS_MAX_EVENT_BYTES - overhead) / 2);
    return signed(viewer, { ...base, content: '"'.repeat(quotes) });
  };
  const page = Array.from({ length: CANVAS_HISTORY_PAGE }, (_, i) =>
    largest(i),
  );
  expect(byteSize(page[0])).toBeGreaterThan(CANVAS_MAX_EVENT_BYTES - 2);
  expect(byteSize(page[0])).toBeLessThanOrEqual(CANVAS_MAX_EVENT_BYTES);
  expect(CANVAS_READ_BYTES).toBe(RELAY_READ_BYTES);
  const relay = createRelayReader({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => page,
  });
  vi.mocked(f.reader.read).mockImplementation(relay.reader.read);
  try {
    const history = await f.canvas.history(channel);
    expect(history.revisions).toHaveLength(CANVAS_HISTORY_PAGE);
    expect(history.next).toEqual({
      until: page.at(-1)?.created_at,
      before_id: page.at(-1)?.id,
    });
  } finally {
    relay.dispose();
  }
});
it.each(["repeated cursor", "newer timestamp"])(
  "rejects %s history rows without exposing them",
  async (problem) => {
    const f = fixture();
    const row = signed(viewer, {
      kind: 40100,
      tags: [["h", channel]],
      content: "Private",
      created_at: 1700000000,
    });
    const cursor = { until: row.created_at, before_id: row.id };
    vi.mocked(f.reader.read).mockResolvedValueOnce([
      {
        ...row,
        ...(problem === "newer timestamp"
          ? { created_at: row.created_at + 1 }
          : {}),
      },
    ]);
    await expect(f.canvas.history(channel, cursor)).rejects.toThrow(
      /invalid or non-advancing/,
    );
  },
);
it("fences Canvas history after access loss or session retirement, including during a read", async () => {
  const f = fixture();
  f.canWrite.mockReturnValue(false);
  await expect(f.canvas.history(channel)).rejects.toThrow(/access changed/);
  expect(f.reader.read).not.toHaveBeenCalled();
  f.canWrite.mockReturnValue(true);
  vi.mocked(f.reader.read).mockImplementationOnce(async () => {
    f.canWrite.mockReturnValue(false);
    return [];
  });
  await expect(f.canvas.history(channel)).rejects.toThrow(/access changed/);
  f.canWrite.mockReturnValue(true);
  vi.mocked(f.reader.read).mockImplementationOnce(async () => {
    f.controller.abort();
    return [];
  });
  await expect(f.canvas.history(channel)).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("keeps private catalog refresh and saves independent of native bindings", async () => {
  const f = fixture();
  const id = await f.capability.save(record.value, undefined);
  await f.capability.refresh();
  expect(f.capability.snapshot().status).toBe("ready");
  expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
  await expect(
    f.capability.save(
      { type: "team", id: "team", name: "Updated", agents: [] },
      id,
    ),
  ).resolves.toBeTypeOf("string");
});

it("keeps a loaded catalog ready while it refreshes in the background", async () => {
  const f = fixture();
  const id = await f.capability.save(record.value, undefined);
  const statuses: string[] = [];
  f.capability.subscribe(() => statuses.push(f.capability.snapshot().status));
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.reader.read;
  vi.mocked(read).mockImplementationOnce(async (...args) => {
    reached();
    await gate;
    return read(...args);
  });
  const refreshing = f.capability.refresh();
  try {
    await entered;
    expect(f.capability.snapshot()).toMatchObject({ status: "ready" });
    expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
  } finally {
    release();
  }
  await refreshing;
  expect(statuses).toEqual(["ready"]);
});
