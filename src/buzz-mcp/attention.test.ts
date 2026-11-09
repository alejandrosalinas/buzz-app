import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkedWrite,
  interestIds,
  show,
  watchSummaries,
} from "../features/agents/attention-objects";
import type { AgentAttention } from "../features/agents/service";
import type { AgentRecord } from "../features/agents/store";
import { ATTENTION_TOOLS } from "./attention";
import type { BuzzClient } from "./client";
import { BUZZ_PROMPT } from "./prompt";
import { respond } from "./rpc";
import { turnNote } from "./session-tools";
import { PLUGIN_TOOLS } from "./plugins";
import { SETTINGS_TOOLS } from "./settings";
import { SOLO_WORKER_TOOLS } from "./solo-worker";
import { TOOLS } from "./tools";

const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const NOW = 10_000;

/** An agent's attention over one in-memory record, as the service builds it. */
function agent(options: { classifier?: boolean; enabled?: boolean } = {}) {
  let record: AgentRecord = {
    pubkey: "a".repeat(64),
    attention: {},
    config: {},
  };
  const now = () => Math.floor(Date.now() / 1000);
  let enabled = options.enabled ?? true;
  const api: AgentAttention = {
    enabled: () => enabled,
    classifier: () => (options.classifier ? "available" : "unavailable"),
    show: (slug, interest) => show(record, slug, now(), interest),
    interests: (search) => interestIds(record, search),
    watches: (filter = {}) => watchSummaries(record, filter, now()),
    write: async (slug, value, write) => {
      record = await checkedWrite(record, slug, value, write, now());
      return show(record, slug, now());
    },
  };
  let id = 0;
  // The attention tools need nothing else of the client.
  const client = { attention: api } as unknown as BuzzClient;
  /** Calls tool `name` through the RPC, as Claude does. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = (await respond(
      client,
      {},
      { id: ++id, method: "tools/call", params: { name, arguments: args } },
    )) as { result: { content: { text: string }[]; isError?: true } };
    const text = answer.result.content[0]?.text ?? "";
    if (answer.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  /** Counts a timer run, as the service does when it delivers one. */
  const ran = (slug: string, at: number, interval: number) => {
    const state = record.timers?.[slug];
    if (!state) throw new Error(`No timer state for ${slug}`);
    record = {
      ...record,
      timers: {
        ...record.timers,
        [slug]: { ...state, used: state.used + 1, nextDue: at + interval },
      },
    };
  };
  /** The owner turns attention off, as the session runs. */
  const turnOff = () => {
    enabled = false;
  };
  return { api, call, ran, turnOff };
}

