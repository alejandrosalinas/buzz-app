import { afterEach, expect, it, vi } from "vitest";
import {
  type TimerWatch,
  timerState,
  validateObject,
} from "../../features/agents/attention";
import type { Agent, AgentChange, Agents } from "../../features/agents/service";
import { type AgentRecord, setAttention } from "../../features/agents/store";
import { dream, memory, notes, withFeature } from "./features";
import {
  cannotEdit,
  featureOn,
  featurePresent,
  replaceCheckIn,
  saveFeature,
} from "./save";
import { v1CheckIn, v1Memory } from "./test-helpers";

afterEach(() => vi.useRealTimers());

it("refuses to turn on a section edited by hand, saving nothing", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = { save, types: () => [] };
  const instructions = withFeature(
    withFeature("Be brief.", memory, true),
    v1CheckIn,
    true,
  ).replace("<!-- /buzz:bestie/checkin.hourly -->", "");
  const agent = {
    key: "a".repeat(64),
    attention: {},
    config: { instructions },
  } as unknown as Agent;
  await expect(
    saveFeature(agents, agent, v1CheckIn, true, { channel: "dm" }),
  ).rejects.toThrow("restore it first");
  // Its timer would otherwise be saved first, leaving half of it on.
  expect(save).not.toHaveBeenCalled();
});

const hosted = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  place: "hosted",
  type: "test/cloud",
  attention: {},
} as unknown as Agent;

it("lets a hosted agent's provider take memory, not a timer, and no other remote agent", () => {
  const provider = { get: vi.fn(), set: vi.fn() };
  const agents = {
    save: vi.fn(),
    types: () => [],
    hostedInstructions: () => provider,
  };
  expect(cannotEdit(agents, hosted, memory)).toBeUndefined();
  expect(cannotEdit(agents, hosted, notes)).toBe(
    "Not available with remote agents yet.",
  );
  expect(cannotEdit(agents, hosted)).toBe(
    "Not available with remote agents yet.",
  );
  expect(
    cannotEdit(
      { ...agents, hostedInstructions: () => undefined },
      hosted,
      memory,
    ),
  ).toBe("Not available with remote agents yet.");
  expect(
    cannotEdit(agents, { ...hosted, place: "elsewhere" } as Agent, memory),
  ).toBe("Not available with remote agents yet.");
});

it("saves a hosted agent's feature through its provider, not Agents", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const set = vi.fn(async () => {});
  const agents = {
    save,
    types: () => [],
    hostedInstructions: () => ({ get: vi.fn(), set }),
  };
  const agent = {
    ...hosted,
    config: { instructions: "Be brief." },
  } as unknown as Agent;
  await saveFeature(agents, agent, memory, true);
  // The provider replaces only the copy the switch showed.
  expect(set).toHaveBeenCalledWith(
    withFeature("Be brief.", memory, true),
    "Be brief.",
  );
  expect(save).not.toHaveBeenCalled();
});

const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const remembering = withFeature("Be brief.", memory, true);
const ada = (
  attention: Record<string, unknown> = {},
  instructions = remembering,
) =>
  ({
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    place: "here",
    type: "test/echo",
    attention,
    config: { instructions },
  }) as unknown as Agent;
/** An agent's attention as it holds the saved objects. */
const held = (change?: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(change ?? {}).map(([slug, value]) => [slug, { value }]),
  );

it("turns Hourly notes on as an Interest with its steps and an hourly timer, and saves no instructions", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = {
    save,
    types: () => [],
  };
  await saveFeature(agents, ada(), notes, true, { channel: DM });
  // Nothing is added to what every turn carries.
  expect(save).toHaveBeenCalledTimes(1);
  const [[, change]] = save.mock.calls as [[string, AgentChange]];
  expect(change.config).toBeUndefined();
  expect(change.attention?.["interest/bestie-notes"]).toEqual({
    type: "interest",
    instructions: notes.timer?.interest,
  });
  expect(change.attention?.["watch/bestie-notes"]).toMatchObject({
    type: "timer",
    interest_id: "bestie-notes",
    prompt: "Hourly notes wake",
    interval_secs: 3600,
    channel: DM,
  });
  for (const [slug, value] of Object.entries(change.attention ?? {}))
    expect(validateObject(slug, value)).toBeUndefined();
});

