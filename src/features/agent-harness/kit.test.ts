import { describe, expect, it, vi } from "vitest";
import { matchFilters } from "nostr-tools/filter";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { fromOwner } from "../agents/owner-attestation";
import type { AgentHandle, Delivery } from "../agents/service";
import { eventDto, type EventData, type RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { keypair, signed } from "../relay/testing";
import { workspaceCanvas } from "../solo/workspace";
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
    /** The Canvas of the chat, as one its owner is still creating has it. */
    canvas?: string;
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
    channelWrites: { startingCanvas: () => options.canvas },
    canvas: { available: false, read: vi.fn(async () => null) },
    agentMemories: { open: vi.fn() },
    workflowAuthority: workflowKey.pubkey,
  };
  const state = { status: "ready" };
  const relay = {
    snapshot: () => ({
      status: state.status,
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
  return { kit, agent, delivery, published, restored, read, session, state };
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

it("restores direct and nested task corrections for a rooted harness wake", async () => {
  const root = message("1", "Source requirements");
  const child = (id: string, parent: string, content: string) =>
    message(id, content, {
      tags: [
        ["h", channel],
        ["e", root.id, "", "root"],
        ["e", parent, "", "reply"],
      ],
    });
  const anchor = child("2", root.id, "Start task");
  const direct = child("3", anchor.id, "DIRECT_CORRECTION");
  const nested = child("4", direct.id, "NESTED_CORRECTION");
  const unrelated = child("5", root.id, "UNRELATED_DISCUSSION");
  const { kit, delivery, read } = setup();
  read.mockImplementation(async (filters) =>
    [root, anchor, direct, nested, unrelated].filter((event) =>
      matchFilters(filters as Parameters<typeof matchFilters>[0], event),
    ),
  );
  const d = delivery(
    {
      type: "plugin",
      plugin: "test",
      id: "9".repeat(64),
      channel,
      root: anchor.id,
      text: "Resume task",
      at: 200_000,
    },
    {
      routeConversation: async () => ({ root: root.id, parent: anchor.id }),
    },
  );
  const conversation = await kit.conversation(d, "thread");
  if (!conversation) throw new Error("Not admitted");
  const prompt = await kit.turnPrompt(d, conversation);
  expect(prompt.text).toContain("DIRECT_CORRECTION");
  expect(prompt.text).toContain("NESTED_CORRECTION");
  expect(prompt.text).not.toContain("UNRELATED_DISCUSSION");
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
    await expect(text).toMatchFileSnapshot(
      "./sections/snapshots/kit.thread.txt",
    );
  });

  it("builds the base prompt with the sections the owner chose", async () => {
    const { kit, agent, delivery } = setup();
    const text = await kit.systemPrompt(
      delivery(
        { type: "mention", event: message("1", "x") },
        {
          agent: {
            ...agent,
            promptSections: () => ({
              owner: {
                progress: { mode: "off" },
                etiquette: { mode: "custom", text: "Be brief." },
              },
            }),
          } as unknown as Delivery["agent"],
        },
      ),
      { scope: "thread", cwd: "~", instructions: "" },
    );
    expect(text).not.toContain("## Progress");
    expect(text).toContain(
      '## Etiquette\n<owner-section id="etiquette">\nBe brief.\n</owner-section>',
    );
  });

  it("asks for the sections of the conversation the session is for", async () => {
    const { kit, agent, delivery } = setup();
    const asked: unknown[] = [];
    const d = delivery(
      { type: "mention", event: reply("2", "1", "x") },
      {
        agent: {
          ...agent,
          promptSections: (channel?: string, root?: string) => {
            asked.push([channel, root]);
            return channel
              ? { plugin: { id: "example", sections: { progress: "Quiet." } } }
              : {};
          },
        } as unknown as Delivery["agent"],
      },
    );
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    const options = { scope: "thread", cwd: "~", instructions: "" } as const;
    const text = await kit.systemPrompt(d, { ...options, conversation });
    expect(asked).toEqual([[conversation.channel, conversation.root]]);
    expect(text).toContain(
      '## Progress\n<plugin-section id="progress" plugin="example">\nQuiet.\n</plugin-section>',
    );
    expect(text).toContain("This session is one thread");
    // Without the conversation, the prompt has no plugin's sections, and its
    // Session Model states the scope alone.
    const unnamed = await kit.systemPrompt(d, options);
    expect(unnamed).not.toContain("</plugin-section>\n");
    expect(unnamed).not.toContain("This session is one thread");
    expect(unnamed).toContain("each thread gets its own independent");
    expect(asked[1]).toEqual([undefined, undefined]);
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

  it("reads a Solo chat's Canvas folders as context where a plugin says where the work happens", async () => {
    const { kit, delivery, agent } = setup({
      type: "solo",
      canvas: workspaceCanvas({
        folders: ["~/app"],
        worktree: { location: "~/trees", baseBranch: "main" },
        canvas: "Use tokens.",
      }),
    });
    const d = delivery({ type: "mention", event: message("1", "go") });
    const conversation = await kit.conversation(d, "thread");
    if (!conversation) throw new Error("not admitted");
    const sections = vi.fn((_channel?: string) => ({ owner: {} }));
    Object.assign(agent, { promptSections: sections });
    expect((await kit.turnPrompt(d, conversation)).text).toContain(
      "This chat's work happens in these folders, not your own workspace: `~/app`, `~/trees`.",
    );
    sections.mockReturnValue({
      owner: {},
      plugin: {
        id: "example",
        sections: { "working-location": "Work in the task's folder." },
      },
    } as never);
    const { text } = await kit.turnPrompt(d, conversation);
    expect(text).toContain(
      "relevant to this chat: `~/app`, `~/trees`. They are for reading.",
    );
    expect(text).not.toContain("create a new worktree");
    expect(sections).toHaveBeenLastCalledWith(channel);
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

  it("builds its client again after a reload, with the new session's relay key", async () => {
    const { kit, agent, session, state } = setup();
    const relay = keypair();
    Object.assign(session, { relayAuthor: relay.pubkey });
    state.status = "connecting";
    // The call arrives mid-reload; its wait ends with the community ready.
    Object.assign(agent, {
      settle: vi.fn(async () => {
        state.status = "ready";
        return true;
      }),
    });
    const answer = (await kit.tools(agent)({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "solo_worker_connections", arguments: {} },
    })) as unknown;
    expect(agent.settle).toHaveBeenCalled();
    expect(JSON.stringify(answer)).not.toContain(
      "does not know its relay's key",
    );
  });

  it("standalone prompts carry the agent's routing context", () => {
    const { kit, agent } = setup();
    expect(kit.standalonePrompt(agent, "Check CI")).toBe(
      `<context>\nScope: standalone\nAgent: ${self}\n</context>\n\nCheck CI`,
    );
  });
});

it.each(["thread", "channel"] as const)(
  "isolates a routed %s harness and keeps its replies under the invocation",
  async (scope) => {
    const f = setup();
    const event = reply("2", "1", "go");
    const d = f.delivery(
      { type: "mention", event },
      {
        routeConversation: async () => ({
          root: "1".repeat(64),
          parent: event.id,
          turnContext: "FIRST_TASK_INSTRUCTIONS",
        }),
      },
    );
    const first = await f.kit.conversation(d, scope);
    if (!first) throw new Error("not admitted");
    const next = await f.kit.conversation(
      f.delivery(
        { type: "mention", event: reply("3", "1", "continue") },
        {
          routeConversation: async () => ({
            root: "1".repeat(64),
            parent: event.id,
            turnContext: "UPDATED_TASK_INSTRUCTIONS",
          }),
        },
      ),
      scope,
    );
    expect(first.key).toBe(`${channel}/${event.id}`);
    if (!next) throw new Error("follow-up was not admitted");
    expect(next.key).toBe(first.key);
    const [firstPrompt, nextPrompt] = await Promise.all([
      f.kit.turnPrompt(d, first),
      f.kit.turnPrompt(d, next),
    ]);
    expect(firstPrompt.text).toContain("FIRST_TASK_INSTRUCTIONS");
    expect(nextPrompt.text).toContain("UPDATED_TASK_INSTRUCTIONS");
    expect(nextPrompt.text).not.toContain("FIRST_TASK_INSTRUCTIONS");
    await f.kit.reply(f.agent, first, "Work");
    expect(f.published[0]?.tags).toEqual([
      ["h", channel],
      ["e", "1".repeat(64), "", "root"],
      ["e", event.id, "", "reply"],
    ]);
  },
);