const ABSENT = "object-v1:absent";
const asks = {
  interest: "triage",
  id: "asks",
  type: "event",
  since: 1,
  channels: [channel],
  kinds: [9],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

describe("the tool list", () => {
  const list = (client?: BuzzClient) =>
    respond(client, {}, { id: 1, method: "tools/list" }).then((answer) =>
      (
        (answer as { result: { tools: { name: string }[] } }).result.tools ?? []
      ).map((tool) => tool.name),
    );

  it("always offers the attention tools with their guidance, and says each turn whether attention is on", async () => {
    // One list whatever the setting, so turning attention on or off never
    // replaces a session or its cached prompt prefix.
    const names = [
      ...TOOLS,
      ...ATTENTION_TOOLS,
      ...SOLO_WORKER_TOOLS,
      ...PLUGIN_TOOLS,
    ].map((tool) => tool.name);
    // Clients without settings don't list their tools; no client lists all.
    expect(await list()).toEqual([
      ...names,
      ...SETTINGS_TOOLS.map((tool) => tool.name),
    ]);
    for (const enabled of [true, false])
      expect(
        await list({
          attention: agent({ enabled }).api,
        } as unknown as BuzzClient),
      ).toEqual(names);
    // How to use them is in their descriptions, loaded with the tools.
    expect(BUZZ_PROMPT).not.toContain("## Attention");
    expect(
      ATTENTION_TOOLS.find((tool) => tool.name === "watch_add")?.description,
    ).toContain("Jev tests relevance");
    // With no Interests there is nothing to review, so the turn need not
    // load the attention tools to find that out.
    const { api, call } = agent();
    expect(turnNote({ attention: api })).toMatch(
      /^<attention>\nYou have no Interests/,
    );
    await call("interest_set", {
      id: "triage",
      instructions: "Triage asks.",
      expected_state: ABSENT,
    });
    expect(turnNote({ attention: api })).toMatch(
      /^<attention>\nHandle the work/,
    );
    expect(turnNote({ attention: agent({ enabled: false }).api })).toMatch(
      /^<attention>\nAttention is off on this device/,
    );
    // A client whose host keeps no attention gets no note.
    expect(turnNote({})).toBeUndefined();
  });

  it("has Janet's verbs, and always has the classifier fields", () => {
    expect(ATTENTION_TOOLS.map((tool) => tool.name)).toEqual([
      "interest_set",
      "interest_show",
      "interest_list",
      "interest_remove",
      "watch_add",
      "watch_update",
      "watch_enable",
      "watch_disable",
      "watch_remove",
      "watch_rearm",
      "watch_show",
      "watch_list",
    ]);
    for (const name of ["watch_add", "watch_update"])
      expect(
        ATTENTION_TOOLS.find((tool) => tool.name === name)?.inputSchema
          .properties,
      ).toHaveProperty("classifier");
  });

  it("refuses an attention call for a client whose host keeps no attention", async () => {
    const answer = (await respond(
      {} as BuzzClient,
      {},
      { id: 1, method: "tools/call", params: { name: "interest_list" } },
    )) as { result: { isError?: true; content: { text: string }[] } };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toMatch(/No tool interest_list/);
  });
});

describe("the attention tools", () => {
  it("creates, shows and replaces an Interest with expected-state tokens", async () => {
    const { call, api } = agent();
    const created = await call("interest_set", {
      id: "triage",
      instructions: "Triage asks.",
      expected_state: ABSENT,
    });
    expect(created).toMatchObject({
      classifier: "unavailable",
      result: "found",
      object: { id: "triage", instructions: "Triage asks." },
    });
    await expect(
      call("interest_set", {
        id: "triage",
        instructions: "Stale.",
        expected_state: ABSENT,
      }),
    ).rejects.toThrow(/^conflict:[\s\S]*\(classifier: unavailable\)$/);
    const shown = await call("interest_show", { id: "triage" });
    expect(shown.expected_state).toBe(created.expected_state);
    const paused = await api.write(
      "interest/triage",
      { type: "interest", instructions: "Triage asks.", paused: true },
      { expected: shown.expected_state },
    );
    await call("interest_set", {
      id: "triage",
      instructions: "Triage every ask.",
      expected_state: paused.expected_state,
    });
    expect(
      (await call("interest_show", { id: "triage" })).object,
    ).toMatchObject({ paused: true, instructions: "Triage every ask." });
    expect(await call("interest_list")).toEqual({
      classifier: "unavailable",
      interests: ["triage"],
    });
  });

  it("saves an Interest's title and summary, and a replacement without them clears them", async () => {
    const { call } = agent();
    const created = await call("interest_set", {
      id: "release",
      title: " Release checks ",
      summary: "Wakes when CI finishes and reports failures.",
      instructions: "Check the release.",
      expected_state: ABSENT,
    });
    expect(created.object).toEqual(
      expect.objectContaining({
        title: "Release checks",
        summary: "Wakes when CI finishes and reports failures.",
      }),
    );
    const replaced = await call("interest_set", {
      id: "release",
      title: "",
      instructions: "Check the release.",
      expected_state: created.expected_state,
    });
    expect(replaced.object).not.toHaveProperty("title");
    expect(replaced.object).not.toHaveProperty("summary");
  });

  it("keeps an Interest until its watches are gone", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    await call("watch_add", { ...asks, expected_state: ABSENT });
    const interest = await call("interest_show", { id: "triage" });
    await expect(
      call("interest_remove", {
        id: "triage",
        expected_state: interest.expected_state,
      }),
    ).rejects.toThrow(/watches/);
    const watch = await call("watch_show", { id: "asks" });
    await call("watch_remove", {
      id: "asks",
      expected_state: watch.expected_state,
    });
    await call("interest_remove", {
      id: "triage",
      expected_state: interest.expected_state,
    });
    expect((await call("interest_list")).interests).toEqual([]);
  });

  it("scopes watch writes to the Interest the agent works for", async () => {
    const { call } = agent();
    for (const id of ["triage", "other"])
      await call("interest_set", {
        id,
        instructions: id,
        expected_state: ABSENT,
      });
    await call("watch_add", { ...asks, expected_state: ABSENT });
    const watch = await call("watch_show", { id: "asks" });
    await expect(
      call("watch_disable", {
        id: "asks",
        interest: "other",
        expected_state: watch.expected_state,
      }),
    ).rejects.toThrow(/^wrong-scope:/);
  });

  it("changes only the fields given, and clears optional ones", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", {
      ...asks,
      name: "Asks",
      is_reply: false,
      expected_state: ABSENT,
    });
    const updated = await call("watch_update", {
      id: "asks",
      kinds: [9, 40002],
      clear: ["is_reply"],
      expected_state: added.expected_state,
    });
    expect(updated.object).toEqual({
      id: "asks",
      type: "event",
      interest_id: "triage",
      name: "Asks",
      enabled: true,
      status: "enabled",
      since: 1,
      channels: [channel],
      kinds: [9, 40002],
    });
    await expect(
      call("watch_update", {
        id: "asks",
        prompt: "no",
        expected_state: updated.expected_state,
      }),
    ).rejects.toThrow(/^invalid: Not a field of this watch type: prompt/);
  });

  it("refuses the removed keywords selector instead of dropping it", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    await expect(
      call("watch_add", {
        ...asks,
        keywords: ["failed"],
        expected_state: ABSENT,
      }),
    ).rejects.toThrow(/^invalid: keywords was removed from watches/);
    expect((await call("watch_show", { id: "asks" })).object).toBeNull();
    const added = await call("watch_add", {
      ...asks,
      enabled: false,
      expected_state: ABSENT,
    });
    await expect(
      call("watch_update", {
        id: "asks",
        enabled: true,
        keywords: ["failed"],
        expected_state: added.expected_state,
      }),
    ).rejects.toThrow(/^invalid: keywords was removed from watches/);
    expect((await call("watch_show", { id: "asks" })).object).toMatchObject({
      enabled: false,
    });
  });

  it("requires since for an event watch", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const { since: _, ...noSince } = asks;
    await expect(
      call("watch_add", { ...noSince, expected_state: ABSENT }),
    ).rejects.toThrow(/since/);
    const now = await call("watch_add", {
      ...asks,
      since: "now",
      expected_state: ABSENT,
    });
    expect(now.object.since).toBe(NOW);
  });

  it("runs a timer once by default, lists it as spent, and rearms only with room", async () => {
    const { call, ran } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", {
      interest: "triage",
      id: "nudge",
      type: "timer",
      prompt: "Check the queue.",
      interval_secs: 60,
      expected_state: ABSENT,
    });
    expect(added.object).toMatchObject({
      max_occurrences: 1,
      armed_at: NOW,
      status: "armed",
      used: 0,
      next_due: NOW + 60,
    });
    vi.setSystemTime((NOW + 61) * 1000);
    ran("watch/nudge", NOW + 61, 60);
    expect((await call("watch_list", { status: "spent" })).watches).toEqual([
      { id: "nudge", interest_id: "triage", type: "timer", status: "spent" },
    ]);
    const spent = await call("watch_show", { id: "nudge" });
    await expect(
      call("watch_rearm", {
        id: "nudge",
        expected_state: spent.expected_state,
      }),
    ).rejects.toThrow(/spent/);
    const rearmed = await call("watch_rearm", {
      id: "nudge",
      max_occurrences: 3,
      expected_state: spent.expected_state,
    });
    expect(rearmed.object).toMatchObject({
      armed_at: NOW + 61,
      max_occurrences: 3,
      status: "armed",
      used: 1,
      next_due: NOW + 121,
    });
  });

  it("accepts a timer budget and an event start sent as digits", async () => {
    // Some MCP clients send an integer that shares its schema with a word as a string.
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const timer = await call("watch_add", {
      interest: "triage",
      id: "nudge",
      type: "timer",
      prompt: "Check the queue.",
      interval_secs: 60,
      max_occurrences: "3",
      expires_at: String(NOW + 600),
      expected_state: ABSENT,
    });
    expect(timer.object).toMatchObject({
      max_occurrences: 3,
      expires_at: NOW + 600,
    });
    const event = await call("watch_add", {
      ...asks,
      since: String(NOW),
      expected_state: ABSENT,
    });
    expect(event.object.since).toBe(NOW);
  });

  it("filters the watch list by type, status and search", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    await call("watch_add", { ...asks, name: "Asks", expected_state: ABSENT });
    await call("watch_add", {
      ...asks,
      id: "quiet",
      enabled: false,
      expected_state: ABSENT,
    });
    const ids = async (args: Record<string, unknown>) =>
      (await call("watch_list", args)).watches.map((w: { id: string }) => w.id);
    expect(await ids({})).toEqual(["asks", "quiet"]);
    expect(await ids({ status: "disabled" })).toEqual(["quiet"]);
    expect(await ids({ type: "timer" })).toEqual([]);
    expect(await ids({ search: "Ask" })).toEqual(["asks"]);
  });

  it("refuses every call once the owner turns attention off", async () => {
    const { call, turnOff } = agent();
    await call("interest_list");
    turnOff();
    await expect(call("interest_list")).rejects.toThrow(
      /Attention is off[\s\S]*\(classifier: unavailable\)/,
    );
  });

  it("never replaces a watch on add", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", {
      ...asks,
      name: "Asks",
      is_reply: false,
      expected_state: ABSENT,
    });
    for (const expected_state of [added.expected_state, ABSENT])
      await expect(
        call("watch_add", { ...asks, expected_state }),
      ).rejects.toThrow(
        /^invalid-operation: watch asks exists; use watch_update/,
      );
    expect((await call("watch_show", { id: "asks" })).object).toMatchObject({
      name: "Asks",
      is_reply: false,
    });
  });

  it("turns an event watch off and on, and refuses missing or stale watches", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", { ...asks, expected_state: ABSENT });
    const off = await call("watch_disable", {
      id: "asks",
      expected_state: added.expected_state,
    });
    expect(off.object).toMatchObject({ enabled: false, status: "disabled" });
    await expect(
      call("watch_enable", {
        id: "asks",
        expected_state: added.expected_state,
      }),
    ).rejects.toThrow(/^conflict:/);
    const on = await call("watch_enable", {
      id: "asks",
      expected_state: off.expected_state,
    });
    expect(on.object).toMatchObject({ enabled: true, status: "enabled" });
    for (const name of ["watch_enable", "watch_update", "watch_rearm"])
      await expect(
        call(name, { id: "none", expected_state: ABSENT }),
      ).rejects.toThrow(/^not-found:/);
    await expect(call("watch_update", { id: "asks" })).rejects.toThrow(
      /^invalid-operation: every write needs the expected_state/,
    );
  });

  it("turns a timer on only by rearming it, never from the past", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", {
      interest: "triage",
      id: "nudge",
      type: "timer",
      prompt: "Check.",
      interval_secs: 3600,
      max_occurrences: 5,
      expected_state: ABSENT,
    });
    const off = await call("watch_disable", {
      id: "nudge",
      expected_state: added.expected_state,
    });
    expect(off.object).toMatchObject({ status: "inactive", used: 0 });
    await expect(
      call("watch_enable", { id: "nudge", expected_state: off.expected_state }),
    ).rejects.toThrow(/^invalid-operation: use watch_rearm/);
    await expect(
      call("watch_update", {
        id: "nudge",
        enabled: true,
        expected_state: off.expected_state,
      }),
    ).rejects.toThrow(/^invalid-operation: use watch_rearm/);
    await expect(
      call("watch_rearm", {
        id: "nudge",
        at: NOW - 1,
        expected_state: off.expected_state,
      }),
    ).rejects.toThrow(/^invalid: at must be/);
    // Ten hours later, nothing was spent while it was off.
    vi.setSystemTime((NOW + 36_000) * 1000);
    const rearmed = await call("watch_rearm", {
      id: "nudge",
      expected_state: off.expected_state,
    });
    expect(rearmed.object).toMatchObject({
      enabled: true,
      status: "armed",
      used: 0,
      next_due: NOW + 36_000 + 3600,
    });
  });

  it("sets a new deadline on every rearm, even in the second it was armed", async () => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const added = await call("watch_add", {
      interest: "triage",
      id: "nudge",
      type: "timer",
      prompt: "Check.",
      interval_secs: 3600,
      max_occurrences: 5,
      expected_state: ABSENT,
    });
    expect(added.object).toMatchObject({ next_due: NOW + 3600 });
    const rearmed = await call("watch_rearm", {
      id: "nudge",
      interval_secs: 60,
      expected_state: added.expected_state,
    });
    expect(rearmed.object).toMatchObject({
      armed_at: NOW,
      used: 0,
      next_due: NOW + 60,
    });
  });
});

