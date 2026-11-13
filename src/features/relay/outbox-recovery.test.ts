import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createOutbox,
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import type { RelayWriter } from "./transport";
import { keypair, signed } from "./testing";
const viewer = keypair();
const input = { kind: 9, content: "First message", tags: [["h", "dm"]] };
const recovery = { key: "new-dm", value: '{"draft":"First message"}' };
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function setup(
  storage: OutboxStorage,
  publish = vi.fn<RelayWriter["publish"]>(async () => {}),
) {
  const sign = vi.fn(async (event) => signed(viewer, event));
  const owner = createOutbox(viewer.pubkey, { sign, publish }, storage);
  owners.push(owner);
  return { ...owner, sign, publish };
}
function memory() {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["live", "restored"])(
  "keeps a verified echo received during recovery's storage read (%s)",
  async (source) => {
    const store = memory();
    let event = signed(viewer, input);
    if (source === "restored")
      store.save([{ event, signed: event, delivery: "unknown" }]);
    const publishing = gate();
    const reading = gate();
    const resume = gate();
    const h = setup(
      {
        ...store,
        async load(options) {
          const records = store.load();
          if (options?.readOnly) {
            reading.release();
            await resume.promise;
          }
          return records;
        },
      },
      vi.fn(async () => publishing.promise),
    );
    const consume = vi.fn();
    try {
      await h.outbox.ready();
      if (source === "live") {
        h.outbox.send(input);
        await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
        const published = h.publish.mock.calls[0]?.[0];
        assert.exists(published);
        event = published;
      }
      const recovering = h.outbox.recover(event.id, recovery, consume);
      await reading.promise;
      h.observe([event]);
      expect(h.local.snapshot()[0]?.delivery).toBe("seen");
      resume.release();
      await recovering;
      expect(h.outbox.snapshot()[0]).toMatchObject({
        event: { id: event.id },
        signed: event,
        recovery,
        delivery: "seen",
      });
      expect(store.load()[0]).toMatchObject({ recovery, delivery: "seen" });
      expect(consume).toHaveBeenCalledOnce();
    } finally {
      resume.release();
      publishing.release();
    }
  },
);

it.each(["dismiss", "dispose"])(
  "does not adopt a receipt after %s during recovery's storage read",
  async (action) => {
    const store = memory();
    const event = signed(viewer, input);
    store.save([{ event, signed: event, delivery: "failed" }]);
    const reading = gate();
    const resume = gate();
    const h = setup({
      ...store,
      async load(options) {
        const records = store.load();
        if (options?.readOnly) {
          reading.release();
          await resume.promise;
        }
        return records;
      },
    });
    const consume = vi.fn();
    try {
      await h.outbox.ready();
      const recovering = h.outbox.recover(event.id, recovery, consume);
      const rejected = expect(recovering).rejects.toThrow(
        action === "dismiss" ? "unavailable" : "Relay session closed",
      );
      await reading.promise;
      if (action === "dismiss") await h.outbox.dismiss(event.id);
      else h.dispose();
      resume.release();
      await rejected;
      expect(store.load().some((item) => item.recovery)).toBe(false);
      expect(consume).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
    } finally {
      resume.release();
    }
  },
);

it("stores recovery with intent before publication and blocks publication on storage failure", async () => {
  const store = memory();
  let release: () => void = () => {};
  const save = vi.fn(async (records: readonly OutgoingEvent[]) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    store.save(records);
  });
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0]).toMatchObject({ event: { id }, recovery });
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  save.mockImplementation(async (records) => store.save(records));
  release();
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const failed = setup({
    load: () => [],
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await failed.outbox.ready();
  failed.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(failed.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(failed.publish).not.toHaveBeenCalled();
});

it("waits for hydration, prevents duplicate recovery keys, and retries the exact restored event", async () => {
  const store = memory();
  const first = setup(
    store,
    vi.fn(async () => {
      throw new Error("Receipt lost");
    }),
  );
  await first.outbox.ready();
  const id = first.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(first.outbox.snapshot()[0]?.delivery).toBe("unknown"),
  );
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("unknown"));
  first.dispose();
  let hydrate: (items: readonly OutgoingEvent[]) => void = () => {};
  const second = setup({
    ...store,
    load: () =>
      new Promise((resolve) => {
        hydrate = resolve;
      }),
  });
  expect(() => second.outbox.send(input, recovery)).toThrow(
    "Recover the earlier",
  );
  hydrate(store.load());
  await second.outbox.ready();
  expect(() => second.outbox.send(input, recovery)).toThrow(
    "Recover the earlier",
  );
  await expect(second.outbox.dismiss(id)).rejects.toThrow(
    "Confirm this message",
  );
  second.outbox.retry(id);
  await vi.waitFor(() => expect(second.publish).toHaveBeenCalledOnce());
  expect(second.publish.mock.calls[0]).toEqual([
    first.publish.mock.calls[0]?.[0],
    expect.any(AbortSignal),
  ]);
  expect(second.sign).not.toHaveBeenCalled();
});

