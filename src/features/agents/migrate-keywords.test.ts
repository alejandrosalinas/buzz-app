import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EventWatch,
  OBJECT_LIMIT,
  timerSpent,
  timerState,
} from "./attention";
import { AGENT_BYTES } from "./attention-objects";
import { migrateWatchKeywords } from "./migrate-keywords";
import { RECORD_PREFIX, STORAGE_KEY, readRecords } from "./store";
import { memoryStorage } from "./test-fakes";

const agent = "a".repeat(64);
const channel = "099e2481-9499-48d6-adad-fa89a15163a0";
const watch: EventWatch = {
  type: "event",
  interest_id: "triage",
  name: "Build failures",
  enabled: true,
  since: 50,
  channels: "all",
  kinds: [9],
  channel,
};
const NOW = 1_000;

afterEach(() => vi.restoreAllMocks());

const seed = (attention: Record<string, unknown>) => {
  const storage = memoryStorage();
  storage.setItem(
    `${RECORD_PREFIX}${agent}`,
    JSON.stringify({ pubkey: agent, config: null, attention }),
  );
  return storage;
};
const stored = (slug: string, value: unknown) => ({
  slug,
  value,
  modifiedAt: 3,
});

describe("migrateWatchKeywords", () => {
  it("turns a keyword watch off and tells its Interest why, once", async () => {
    const storage = seed({
      "interest/triage": stored("interest/triage", {
        type: "interest",
        instructions: "T.",
      }),
      "watch/builds": stored("watch/builds", {
        ...watch,
        keywords: ["failed", "[release]"],
      }),
    });
    await migrateWatchKeywords(storage, NOW);
    const once = storage.getItem(`${RECORD_PREFIX}${agent}`);
    const read = readRecords(storage)[agent];
    expect(read?.skipped).toEqual({});
    expect(read?.attention["watch/builds"]?.value).toEqual({
      ...watch,
      enabled: false,
    });
    const timer = read?.attention["watch/fix-builds"]?.value;
    expect(timer).toMatchObject({
      type: "timer",
      interest_id: "triage",
      enabled: true,
      interval_secs: 3_600,
      armed_at: NOW,
      max_occurrences: 3,
      expires_at: null,
    });
    // The watch's own address may no longer be deliverable.
    expect(timer).not.toHaveProperty("channel");
    const prompt = timer?.type === "timer" ? timer.prompt : "";
    expect(prompt).toContain(
      '"builds" (Build failures) matched only events whose content contained any of ["failed","[release]"]. Buzz removed the keywords and turned the watch off.',
    );
    expect(prompt).toContain('watch_remove id "fix-builds"');
    expect(prompt).toContain(
      "If you already handled this, only remove this notice.",
    );
    // It first runs a minute after startup, not one interval later.
    const saved = read?.timers?.["watch/fix-builds"];
    expect(timerState(timer as never, saved, NOW)).toMatchObject({
      nextDue: NOW + 60,
      used: 0,
    });
    // Seen first long after (Attention was off), it still runs.
    const late = timerState(timer as never, saved, NOW + 86_400);
    expect(late.nextDue).toBeLessThanOrEqual(NOW + 86_400);
    expect(timerSpent(timer as never, late, NOW + 86_400)).toBe(false);
    await migrateWatchKeywords(storage, NOW + 5);
    expect(storage.getItem(`${RECORD_PREFIX}${agent}`)).toBe(once);
  });
  it("keeps a paused watch off and says it was paused before", async () => {
    const storage = seed({
      "watch/builds": stored("watch/builds", {
        ...watch,
        enabled: false,
        keywords: ["x"],
      }),
    });
    await migrateWatchKeywords(storage, NOW);
    const read = readRecords(storage)[agent];
    expect(read?.attention["watch/builds"]?.value).toEqual({
      ...watch,
      enabled: false,
    });
    const timer = read?.attention["watch/fix-builds"]?.value;
    const prompt = timer?.type === "timer" ? timer.prompt : "";
    expect(prompt).toContain("The watch was already off");
    expect(prompt).not.toContain("turned the watch off");
    expect(prompt).not.toContain("then enable it");
  });
  it("picks a free timer id", async () => {
    const long = "w".repeat(62);
    const storage = seed({
      [`watch/${long}`]: stored(`watch/${long}`, { ...watch, keywords: ["x"] }),
      "watch/a": stored("watch/a", { ...watch, keywords: ["x"] }),
      "watch/fix-a": stored("watch/fix-a", watch),
    });
    await migrateWatchKeywords(storage, NOW);
    const attention = readRecords(storage)[agent]?.attention ?? {};
    expect(Object.keys(attention).sort()).toEqual([
      "watch/a",
      "watch/fix-a",
      "watch/fix-keywords-1",
      "watch/fix-keywords-2",
      `watch/${long}`,
    ]);
    expect(attention["watch/fix-a"]?.value).toEqual(watch);
  });
  it("leaves the watch for the owner when its timer passes the object limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attention: Record<string, unknown> = {
      "watch/builds": stored("watch/builds", { ...watch, keywords: ["x"] }),
    };
    for (let i = 0; i < OBJECT_LIMIT - 1; i++)
      attention[`watch/w${i}`] = stored(`watch/w${i}`, watch);
    const storage = seed(attention);
    const before = storage.getItem(`${RECORD_PREFIX}${agent}`);
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(`${RECORD_PREFIX}${agent}`)).toBe(before);
    expect(
      readRecords(storage)[agent]?.skipped?.["watch/builds"],
    ).toMatchObject({ problem: "Unknown field: keywords" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/watch\/builds: the notice timer would pass/),
    );
  });
  it("leaves the watch for the owner when its timer passes the byte limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attention: Record<string, unknown> = {
      "watch/builds": stored("watch/builds", { ...watch, keywords: ["x"] }),
    };
    // Just under the limit before the notice: Interests of 15 KB each.
    for (let i = 0; i < Math.floor(AGENT_BYTES / 15_400); i++)
      attention[`interest/i${i}`] = stored(`interest/i${i}`, {
        type: "interest",
        instructions: "x".repeat(15_300),
      });
    const used = new TextEncoder().encode(
      JSON.stringify([attention, {}]),
    ).length;
    attention["interest/pad"] = stored("interest/pad", {
      type: "interest",
      instructions: "x".repeat(AGENT_BYTES - used - 400),
    });
    const storage = seed(attention);
    const before = storage.getItem(`${RECORD_PREFIX}${agent}`);
    expect(before?.length).toBeLessThan(AGENT_BYTES);
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(`${RECORD_PREFIX}${agent}`)).toBe(before);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        `watch/builds: the notice timer would pass the limit of ${AGENT_BYTES / 1024} KB`,
      ),
    );
  });
  it("converts keyword watches in the legacy shared record", async () => {
    const storage = memoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        agents: {
          [agent]: {
            pubkey: agent,
            config: null,
            attention: {
              "watch/builds": stored("watch/builds", {
                ...watch,
                keywords: ["x"],
              }),
            },
          },
        },
      }),
    );
    await migrateWatchKeywords(storage, NOW);
    const record = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").agents[
      agent
    ];
    expect(record.attention["watch/builds"].value).toEqual({
      ...watch,
      enabled: false,
    });
    expect(record.attention["watch/fix-builds"].value.type).toBe("timer");
  });
  it("leaves missing or malformed storage alone", async () => {
    const storage = memoryStorage();
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    storage.setItem(STORAGE_KEY, "{");
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(STORAGE_KEY)).toBe("{");
  });
});
