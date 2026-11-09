import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import type { ExternalScope } from "../features/agents/external-connection";
import { respondExternal } from "./external";
import { respond } from "./rpc";
import type { AddedTool } from "./session-tools";

const note: AddedTool = {
  name: "notes_plugin_get",
  description: "A tool a plugin adds, which Buzz classifies nowhere.",
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string" }, depth: { type: "integer" } },
  },
  call: vi.fn(async (_client, _context, args) => `note ${String(args.slug)}`),
};

function fixture(events: BuzzEvent[] = [], settings = false) {
  const query = vi.fn(async (_filters: readonly Filter[]) => events);
  const publish = vi.fn(async (event: Template) => ({
    ...event,
    id: "d".repeat(64),
  }));
  const read = vi.fn(async () => {
    throw new Error("This agent cannot read /tmp/private");
  });
  const client = {
    pubkey: "a".repeat(64),
    key: "a".repeat(64),
    owner: "b".repeat(64),
    query,
    publish,
    read,
    ...(settings
      ? { settings: { list: () => [], get: () => undefined, set: vi.fn() } }
      : {}),
  } as unknown as BuzzClient;
  let added: readonly AddedTool[] = [note];
  const message = (
    method: string,
    params: object,
    scopes: readonly ExternalScope[] = ["agent"],
  ) =>
    respondExternal(
      client,
      { jsonrpc: "2.0", id: 1, method, params },
      () => {},
      scopes,
      () => added,
    );
  const call = (
    name: string,
    args: unknown,
    scopes: readonly ExternalScope[] = ["agent"],
  ) => message("tools/call", { name, arguments: args }, scopes);
  const list = async (scopes: readonly ExternalScope[] = ["agent"]) =>
    (await message("tools/list", {}, scopes)) as {
      result: {
        tools: { name: string; _meta: object }[];
        _meta: object;
      };
    };
  return {
    client,
    query,
    publish,
    read,
    call,
    list,
    message,
    setAdded: (next: readonly AddedTool[]) => {
      added = next;
    },
  };
}

it("negotiates only the external protocol and leaves notifications unanswered", async () => {
  const { client } = fixture();
  const connected = vi.fn();
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  };
  const answer = (input: unknown) =>
    respondExternal(client, input, connected, ["agent"], () => []);
  expect(await answer(request)).toHaveProperty("error.code", -32602);
  expect(connected).not.toHaveBeenCalled();
  request.params.protocolVersion = "2025-06-18";
  const initialized = await answer(request);
  expect(initialized).toHaveProperty("result.protocolVersion", "2025-06-18");
  expect(initialized).toHaveProperty(
    "result.instructions",
    expect.stringContaining("explicit channel or message IDs"),
  );
  expect(connected).toHaveBeenCalledOnce();
  expect(
    await answer({ id: 3, method: "tools/list", params: { cursor: "next" } }),
  ).toHaveProperty("error.code", -32602);
  expect(await answer({ method: "notifications/initialized" })).toBeUndefined();
});

it.each([false, true])(
  "lists exactly the native session tools and schemas (settings %s)",
  async (settings) => {
    const { client, list } = fixture([], settings);
    const native = (await respond(client, {}, { id: 1, method: "tools/list" }, [
      note,
    ])) as { result: { tools: { name: string }[] } };
    const external = await list();
    expect(external.result.tools).toEqual(
      native.result.tools.map((tool) => ({
        ...tool,
        _meta: { "buzz/requiredScopes": ["agent"] },
      })),
    );
    const names = external.result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["repo", "agent_create", "notes_plugin_get"]),
    );
    expect(names.includes("settings_set")).toBe(settings);
    expect(external.result._meta).toEqual({
      "buzz/grantedScopes": ["agent"],
      "buzz/supportedScopes": ["agent"],
    });
  },
);

it("follows plugin tools as they are added and removed", async () => {
  const { call, list, setAdded } = fixture();
  expect(
    await call("notes_plugin_get", { slug: "x", depth: 2 }),
  ).toHaveProperty("result.content.0.text", "note x");
  expect(note.call).toHaveBeenCalledWith(
    expect.not.objectContaining({ settings: expect.anything() }),
    {},
    { slug: "x", depth: 2 },
  );
  setAdded([]);
  expect(
    (await list()).result.tools.some(
      (tool) => tool.name === "notes_plugin_get",
    ),
  ).toBe(false);
  expect(await call("notes_plugin_get", { slug: "x" })).toHaveProperty(
    "result.isError",
    true,
  );
});

it("passes full arguments to the native handler", async () => {
  const { call, publish } = fixture();
  const member = "c".repeat(64);
  await call("channel_create", {
    name: "Triage",
    visibility: "private",
    solo: true,
    members: [member],
  });
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 9007,
      tags: expect.arrayContaining([
        ["visibility", "private"],
        ["t", "buzz.solo"],
        ["p", member],
      ]),
    }),
  );
});

it("posts as the selected agent with explicit targets only", async () => {
  const { call, publish } = fixture();
  expect(
    await call("send", { text: "No target", audience: "everyone" }),
  ).toHaveProperty("result.isError", true);
  expect(publish).not.toHaveBeenCalled();
  expect(
    await call("send", {
      channel: "chan",
      text: "Test message",
      audience: "agents",
    }),
  ).toHaveProperty("result.content.0.text", `sent ${"d".repeat(64)}`);
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 9,
      content: "Test message",
      tags: expect.arrayContaining([["h", "chan"]]),
    }),
  );
});

it("returns the native refusal when the agent cannot do something", async () => {
  const { call, read, publish } = fixture();
  expect(
    await call("send", {
      channel: "chan",
      text: "x",
      audience: "everyone",
      files: ["/tmp/private"],
    }),
  ).toHaveProperty("result.isError", true);
  expect(read).toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it.each<{ scopes: readonly ExternalScope[] }>([
  { scopes: ["read"] },
  { scopes: ["read", "post"] },
  { scopes: ["read", "post", "create"] },
  { scopes: ["create"] },
  { scopes: [] },
])(
  "never widens an older $scopes approval: lists without granting and refuses calls",
  async ({ scopes }) => {
    const { call, list, query, publish } = fixture();
    const listed = await list(scopes);
    expect(listed.result._meta).toEqual({
      "buzz/grantedScopes": [],
      "buzz/supportedScopes": ["agent"],
    });
    for (const [name, args] of [
      ["read", { channel: "chan" }],
      ["send", { channel: "chan", text: "x", audience: "everyone" }],
      ["notes_plugin_get", { slug: "x" }],
    ] as const) {
      const reply = await call(name, args, scopes);
      expect(reply).toHaveProperty("result.isError", true);
      expect(reply).toHaveProperty("result._meta.buzz/error", {
        code: "authorization_required",
        required_scopes: ["agent"],
      });
    }
    expect(query).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);