it("allows removing a definitive failure but preserves confirmed recovery until acknowledgement", async () => {
  const store = memory();
  const h = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Not sent");
    }),
  );
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  await h.outbox.dismiss(id);
  expect(store.load()).toEqual([]);
  h.publish.mockResolvedValue(undefined);
  const next = h.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  await expect(h.outbox.dismiss(next)).rejects.toThrow("Confirm this message");
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  h.observe([signed(viewer, operation.event)]);
  expect(h.outbox.snapshot()[0]).toMatchObject({ delivery: "seen", recovery });
  await h.outbox.acknowledge(next);
  expect(h.outbox.snapshot()).toEqual([]);
  expect(store.load()[0]?.recovery).toBeUndefined();
});

it("keeps the latest delivery evidence and recovery key if acknowledgement persistence fails", async () => {
  const store = memory();
  const save = vi.fn(async (records: readonly OutgoingEvent[]) =>
    store.save(records),
  );
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("accepted"));
  let reject: (error: Error) => void = () => {};
  save.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const completed = h.outbox.acknowledge(id);
  const failed = expect(completed).rejects.toThrow("Disk full");
  await vi.waitFor(() =>
    expect(save.mock.calls.at(-1)?.[0][0]?.recovery).toBeUndefined(),
  );
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  h.observe([signed(viewer, operation.event)]);
  expect(() => h.outbox.send(input, recovery)).toThrow("Recover the earlier");
  reject(new Error("Disk full"));
  await failed;
  expect(h.outbox.snapshot()[0]).toMatchObject({ delivery: "seen", recovery });
  await h.outbox.acknowledge(id);
  expect(store.load()[0]?.recovery).toBeUndefined();
  expect(() => h.outbox.send(input, recovery)).not.toThrow();
});

it("adopts a retained legacy echo durably before allowing recovery", async () => {
  const store = memory();
  const h = setup(store);
  await h.outbox.ready();
  const id = h.outbox.send(input);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("accepted"));
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  const event = signed(viewer, operation.event);
  h.observe([event]);
  expect(h.outbox.snapshot()).toEqual([]);
  await h.outbox.recover(id, recovery);
  expect(store.load()[0]).toMatchObject({ recovery, delivery: "seen" });
  await expect(h.outbox.dismiss(id)).rejects.toThrow("Confirm this message");
  h.dispose();
  const restored = setup(store);
  await restored.outbox.ready();
  expect(restored.outbox.snapshot()[0]).toMatchObject({
    recovery,
    event: { id },
  });
  await restored.outbox.acknowledge(id);
  expect(store.load()[0]).toMatchObject({ acknowledged: true });
  expect(restored.outbox.snapshot()).toEqual([]);
  restored.dispose();
  const completed = setup(store);
  await completed.outbox.ready();
  expect(completed.outbox.snapshot()).toEqual([]);
  expect(completed.local.snapshot()[0]).toMatchObject({ acknowledged: true });
});

