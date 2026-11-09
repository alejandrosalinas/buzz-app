import { describe, expect, it, vi } from "vitest";
import type { ProtectionAction } from "../features/agent-protection/service";
import type {
  BuzzClient,
  BuzzEvent,
  OwnerAccess,
  OwnerChannel,
} from "./client";
import { CANVAS_HISTORY_PAGE } from "../features/channel-templates/canvas-limits";
import { OWNER_TOOLS, callOwnerTool, isOwnerTool } from "./owner";
import { respond } from "./rpc";
import {
  type AddedTool,
  callSessionTool,
  sessionHint,
  sessionTools,
} from "./session-tools";

const executedAs = {
  agent: "b".repeat(64),
  owner: "a".repeat(64),
  community: "https://relay.example.test",
};
const id = "11111111-1111-4111-8111-111111111111";
const hex = (c: string) => c.repeat(64);
const person = hex("c");
const message = (key: string, patch: Partial<BuzzEvent> = {}): BuzzEvent => ({
  id: hex(key),
  pubkey: person,
  created_at: 1_700_000_000,
  kind: 9,
  tags: [["h", id]],
  content: `message ${key}`,
  sig: "",
  ...patch,
});
const channel = (name: string): OwnerChannel => ({
  id: `${name}-id`,
  name,
  type: "stream",
  visibility: "private",
  archived: false,
  role: null,
});

function owned() {
  return {
    channels: vi.fn<OwnerAccess["channels"]>(async () => ({
      execution: executedAs,
      channels: ["Plans", "Planning", "Lunch"].map(channel),
      partial: false,
    })),
    channel: vi.fn(async () => ({
      execution: executedAs,
      channel: channel("Plans"),
      capabilities: {
        manageRoles: false,
        removeMembers: false,
        archive: false,
        unarchive: false,
        delete: false,
      },
    })),
    members: vi.fn(async () => ({
      execution: executedAs,
      channel: id,
      total: 3,
      members: [{ pubkey: executedAs.owner, role: "owner" as const }],
    })),
    messages: vi.fn<OwnerAccess["messages"]>(async () => ({
      execution: executedAs,
      channel: id,
      events: [message("1"), message("2")],
      names: { [person]: "Pat" },
    })),
    canvas: vi.fn<OwnerAccess["canvas"]>(async () => ({
      execution: executedAs,
      channel: id,
      canvas: message("9", { kind: 40100, content: "# Plan\nShip it" }),
    })),
    canvasHistory: vi.fn<OwnerAccess["canvasHistory"]>(async () => ({
      execution: executedAs,
      channel: id,
      revisions: [message("9", { kind: 40100, content: "# Plan\nShip it" })],
    })),
    held: vi.fn<OwnerAccess["held"]>(),
  };
}
const clientWith = (fields: Partial<BuzzClient> = {}) =>
  ({
    pubkey: executedAs.agent,
    key: executedAs.agent,
    ...fields,
  }) as BuzzClient;

