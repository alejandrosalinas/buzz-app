import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { StatusInput, UserStatus } from "../../features/relay/user-status";
import { createFocus } from "./state";
import { FOCUS_STATUS, bindFocusStatus, soloConversation } from "./status";

const NOW = Date.UTC(2026, 10, 2, 20);
const at = (seconds: number) => Math.floor(NOW / 1000) + seconds;
const flush = () => vi.advanceTimersByTimeAsync(0);

type Raw = {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
};
const raw = (input: StatusInput, createdAt: number): Raw => ({
  id: `event-${createdAt}`,
  pubkey: "viewer",
  created_at: createdAt,
  content: input.text,
  tags: [
    ["d", "general"],
    ...(input.emoji ? [["emoji", input.emoji]] : []),
    ...(input.expiresAt === undefined
      ? []
      : [["expiration", String(input.expiresAt)]]),
  ],
});
/** What the status store shows: the newest event, unless a clear or expired. */
function visible(event: Raw | undefined): UserStatus | undefined {
  if (!event) return undefined;
  const emoji = event.tags.find(([key]) => key === "emoji")?.[1] ?? "";
  const expiration = event.tags.find(([key]) => key === "expiration")?.[1];
  const expiresAt = expiration === undefined ? undefined : Number(expiration);
  if (!event.content && !emoji) return undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now() / 1000)
    return undefined;
  return {
    userId: "viewer",
    text: event.content,
    emoji,
    updatedAt: event.created_at,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function relay(initial?: StatusInput) {
  // The relay keeps the newest replacement, clears and expired ones included.
  let latest: Raw | undefined = initial && raw(initial, at(-100));
  let clock = 0;
  const save = vi.fn(async (input: StatusInput) => {
    latest = raw(input, at(0) + clock++);
  });
  const listeners = new Set<() => void>();
  let state = {
    status: "ready",
    cached: false,
    scope: "wss://a:viewer",
    viewer: "viewer",
    session: {
      readRemote: vi.fn(async () => (latest ? [latest] : [])),
      statuses: {
        writable: true,
        save,
        current: vi.fn(async () => visible(latest)),
        snapshot: () => {
          const shown = visible(latest);
          return new Map(shown ? [["viewer", shown]] : []);
        },
      },
      channels: {
        list: () => ({
          channels: [
            { id: "solo", channelType: "solo" },
            { id: "team", channelType: "stream" },
          ],
        }),
      },
    },
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const data = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    data,
    save,
    /** Another device or the status dialog publishes a newer status, or one
     * that wins a timestamp tie with a lower id. */
    publish(input: StatusInput, tie?: { createdAt: number; id: string }) {
      latest = tie
        ? { ...raw(input, tie.createdAt), id: tie.id }
        : raw(input, at(0) + clock++);
    },
    /** The relay has nothing, as one that drops expired events would. */
    forget() {
      latest = undefined;
    },
    select(scope: string) {
      state = { ...state, scope };
      notify();
    },
    connection(status: string) {
      state = { ...state, status };
      notify();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

it("sets the telescope until the deadline and restores the previous status", async () => {
  const lunch = { text: "Lunch", emoji: "🥪", expiresAt: at(9000) };
  const community = relay(lunch);
  const focus = createFocus(undefined);
  const stop = bindFocusStatus(focus, community.data);
  focus.start(at(3600));
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(3600),
  });
  expect(focus.snapshot().status).toEqual({
    until: at(3600),
    scope: "wss://a:viewer",
    previous: lunch,
    published: at(0),
    replaced: `event-${at(-100)}`,
  });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
  expect(focus.snapshot().status).toBeUndefined();
  stop();
});

it("clears the telescope when Focus ends early with no previous status", async () => {
  const community = relay();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({ text: "", emoji: "" });
});

it("leaves an expired telescope alone when there is nothing to restore", async () => {
  const community = relay();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("leaves a status the person changed during Focus alone", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "Travelling", emoji: "✈️" });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("does not bring back the old status after the person cleared theirs", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "", emoji: "" });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("does not bring back the old status after a newer one expired", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "Call", emoji: "📞", expiresAt: at(30) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(focus.snapshot().until).toBeUndefined();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("restores after the telescope expired, but not a stale status", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪", expiresAt: at(30) });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("restores when the relay no longer has the expired telescope", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.forget();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenLastCalledWith({
    text: "Lunch",
    emoji: "🥪",
  });
});

it("waits for the community it changed before restoring", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.select("wss://b:viewer");
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  community.select("wss://a:viewer");
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    text: "Lunch",
    emoji: "🥪",
  });
});