it("keeps failed adoption protected and persists again before a later recovery", async () => {
  const store = memory();
  const save = vi.fn(async (records: readonly OutgoingEvent[]) =>
    store.save(records),
  );
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const id = h.outbox.send(input);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("accepted"));
  save.mockRejectedValue(new Error("Disk full"));
  await expect(h.outbox.recover(id, recovery)).rejects.toThrow("Disk full");
  await expect(h.outbox.dismiss(id)).rejects.toThrow("Confirm this message");
  expect(store.load()[0]?.recovery).toBeUndefined();
  save.mockImplementation(async (records) => store.save(records));
  await h.outbox.recover(id, recovery);
  expect(store.load()[0]?.recovery).toEqual(recovery);
  await expect(
    h.outbox.recover(id, { ...recovery, value: "other" }),
  ).rejects.toThrow("Recover the earlier");
  const second = h.outbox.send(input);
  await expect(h.outbox.recover(second, recovery)).rejects.toThrow(
    "Recover the earlier",
  );
  await expect(h.outbox.recover("missing", recovery)).rejects.toThrow(
    "unavailable",
  );
});

it("retains acknowledgement through a late echo and restores only literal true", async () => {
  const store = memory();
  const h = setup(store);
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("accepted"));
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  const event = signed(viewer, operation.event);
  await h.outbox.acknowledge(id);
  h.observe([event]);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("seen"));
  expect(h.local.snapshot()[0]?.acknowledged).toBe(true);
  h.dispose();
  const restored = setup(store);
  await restored.outbox.ready();
  expect(restored.outbox.snapshot()).toEqual([]);
  expect(restored.local.snapshot()[0]?.acknowledged).toBe(true);
  const invalid = setup({
    ...store,
    load: () =>
      JSON.parse(
        JSON.stringify(store.load()).replace(
          '"acknowledged":true',
          '"acknowledged":"true"',
        ),
      ),
  });
  await invalid.outbox.ready();
  expect(invalid.local.snapshot()[0]?.acknowledged).toBeUndefined();
});

it("retires roster-confirmed member recovery without inventing a delivery receipt or retrying it", async () => {
  const store = memory();
  const h = setup(
    store,
    vi.fn(async () => {
      throw new Error("Receipt lost");
    }),
  );
  await h.outbox.ready();
  const id = h.outbox.send(
    { ...input, kind: 9000 },
    { key: "member-add:channel:person", value: "1" },
  );
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("unknown"));
  await h.outbox.acknowledge(id);
  expect(h.local.snapshot()[0]).toMatchObject({
    acknowledged: true,
    delivery: "unknown",
  });
  expect(h.outbox.snapshot()).toEqual([]);
  h.outbox.retry(id);
  h.dispose();
  const restored = setup(store);
  await restored.outbox.ready();
  restored.outbox.retry(id);
  expect(restored.outbox.snapshot()).toEqual([]);
  expect(restored.local.snapshot()[0]).toMatchObject({
    acknowledged: true,
    delivery: "unknown",
  });
  expect(h.publish).toHaveBeenCalledOnce();
  expect(restored.publish).not.toHaveBeenCalled();
});

it("finds another window's durable recovery without importing or publishing its operation", async () => {
  const store = memory();
  const reader = setup(store);
  await reader.outbox.ready();
  const writer = setup(store);
  await writer.outbox.ready();
  const id = writer.outbox.send(input, recovery);
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  expect(reader.outbox.snapshot()).toEqual([]);
  expect(await reader.outbox.recovery(recovery.key)).toMatchObject({
    event: { id },
    recovery,
  });
  expect(reader.outbox.snapshot()).toEqual([]);
  expect(reader.publish).not.toHaveBeenCalled();
});

it("forgets a dismissed hydrated receipt without saving it back to the shared journal", async () => {
  const store = memory();
  const original = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Refused");
    }),
  );
  await original.outbox.ready();
  const id = original.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("failed"));
  const save = vi.spyOn(store, "save");
  const stale = setup(store);
  await stale.outbox.ready();
  await original.outbox.dismiss(id);
  save.mockClear();
  expect(await stale.outbox.recovery(recovery.key)).toBeUndefined();
  expect(stale.outbox.snapshot()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
  expect(store.load()).toEqual([]);
});