describe("a classifier", () => {
  const classifier = {
    questions: { ask: { question: "Is this a request for help?" } },
  };
  const setup = async (available: boolean) => {
    const { call } = agent({ classifier: available });
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    return call;
  };

  it.each(["event", "source"])(
    "saves a %s classifier without a key and reports it consistently",
    async (type) => {
      const call = await setup(false);
      const added = await call("watch_add", {
        ...(type === "event"
          ? asks
          : {
              id: "asks",
              type,
              interest: "triage",
              provider: "example/command",
              config: {},
            }),
        classifier,
        expected_state: ABSENT,
      });
      expect(added).toMatchObject({
        classifier: "unavailable",
        classifier_note: expect.stringMatching(
          /once a classifier is available/,
        ),
        object: { classifier },
      });
      expect(
        (await call("watch_show", { id: "asks" })).classifier_note,
      ).toMatch(/pass unchecked/);
      expect((await call("watch_list")).watches).toEqual([
        {
          id: "asks",
          interest_id: "triage",
          type,
          status: "enabled",
          classified: true,
          classifier: "unavailable",
        },
      ]);
      const cleared = await call("watch_update", {
        id: "asks",
        clear: ["classifier"],
        expected_state: added.expected_state,
      });
      expect(cleared).not.toHaveProperty("classifier_note");
      expect(cleared.object).not.toHaveProperty("classifier");
    },
  );

  it("carries no warning when a classifier can run", async () => {
    const call = await setup(true);
    const added = await call("watch_add", {
      ...asks,
      classifier,
      expected_state: ABSENT,
    });
    expect(added.classifier).toBe("available");
    expect(added).not.toHaveProperty("classifier_note");
    expect((await call("watch_list")).watches[0]).not.toHaveProperty(
      "classifier",
    );
  });
});