it("arms Nightly review at 03:00 where the device is, so its first wake is the next 03:00", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = { save, types: () => [] };
  for (const now of [
    new Date(2026, 10, 12, 14, 30),
    new Date(2026, 10, 12, 1, 0),
    new Date(2026, 10, 12, 3, 0),
  ]) {
    vi.useFakeTimers({ now });
    save.mockClear();
    await saveFeature(agents, ada(), dream, true, { channel: DM });
    const [[, change]] = save.mock.calls as [[string, AgentChange]];
    const timer = change.attention?.["watch/bestie-dream"] as TimerWatch;
    expect(timer).toMatchObject({
      interest_id: "bestie-dream",
      prompt: "Nightly review wake",
      interval_secs: 86_400,
      channel: DM,
    });
    // Armed at the latest 03:00, not after now, and due one day on.
    const at = new Date(timer.armed_at * 1000);
    expect(at.getHours()).toBe(3);
    expect(timer.armed_at * 1000).toBeLessThanOrEqual(now.getTime());
    const due = timerState(timer, undefined, now.getTime() / 1000).nextDue;
    expect(new Date(due * 1000).getHours()).toBe(3);
    expect(due * 1000).toBeGreaterThan(now.getTime());
    expect(due * 1000 - now.getTime()).toBeLessThanOrEqual(25 * 3_600_000);
  }
  // The hourly timer is armed now, not on the hour.
  vi.useFakeTimers({ now: new Date(2026, 10, 12, 14, 30) });
  save.mockClear();
  await saveFeature(agents, ada(), notes, true, { channel: DM });
  const [[, change]] = save.mock.calls as [[string, AgentChange]];
  const hourly = change.attention?.["watch/bestie-notes"] as
    | TimerWatch
    | undefined;
  expect(hourly?.armed_at).toBe(Math.floor(Date.now() / 1000));
});

it("turns Nightly review on and off without Hourly notes, and memory off takes both", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = {
    save,
    types: () => [],
  };
  const both = ada(held({ ...attentionOf(notes), ...attentionOf(dream) }));
  const onlyDream = ada(held(attentionOf(dream)));
  // Each reads on by itself, with memory.
  expect(featureOn(onlyDream, notes)).toBe(false);
  expect(featureOn(onlyDream, dream)).toBe(true);
  expect(featureOn(ada(held(attentionOf(notes))), dream)).toBe(false);
  // Hourly notes off leaves the review's Interest and timer.
  await saveFeature(agents, both, notes, false);
  expect(save.mock.calls).toEqual([
    [
      both.key,
      {
        attention: {
          "interest/bestie-notes": null,
          "watch/bestie-notes": null,
        },
      },
    ],
  ]);
  // Turned on with Hourly notes off, as a user who never had it on would.
  save.mockClear();
  await saveFeature(agents, ada(), dream, true, { channel: DM });
  expect(Object.keys(save.mock.calls[0]?.[1].attention ?? {})).toEqual([
    "interest/bestie-dream",
    "watch/bestie-dream",
  ]);
  // Memory off removes both, and its section.
  save.mockClear();
  await saveFeature(agents, both, memory, false);
  expect(Object.keys(save.mock.calls[0]?.[1].attention ?? {}).sort()).toEqual([
    "interest/bestie-dream",
    "interest/bestie-notes",
    "watch/bestie-dream",
    "watch/bestie-notes",
  ]);
  expect(save.mock.calls[1]?.[1].config).toEqual({ instructions: "Be brief." });
});