it("preserves locally owned intent when its first save fails", async () => {
  const h = setup({
    load: () => [],
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(await h.outbox.recovery(recovery.key)).toMatchObject({
    event: { id },
  });
  expect(h.publish).not.toHaveBeenCalled();
});

it("returns newer shared ownership instead of a stale hydrated receipt", async () => {
  const store = memory();
  const original = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Refused");
    }),
  );
  await original.outbox.ready();
  const old = original.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("failed"));
  const stale = setup(store);
  await stale.outbox.ready();
  await original.outbox.dismiss(old);
  const next = original.outbox.send(
    { ...input, content: "New intent" },
    recovery,
  );
  await vi.waitFor(() => expect(store.load()[0]?.event.id).toBe(next));
  expect(await stale.outbox.recovery(recovery.key)).toMatchObject({
    event: { id: next },
  });
  expect(stale.outbox.snapshot()).toEqual([]);
  expect(stale.publish).not.toHaveBeenCalled();
});

it("keeps newly attached recovery ownership after a hydrated operation's save fails", async () => {
  const store = memory();
  const original = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Refused");
    }),
  );
  await original.outbox.ready();
  const id = original.outbox.send(input);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("failed"));
  const h = setup({
    ...store,
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await h.outbox.ready();
  await expect(h.outbox.recover(id, recovery)).rejects.toThrow("Disk full");
  expect(await h.outbox.recovery(recovery.key)).toMatchObject({
    event: { id },
    recovery,
  });
});

it("keeps a hydrated operation locally owned once Retry starts", async () => {
  const store = memory();
  const original = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Refused");
    }),
  );
  await original.outbox.ready();
  const id = original.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("failed"));
  const h = setup({
    ...store,
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await h.outbox.ready();
  await original.outbox.dismiss(id);
  h.outbox.retry(id);
  expect(await h.outbox.recovery(recovery.key)).toMatchObject({
    event: { id },
    recovery,
  });
});

