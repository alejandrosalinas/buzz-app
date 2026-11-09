import { expect, it, vi } from "vitest";
import type { ReadFilter } from "../relay/events";
import {
  CATCH_UP_KEY,
  CATCH_UP_PAGE,
  CATCH_UP_PAGES,
  catchUpKey,
  admitted,
  delivered,
  finished,
  HEARD_LIMIT,
  heardOf,
  readCheckpoints,
  readWindow,
  splitLegacyCheckpoints,
  streamKey,
  writeCheckpoints,
  type Stream,
} from "./catch-up";
import { fileStore } from "./state";
import { memoryStorage, sharedFiles } from "./test-fakes";

type Stored = { id: string; created_at: number; content: string };
const id = (i: number) => i.toString(16).padStart(64, "0");
/** A relay's page: newest first, ties by id ascending, below the cursor. */
const relay = (events: readonly Stored[]) => {
  const reads: ReadFilter[] = [];
  const read = async (filter: ReadFilter) => {
    reads.push(filter);
    const until = filter.until ?? Number.MAX_SAFE_INTEGER;
    return events
      .filter(
        (event) =>
          event.created_at >= (filter.since ?? 0) &&
          (event.created_at < until ||
            (event.created_at === until &&
              (filter.before_id === undefined || event.id > filter.before_id))),
      )
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit);
  };
  return { read, reads };
};
/** A watch on every channel: the bound applies there too. */
const all: Stream = {
  key: "k",
  slug: "watch/all",
  kinds: [9],
  since: 1,
  enabled: true,
};

it("reads a whole window and gives it oldest first, ties by id", async () => {
  // Two events a second, stored out of order.
  const events = Array.from({ length: 40 }, (_, i) => ({
    id: id(i),
    created_at: 100 + Math.floor(i / 2),
    content: `m${i}`,
  })).reverse();
  const { read, reads } = relay(events);
  const window = await readWindow(all, undefined, 500, read);
  expect(window?.skipped).toBe(false);
  expect(window?.events.map(({ content }) => content)).toEqual(
    Array.from({ length: 40 }, (_, i) => `m${i}`),
  );
  // No channel and no tags: the relay filters most tags after its limit.
  expect(reads[0]).toEqual({ kinds: [9], since: 1, until: 500, limit: 16 });
  expect(reads).toHaveLength(4);
  expect(window?.checkpoint).toEqual({ through: 0, upper: 500 });
});

it("stops after its page bound on every channel, skipping the oldest second it reached whole", async () => {
  const total = CATCH_UP_PAGES * CATCH_UP_PAGE + 100;
  const events = Array.from({ length: total }, (_, i) => ({
    id: id(i),
    created_at: 1000 + Math.floor(i / 2),
    content: `m${i}`,
  }));
  const { read, reads } = relay(events);
  const window = await readWindow(all, undefined, 1_000_000, read);
  // 256 full pages, then one event to learn that older ones are left.
  expect(reads).toHaveLength(CATCH_UP_PAGES + 1);
  expect(reads.at(-1)?.limit).toBe(1);
  // The last page read reached i = 100, at second 1050; its partner i = 101
  // was read too, but all of second 1050 is skipped with everything older.
  expect(window?.skipped).toBe(true);
  expect(window?.events[0]?.content).toBe("m102");
  expect(window?.events.at(-1)?.content).toBe(`m${total - 1}`);
  expect(window?.events).toHaveLength(total - 102);
  expect(window?.checkpoint).toEqual({ through: 1050, upper: 1_000_000 });
  // What is left is read no more: the next window starts after it.
  const again = await readWindow(all, window?.checkpoint, 1_000_000, read);
  expect(again?.events).toHaveLength(total - 102);
  expect(again?.skipped).toBe(false);
});

it("stops after its byte bound too", async () => {
  const big = "x".repeat(256 * 1024);
  const events = Array.from({ length: 64 }, (_, i) => ({
    id: id(i),
    created_at: 1000 + i,
    content: big,
  }));
  const { read } = relay(events);
  const window = await readWindow(all, undefined, 1_000_000, read);
  expect(window?.skipped).toBe(true);
  // Two pages, past 8 MiB, then the oldest second reached is skipped.
  expect(window?.events).toHaveLength(31);
  expect(window?.events[0]?.created_at).toBe(1000 + 33);
});

