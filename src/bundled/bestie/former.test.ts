// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentChange, Agents } from "../../features/agents/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { chooseDefaultAgent } from "../../features/solo/default-agent";
import { dream, memory, notes, withFeature } from "./features";
import { v1CheckIn } from "./test-helpers";
import {
  formerWithSettings,
  rememberNewBestie,
  stopFormerCheckIns,
} from "./former";

afterEach(() => localStorage.clear());

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const TIMER = {
  "interest/bestie-hourly-check-in": { value: { type: "interest" } },
  "watch/bestie-hourly-check-in": { value: { type: "timer", channel: DM } },
};
const checkingIn = withFeature(
  withFeature("Be brief.\n", memory, true),
  v1CheckIn,
  true,
);
const agent = (digit: string, instructions = "", attention = {}): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name: digit,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
    attention,
    config: { instructions },
  }) as unknown as Agent;
/** Hourly notes, which has no section of the instructions to leave behind. */
const NOTES = {
  "interest/bestie-notes": { value: { type: "interest" } },
  "watch/bestie-notes": { value: { type: "timer", channel: DM } },
};
const NOTES_OFF = {
  "interest/bestie-notes": null,
  "watch/bestie-notes": null,
};
const DREAM = {
  "interest/bestie-dream": { value: { type: "interest" } },
  "watch/bestie-dream": { value: { type: "timer", channel: DM } },
};
const remembering = withFeature("Be brief.\n", memory, true);
const ada = agent("a", checkingIn, TIMER);
const bea = agent("b");

/** A community whose account read of the saved Bestie waits until `settle`,
 * or `fail`. */
function community(channels: readonly ChannelSummary[] = [], account = true) {
  let settle: (pubkey: string | null | undefined) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const read = new Promise<string | null | undefined>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const write = vi.fn(async (_agent: string | null) => {});
  const session = {
    viewer: OWNER,
    ...(account && { mainAgent: { read: () => read, write } }),
    channels: {
      list: () => ({ channels }),
      subscribeList: () => () => {},
      ensureList: () => {},
    },
  };
  const snapshot = { status: "ready", scope: SCOPE, session };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  return {
    relay,
    write,
    snapshot: snapshot as unknown as RelaySnapshot,
    /** Settles the read with a Bestie, a saved none (null), or no record. */
    settle: async (pubkey: string | null | undefined) => {
      settle(pubkey);
      await read;
      await Promise.resolve();
    },
    fail: async () => {
      fail(new Error("offline"));
      await read.catch(() => {});
      await Promise.resolve();
    },
  };
}

function host(list: Agent[], running: Agent[] = []) {
  let agents = list;
  const listeners = new Set<() => void>();
  const save = vi.fn<Agents["save"]>(async (key, change) => {
    agents = agents.map((each) =>
      each.key !== key
        ? each
        : ({
            ...each,
            ...(change.config !== undefined && { config: change.config }),
            ...(change.attention && {
              attention: Object.fromEntries(
                Object.entries({
                  ...each.attention,
                  ...change.attention,
                }).filter(([, value]) => value),
              ),
            }),
          } as Agent),
    );
    for (const listener of listeners) listener();
  });
  return {
    save,
    /** The agents' listeners are told, with nothing changed. */
    notify: () => {
      for (const listener of listeners) listener();
    },
    agents: {
      save,
      types: () => [{ key: "test/echo", adopt: () => ({}) }],
      snapshot: () => ({ agents, running: [...agents, ...running] }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } as unknown as Pick<Agents, "save" | "types" | "snapshot" | "subscribe">,
  };
}

it("stops a former Bestie's check-ins once the Bestie is known, and leaves its memory", async () => {
  const { relay, settle } = community();
  const { agents, save, notify } = host([ada, bea]);
  const stop = stopFormerCheckIns(relay, agents);
  // While the saved Bestie is being read, nobody is former.
  await Promise.resolve();
  expect(save).not.toHaveBeenCalled();
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-hourly-check-in": null,
          "watch/bestie-hourly-check-in": null,
        },
      },
    ],
    [
      ada.key,
      { config: { instructions: withFeature("Be brief.\n", memory, true) } },
    ],
  ]);
  // Once stopped there is nothing more to do.
  save.mockClear();
  notify();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("stops a former Bestie's Hourly notes and Nightly review, one save each, and leaves its memory", async () => {
  const { relay, settle } = community();
  const cara = agent("c", remembering, { ...NOTES, ...DREAM });
  const { agents, save } = host([cara, bea]);
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls).toEqual([
    [cara.key, { attention: NOTES_OFF }],
    [
      cara.key,
      {
        attention: {
          "interest/bestie-dream": null,
          "watch/bestie-dream": null,
        },
      },
    ],
  ]);
  // No section was there to take out, so its instructions are never saved.
  expect(save.mock.calls.some(([, change]) => change.config)).toBe(false);
  stop();
});