describe("callOwnerTool", () => {
  it("lists, filters and pages the owner's channels with who it ran as", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    expect(
      JSON.parse(
        (
          await callOwnerTool(client, "owner_channel_list", {
            q: "PLAN",
            limit: 1,
          })
        ).text,
      ),
    ).toEqual({
      executedAs,
      channels: [channel("Plans")],
      total: 2,
      next: { offset: 1 },
      partial: false,
    });
    ownerAccess.channels.mockResolvedValueOnce({
      execution: executedAs,
      channels: [],
      partial: true,
      error: "offline",
    });
    expect(
      JSON.parse(
        String((await callOwnerTool(client, "owner_channel_list", {})).text),
      ),
    ).toEqual({
      executedAs,
      channels: [],
      total: 0,
      partial: true,
      error: "offline",
    });
  });

  it("answers a channel and a page of its members", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    expect(
      JSON.parse(
        (await callOwnerTool(client, "owner_channel_get", { channel: id }))
          .text,
      ),
    ).toMatchObject({ executedAs, channel: { name: "Plans" } });
    expect(ownerAccess.channel).toHaveBeenCalledWith(id);
    expect(
      JSON.parse(
        (
          await callOwnerTool(client, "owner_member_list", {
            channel: id,
            offset: 1,
            limit: 1,
          })
        ).text,
      ),
    ).toEqual({
      executedAs,
      channel: id,
      total: 3,
      members: [{ pubkey: executedAs.owner, role: "owner" }],
      next: { offset: 2 },
    });
    expect(ownerAccess.members).toHaveBeenCalledWith(id, {
      offset: 1,
      limit: 1,
    });
    await callOwnerTool(client, "owner_member_list", {
      channel: id,
      limit: 900,
    });
    expect(ownerAccess.members).toHaveBeenLastCalledWith(id, {
      offset: 0,
      limit: 500,
    });
  });

  it.each([
    ["owner_channel_get", {}, "channel is required"],
    ["owner_channel_get", { channel: 7 }, "channel must be text"],
    ["owner_member_list", { channel: id, limit: 0 }, "limit must be"],
    ["owner_member_list", { channel: id, offset: -1 }, "offset must be"],
    ["owner_channel_list", { limit: 1.5 }, "limit must be"],
    // No argument may name another owner, account, community or agent.
    ["owner_channel_list", { owner: executedAs.agent }, "owner cannot be used"],
    ["owner_channel_get", { channel: id, community: "x" }, "cannot be used"],
    // No default to the current conversation.
    ["owner_read", {}, "channel, thread, message_url or q is required"],
    ["owner_read", { thread: "abc" }, "thread must be a 64-character"],
    ["owner_read", { channel: id, before_id: hex("1") }, "before_id needs"],
    [
      "owner_read",
      { q: "x", before: 5, before_id: hex("1") },
      "before_id pages",
    ],
    ["owner_read", { thread: hex("1"), author: person }, "not a thread"],
    ["owner_read", { q: "x", thread: hex("1") }, "q searches channels"],
    ["owner_read", { channel: id, since: 9, before: 5 }, "since must not"],
    ["owner_read", { channel: id, author: "pat" }, "author must be"],
    ["owner_read", { channel: id, message_url: "x" }, "cannot be combined"],
    ["owner_read", { message_url: "https://x.test" }, "Buzz message link"],
    ["owner_read", { channel: id, as: executedAs.owner }, "cannot be used"],
    ["owner_canvas_get", { channel: id, id: "v1" }, "id must be a 64"],
    ["owner_canvas_history", { channel: id, before_id: hex("1") }, "needs"],
    ["owner_canvas_history", {}, "channel is required"],
  ])("rejects %s %j before reading", async (name, args, message) => {
    const ownerAccess = owned();
    await expect(
      callOwnerTool(clientWith({ ownerAccess }), name, args),
    ).rejects.toThrow(message);
    const { held: _, ...reads } = ownerAccess;
    for (const read of Object.values(reads))
      expect(read).not.toHaveBeenCalled();
  });

  it("reads nothing for a client without owner access", async () => {
    for (const { name } of OWNER_TOOLS)
      await expect(
        callOwnerTool(clientWith(), name, { channel: id }),
      ).rejects.toThrow("not available to this agent here; nothing was read");
  });

  it("reads a channel, a thread or a search with read's limits and continuation", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    const read = async (args: Record<string, unknown>) =>
      JSON.parse((await callOwnerTool(client, "owner_read", args)).text);
    ownerAccess.messages.mockResolvedValueOnce({
      execution: executedAs,
      channel: id,
      // Out of order, with edits by their author and a newer one by someone else.
      events: [
        message("2", { created_at: 1_700_000_100 }),
        message("5", {
          kind: 40003,
          created_at: 1_700_000_250,
          tags: [
            ["h", id],
            ["e", hex("2")],
          ],
          content: "their edit",
        }),
        message("1"),
        message("3", {
          kind: 40003,
          created_at: 1_700_000_200,
          tags: [
            ["h", id],
            ["e", hex("1")],
          ],
          content: "edited",
        }),
        message("4", {
          kind: 40003,
          pubkey: executedAs.owner,
          created_at: 1_700_000_300,
          tags: [
            ["h", id],
            ["e", hex("2")],
          ],
          content: "not theirs",
        }),
      ],
      names: { [person]: "Pat" },
      more: { before: 1_700_000_000, beforeId: hex("1") },
    });
    expect(
      await read({ channel: id, author: person, since: 5, limit: 999 }),
    ).toEqual({
      executedAs,
      channel: id,
      messages: [
        `${hex("1")} from ${person} "Pat" at 2023-11-14T22:13Z: edited`,
        `${hex("2")} from ${person} "Pat" at 2023-11-14T22:15Z: their edit`,
      ],
      next: {
        channel: id,
        author: person,
        since: 5,
        limit: 200,
        before: 1_700_000_000,
        before_id: hex("1"),
      },
    });
    expect(ownerAccess.messages).toHaveBeenLastCalledWith({
      channel: id,
      author: person,
      since: 5,
      limit: 200,
    });

    // Its verified owner's correction counts in its channel, newest first.
    const correction = (key: string, h: string, created_at: number) =>
      message(key, {
        kind: 40003,
        pubkey: executedAs.owner,
        created_at,
        tags: [
          ["h", h],
          ["e", hex("2")],
        ],
        content: `owner ${key}`,
      });
    ownerAccess.messages.mockResolvedValueOnce({
      execution: executedAs,
      channel: id,
      events: [
        message("2"),
        message("5", {
          kind: 40003,
          created_at: 1_700_000_100,
          tags: [
            ["h", id],
            ["e", hex("2")],
          ],
          content: "their edit",
        }),
        correction("6", id, 1_700_000_200),
        correction("7", "elsewhere", 1_700_000_300),
      ],
      names: {},
      owners: { [person]: executedAs.owner },
    });
    expect((await read({ channel: id })).messages).toEqual([
      `${hex("2")} from ${person} at 2023-11-14T22:13Z: owner 6`,
    ]);

    ownerAccess.messages.mockResolvedValueOnce({
      execution: executedAs,
      channel: id,
      root: hex("1"),
      events: [message("1")],
      names: {},
      more: { before: 7, beforeId: hex("1") },
    });
    expect(
      await read({ thread: hex("2"), before: 9, before_id: hex("5") }),
    ).toMatchObject({
      thread: hex("1"),
      next: { thread: hex("1"), limit: 100, before: 7, before_id: hex("1") },
    });
    expect(ownerAccess.messages).toHaveBeenLastCalledWith({
      thread: hex("2"),
      before: 9,
      beforeId: hex("5"),
      limit: 100,
    });

    // A message link is a thread read, from any of its messages.
    await read({
      message_url: `buzz://message?channel=${id}&id=${hex("2")}`,
    });
    expect(ownerAccess.messages).toHaveBeenLastCalledWith({
      thread: hex("2"),
      limit: 100,
    });

    // The relay caps a read at 500, and the thread read asks one more.
    await read({ thread: hex("2"), limit: 900 });
    expect(ownerAccess.messages).toHaveBeenLastCalledWith({
      thread: hex("2"),
      limit: 499,
    });

    ownerAccess.messages.mockResolvedValueOnce({
      execution: executedAs,
      events: [],
      names: {},
      limited: true,
      editsLimited: true,
      partial: true,
    });
    expect(await read({ q: " plan ", limit: 500 })).toEqual({
      executedAs,
      messages: [],
      limited: true,
      edits_limited: true,
      partial: true,
    });
    expect(ownerAccess.messages).toHaveBeenLastCalledWith({
      search: "plan",
      limit: 100,
    });
  });

  it("reads a canvas, an earlier revision and a page of its history", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await callOwnerTool(client, name, args)).text);
    expect(await call("owner_canvas_get", { channel: id })).toEqual({
      executedAs,
      channel: id,
      id: hex("9"),
      author: person,
      at: "2023-11-14T22:13Z",
      canvas: "# Plan\nShip it",
    });
    expect(ownerAccess.canvas).toHaveBeenLastCalledWith(id, undefined);
    await call("owner_canvas_get", { channel: id, id: hex("8") });
    expect(ownerAccess.canvas).toHaveBeenLastCalledWith(id, hex("8"));
    ownerAccess.canvas.mockResolvedValueOnce({
      execution: executedAs,
      channel: id,
    });
    expect(await call("owner_canvas_get", { channel: id })).toEqual({
      executedAs,
      channel: id,
      canvas: null,
    });

    expect(await call("owner_canvas_history", { channel: id })).toEqual({
      executedAs,
      channel: id,
      version: hex("9"),
      revisions: [
        {
          id: hex("9"),
          at: "2023-11-14T22:13Z",
          author: person,
          bytes: 14,
          line: "# Plan",
        },
      ],
    });
    expect(ownerAccess.canvasHistory).toHaveBeenLastCalledWith(id, {});
    const full = Array.from({ length: CANVAS_HISTORY_PAGE }, (_, at) =>
      message(String(at % 10), { kind: 40100, created_at: 50 - at }),
    );
    ownerAccess.canvasHistory.mockResolvedValueOnce({
      execution: executedAs,
      channel: id,
      revisions: full,
    });
    const older = await call("owner_canvas_history", {
      channel: id,
      before: 60,
      before_id: hex("a"),
    });
    expect(older).not.toHaveProperty("version");
    expect(older.next).toEqual({
      channel: id,
      before: full.at(-1)?.created_at,
      before_id: full.at(-1)?.id,
    });
    expect(ownerAccess.canvasHistory).toHaveBeenLastCalledWith(id, {
      before: 60,
      beforeId: hex("a"),
    });
  });

  it("names only the read tools", () => {
    expect(OWNER_TOOLS.map(({ name }) => name)).toEqual([
      "owner_channel_list",
      "owner_channel_get",
      "owner_member_list",
      "owner_read",
      "owner_canvas_get",
      "owner_canvas_history",
    ]);
    expect(
      OWNER_TOOLS.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(isOwnerTool("owner_channel_list")).toBe(true);
    expect(isOwnerTool("owner_send")).toBe(false);
  });
});