it("goes on after the last event delivered when a window was cut short", async () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    id: id(i),
    created_at: 100 + i,
    content: `m${i}`,
  }));
  const { read } = relay(events);
  const window = await readWindow(
    all,
    { through: 0, upper: 500, after: { created_at: 109, id: id(9) } },
    900,
    read,
  );
  expect(window?.upper).toBe(500);
  expect(window?.events.map(({ content }) => content)).toEqual(
    Array.from({ length: 10 }, (_, i) => `m${i + 10}`),
  );
});

it("keeps only valid live events heard past a saved checkpoint, and skips them", async () => {
  const storage = memoryStorage();
  const k = streamKey(id(9), "watch/all");
  storage.setItem(
    catchUpKey(id(9)),
    JSON.stringify({
      version: 1,
      streams: {
        [k]: {
          through: 10,
          heard: [
            { created_at: 11, id: id(1) },
            // At or before its checkpoint, or malformed.
            { created_at: 10, id: id(2) },
            { created_at: 12, id: "short" },
            null,
          ],
        },
      },
    }),
  );
  const saved = readCheckpoints(storage)[k];
  expect(saved).toEqual({
    through: 10,
    heard: [{ created_at: 11, id: id(1) }],
  });
  const { read } = relay([
    { id: id(1), created_at: 11, content: "heard" },
    { id: id(3), created_at: 11, content: "missed" },
  ]);
  const window = await readWindow(all, saved, 20, read);
  expect(window?.events.map(({ content }) => content)).toEqual(["missed"]);
});

const a = streamKey(id(10), "watch/chat");
const b = streamKey(id(11), "watch/chat");

it("keeps the progress each program saves for its own agents", async () => {
  const { disk, open } = sharedFiles();
  const setup = open();
  await writeCheckpoints(
    setup,
    { [a]: { through: 100 }, [b]: { through: 100 } },
    {},
  );
  // Two programs start from the same files, each running one agent, and each
  // keeps its own copy of every agent's progress.
  const first = open();
  const second = open();
  const firstCopy = readCheckpoints(first);
  const secondCopy = readCheckpoints(second);
  await writeCheckpoints(
    first,
    { ...firstCopy, [a]: { through: 200 } },
    firstCopy,
  );
  await writeCheckpoints(
    second,
    { ...secondCopy, [b]: { through: 300 } },
    secondCopy,
  );
  // Neither wrote over the other's agent.
  expect(readCheckpoints(open())).toEqual({
    [a]: { through: 200 },
    [b]: { through: 300 },
  });
  expect([...disk.keys()].sort()).toEqual(
    [catchUpKey(id(10)), catchUpKey(id(11))].sort(),
  );
});

it("writes the agents whose streams changed, and no other", async () => {
  const storage = memoryStorage();
  const set = vi.spyOn(storage, "set");
  const c = streamKey(id(10), "watch/other");
  const first = { through: 100 };
  const saved = { [a]: first, [b]: { through: 100 } };
  await writeCheckpoints(storage, saved, {});
  set.mockClear();
  // Nothing changed, even when the saved copy is equal but not the same.
  await writeCheckpoints(storage, saved, structuredClone(saved));
  expect(set).not.toHaveBeenCalled();
  // A changed stream writes only its agent.
  await writeCheckpoints(storage, { ...saved, [b]: { through: 200 } }, saved);
  expect(set.mock.calls.map(([key]) => key)).toEqual([catchUpKey(id(11))]);
  // A new stream of an agent writes it.
  set.mockClear();
  await writeCheckpoints(storage, { ...saved, [c]: { through: 100 } }, saved);
  expect(set.mock.calls.map(([key]) => key)).toEqual([catchUpKey(id(10))]);
  expect(Object.keys(readCheckpoints(storage))).toEqual(
    expect.arrayContaining([a, b, c]),
  );
  // Removing an agent's last stream removes its key.
  await writeCheckpoints(storage, { [a]: first }, saved);
  expect(storage.get(catchUpKey(id(11)))).toBeNull();
  expect(storage.get(catchUpKey(id(10)))).not.toBeNull();
});

it("serialises the same however many agents did not change", async () => {
  const serialised = async (agents: number) => {
    const saved = Object.fromEntries(
      Array.from({ length: agents }, (_, n) => [
        streamKey(id(100 + n), "watch/chat"),
        { through: 100 },
      ]),
    );
    const key = streamKey(id(100), "watch/chat");
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      await writeCheckpoints(
        memoryStorage(),
        { ...saved, [key]: { through: 200 } },
        saved,
      );
      return stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }
  };
  const few = await serialised(2);
  expect(few).toBeGreaterThan(0);
  expect(await serialised(20)).toBe(few);
});

