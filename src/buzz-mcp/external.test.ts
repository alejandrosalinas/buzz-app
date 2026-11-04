import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import type { ExternalScope } from "../features/agents/external-connection";
import { respondExternal } from "./external";

function fixture(events: BuzzEvent[] = []) {
  const query = vi.fn(async (_filters: readonly Filter[]) => events);
  const publish = vi.fn(async (event: Template) => ({
    ...event,
    id: "d".repeat(64),
  }));
  const defaultWorker = vi.fn(async () => "c".repeat(64));
  const read = vi.fn(async () => {
    throw new Error("file access");
  });
  const client = {
    pubkey: "a".repeat(64),
    key: "a".repeat(64),
    owner: "b".repeat(64),
    query,
    publish,
    read,
  } as unknown as BuzzClient;
  const call = (
    name: string,
    args: unknown,
    scopes: readonly ExternalScope[] = ["read", "post"],
  ) =>
    respondExternal(
      client,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      () => {},
      scopes,
      defaultWorker,
    );
  return { client, query, publish, read, call, defaultWorker };
}

it("lists the restricted schemas and negotiates only the external protocol", async () => {
  const { client } = fixture();
  const connected = vi.fn();
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  };
  expect(await respondExternal(client, request, connected)).toHaveProperty(
    "error.code",
    -32602,
  );
  expect(connected).not.toHaveBeenCalled();
  request.params.protocolVersion = "2025-06-18";
  expect(await respondExternal(client, request, connected)).toHaveProperty(
    "result.protocolVersion",
    "2025-06-18",
  );
  expect(connected).toHaveBeenCalledOnce();
  const list = await respondExternal(
    client,
    { id: 2, method: "tools/list" },
    connected,
  );
  const tools = (
    list as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: object; required?: string[] };
        }[];
      };
    }
  ).result.tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "channel_create",
    "channel_get",
    "channel_list",
    "read",
    "reply_in_subthread",
    "send",
  ]);
  const send = tools.find((tool) => tool.name === "send");
  expect(send?.inputSchema.properties).not.toHaveProperty("files");
  expect(send?.inputSchema.properties).not.toHaveProperty("path");
  expect(send?.inputSchema.required).toEqual(["channel", "text", "audience"]);
  const create = tools.find((tool) => tool.name === "channel_create");
  expect(create?.inputSchema.properties).toEqual({ name: { type: "string" } });
  expect(create?.inputSchema.required).toEqual(["name"]);
  expect(create).toHaveProperty("annotations.readOnlyHint", false);
  expect(create).toHaveProperty("_meta.buzz/requiredScopes", ["create"]);
  expect(
    await respondExternal(
      client,
      { id: 3, method: "tools/list", params: { cursor: "next" } },
      connected,
    ),
  ).toHaveProperty("error.code", -32602);
  expect(
    await respondExternal(
      client,
      { method: "notifications/initialized" },
      connected,
    ),
  ).toBeUndefined();
});

it.each([
  ["run", { command: "pwd" }],
  ["media_get", { url: "https://example.test/image" }],
  ["git_auth", {}],
  ["mem_list", {}],
  ["agent_create", {}],
  [
    "send",
    {
      channel: "chan",
      text: "text",
      audience: "everyone",
      path: "/tmp/private",
    },
  ],
  [
    "send",
    {
      channel: "chan",
      text: "text",
      audience: "everyone",
      files: ["/tmp/private"],
    },
  ],
  ["send", { text: "text", audience: "everyone" }],
  ["send", { channel: "chan", text: "text", audience: "user" }],
  [
    "send",
    { channel: "chan", text: "text", audience: "everyone", mentions: [false] },
  ],
  ["read", { q: "text" }],
  ["read", { channel: " ", q: "needle" }],
  ["read", { channel: " " }],
  ["read", { thread: " " }],
  ["read", { message_url: " " }],
  ["read", { message_url: "https://example.test/message" }],
  ["read", { message_url: `buzz://channel/chan` }],
  [
    "read",
    {
      message_url: `buzz://message?channel=chan&id=${"a".repeat(64)}`,
      channel: "other",
    },
  ],
  ["read", { channel: "chan", limit: 1.5 }],
  ["channel_get", {}],
  ["channel_list", { all: "true" }],
  ["channel_list", { types: ["unknown"] }],
  ["channel_list", { types: [] }],
  ["reply_in_subthread", { text: "text", audience: "everyone" }],
])(
  "rejects unsafe or invalid %s arguments before accessing the client",
  async (name, args) => {
    const { call, query, publish, read } = fixture();
    expect(await call(name as string, args)).toHaveProperty(
      "result.isError",
      true,
    );
    expect(query).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);

it("posts text through the shared handler with the selected identity", async () => {
  const { call, publish, read } = fixture();
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
      tags: expect.arrayContaining([
        ["h", "chan"],
        ["audience", "agents"],
      ]),
    }),
  );
  expect(read).not.toHaveBeenCalled();
});