function legacyAddition(age = 901) {
  const event = signed(viewer, {
    kind: 9000,
    content: "",
    tags: [
      ["h", "channel"],
      ["p", "person"],
    ],
    created_at: Math.floor(Date.now() / 1000) - age,
  });
  const recovery = { key: "member-add:channel:person", value: "1" };
  let records: readonly OutgoingEvent[] = [
    { event, signed: event, delivery: "unknown", recovery },
  ];
  const store = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  return { event, recovery, store };
}
it("fences replay and replacement until an expired legacy invitation is durably resolved", async () => {
  const { event, recovery, store } = legacyAddition();
  const h = setup(store);
  await h.outbox.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify = vi.fn(async () => {
    await gate;
    return undefined;
  });
  const retire = h.outbox.acknowledge(event.id, verify);
  try {
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    h.outbox.retry(event.id);
    expect(() =>
      h.outbox.send(
        {
          kind: 9000,
          content: "",
          tags: [
            ["h", "channel"],
            ["p", "person"],
            ["role", "member"],
          ],
        },
        recovery,
      ),
    ).toThrow(/Recover the earlier/);
    expect(store.load()[0]?.acknowledged).toBeUndefined();
  } finally {
    release();
  }
  await retire;
  expect(h.publish).not.toHaveBeenCalled();
  expect(store.load()[0]).toMatchObject({
    acknowledged: true,
    delivery: "unknown",
  });
  expect(h.outbox.snapshot()).toEqual([]);
});
it("cannot retire a still-active delivery after its intake window expires", async () => {
  const { event, store } = legacyAddition(0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = vi.fn(async () => {
    await gate;
  });
  const h = setup(store, publish);
  await h.outbox.ready();
  h.outbox.retry(event.id);
  try {
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((event.created_at + 901) * 1000);
    const verify = vi.fn(async () => undefined);
    await expect(h.outbox.acknowledge(event.id, verify)).rejects.toThrow(
      /may still arrive/,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(store.load()[0]?.acknowledged).toBeUndefined();
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
});
it("retains a legacy receipt when an echo arrives during negative verification", async () => {
  const { event, store } = legacyAddition();
  const h = setup(store);
  await h.outbox.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify = vi.fn(async () => {
    await gate;
    return undefined;
  });
  const retire = h.outbox.acknowledge(event.id, verify);
  const rejected = expect(retire).rejects.toThrow(/changed while checking/);
  try {
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    h.observe([event]);
  } finally {
    release();
  }
  await rejected;
  expect(h.outbox.snapshot()[0]).toMatchObject({
    delivery: "seen",
    recovery: { key: "member-add:channel:person" },
  });
  expect(store.load()[0]?.acknowledged).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
});

it("atomically hands legacy recovery to a durable Member invitation before publication", async () => {
  const { event, recovery, store } = legacyAddition();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.fn(async (records: readonly OutgoingEvent[]) => {
    await gate;
    store.save(records);
  });
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const queued = vi.fn();
  const handoff = h.outbox.acknowledge(event.id, async () => undefined, {
    input: () => ({
      kind: 9000,
      content: "",
      tags: [
        ["h", "channel"],
        ["p", "person"],
        ["role", "member"],
      ],
    }),
    queued,
  });
  try {
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const transaction = save.mock.calls[0]?.[0];
    expect(
      transaction?.find((item) => item.event.id === event.id),
    ).toMatchObject({ acknowledged: true, recovery: undefined });
    expect(
      transaction?.find((item) => item.event.id !== event.id),
    ).toMatchObject({ recovery, delivery: "sending" });
    expect(store.load()[0]?.acknowledged).toBeUndefined();
    expect(h.outbox.snapshot().length).toBeGreaterThan(0);
    expect(h.publish).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await handoff;
  expect(queued).toHaveBeenCalledOnce();
  const replacement = queued.mock.calls[0]?.[0];
  expect(
    store.load().find((item) => item.event.id === replacement)?.recovery,
  ).toEqual(recovery);
  h.dispose();
  const restored = setup(store);
  await restored.outbox.ready();
  expect(restored.outbox.snapshot()).toMatchObject([
    { event: { id: replacement }, recovery },
  ]);
  expect(restored.publish).not.toHaveBeenCalled();
  restored.outbox.retry(replacement);
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledOnce());
  expect(restored.publish.mock.calls[0]?.[0].id).toBe(replacement);
});

it("keeps only the original recoverable intent when an atomic handoff cannot be saved", async () => {
  const { event, store } = legacyAddition();
  const h = setup({
    ...store,
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await h.outbox.ready();
  const queued = vi.fn();
  await expect(
    h.outbox.acknowledge(event.id, async () => undefined, {
      input: () => ({
        kind: 9000,
        content: "",
        tags: [
          ["h", "channel"],
          ["p", "person"],
          ["role", "member"],
        ],
      }),
      queued,
    }),
  ).rejects.toThrow("Disk full");
  expect(h.outbox.snapshot()).toMatchObject([
    { event: { id: event.id }, recovery: { key: "member-add:channel:person" } },
  ]);
  expect(h.outbox.snapshot()).toHaveLength(1);
  expect(store.load()[0]?.acknowledged).toBeUndefined();
  expect(queued).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("does not expose replacement intent to an earlier queued save", async () => {
  const { event, recovery, store } = legacyAddition();
  // Attach recovery to an unowned receipt so both calls exercise queued saves.
  // An already durable matching recovery deliberately performs no write.
  store.save(store.load().map(({ recovery: _recovery, ...item }) => item));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transactions: (readonly OutgoingEvent[])[] = [];
  const save = vi.fn(async (records: readonly OutgoingEvent[]) => {
    await held;
    transactions.push(structuredClone(records));
    store.save(records);
  });
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const first = h.outbox.recover(event.id, recovery);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  const changed = vi.fn();
  const stop = h.outbox.subscribe(changed);
  const earlier = h.outbox.recover(event.id, recovery);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  const input = vi.fn(() => ({
    kind: 9000,
    content: "",
    tags: [
      ["h", "channel"],
      ["p", "person"],
      ["role", "member"],
    ],
  }));
  const queued = vi.fn();
  const handoff = h.outbox.acknowledge(event.id, async () => undefined, {
    input,
    queued,
  });
  try {
    await vi.waitFor(() => expect(input).toHaveBeenCalledOnce());
    expect(h.outbox.snapshot()).toHaveLength(1);
  } finally {
    release();
    stop();
  }
  await Promise.all([first, earlier, handoff]);
  const replacement = queued.mock.calls[0]?.[0];
  expect(replacement).toBeDefined();
  for (const records of transactions) {
    if (records.some((item) => item.event.id === replacement))
      expect(
        records.find((item) => item.event.id === event.id)?.acknowledged,
      ).toBe(true);
  }
});