it("moves the old shared progress into each agent's key, and a late move keeps newer progress", async () => {
  const { disk, open } = sharedFiles({
    [CATCH_UP_KEY]: JSON.stringify({
      version: 1,
      streams: { [a]: { through: 100 }, [b]: { through: 100 } },
    }),
  });
  // Both programs start from the old value. The second's saves wait.
  let release = () => {};
  const first = open();
  const second = open(new Promise((resolve) => (release = resolve)));
  const moved = splitLegacyCheckpoints(first);
  const firstCopy = readCheckpoints(first);
  const late = splitLegacyCheckpoints(second);
  const secondCopy = readCheckpoints(second);
  await moved;
  expect(disk.has(CATCH_UP_KEY)).toBe(false);
  // The first runs its agent on before the second's move is saved.
  await writeCheckpoints(
    first,
    { ...firstCopy, [a]: { through: 200 } },
    firstCopy,
  );
  release();
  await late;
  // The late move kept the newer progress, and the second's copy has it too.
  expect(readCheckpoints(open())[a]).toEqual({ through: 200 });
  expect(readCheckpoints(second)[a]).toEqual({ through: 200 });
  // The second saves only its own agent, from its older copy.
  await writeCheckpoints(
    second,
    { ...secondCopy, [b]: { through: 300 } },
    secondCopy,
  );
  expect(readCheckpoints(open())).toEqual({
    [a]: { through: 200 },
    [b]: { through: 300 },
  });
});