it("reads a message link through the shared handler without an implicit target", async () => {
  const id = "a".repeat(64);
  const { call } = fixture([
    {
      id,
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 9,
      content: "Linked message",
      tags: [["h", "chan"]],
      sig: "",
    },
  ]);
  const reply = await call("read", {
    message_url: `buzz://message?channel=chan&id=${id}`,
  });
  expect(reply).toHaveProperty(
    "result.content.0.text",
    expect.stringContaining(`thread ${id} in chan`),
  );
  expect(reply).toHaveProperty(
    "result.content.0.text",
    expect.stringContaining("Linked message"),
  );
});

it("enforces read-only scope even when a caller asks for a post tool", async () => {
  const { client, publish } = fixture();
  const call = await respondExternal(
    client,
    {
      id: 1,
      method: "tools/call",
      params: {
        name: "send",
        arguments: { channel: "chan", text: "blocked", audience: "everyone" },
      },
    },
    () => {},
    ["read"],
  );
  expect(call).toHaveProperty("result.isError", true);
  expect(publish).not.toHaveBeenCalled();
  const list = await respondExternal(
    client,
    { id: 2, method: "tools/list" },
    () => {},
    ["read"],
  );
  expect(list).toHaveProperty(
    "result.tools",
    expect.arrayContaining([expect.objectContaining({ name: "read" })]),
  );
  expect(list).toHaveProperty("result._meta", {
    "buzz/grantedScopes": ["read"],
    "buzz/supportedScopes": ["read", "post", "create"],
  });
  expect(list).toHaveProperty(
    "result.tools",
    expect.arrayContaining([
      expect.objectContaining({
        name: "send",
        _meta: { "buzz/requiredScopes": ["post"] },
      }),
    ]),
  );
  expect(call).toHaveProperty("result._meta.buzz/error", {
    code: "authorization_required",
    required_scopes: ["post"],
  });
  expect(publish).not.toHaveBeenCalled();
  const granted = ["read", "post"] as const;
  const explicit = await respondExternal(
    client,
    {
      id: 3,
      method: "tools/call",
      params: {
        name: "send",
        arguments: {
          channel: "chan",
          text: "After approval",
          audience: "everyone",
        },
      },
    },
    () => {},
    granted,
  );
  expect(explicit).toHaveProperty(
    "result.content.0.text",
    `sent ${"d".repeat(64)}`,
  );
  expect(publish).toHaveBeenCalledOnce();
});