it("reads a check-in as off unless its Interest and its timer are both there", () => {
  const timer = held({ "watch/bestie-notes": { type: "timer" } });
  const interest = held({ "interest/bestie-notes": { type: "interest" } });
  expect(featureOn(ada(timer), notes)).toBe(false);
  expect(featureOn(ada(interest), notes)).toBe(false);
  expect(featureOn(ada({ ...timer, ...interest }), notes)).toBe(true);
  // Either half is something to remove.
  expect(featurePresent(ada(timer), notes)).toBe(true);
  expect(featurePresent(ada(interest), notes)).toBe(true);
  expect(featurePresent(ada(), notes)).toBe(false);
});

it("replaces nothing for an agent without the old hourly check-in", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  await replaceCheckIn(
    { save, types: () => [] },
    ada(held(attentionOf(notes))),
  );
  expect(save).not.toHaveBeenCalled();
});

it("keeps an old hourly check-in paused in Attention paused in Hourly notes and Nightly review", async () => {
  const checkingIn = withFeature(remembering, v1CheckIn, true);
  const wake = { type: "timer", channel: DM, enabled: true };
  for (const [paused, interest, timer] of [
    // Its timer paused, its Interest paused, or neither.
    [true, { type: "interest" }, { ...wake, enabled: false }],
    [true, { type: "interest", paused: true }, wake],
    [false, { type: "interest" }, wake],
  ] as const) {
    const save = vi.fn<Agents["save"]>(async () => {});
    await replaceCheckIn(
      { save, types: () => [] },
      ada(
        held({
          "interest/bestie-hourly-check-in": interest,
          "watch/bestie-hourly-check-in": timer,
        }),
        checkingIn,
      ),
    );
    const changes = save.mock.calls.map(([, change]) => change.attention ?? {});
    for (const id of ["bestie-notes", "bestie-dream"]) {
      const made = changes.find((change) => change[`watch/${id}`]);
      expect(made?.[`watch/${id}`]).toMatchObject({ enabled: !paused });
      expect(made?.[`interest/${id}`]).toEqual({
        type: "interest",
        instructions: expect.any(String),
        ...(paused && { paused: true }),
      });
      for (const [slug, value] of Object.entries(made ?? {}))
        if (value !== null) expect(validateObject(slug, value)).toBeUndefined();
    }
    // The rest of the upgrade is the same: the old check-in is taken away.
    expect(changes).toContainEqual(
      expect.objectContaining({
        "interest/bestie-hourly-check-in": null,
        "watch/bestie-hourly-check-in": null,
      }),
    );
    expect(save).toHaveBeenLastCalledWith(expect.any(String), {
      config: { instructions: remembering },
    });
  }
});

const LEGACY_TIMER = {
  "interest/bestie-hourly-check-in": { type: "interest", instructions: "Up" },
  "watch/bestie-hourly-check-in": {
    type: "timer",
    interest_id: "bestie-hourly-check-in",
    prompt: "Hourly upkeep wake",
    enabled: true,
    interval_secs: 3600,
    armed_at: 1_700_000_000,
    max_occurrences: null,
    expires_at: null,
    channel: DM,
  },
};

it("replaces the old hourly check-in in one Attention change, the old one first, so a failure on either new one saves nothing", async () => {
  const checkingIn = withFeature(remembering, v1CheckIn, true);
  const save = vi
    .fn<Agents["save"]>()
    .mockRejectedValueOnce(
      new Error("An agent can have at most 250 watches and timers"),
    );
  await expect(
    replaceCheckIn(
      { save, types: () => [] },
      ada(held(LEGACY_TIMER), checkingIn),
    ),
  ).rejects.toThrow("at most 250");
  // Nothing else was tried: the old check-in, section and all, is as it was.
  expect(save).toHaveBeenCalledTimes(1);
  expect(Object.keys(save.mock.calls[0]?.[1].attention ?? {})).toEqual([
    "interest/bestie-hourly-check-in",
    "watch/bestie-hourly-check-in",
    "interest/bestie-notes",
    "watch/bestie-notes",
    "interest/bestie-dream",
    "watch/bestie-dream",
  ]);
  expect(save.mock.calls[0]?.[1].config).toBeUndefined();
});