/** Ada, Bestie, with memory and the old hourly check-in on. */
function oldCheckIn(
  instructions = checkingIn,
  attention: Record<string, unknown> = TIMER,
) {
  const { relay, settle } = community();
  const hosted = host([agent("a", instructions, attention), bea]);
  const stop = stopFormerCheckIns(relay, hosted.agents);
  return {
    ...hosted,
    stop,
    run: () => settle(ada.pubkey),
    now: () => hosted.agents.snapshot().agents[0] as Agent,
  };
}

it("replaces the Bestie's old hourly check-in with Hourly notes and Nightly review, in the DM it ran in", async () => {
  const { save, run, now, stop } = oldCheckIn();
  expect(checkingIn).toContain("each private channel you have been added to");
  await run();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const [first, second] = save.mock.calls;
  // One Attention change, the old timer and Interest first, so it saves
  // whole or not at all and the old one's room is free for the new ones.
  expect(first?.[1]).toEqual({
    attention: {
      "interest/bestie-hourly-check-in": null,
      "watch/bestie-hourly-check-in": null,
      "interest/bestie-notes": {
        type: "interest",
        instructions: notes.timer?.interest,
      },
      "watch/bestie-notes": expect.objectContaining({
        type: "timer",
        interest_id: "bestie-notes",
        interval_secs: 3600,
        channel: DM,
        enabled: true,
      }),
      "interest/bestie-dream": {
        type: "interest",
        instructions: dream.timer?.interest,
      },
      "watch/bestie-dream": expect.objectContaining({
        type: "timer",
        interest_id: "bestie-dream",
        interval_secs: 86_400,
        channel: DM,
        enabled: true,
      }),
    },
  });
  expect(Object.keys(first?.[1].attention ?? {}).slice(0, 2)).toEqual([
    "interest/bestie-hourly-check-in",
    "watch/bestie-hourly-check-in",
  ]);
  // Then its section.
  expect(second?.[1]).toEqual({ config: { instructions: remembering } });
  // Memory stays; none of the old steps, with the channel self-add, remain.
  const left = now();
  expect(Object.keys(left.attention).sort()).toEqual([
    "interest/bestie-dream",
    "interest/bestie-notes",
    "watch/bestie-dream",
    "watch/bestie-notes",
  ]);
  const text = (left.config as { instructions: string }).instructions;
  expect(text).not.toContain("Hourly upkeep");
  expect(text).not.toContain("added to");
  // Done: nothing is saved again.
  save.mockClear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("only removes an old hourly check-in that read as off, or that has no memory", async () => {
  // Its section without its timer, and its timer without its section.
  for (const [instructions, attention] of [
    [checkingIn, {}],
    [remembering, TIMER],
    [withFeature("Be brief.\n", v1CheckIn, true), TIMER],
  ] as const) {
    const { save, run, stop } = oldCheckIn(instructions, attention);
    await run();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Nothing new is turned on.
    expect(
      save.mock.calls.some(([, change]) =>
        Object.keys(change.attention ?? {}).some((slug) =>
          /bestie-(notes|dream)$/.test(slug),
        ),
      ),
    ).toBe(false);
    stop();
  }
});

it("keeps the old hourly check-in whole if the new ones can't be saved, and doesn't retry until something changes", async () => {
  const { save, run, now, notify, stop } = oldCheckIn();
  save.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await run();
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1);
  expect(now().attention).toEqual(TIMER);
  expect((now().config as { instructions: string }).instructions).toBe(
    checkingIn,
  );
  notify();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  stop();
  warn.mockRestore();
});

it("swaps only the timers of a Bestie also in another community, whose instructions it shares", async () => {
  const { relay, settle } = community();
  const elsewhere = { ...ada, relay: "wss://other.example" } as Agent;
  const { agents, save } = host([ada, bea], [elsewhere]);
  const stop = stopFormerCheckIns(relay, agents);
  await settle(ada.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  expect(Object.keys(save.mock.calls[0]?.[1].attention ?? {}).sort()).toEqual([
    "interest/bestie-dream",
    "interest/bestie-hourly-check-in",
    "interest/bestie-notes",
    "watch/bestie-dream",
    "watch/bestie-hourly-check-in",
    "watch/bestie-notes",
  ]);
  expect(save.mock.calls.some(([, change]) => change.config)).toBe(false);
  stop();
});

it("stops every agent's check-ins once the account is read to have no Bestie", async () => {
  const none = community();
  const cara = agent("c", checkingIn, TIMER);
  const { agents, save } = host([ada, bea, cara]);
  const stop = stopFormerCheckIns(none.relay, agents);
  // Not while it is read.
  await Promise.resolve();
  expect(save).not.toHaveBeenCalled();
  await none.settle(null);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(4));
  expect(new Set(save.mock.calls.map(([key]) => key))).toEqual(
    new Set([ada.key, cara.key]),
  );
  // Memory stays.
  expect(save).toHaveBeenCalledWith(cara.key, {
    config: { instructions: withFeature("Be brief.\n", memory, true) },
  });
  stop();
});

it("leaves every agent's check-ins alone on an account with no record", async () => {
  const never = community();
  const cara = agent("c", checkingIn, TIMER);
  const { agents, save } = host([ada, cara]);
  const stop = stopFormerCheckIns(never.relay, agents);
  // Nobody ever chose a Bestie here; either agent may be Bestie in another
  // community, which shares its instructions.
  await never.settle(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("keeps the check-ins of an agent made Bestie while the account is read, or while none is stopped", async () => {
  const none = community();
  const cara = agent("c", remembering, NOTES);
  const dara = agent("d");
  const { agents, save } = host([ada, bea, cara, dara]);
  const session = none.relay.snapshot().session as unknown as RelaySession;
  const stop = stopFormerCheckIns(none.relay, agents);
  // Chosen before the read settles: the read's none isn't known.
  void none.settle(null);
  await chooseDefaultAgent(session, SCOPE, cara.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(new Set(save.mock.calls.map(([key]) => key))).toEqual(
    new Set([ada.key]),
  );

  // Chosen as Dara's check-in is about to be stopped.
  save.mockClear();
  void agents.save(dara.key, {
    config: { instructions: remembering },
    attention: NOTES,
  } as unknown as AgentChange);
  await chooseDefaultAgent(session, SCOPE, dara.pubkey);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Only Cara, now former, is stopped; Dara keeps its check-in.
  expect(save.mock.calls).toEqual([
    [dara.key, expect.anything()],
    [cara.key, { attention: NOTES_OFF }],
  ]);

  // Made Bestie again as Cara's check-in is about to be stopped, then not:
  // Cara is stopped once the choice is known.
  save.mockClear();
  // Turned on again, so it is a different timer to the one stopped before.
  void agents.save(cara.key, {
    attention: {
      ...NOTES,
      "watch/bestie-notes": {
        value: { type: "timer", channel: DM, armed_at: 2 },
      },
    },
  } as unknown as AgentChange);
  none.write.mockRejectedValueOnce(new Error("offline"));
  await expect(
    chooseDefaultAgent(session, SCOPE, cara.pubkey),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.map(([key]) => key)).toEqual([cara.key, cara.key]);
  stop();
});

it("does nothing while the saved Bestie is unknown, or to the Bestie itself", async () => {
  const unknown = community();
  const first = host([ada]);
  const stopUnknown = stopFormerCheckIns(unknown.relay, first.agents);
  // A read that failed isn't "none".
  await unknown.fail();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.save).not.toHaveBeenCalled();
  stopUnknown();

  const known = community();
  const current = agent("a", remembering, NOTES);
  const second = host([current]);
  const stopKnown = stopFormerCheckIns(known.relay, second.agents);
  await known.settle(current.pubkey);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(second.save).not.toHaveBeenCalled();
  stopKnown();
});

it("stops a timer left without its section, and doesn't retry a failed save until something changes", async () => {
  const { relay, settle } = community();
  const half = agent("c", "Be brief.", TIMER);
  const { agents, save, notify } = host([half]);
  save.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1);
  // The same state seen again isn't saved again.
  notify();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  stop();
  warn.mockRestore();
});

it("starts no further save once stopped while a timer save is pending", async () => {
  const { relay, settle } = community();
  const { agents, save } = host([ada, bea]);
  let resolve = () => {};
  save.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  stop();
  resolve();
  await new Promise((done) => setTimeout(done, 0));
  // Neither its instructions nor a final pass over the agents.
  expect(save).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

it("turns memory on for a local agent made Bestie here, unless it has it", async () => {
  const { relay } = community();
  const { agents, save } = host([ada, bea]);
  await rememberNewBestie(relay, agents, ada.pubkey);
  expect(save).not.toHaveBeenCalled();
  await rememberNewBestie(relay, agents, bea.pubkey);
  expect(save).toHaveBeenCalledWith(bea.key, {
    config: { instructions: withFeature("", memory, true) },
  });
  // A remote agent, or one in another community, is left alone.
  save.mockClear();
  await rememberNewBestie(relay, agents, "9".repeat(64));
  expect(save).not.toHaveBeenCalled();
  // Nor is one whose section was edited by hand: no second section.
  const edited = host([
    {
      ...bea,
      config: {
        instructions: withFeature("", memory, true).replace(
          "<!-- /buzz:bestie/memory -->",
          "",
        ),
      },
    } as Agent,
  ]);
  await rememberNewBestie(relay, edited.agents, bea.pubkey);
  expect(edited.save).not.toHaveBeenCalled();
});

it("turns memory on for no remote agent made Bestie, as its instructions aren't here", async () => {
  const { relay } = community();
  const hosted = { ...bea, place: "hosted" } as Agent;
  const elsewhere = { ...agent("c"), place: "elsewhere" } as Agent;
  const { agents, save } = host([hosted, elsewhere]);
  await rememberNewBestie(relay, agents, hosted.pubkey);
  await rememberNewBestie(relay, agents, elsewhere.pubkey);
  expect(save).not.toHaveBeenCalled();
});

it("stops a local former Bestie's check-ins when a remote agent is Bestie, and leaves the remote one alone", async () => {
  const { relay, settle } = community();
  const remote = { ...agent("c", checkingIn, TIMER), place: "hosted" } as Agent;
  const sky = { ...agent("d"), place: "elsewhere" } as Agent;
  const { agents, save } = host([ada, remote, sky]);
  const stop = stopFormerCheckIns(relay, agents);
  await settle(sky.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  // Only Ada, on this device, is stopped; the remote agent's timers are its
  // own.
  expect(save.mock.calls.map(([key]) => key)).toEqual([ada.key, ada.key]);
  stop();
});

it("counts a former Bestie as on while it has a section, or a private channel once seen as Bestie", async () => {
  const channel = {
    id: "c1",
    name: "plans",
    channelType: "stream",
    private: true,
    members: [OWNER, bea.pubkey],
  } as unknown as ChannelSummary;
  const { relay, snapshot, settle } = community([channel]);
  const { agents } = host([ada, bea]);
  expect(formerWithSettings(ada, snapshot)).toBe(true);
  // Any agent in a private channel isn't a former Bestie...
  expect(formerWithSettings(bea, snapshot)).toBe(false);
  // ...but one this device saw as Bestie is, once another one is.
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  expect(formerWithSettings(bea, snapshot)).toBe(true);
  expect(
    formerWithSettings({ ...bea, pubkey: "d".repeat(64) } as Agent, snapshot),
  ).toBe(false);
  stop();
});

it("leaves a Bestie kept only on this device alone, as an automatic pick looks the same", async () => {
  const { relay } = community([], false);
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([SCOPE, "solo:default-agent"])}`,
    JSON.stringify(bea.pubkey),
  );
  const { agents, save } = host([ada, bea]);
  const stop = stopFormerCheckIns(relay, agents);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("stops only the timer of an agent also in another community, whose instructions it shares", async () => {
  const { relay, settle } = community();
  const elsewhere = { ...ada, relay: "wss://other.example" } as Agent;
  const { agents, save } = host([ada, bea], [elsewhere]);
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-hourly-check-in": null,
          "watch/bestie-hourly-check-in": null,
        },
      },
    ],
  ]);
  stop();
});