it("keeps the old shared progress when the move cannot be saved", async () => {
  const shared = JSON.stringify({
    version: 1,
    streams: { [a]: { through: 100 } },
  });
  const storage = fileStore(new Map([[CATCH_UP_KEY, shared]]), async () => {
    throw new Error("disk full");
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await splitLegacyCheckpoints(storage);
  error.mockRestore();
  expect(storage.get(CATCH_UP_KEY)).toBe(shared);
  expect(readCheckpoints(storage)).toEqual({ [a]: { through: 100 } });
});

it("keeps an overlap open and finds an event stored late, once", async () => {
  const events: Stored[] = [{ id: id(1), created_at: 480, content: "a" }];
  const { read } = relay(events);
  const first = await readWindow(all, { through: 100 }, 490, read);
  if (!first) throw new Error("no window");
  expect(first.events.map(({ content }) => content)).toEqual(["a"]);
  const checkpoint = finished(first, [], 60);
  expect(checkpoint).toEqual({
    through: 430,
    read: 490,
    heard: [{ created_at: 480, id: id(1) }],
  });
  // Read through its upper already: nothing to read again.
  expect(await readWindow(all, checkpoint, 490, read)).toBeUndefined();
  // The relay stores one late, with a time behind the last read.
  events.push({ id: id(2), created_at: 470, content: "late" });
  const second = await readWindow(all, checkpoint, 520, read);
  if (!second) throw new Error("no window");
  expect(second.events.map(({ content }) => content)).toEqual(["late"]);
  const next = finished(second, checkpoint.heard, 60);
  expect(next).toEqual({
    through: 460,
    read: 520,
    heard: [
      { created_at: 470, id: id(2) },
      { created_at: 480, id: id(1) },
    ],
  });
  const third = await readWindow(all, next, 550, read);
  expect(third?.events).toEqual([]);
});

it("shrinks the overlap to keep the newest heard events", () => {
  const read = Array.from({ length: HEARD_LIMIT + 2 }, (_, i) => ({
    id: id(i + 1),
    created_at: 1000 + i,
  }));
  const upper = 1000 + HEARD_LIMIT + 2;
  const checkpoint = finished(
    {
      events: [],
      read,
      upper,
      checkpoint: { through: 0, upper },
      skipped: false,
    },
    [],
    10_000,
  );
  expect(checkpoint.through).toBe(1001);
  expect(checkpoint.heard).toHaveLength(HEARD_LIMIT);
  expect(checkpoint.heard?.[0]).toEqual({ created_at: 1002, id: id(3) });
  expect(
    finished({
      events: [],
      read,
      upper,
      checkpoint: { through: 0 },
      skipped: false,
    }),
  ).toEqual({ through: upper });
});

it("moves past the heard it drops, but not past what was read or a window's cursor", () => {
  const heard = Array.from({ length: HEARD_LIMIT + 2 }, (_, i) => ({
    id: id(i + 1),
    created_at: 1000 + i,
  }));
  // Read through 1100: it moves past the two oldest, which were read.
  expect(heardOf({ through: 0, read: 1100 }, heard)).toMatchObject({
    through: 1001,
    read: 1100,
    heard: heard.slice(2),
  });
  // Read only through 1000: past that, one may not have been read yet, and
  // it keeps every one past where it stays, so none is given again.
  const unread = heardOf({ through: 0, read: 1000 }, heard);
  expect(unread.through).toBe(1000);
  expect(unread.read).toBeUndefined();
  expect(unread.heard).toEqual(heard.slice(1));
  // A window being given goes no further than before its cursor's second.
  const after = { created_at: 1001, id: id(2) };
  expect(heardOf({ through: 0, upper: 2000, after }, heard)).toMatchObject({
    through: 1000,
    upper: 2000,
    after,
  });
  // Unread, with no window: it stays where it is and keeps them all.
  expect(heardOf({ through: 0 }, heard)).toEqual({ through: 0, heard });
});

it("finds an event stored late below a window cut short twice, and gives none twice", async () => {
  const at = (i: number, created_at: number, content = `e${i}`) => ({
    id: id(i),
    created_at,
    content,
  });
  const events: Stored[] = [at(1, 110), at(2, 120), at(3, 130), at(4, 140)];
  const { read } = relay(events);
  const overlap = 1000;
  const given: string[] = [];
  const give = (window: { events: readonly Stored[] }, count: number) => {
    const taken = window.events.slice(0, count);
    given.push(...taken.map(({ content }) => content));
    return taken;
  };
  const first = await readWindow(all, { through: 100 }, 200, read);
  if (!first) throw new Error("no window");
  const cut = admitted(first, give(first, 2), [], overlap);
  // Stored late, below where the window goes on.
  events.push(at(5, 115, "late"));
  const second = await readWindow(all, cut, 200, read);
  if (!second) throw new Error("no window");
  const again = admitted(second, give(second, 1), cut.heard, overlap);
  expect(again.through).toBe(100);
  const third = await readWindow(all, again, 200, read);
  if (!third) throw new Error("no window");
  give(third, third.events.length);
  const done = finished(third, again.heard, overlap);
  const poll = await readWindow(all, done, 210, read);
  if (!poll) throw new Error("no window");
  give(poll, poll.events.length);
  // Found as soon as the window goes on, in its place in order.
  expect(given).toEqual(["e1", "e2", "late", "e3", "e4"]);
});

it("finds an event stored late in the second a cut-short read went on from, before it in order", async () => {
  const at = (i: number, created_at: number, content = `e${i}`) => ({
    id: id(i),
    created_at,
    content,
  });
  const events: Stored[] = [at(2, 120), at(3, 120), at(4, 130)];
  const { read } = relay(events);
  const overlap = 1000;
  const given: string[] = [];
  const give = (window: { events: readonly Stored[] }, count: number) => {
    const taken = window.events.slice(0, count);
    given.push(...taken.map(({ content }) => content));
    return taken;
  };
  const first = await readWindow(all, { through: 100 }, 200, read);
  if (!first) throw new Error("no window");
  const cut = admitted(first, give(first, 2), [], overlap);
  expect(cut.after).toBeUndefined();
  // Same second as the last one given, and before it in order.
  events.push(at(1, 120, "late"));
  const rest = await readWindow(all, cut, 200, read);
  if (!rest) throw new Error("no window");
  give(rest, rest.events.length);
  const done = finished(rest, cut.heard, overlap);
  const poll = await readWindow(all, done, 210, read);
  give(poll ?? { events: [] }, Number.MAX_SAFE_INTEGER);
  expect(given.sort()).toEqual(["e2", "e3", "e4", "late"]);
});

it("lists what a cursor saved without an overlap passed, once a read with one goes on, and gives none again", async () => {
  const at = (i: number, created_at: number) => ({
    id: id(i),
    created_at,
    content: `e${i}`,
  });
  const events: Stored[] = [at(1, 120), at(2, 120), at(3, 130)];
  const { read } = relay(events);
  const overlap = 1000;
  // e1 and e2 were given by a read with no overlap, which saved a cursor.
  const plain = delivered(200, at(2, 120));
  const resumed = await readWindow(all, plain, 200, read);
  if (!resumed) throw new Error("no window");
  expect(resumed.events.map(({ content }) => content)).toEqual(["e3"]);
  const cut = admitted(resumed, resumed.events, [], overlap);
  expect(cut.after).toBeUndefined();
  expect(cut.heard?.map(({ id }) => id)).toEqual([id(1), id(2), id(3)]);
  const again = await readWindow(all, cut, 200, read);
  expect(again?.events).toEqual([]);
  if (!again) throw new Error("no window");
  const done = finished(again, cut.heard, overlap);
  expect((await readWindow(all, done, 210, read))?.events ?? []).toEqual([]);
});