it("replaces the old hourly check-in of an agent at 249 of 250 watches and timers, ending at 250", async () => {
  let record: AgentRecord = {
    pubkey: "a".repeat(64),
    attention: {},
    config: undefined,
  };
  for (const [slug, value] of Object.entries(LEGACY_TIMER))
    record = setAttention(record, slug, value as never);
  record = setAttention(record, "interest/other", {
    type: "interest",
    instructions: "Other",
  });
  for (let i = 0; record && Object.keys(record.attention).length < 251; i++)
    record = setAttention(record, `watch/other-${i}`, {
      ...LEGACY_TIMER["watch/bestie-hourly-check-in"],
      interest_id: "other",
    } as never);
  const watches = (attention: AgentRecord["attention"]) =>
    Object.values(attention).filter(({ value }) => value.type !== "interest")
      .length;
  expect(watches(record.attention)).toBe(249);
  // As the agents service saves a change: all of it, or none of it.
  const save = vi.fn<Agents["save"]>(async (_, change) => {
    let next = record;
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      next = setAttention(next, slug, value);
    record = next;
  });
  const agent = {
    ...ada(undefined, withFeature(remembering, v1CheckIn, true)),
    attention: record.attention,
  } as Agent;
  await replaceCheckIn({ save, types: () => [] }, agent);
  expect(watches(record.attention)).toBe(250);
  expect(record.attention["watch/bestie-hourly-check-in"]).toBeUndefined();
  expect(record.attention["watch/bestie-notes"]).toBeDefined();
  expect(record.attention["watch/bestie-dream"]).toBeDefined();
});

it("upgrades a v1 memory section in place with the old check-in's section, so chat turns stop keeping prose in mem/memory", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const old = withFeature(
    withFeature("Be brief.", v1Memory, true),
    v1CheckIn,
    true,
  );
  await replaceCheckIn({ save, types: () => [] }, ada(held(LEGACY_TIMER), old));
  expect(save).toHaveBeenLastCalledWith(expect.any(String), {
    config: { instructions: remembering },
  });
  // A timer-only replacement leaves the shared instructions as they are.
  save.mockClear();
  await replaceCheckIn(
    { save, types: () => [] },
    ada(held(LEGACY_TIMER), old),
    { timerOnly: true },
  );
  expect(save.mock.calls.some(([, change]) => change.config)).toBe(false);
});

it("takes only the old check-in's section away beside a v1 memory section the owner edited", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const mine = withFeature("Be brief.", v1Memory, true).replace(
    "Rules:",
    "Rules:\n- Never store my medical details.",
  );
  await replaceCheckIn(
    { save, types: () => [] },
    ada(held(LEGACY_TIMER), withFeature(mine, v1CheckIn, true)),
  );
  expect(save).toHaveBeenLastCalledWith(expect.any(String), {
    config: { instructions: mine },
  });
});

it("undoes the timer of a feature with a section when its instructions can't be saved", async () => {
  const save = vi
    .fn<Agents["save"]>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Instructions changed elsewhere"))
    .mockResolvedValueOnce();
  const agents = {
    save,
    types: () => [],
  };
  await expect(
    saveFeature(agents, ada(), v1CheckIn, true, { channel: DM }),
  ).rejects.toThrow("Instructions changed elsewhere");
  // The timer first, then the instructions, then the timer taken away again.
  expect(save).toHaveBeenCalledTimes(3);
  expect(save.mock.calls[2]).toEqual([
    ada().key,
    {
      attention: {
        "interest/bestie-hourly-check-in": null,
        "watch/bestie-hourly-check-in": null,
      },
    },
  ]);
  // If that fails too, it says the timer may still be saved.
  save
    .mockReset()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Instructions changed elsewhere"))
    .mockRejectedValueOnce(new Error("Offline"));
  await expect(
    saveFeature(agents, ada(), v1CheckIn, true, { channel: DM }),
  ).rejects.toThrow(
    "Instructions changed elsewhere Its timer may still be saved; remove it below.",
  );
});

function attentionOf({ timer }: typeof notes): Record<string, unknown> {
  return {
    [`interest/${timer?.id}`]: { type: "interest" },
    [`watch/${timer?.id}`]: { type: "timer" },
  };
}
