import { describe, expect, it, vi } from "vitest";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { fromOwner } from "../agents/owner-attestation";
import type { AgentHandle, Delivery } from "../agents/service";
import { eventDto, type EventData, type RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { keypair, signed } from "../relay/testing";
import { harnessKit } from "./kit";

const self = "c".repeat(64);
const alice = "a".repeat(64);
const mallory = "f".repeat(64);
const channel = "chan-1";
const workflowKey = keypair();

const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;
const reply = (id: string, root: string, content: string, pubkey = alice) =>
  message(id, content, {
    pubkey,
    tags: [
      ["h", channel],
      ["e", root.repeat(64).slice(0, 64), "", "reply"],
    ],
  });

function setup(
  options: Readonly<{
    type?: "stream" | "dm" | "solo";
    name?: string;
    thread?: readonly EventData[];
    core?: string | null;
    notes?: readonly string[];
  }> = {},
) {
  const read = vi.fn(
    async (filters: readonly { ids?: string[]; "#e"?: string[] }[]) => {
      const root = filters[0]?.ids?.[0];
      return (options.thread ?? []).filter(
        (event) =>
          !root ||
          event.id === root ||
          event.tags.some((tag) => tag[0] === "e" && tag[1] === root),
      );
    },
  );
  const session = {
    read,
    channels: {
      list: () => ({
        status: "ready",
        channels: [
          {
            id: channel,
            ...(options.name === "" ? {} : { name: options.name ?? "general" }),
            channelType: options.type ?? "stream",
            members: [],
          },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
    channelWrites: { startingCanvas: () => undefined },
    canvas: { available: false, read: vi.fn(async () => null) },
    agentMemories: { open: vi.fn() },
    workflowAuthority: workflowKey.pubkey,
  };
  const relay = {
    snapshot: () => ({
      status: "ready",
      session,
      viewer: alice,
      scope: `https://kit.example:${alice}`,
    }),
  } as unknown as RelayData;
  const kit = harnessKit({
    relay: () => relay,
    core: async () => options.core,
    added: () => [],
    repositories: (partition) => `<repos for="${partition}"/>`,
  });
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const restored: unknown[][] = [];
  const agent = {
    key: self,
    pubkey: self,
    name: "Ampy",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return template;
    }),
    query: vi.fn(async () => []),
    notes: vi.fn(() => [...(options.notes ?? [])]),
    restoreNotes: vi.fn((...args: unknown[]) => void restored.push(args)),
  } as unknown as AgentHandle;
  const delivery = (
    trigger: Delivery["trigger"],
    extra: Partial<Delivery> = {},
  ) =>
    ({
      trigger,
      channelId: channel,
      agent,
      config: {},
      signal: new AbortController().signal,
      workingUntil: () => undefined,
      current: () => true,
      ...extra,
    }) as unknown as Delivery;
  return { kit, agent, delivery, published, restored, read };
}

describe("harnessKit.conversation", () => {
  it("admits the owner's mention, keyed by its thread", async () => {
    const { kit, delivery } = setup();
    const event = reply("2", "1", "@Ampy go");
    expect(
      await kit.conversation(delivery({ type: "mention", event }), "thread"),
    ).toEqual({
      key: `${channel}/${"1".repeat(64)}`,
      channel,
      root: "1".repeat(64),
      topLevel: false,
      where: "#general",
    });
  });

  it("gives a top-level mention its own thread, or the channel when scoped so", async () => {
    const { kit, delivery } = setup();
    const event = message("3", "@Ampy go");
    const trigger = { type: "mention", event } as const;
    expect((await kit.conversation(delivery(trigger), "thread"))?.key).toBe(
      `${channel}/${event.id}`,
    );
    const whole = await kit.conversation(delivery(trigger), "channel");
    expect(whole).toMatchObject({ key: channel, topLevel: false });
    expect(whole?.root).toBeUndefined();
  });

  it("keeps a DM one conversation, and a Solo chat one at the top level", async () => {
    const event = reply("2", "1", "go");
    const dm = setup({ type: "dm", name: "" });
    expect(
      await dm.kit.conversation(
        dm.delivery({ type: "mention", event }),
        "thread",
      ),
    ).toMatchObject({ key: channel, topLevel: false, where: "DM" });
    const solo = setup({ type: "solo" });
    expect(
      await solo.kit.conversation(
        solo.delivery({ type: "mention", event }),
        "thread",
      ),
    ).toMatchObject({ key: channel, topLevel: true });
  });

  it("refuses a mention from anyone else, and triggers that are not its", async () => {
    const { kit, delivery } = setup();
    const event = message("2", "@Ampy rm -rf", { pubkey: mallory });
    expect(
      await kit.conversation(delivery({ type: "mention", event }), "thread"),
    ).toBeUndefined();
    // A relay workflow mention the bundled harnesses would run: signed by
    // the community's workflow key, owned by the owner, aimed at this agent.
    const workflow = eventDto(
      signed(workflowKey, {
        kind: 9,
        content: "@Ampy go",
        tags: [
          ["h", channel],
          ["p", self],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", alice],
          ["buzz:workflow-mention", self],
        ],
      }),
    );
    expect(
      await fromOwner(workflow, alice, {
        agent: self,
        authority: workflowKey.pubkey,
      }),
    ).toBe(true);
    expect(
      await kit.conversation(
        delivery({ type: "mention", event: workflow }),
        "thread",
      ),
    ).toBeUndefined();
    // A workflow marker does not revoke the owner's own mention.
    const marked = message("3", "@Ampy go", {
      tags: [
        ["h", channel],
        ["p", self],
        ["buzz:workflow", "true"],
      ],
    });
    expect(
      await kit.conversation(
        delivery({ type: "mention", event: marked }),
        "thread",
      ),
    ).toBeDefined();
    expect(
      await kit.conversation(
        delivery({
          type: "timer",
          slug: "t",
          timer: {} as never,
          spent: false,
        }),
        "thread",
      ),
    ).toBeUndefined();
  });

  it("takes a plugin's wake in its thread, and drops one with nowhere to go", async () => {
    const { kit, delivery } = setup();
    const wake = {
      type: "plugin",
      plugin: "example",
      channel,
      text: "CI passed",
      id: "w".repeat(64),
      at: 200_000,
    } as const;
    expect(
      await kit.conversation(
        delivery({ ...wake, root: "1".repeat(64) }),
        "thread",
      ),
    ).toMatchObject({ key: `${channel}/${"1".repeat(64)}`, topLevel: false });
    expect(await kit.conversation(delivery(wake), "thread")).toBeUndefined();
  });
});

describe("harnessKit.turnPrompt", () => {
  it("shows what the session has not seen, takes notes and restores them", async () => {
    const root = message("1", "Kick off");
    const earlier = reply("2", "1", "Some context");
    const mine = reply("3", "1", "On it", self);
    const event = reply("4", "1", "@Ampy and now?");
    const { kit, delivery, restored } = setup({
      thread: [root, earlier, mine, event],
      notes: ["<note>from a plugin</note>"],
    });
    const d = delivery({ type: "mention", event });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");

    const fresh = await kit.turnPrompt(d, conversation);
    expect(fresh.text).toContain("Kick off");
    expect(fresh.text).toContain("Some context");
    expect(fresh.text).toContain("On it");
    expect(fresh.text).toContain("@Ampy and now?");
    expect(fresh.text).toContain("<note>from a plugin</note>");
    expect(JSON.parse(fresh.cursor)).toEqual({ seen: event.created_at });

    const cursor = JSON.stringify({ seen: earlier.created_at });
    const later = await kit.turnPrompt(d, conversation, { cursor });
    expect(later.text).not.toContain("Some context");
    expect(later.text).not.toContain("On it");
    expect(later.text).toContain("@Ampy and now?");

    later.restore();
    expect(restored).toEqual([
      [channel, ["<note>from a plugin</note>"], "1".repeat(64)],
    ]);
    const again = await kit.turnPrompt(d, conversation, { cursor });
    expect(again.text).toBe(later.text);
  });

  it("ends the prompt with its conversation's instructions, keyed as its notes are", async () => {
    const root = message("1", "Kick off");
    const event = reply("4", "1", "@Ampy and now?");
    const { kit, agent, delivery } = setup({ thread: [root, event] });
    const conversationInstructions = vi.fn(() => ({
      plugin: "acme.tasks",
      text: "Review only.",
    }));
    Object.assign(agent, { conversationInstructions });
    const d = delivery({ type: "mention", event });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    const { text } = await kit.turnPrompt(d, conversation);
    expect(text).toMatch(
      /<owner-instructions source="acme\.tasks">\n[\s\S]*\n\nReview only\.\n<\/owner-instructions>$/,
    );
    expect(conversationInstructions).toHaveBeenCalledWith(
      channel,
      "1".repeat(64),
    );
  });

  it("keeps a mark for each thread of a channel conversation", async () => {
    const rootA = message("1", "Thread A");
    const rootB = message("2", "Thread B");
    const contextB = reply("3", "2", "Context in B");
    const mentionA = reply("7", "1", "@Ampy in A");
    const mentionB = reply("8", "2", "@Ampy in B");
    const laterB = reply("9", "2", "@Ampy again in B");
    const { kit, delivery } = setup({
      thread: [rootA, rootB, contextB, mentionA, mentionB, laterB],
    });
    const turn = async (event: RelayEvent, cursor?: string) => {
      const d = delivery({ type: "mention", event });
      const conversation = await kit.conversation(d, "channel");
      if (!conversation) throw new Error("not admitted");
      expect(conversation.key).toBe(channel);
      return kit.turnPrompt(d, conversation, cursor ? { cursor } : {});
    };

    const a = await turn(mentionA);
    expect(a.text).toContain("Thread A");
    const b = await turn(mentionB, a.cursor);
    expect(b.text).toContain("Thread B");
    expect(b.text).toContain("Context in B");
    const again = await turn(laterB, b.cursor);
    expect(again.text).not.toContain("Context in B");
    expect(again.text).toContain("@Ampy again in B");
  });

  it("starts over from a cursor it cannot read", async () => {
    const event = reply("2", "1", "@Ampy go");
    const earlier = reply("1", "1", "Earlier");
    const { kit, delivery } = setup({ thread: [earlier, event] });
    const d = delivery({ type: "mention", event });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    expect(
      (await kit.turnPrompt(d, conversation, { cursor: "{nope" })).text,
    ).toContain("Earlier");
  });

  it("tells a resumed turn to carry on", async () => {
    const event = reply("2", "1", "@Ampy go");
    const { kit, delivery } = setup({ thread: [event] });
    const d = delivery({ type: "mention", event, resumed: true });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    expect(
      (
        await kit.turnPrompt(d, conversation, {
          cursor: JSON.stringify({ seen: 150 }),
        })
      ).text,
    ).toContain(RESUMED_PROMPT);
  });

  it("rejects a conversation it did not admit", async () => {
    const { kit, delivery } = setup();
    await expect(
      kit.turnPrompt(delivery({ type: "mention", event: message("1", "x") }), {
        key: channel,
        channel,
        topLevel: false,
        where: "#general",
      }),
    ).rejects.toThrow("not admitted");
  });
});

describe("harnessKit.systemPrompt", () => {
  it("gives the agent its instructions, team and core memory", async () => {
    const { kit, delivery } = setup({ core: "Remember the milk." });
    const text = await kit.systemPrompt(
      delivery(
        { type: "mention", event: message("1", "x") },
        { team: "<team>Squad</team>" },
      ),
      { scope: "thread", cwd: "~/work", instructions: "Be terse." },
    );
    expect(text).toContain("Be terse.");
    expect(text).toContain("<team>Squad</team>");
    expect(text).toContain("Remember the milk.");
    expect(text).toContain("~/work");
    expect(text).toContain(`<repos for="https://kit.example:${alice}"/>`);
    expect(text).not.toContain("<buzz-tools-unavailable>");
  });

  it("tells a session without tools that its final message is its reply", async () => {
    const { kit, delivery } = setup();
    const text = await kit.systemPrompt(
      delivery({ type: "mention", event: message("1", "x") }),
      { scope: "thread", cwd: "~", instructions: "", tools: false },
    );
    expect(text).toMatch(
      /<buzz-tools-unavailable>[\s\S]*final message is posted as your reply/,
    );
  });
});

describe("harnessKit.reply", () => {
  it("replies in the thread, tagging the owner when asked", async () => {
    const { kit, delivery, published } = setup();
    const event = reply("2", "1", "@Ampy go");
    const d = delivery({ type: "mention", event });
    const conversation = await kit.conversation(d, "channel");
    if (!conversation) throw new Error("not admitted");
    await kit.reply(d.agent, conversation, "⚠️ failed", { notifyOwner: true });
    expect(published).toEqual([
      {
        kind: 9,
        content: "⚠️ failed",
        tags: [
          ["h", channel],
          ["e", "1".repeat(64), "", "reply"],
          ["p", alice],
        ],
      },
    ]);
  });

  it("posts at a Solo chat's top level", async () => {
    const { kit, delivery, published } = setup({ type: "solo" });
    const event = reply("2", "1", "go");
    const d = delivery({ type: "mention", event });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    await kit.reply(d.agent, conversation, "Done");
    expect(published[0]?.tags).toEqual([["h", channel]]);
  });
});

describe("harnessKit.tools", () => {
  it("answers MCP with the Buzz tools", async () => {
    const { kit, agent } = setup();
    const handler = kit.tools(agent);
    const listed = (await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain("send");
    expect(names).toContain("read");
    const started = (await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    })) as { result: { instructions?: string } };
    expect(started.result.instructions).toContain("Read and act in Buzz");
  });

  it("answers a message without a jsonrpc field", async () => {
    const { kit, agent } = setup();
    const listed = (await kit.tools(agent)({
      id: 7,
      method: "tools/list",
    })) as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(listed.id).toBe(7);
    expect(listed.result.tools.length).toBeGreaterThan(0);
  });

  it("reads files for uploads only through the plugin's read", async () => {
    const { kit, agent, delivery } = setup();
    const event = reply("2", "1", "@Ampy go");
    const conversation = await kit.conversation(
      delivery({ type: "mention", event }),
      "thread",
    );
    const read = vi.fn(async () => {
      throw new Error("No such file");
    });
    const call = (handler: ReturnType<typeof kit.tools>) =>
      handler({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "send",
          arguments: { files: ["./a.txt"], audience: "everyone" },
        },
      }) as Promise<{ result: { content: { text: string }[] } }>;
    const without = await call(kit.tools(agent, conversation));
    expect(JSON.stringify(without)).toContain("cannot read ./a.txt");
    await call(kit.tools(agent, conversation, { read }));
    expect(read).toHaveBeenCalledWith("./a.txt");
  });

  it("standalone prompts carry the agent's routing context", () => {
    const { kit, agent } = setup();
    expect(kit.standalonePrompt(agent, "Check CI")).toBe(
      `<context>\nScope: standalone\nAgent: ${self}\n</context>\n\nCheck CI`,
    );
  });
});