describe("owner tools in the session", () => {
  const names = (tools: readonly { name: string }[]) =>
    tools.map(({ name }) => name);

  it("lists them only to a client with owner access, on search", async () => {
    expect(names(sessionTools()).some(isOwnerTool)).toBe(false);
    expect(sessionHint()).not.toContain("owner_channel_list");
    const tools = sessionTools([], true);
    expect(
      tools.filter((tool) => isOwnerTool(tool.name)).map((tool) => tool.load),
    ).toEqual(OWNER_TOOLS.map(() => "search"));
    expect(sessionHint([], true)).toContain("owner_channel_list");
    const list = async (client?: BuzzClient) =>
      (
        (await respond(client, {}, { id: 1, method: "tools/list" })) as {
          result: { tools: { name: string }[] };
        }
      ).result.tools;
    expect(names(await list()).some(isOwnerTool)).toBe(false);
    expect(names(await list(clientWith())).some(isOwnerTool)).toBe(false);
    expect(names(await list(clientWith({ ownerAccess: owned() })))).toEqual(
      expect.arrayContaining(names(OWNER_TOOLS)),
    );
  });

  it("refuses a direct or remembered call from a client without owner access", async () => {
    await expect(
      callSessionTool(clientWith(), {}, "owner_channel_list", {}),
    ).rejects.toThrow("nothing was read");
  });

  it("gives a plugin tool neither owner access nor settings, even one shadowing an owner tool", async () => {
    const ownerAccess = owned();
    const settings = { list: vi.fn(), get: vi.fn(), set: vi.fn() };
    const seen: BuzzClient[] = [];
    const plugin = (name: string): AddedTool => ({
      name,
      description: "A plugin's tool.",
      inputSchema: { type: "object" },
      call: async (client) => {
        seen.push(client);
        return "plugin";
      },
    });
    const client = clientWith({ ownerAccess, settings });
    for (const name of ["notes_add", "owner_channel_list"])
      expect(await callSessionTool(client, {}, name, {}, [plugin(name)])).toBe(
        "plugin",
      );
    expect(seen).toHaveLength(2);
    for (const each of seen) {
      expect("ownerAccess" in each).toBe(false);
      expect("settings" in each).toBe(false);
      expect(each.pubkey).toBe(executedAs.agent);
    }
    expect(ownerAccess.channels).not.toHaveBeenCalled();
  });

  it("releases an owner answer only after its review, while its binding holds", async () => {
    const ownerAccess = owned();
    const order: string[] = [];
    const protect = vi.fn(async (action: ProtectionAction) => {
      order.push(action.kind);
    });
    ownerAccess.held.mockImplementation(() => {
      order.push("held");
    });
    const client = clientWith({ ownerAccess, protect });
    expect(
      JSON.parse(
        String(await callSessionTool(client, {}, "owner_channel_list", {})),
      ),
    ).toMatchObject({ executedAs });
    expect(order).toEqual(["tool", "tool-result", "held"]);
    expect(ownerAccess.held).toHaveBeenCalledWith(executedAs);
    ownerAccess.held.mockImplementation(() => {
      throw new Error("changed during the call");
    });
    await expect(
      callSessionTool(client, {}, "owner_channel_list", {}),
    ).rejects.toThrow("changed during the call");
  });

  it("reads nothing when protection refuses the call, and withholds a refused result", async () => {
    const ownerAccess = owned();
    const protect = vi.fn(async (action: ProtectionAction) => {
      if (action.kind === "tool") throw new Error("denied action");
    });
    await expect(
      callSessionTool(
        clientWith({ ownerAccess, protect }),
        {},
        "owner_channel_list",
        {},
      ),
    ).rejects.toThrow("denied action");
    expect(ownerAccess.channels).not.toHaveBeenCalled();

    protect.mockImplementation(async (action) => {
      if (action.kind === "tool-result") throw new Error("denied result");
    });
    await expect(
      callSessionTool(
        clientWith({ ownerAccess, protect }),
        {},
        "owner_channel_list",
        {},
      ),
    ).rejects.toThrow("denied result");
    expect(ownerAccess.channels).toHaveBeenCalledOnce();
    const result = protect.mock.calls.at(-1)?.[0];
    expect(result).toMatchObject({ kind: "tool-result" });
    expect(String(result?.content)).toContain('"executedAs"');
  });
});