it("does not expand existing read/post grants to create", async () => {
  const { call, defaultWorker, query, publish } = fixture();
  const reply = await call("channel_create", { name: "Triage" });
  expect(reply).toHaveProperty("result.isError", true);
  expect(reply).toHaveProperty("result._meta.buzz/error", {
    code: "authorization_required",
    required_scopes: ["create"],
  });
  expect(defaultWorker).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it.each([
  ["channel_list", {}, "read"],
  ["channel_get", { channel: "chan" }, "read"],
  ["read", { channel: "chan" }, "read"],
  ["send", { channel: "chan", text: "blocked", audience: "everyone" }, "post"],
  [
    "reply_in_subthread",
    { parent: "a".repeat(64), text: "blocked", audience: "everyone" },
    "post",
  ],
])(
  "does not grant %s through create-only consent",
  async (name, args, scope) => {
    const { call, defaultWorker, query, publish, read } = fixture();
    const reply = await call(name as string, args, ["create"]);
    expect(reply).toHaveProperty("result.isError", true);
    expect(reply).toHaveProperty("result._meta.buzz/error", {
      code: "authorization_required",
      required_scopes: [scope],
    });
    expect(defaultWorker).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);

it.each([
  {},
  { name: " " },
  { name: 123 },
  ...[
    "owner",
    "agent",
    "worker",
    "members",
    "visibility",
    "solo",
    "template",
    "type",
    "about",
    "ttl",
    "join_role",
  ].map((field) => ({ name: "Triage", [field]: "override" })),
])("rejects external Solo overrides or invalid names (%j)", async (args) => {
  const { call, defaultWorker, query, publish } = fixture();
  expect(await call("channel_create", args, ["create"])).toHaveProperty(
    "result.isError",
    true,
  );
  expect(defaultWorker).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it.each([{ owner: undefined }, { owner: "invalid" }, { pubkey: "invalid" }])(
  "rejects invalid authenticated Solo identities (%j)",
  async (identity) => {
    const { client, call, defaultWorker, publish } = fixture();
    Object.assign(client, identity);
    expect(
      await call("channel_create", { name: "Triage" }, ["create"]),
    ).toHaveProperty(
      "result.content.0.text",
      expect.stringContaining("Authorize the app again"),
    );
    expect(defaultWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);

it("rejects invalid or unreadable default-worker configuration before publication", async () => {
  const { call, defaultWorker, publish } = fixture();
  defaultWorker.mockResolvedValueOnce("invalid");
  expect(
    await call("channel_create", { name: "Triage" }, ["create"]),
  ).toHaveProperty(
    "result.content.0.text",
    "Choose and save a Bestie in Buzz, then try again.",
  );
  defaultWorker.mockRejectedValueOnce(
    new Error("Your saved Bestie could not be read."),
  );
  expect(
    await call("channel_create", { name: "Triage" }, ["create"]),
  ).toHaveProperty("result.isError", true);
  expect(publish).not.toHaveBeenCalled();
});

function soloFixture() {
  const f = fixture();
  f.query.mockImplementation(async (filters) => {
    const created = f.publish.mock.lastCall?.[0];
    if (!created) return [];
    const id = created.tags.find(([key]) => key === "h")?.[1] as string;
    const kind = (filters[0]?.kinds as number[] | undefined)?.[0] ?? 0;
    const tags =
      kind === 39000
        ? [
            ["d", id],
            ["name", "Triage"],
            ["private"],
            ["t", "stream"],
            ["t", "buzz.solo"],
            ["t", "buzz.session.named"],
          ]
        : kind === 39002
          ? [
              ["d", id],
              ["p", f.client.pubkey, "", "owner"],
              ...created.tags.filter(([key]) => key === "p"),
            ]
          : undefined;
    return tags
      ? [
          {
            id: "e".repeat(64),
            pubkey: f.client.pubkey,
            created_at: 1,
            kind,
            content: "",
            tags,
            sig: "",
          },
        ]
      : [];
  });
  return f;
}

it.each(["a".repeat(64), "b".repeat(64), "c".repeat(64)])(
  "creates only a private Solo and deduplicates the worker %s",
  async (worker) => {
    const { call, client, defaultWorker, publish } = soloFixture();
    defaultWorker.mockResolvedValue(worker);
    const reply = await call("channel_create", { name: "Triage" }, ["create"]);
    expect(reply).not.toHaveProperty("result.isError", true);
    expect(reply).toHaveProperty(
      "result.content.0.text",
      expect.not.stringContaining("did not keep the Solo label"),
    );
    expect(reply).toHaveProperty(
      "result.content.0.text",
      expect.stringMatching(/^created /),
    );
    expect(publish).toHaveBeenCalledOnce();
    const created = publish.mock.calls[0]?.[0];
    const members = [...new Set([client.owner, worker])].filter(
      (key) => key !== client.pubkey,
    );
    expect(created).toEqual({
      kind: 9007,
      content: "",
      tags: [
        ["h", expect.any(String)],
        ["name", "Triage"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["t", "buzz.solo"],
        ["t", "buzz.session.named"],
        ...members.map((key) => ["p", key]),
      ],
    });
    for (const member of members)
      expect(reply).toHaveProperty(
        "result.content.0.text",
        expect.stringContaining(`added ${member}`),
      );
  },
);

it("preserves relay refusal and unconfirmed creation results", async () => {
  const { call, publish } = soloFixture();
  publish.mockRejectedValueOnce(new Error("Relay refused a required member."));
  const refused = await call("channel_create", { name: "Triage" }, ["create"]);
  expect(refused).toHaveProperty("result.isError", true);
  expect(refused).toHaveProperty(
    "result.content.0.text",
    "Relay refused a required member.",
  );
  const pending = fixture();
  vi.useFakeTimers();
  try {
    const reply = pending.call("channel_create", { name: "Triage" }, [
      "create",
    ]);
    await vi.runAllTimersAsync();
    expect(await reply).toHaveProperty(
      "result.content.0.text",
      expect.stringMatching(
        /^The community accepted channel .+; its members are not confirmed\.$/,
      ),
    );
  } finally {
    vi.useRealTimers();
  }
});