it("a later Focus elsewhere still sets the telescope", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.select("wss://b:viewer");
  focus.end();
  await flush();
  focus.start(at(120));
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(120),
  });
  expect(focus.snapshot().status).toMatchObject({
    until: at(120),
    scope: "wss://b:viewer",
  });
});

it("retries a failed set once the connection comes back, not before", async () => {
  const community = relay();
  community.save.mockRejectedValueOnce(new Error("offline"));
  const report = vi.fn();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, report);
  focus.start(at(60));
  await flush();
  community.select("wss://a:viewer");
  await flush();
  expect(report).toHaveBeenCalledTimes(1);
  expect(community.save).toHaveBeenCalledTimes(1);
  community.connection("connecting");
  await flush();
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(2);
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(60),
  });
  expect(focus.snapshot().status).toMatchObject({ until: at(60) });
});

it("restores after a save that failed but still reached the relay", async () => {
  const lunch = { text: "Lunch", emoji: "🥪" };
  const community = relay(lunch);
  const save = community.save.getMockImplementation();
  community.save.mockImplementationOnce(async (input) => {
    await save?.(input);
    throw new Error("timed out");
  });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, () => {});
  focus.start(at(60));
  await flush();
  community.connection("connecting");
  community.connection("ready");
  await flush();
  // The retry finds the telescope that landed and does not set it again.
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toMatchObject({
    previous: lunch,
    published: at(0),
  });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
});

it("a retry after a lost answer leaves a status set elsewhere alone", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const save = community.save.getMockImplementation();
  community.save.mockImplementationOnce(async (input) => {
    await save?.(input);
    throw new Error("timed out");
  });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, () => {});
  focus.start(at(60));
  await flush();
  community.connection("connecting");
  community.publish({ text: "Travelling", emoji: "✈️" });
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("a retry after a lost answer leaves a status cleared elsewhere alone", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  community.save.mockRejectedValueOnce(new Error("offline"));
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, () => {});
  focus.start(at(60));
  await flush();
  community.connection("connecting");
  community.publish({ text: "", emoji: "" });
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
});

it("a new Focus before the earlier restore ran keeps the earlier status", async () => {
  const lunch = { text: "Lunch", emoji: "🥪" };
  const community = relay(lunch);
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  // Focus ends while offline, then starts again before the restore can run.
  community.connection("connecting");
  focus.end();
  focus.start(at(120));
  community.connection("ready");
  await flush();
  expect(focus.snapshot().status).toMatchObject({
    until: at(120),
    previous: lunch,
  });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
});

it("a new Focus after the earlier telescope expired offline keeps the earlier status", async () => {
  const lunch = { text: "Lunch", emoji: "🥪" };
  const community = relay(lunch);
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  // The first Focus reaches its deadline offline; a second starts before the
  // restore can run, while the expired telescope no longer shows.
  community.connection("connecting");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(focus.snapshot().until).toBeUndefined();
  focus.start(at(180));
  community.connection("ready");
  await flush();
  expect(focus.snapshot().status).toMatchObject({
    until: at(180),
    previous: lunch,
  });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
});

it("a retry leaves alone a status that won a timestamp tie elsewhere", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  community.save.mockRejectedValueOnce(new Error("offline"));
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, () => {});
  focus.start(at(60));
  await flush();
  community.connection("connecting");
  // Same second as "Lunch", lower id: the relay keeps this one.
  community.publish(
    { text: "Travelling", emoji: "✈️" },
    { createdAt: at(-100), id: "event-0" },
  );
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
});

it("a retry after an earlier Focus expired sets the new telescope", async () => {
  const lunch = { text: "Lunch", emoji: "🥪" };
  const community = relay(lunch);
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, () => {});
  focus.start(at(60));
  await flush();
  community.connection("connecting");
  await vi.advanceTimersByTimeAsync(60_000);
  focus.start(at(180));
  // The second Focus's set fails before it reaches the relay, so the newest
  // event is still the first Focus's expired telescope.
  community.save.mockRejectedValueOnce(new Error("offline"));
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(2);
  community.connection("connecting");
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(3);
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(180),
  });
  expect(focus.snapshot().status).toMatchObject({ previous: lunch });
  expect(focus.snapshot().status?.published).toBeDefined();
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
});

it("recognises only listed Solo conversations", () => {
  const { data } = relay();
  expect(
    soloConversation(data.snapshot(), {
      kind: "conversation",
      channelId: "solo",
    }),
  ).toBe(true);
  expect(
    soloConversation(data.snapshot(), {
      kind: "conversation",
      channelId: "team",
    }),
  ).toBe(false);
  expect(soloConversation(data.snapshot(), { kind: "page" })).toBe(false);
  // A community with no retained session lists nothing.
  expect(
    soloConversation(undefined, { kind: "conversation", channelId: "solo" }),
  ).toBe(false);
});