it("creates and updates plugin-owned source configuration", async () => {
  const { call } = agent();
  await call("interest_set", {
    id: "triage",
    instructions: "Watch",
    expected_state: ABSENT,
  });
  const added = await call("watch_add", {
    interest: "triage",
    id: "source",
    type: "source",
    provider: "example/check",
    config: { url: "example" },
    channel,
    expected_state: ABSENT,
  });
  expect(added.object).toMatchObject({
    type: "source",
    provider: "example/check",
    config: { url: "example" },
    channel,
  });
  const updated = await call("watch_update", {
    id: "source",
    config: { url: "changed" },
    root: "e".repeat(64),
    expected_state: added.expected_state,
  });
  expect(updated.object).toMatchObject({
    config: { url: "changed" },
    root: "e".repeat(64),
  });
  await expect(
    call("watch_update", {
      id: "source",
      prompt: "timer only",
      expected_state: updated.expected_state,
    }),
  ).rejects.toThrow(/Not a field/);
});

it.each(["event", "timer", "source"])(
  "sets and clears %s delivery without changing its trigger",
  async (type) => {
    const { call } = agent();
    await call("interest_set", {
      id: "triage",
      instructions: "T.",
      expected_state: ABSENT,
    });
    const root = "e".repeat(64);
    const fields =
      type === "event"
        ? { since: 1, channels: [channel] }
        : type === "timer"
          ? { prompt: "tick", interval_secs: 60 }
          : { provider: "example/check", config: { key: "value" } };
    let saved = await call("watch_add", {
      interest: "triage",
      id: "delivery",
      type,
      expected_state: ABSENT,
      ...fields,
      channel,
      root,
    });
    const storedFields = fields;
    expect(saved.object).toMatchObject({ ...storedFields, channel, root });
    await expect(
      call("watch_update", {
        id: "delivery",
        expected_state: saved.expected_state,
        clear: ["channel"],
      }),
    ).rejects.toThrow(/requires a channel/);
    saved = await call("watch_update", {
      id: "delivery",
      expected_state: saved.expected_state,
      clear: ["channel", "root"],
    });
    expect(saved.object.channel).toBeUndefined();
    expect(saved.object.root).toBeUndefined();
    expect(saved.object).toMatchObject(storedFields);
  },
);
