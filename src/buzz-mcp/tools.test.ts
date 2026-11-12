import { LIVE_CANVAS_BYTES } from "../features/channel-templates/model";
import {
  CANVAS_HISTORY_PAGE,
  CANVAS_MAX_EVENT_BYTES,
  CANVAS_READ_BYTES,
} from "../features/channel-templates/canvas-limits";
import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto } from "../features/relay/events";
import { keypair, signed } from "../features/relay/testing";
import type { BuzzClient, BuzzEvent, Filter, Memory, Template } from "./client";
import { respond } from "./rpc";
import { ATTENTION_TOOLS } from "./attention";
import { createHash } from "node:crypto";
import { callTool, memoryVersion, TOOLS } from "./tools";
import { callSessionTool, sessionTools } from "./session-tools";
import { PLUGIN_TOOLS } from "./plugins";
import { SETTINGS_TOOLS } from "./settings";
import { SOLO_WORKER_TOOLS } from "./solo-worker";
import { Context } from "@deepseek-ai/cordis";
import { AgentProtectionService } from "../features/agent-protection/service";
import type { Agent } from "../features/agents/service";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const me = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const root = "1".repeat(64);
const nested = "2".repeat(64);
const event = (fields: Partial<BuzzEvent>): BuzzEvent => ({
  id: "f".repeat(64),
  pubkey: alice,
  created_at: 100,
  kind: 9,
  tags: [["h", "chan"]],
  content: "",
  sig: "",
  ...fields,
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A community with `events` in it, answering filters by kind and a few tags,
 * newest first and a page at a time, as the relay does. */
function fake(
  events: readonly BuzzEvent[] = [],
  {
    keep = false,
    hidden = () => false,
  }: {
    keep?: boolean;
    /** Leaves an event out of a filter's results before its limit applies. */
    hidden?: (filter: Filter, item: BuzzEvent) => boolean;
  } = {},
) {
  // With keep, a publication joins the community as a fresh event.
  const kept: BuzzEvent[] = [];
  const published: Template[] = [];
  const matches = (filter: Filter, item: BuzzEvent) => {
    const tag = (name: string) =>
      item.tags.filter((t) => t[0] === name).map((t) => t[1]);
    const { since, until, before_id } = filter as {
      since?: number;
      until?: number;
      before_id?: string;
    };
    if (since !== undefined && item.created_at < since) return false;
    if (until !== undefined && item.created_at > until) return false;
    if (item.created_at === until && before_id && item.id <= before_id)
      return false;
    if (hidden(filter, item)) return false;
    return Object.entries(filter).every(([key, value]) => {
      if (key === "kinds") return (value as number[]).includes(item.kind);
      if (key === "ids") return (value as string[]).includes(item.id);
      if (key === "authors") return (value as string[]).includes(item.pubkey);
      if (key.startsWith("#"))
        return (value as string[]).some((v) => tag(key.slice(1)).includes(v));
      return true;
    });
  };
  const client: BuzzClient = {
    key: me,
    pubkey: me,
    effectiveEdit: vi.fn(async (id: string) => {
      const found = events.find((event) => event.id === id);
      if (!found) throw new Error("No effective edit fixture");
      return found;
    }),
    query: vi.fn(async (filters: readonly Filter[]) => {
      const newest = [...events, ...kept].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      );
      const found = filters.map((filter) =>
        newest
          .filter((item) => matches(filter, item))
          .slice(0, (filter.limit as number | undefined) ?? Infinity),
      );
      return newest.filter((item) => found.some((page) => page.includes(item)));
    }),
    publish: vi.fn(async (template: Template) => {
      published.push(template);
      const signed = keep
        ? event({
            ...template,
            pubkey: me,
            id: `${published.length}`.padStart(64, "e"),
            created_at: Math.floor(Date.now() / 1000),
          })
        : event({ ...template, pubkey: me, id: "e".repeat(64) });
      if (keep) kept.push(signed);
      return signed;
    }),
    upload: vi.fn(async (_data: Uint8Array, mime: string) => ({
      url: "https://relay/media/x.png",
      sha256: "ab",
      size: 7,
      type: mime,
      dim: "1x1",
    })),
    read: vi.fn(async (path: string) =>
      path.endsWith(".png") ? PNG : new TextEncoder().encode(`# ${path}`),
    ),
    memories: vi.fn(async () => ({
      entries: [{ slug: "mem/notes", body: "old", createdAt: 50 }],
      partial: false,
    })),
    remember: vi.fn(async () => undefined),
    media: vi.fn(async (url: string) =>
      url.endsWith(".png")
        ? {
            path: `/cache/${url}`,
            type: "image/png",
            size: PNG.length,
            data: btoa(String.fromCharCode(...PNG)),
          }
        : { path: `/cache/${url}`, type: "video/mp4", size: 3 },
    ),
  };
  return { client, published };
}

it.each([false, true])(
  "serves product help through MCP without channel access or host I/O (protected: %s)",
  async (protectedSession) => {
    const protect = vi.fn<NonNullable<BuzzClient["protect"]>>(async () => {});
    const client = new Proxy({} as BuzzClient, {
      get(_target, property) {
        // The shared session gate checks these optional hooks before dispatch.
        if (property === "protect")
          return protectedSession ? protect : undefined;
        if (property === "nativeToolGate") return undefined;
        // The tool list checks whether settings can change here.
        if (property === "settings") return undefined;
        throw new Error(`Help must not access the host: ${String(property)}`);
      },
    });
    const list = await respond(client, {}, { id: 1, method: "tools/list" });
    expect(list).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "buzz_help" }),
        ]),
      },
    });
    const reply = await respond(
      client,
      {},
      {
        id: 2,
        method: "tools/call",
        params: { name: "buzz_help", arguments: {} },
      },
    );
    expect(reply).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("# Buzz quick guide"),
          },
        ],
      },
    });
    expect(reply).not.toHaveProperty("result.isError");
    expect(protect.mock.calls.map(([action]) => action.kind)).toEqual(
      protectedSession ? ["tool", "tool-result"] : [],
    );
  },
);

const members = event({
  kind: 39002,
  tags: [
    ["d", "chan"],
    ["p", alice, "", "member"],
    ["p", bob, "", "admin"],
    ["p", me, "", "bot"],
  ],
});
const profile = (pubkey: string, name: string) =>
  event({ kind: 0, pubkey, content: JSON.stringify({ display_name: name }) });
const community = [
  members,
  profile(alice, "Alice Smith"),
  profile(bob, "Bob"),
  event({ id: root }),
  event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  }),
];

it.each([
  ["send", { audience: "everyone" }, "text"],
  ["reply_in_subthread", { audience: "everyone", parent: root }, "text"],
  ["mem_set", { slug: "captured" }, "text"],
  ["notes_set", { name: "captured", title: "Captured" }, "text"],
  ["canvas_set", {}, "content"],
] as const)(
  "reviews and writes the same captured file text for %s",
  async (name, input, field) => {
    const { client, published } = fake(
      [
        ...community,
        event({
          kind: 39000,
          tags: [
            ["d", "chan"],
            ["t", "stream"],
          ],
        }),
      ],
      { keep: true },
    );
    let source = "reviewed text";
    client.read = vi.fn(async () => new TextEncoder().encode(source));
    const entered = gate<void>();
    const approval = gate<void>();
    client.protect = vi.fn(async (action) => {
      if (action.kind !== "tool") return;
      entered.resolve(undefined);
      await approval.promise;
    });
    const args: Record<string, unknown> = {
      ...input,
      path: " body.md ",
      [field]: "ignored",
    };
    const result = callSessionTool(
      client,
      { channel: "chan", root },
      name,
      args,
    );
    try {
      await entered.promise;
      expect(client.protect).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "tool",
          content: { title: name, arguments: { ...input, [field]: source } },
        }),
      );
      expect(published).toEqual([]);
      expect(client.upload).not.toHaveBeenCalled();
      expect(client.remember).not.toHaveBeenCalled();
      source = "changed after review";
      args.path = "changed.md";
      args[field] = "changed caller text";
      approval.resolve(undefined);
      await result;
      expect(client.read).toHaveBeenCalledExactlyOnceWith("body.md");
      if (name === "mem_set")
        expect(client.remember).toHaveBeenCalledExactlyOnceWith(
          "mem/captured",
          "reviewed text",
          0,
        );
      else
        expect(published.map((event) => event.content)).toEqual([
          "reviewed text",
        ]);
    } finally {
      approval.resolve(undefined);
      await result.catch(() => undefined);
    }
  },
);

it.each(["read", "review"])(
  "does not write when file-backed %s fails",
  async (failure) => {
    const { client, published } = fake(community);
    client.protect = vi.fn(async () => {
      if (failure === "review") throw new Error("denied");
    });
    if (failure === "read")
      client.read = vi.fn(async () => {
        throw new Error("unreadable");
      });
    await expect(
      callSessionTool(client, { channel: "chan" }, "send", {
        audience: "everyone",
        path: "body.md",
      }),
    ).rejects.toThrow(failure === "read" ? "unreadable" : "denied");
    expect(published).toEqual([]);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.remember).not.toHaveBeenCalled();
  },
);

it.each(["send", "reply_in_subthread"])(
  "refuses protected %s attachments before reads or side effects",
  async (name) => {
    const { client, published } = fake(community);
    client.protect = vi.fn(async () => {});
    await expect(
      callSessionTool(client, { channel: "chan", root }, name, {
        audience: "everyone",
        parent: root,
        text: "hello",
        path: "body.md",
        files: ["shot.png"],
      }),
    ).rejects.toThrow("Protected attachment uploads are not supported");
    expect(client.read).not.toHaveBeenCalled();
    expect(client.protect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "tool-result",
        content: {
          error: expect.stringContaining(
            "Protected attachment uploads are not supported",
          ),
        },
      }),
    );
    expect(client.upload).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  },
);

it.each(["agent_create", "agent_update"])(
  "refuses protected %s pictures before reads or uploads",
  async (tool) => {
    const { client } = fake([]);
    client.protect = vi.fn(async () => {});
    client.createAgent = vi.fn();
    client.updateAgent = vi.fn();
    await expect(
      callSessionTool(client, {}, tool, {
        agent: "Child",
        type: "codex/codex",
        name: "Kid",
        picture: "me.png",
      }),
    ).rejects.toThrow("Protected picture uploads are not supported");
    expect(client.read).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(client.updateAgent).not.toHaveBeenCalled();
  },
);

it("enforces a plugin’s captured-file budget before review or publication", async () => {
  const { client, published } = fake(community);
  const ctx = new Context();
  const agent = {
    owner: alice,
    pubkey: me,
    name: "Worker",
    type: "test/worker",
    relay: "wss://relay.example",
    protection: { provider: "security.test", policy: {} },
  } as Agent;
  const service = new AgentProtectionService(
    ctx,
    () => ({ owner: alice, agents: [agent] }),
    {
      read: async () => ({ revision: 0, defaults: null }),
      save: async () => {},
      update: async () => {},
    },
  );
  ctx
    .extend({ pluginOwner: { id: "security.test", revision: "one" } })
    .agentProtection.register({
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      checkEvidence: async (_metadata, evidence) => {
        let size = 0;
        for await (const part of evidence.read())
          size += new TextEncoder().encode(part).length;
        return size <= 1024;
      },
    });
  const protection = service.bind(agent);
  if (!protection) throw new Error("Expected protected handle");
  client.protect = (action) =>
    protection.check(action, new AbortController().signal);
  client.read = vi.fn(async () => new TextEncoder().encode("x".repeat(1024)));
  try {
    await expect(
      callSessionTool(client, { channel: "chan" }, "send", {
        audience: "everyone",
        path: "large.md",
      }),
    ).rejects.toThrow("denied by its protection policy");
    expect(client.read).toHaveBeenCalledExactlyOnceWith("large.md");
    expect(client.upload).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  } finally {
    await ctx.fiber.dispose();
  }
});

it("replies in the current thread and notifies the members it names", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    text: "@Alice Smith see `@Bob`",
  });
  expect(published).toEqual([
    {
      kind: 9,
      content: "@Alice Smith see `@Bob`",
      tags: [
        ["h", "chan"],
        ["e", root, "", "reply"],
        ["p", alice],
      ],
    },
  ]);
});

// As a model that fills in every optional field sends it.
it("replies in the current thread when channel and reply are blank", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    text: "hi",
    channel: "",
    reply: "",
    path: "",
    files: [],
    mentions: [],
    final: true,
  });
  expect(published.at(-1)?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "reply"],
  ]);
});

it("tags a message for agents, and needs the audience said", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await callTool(client, context, "send", {
    text: "@Bob run the suite",
    audience: "agents",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "reply"],
    ["p", bob],
    ["audience", "agents"],
  ]);
  await expect(
    callTool(client, context, "send", { text: "hi" }),
  ).rejects.toThrow("audience must be everyone or agents");
  await expect(
    callTool(client, context, "send", { text: "hi", audience: "humans" }),
  ).rejects.toThrow("audience must be everyone or agents");
  expect(published).toHaveLength(1);
});

it("signs the turn's triggering request separately from the flattened reply", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  const request = "f".repeat(64);
  await callTool(client, context, "send", {
    text: "Checking",
    audience: "agents",
    request: request.toUpperCase(),
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "reply"],
    ["audience", "agents"],
    ["buzz:request", request],
  ]);
  for (const bad of ["", "nope", 7])
    await expect(
      callTool(client, context, "send", {
        text: "hi",
        audience: "agents",
        request: bad,
      }),
    ).rejects.toThrow("Not an event id");
  expect(published).toHaveLength(1);
});

it("refuses to post a name it cannot resolve unless told who it means", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await expect(
    callTool(client, context, "send", {
      audience: "everyone",
      text: "hi @Carol",
    }),
  ).rejects.toThrow("No single channel member is @carol");
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "hi @Carol",
    mentions: [bob],
  });
  expect(published[0]?.tags).toContainEqual(["p", bob]);
});

it("tags a member by the names the relay verified, ahead of names people gave themselves", async () => {
  const relay = keypair();
  // Signed and admitted, as a connection's query returns them.
  const verified = (
    subject: string,
    names: readonly string[][],
    { by = relay, at = 100, active = true } = {},
  ): BuzzEvent =>
    eventDto(
      signed(by, {
        kind: 30382,
        content: "",
        created_at: at,
        tags: [
          ["d", subject],
          ["p", subject],
          ["active", String(active)],
          ...(active
            ? [
                ["issuer_label", "Example"],
                ["verified_at", String(at)],
              ]
            : []),
          ...names,
        ],
      }),
    );
  const { client, published } = fake([
    ...community,
    verified(alice, [
      ["display_name", "Alice S"],
      ["username", "asmith"],
      ["full_name", "Alice Smith-Jones"],
    ]),
    // Bob's own profile claims Alice's verified name, and her username.
    profile(bob, "Alice S"),
    event({
      kind: 0,
      pubkey: bob,
      created_at: 101,
      content: JSON.stringify({ display_name: "Alice S", name: "asmith" }),
    }),
    // A name another key signed, one the relay retracted, and one the app
    // would reject give nobody.
    verified(
      bob,
      [
        ["display_name", "Forged"],
        ["username", "forged"],
      ],
      {
        by: keypair(),
      },
    ),
    verified(
      bob,
      [
        ["display_name", "Bobby"],
        ["username", "bobby"],
      ],
      {
        at: 90,
      },
    ),
    verified(bob, [], { at: 95, active: false }),
    verified(me, [
      ["display_name", "Bad"],
      ["username", "Not A Handle"],
    ]),
  ]);
  const tagged = { ...client, relayAuthor: relay.pubkey };
  const context = { channel: "chan", root };
  for (const text of [
    "@Alice S see this",
    "@asmith see this",
    "@alice smith-jones see this",
  ]) {
    await callTool(tagged, context, "send", { audience: "everyone", text });
    expect(published.at(-1)?.tags).toEqual([
      ["h", "chan"],
      ["e", root, "", "reply"],
      ["p", alice],
    ]);
  }
  for (const name of ["forged", "bobby", "bad"])
    await expect(
      callTool(tagged, context, "send", {
        audience: "everyone",
        text: `@${name} hi`,
      }),
    ).rejects.toThrow(`No single channel member is @${name}`);
  // Without the relay's key, verified names are not read at all, so only
  // the names people gave themselves are left.
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "@asmith hi",
  });
  expect(published.at(-1)?.tags).toContainEqual(["p", bob]);
});

it("replies to a message inside a thread at the thread's root, and posts a file's text and attachments", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: nested,
    path: "notes.md",
    files: ["shot.png", "docs/plan.pdf"],
  });
  expect(published[0]).toEqual({
    kind: 9,
    content:
      "# notes.md\n![shot.png](<https://relay/media/x.png>)\n[plan.pdf](<https://relay/media/x.png>)",
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
      [
        "imeta",
        "url https://relay/media/x.png",
        "m image/png",
        "x ab",
        "size 7",
        "dim 1x1",
        "filename shot.png",
      ],
      [
        "imeta",
        "url https://relay/media/x.png",
        "m application/octet-stream",
        "x ab",
        "size 7",
        "dim 1x1",
        "filename plan.pdf",
      ],
    ],
  });
});

it("posts at the channel's top level when given a channel", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    channel: "other",
    text: "hello",
  });
  expect(published[0]?.tags).toEqual([["h", "other"]]);
});

it("refuses to edit when the host cannot obtain effective attachment state", async () => {
  const { client, published } = fake(community);
  delete client.effectiveEdit;
  await expect(
    callTool(client, { channel: "chan" }, "edit", {
      id: root,
      text: "must not copy the original's attachments",
    }),
  ).rejects.toThrow("cannot obtain effective edit state");
  expect(published).toEqual([]);
});

it("tags the community emoji a message or edit uses, as the composer does", async () => {
  const stamp = "https://relay/media/stamp.png";
  const emojiSet = (pubkey: string, created_at: number, entries: string[][]) =>
    event({
      id: `${created_at}`.padStart(64, "d"),
      pubkey,
      created_at,
      kind: 30030,
      tags: [
        ["d", "buzz:custom-emoji"],
        ...entries.map((e) => ["emoji", ...e]),
      ],
    });
  const { client, published } = fake([
    ...community,
    // Alice's newer set replaces her older one, so its :gone: is not used.
    emojiSet(alice, 10, [["gone", "https://relay/media/gone.png"]]),
    emojiSet(alice, 20, [["pray-for-stamp", stamp]]),
    emojiSet(bob, 15, [["wave", "https://relay/media/wave.png"]]),
  ]);
  await callTool(client, { channel: "chan" }, "send", {
    audience: "everyone",
    channel: "chan",
    text: ":Pray-For-Stamp: :gone: :unknown: https://x.test/:wave: :pray-for-stamp:",
  });
  await callTool(client, { channel: "chan" }, "edit", {
    id: root,
    text: "now :wave:",
  });
  expect(published.map((p) => p.tags)).toEqual([
    [
      ["h", "chan"],
      ["emoji", "pray-for-stamp", stamp],
    ],
    [
      ["h", "chan"],
      ["e", root],
      ["emoji", "wave", "https://relay/media/wave.png"],
    ],
  ]);
});

it("reads no emoji sets for a message without a shortcode", async () => {
  const { client } = fake(community);
  await callTool(client, { channel: "chan" }, "send", {
    audience: "everyone",
    channel: "chan",
    text: "at 10:30 see https://x.test/a:b:c",
  });
  expect(client.query).not.toHaveBeenCalledWith([
    expect.objectContaining({ kinds: [30030] }),
  ]);
});

it("keeps a top-level chat out of threads, wherever a reply would resolve", async () => {
  const elsewhere = "3".repeat(64);
  const { client, published } = fake([
    ...community,
    event({ id: elsewhere, tags: [["h", "other"]] }),
  ]);
  const context = { channel: "chan", topLevel: true };
  const refused = "This chat stays at the top level: send again without reply.";
  // A reply alone takes its target's channel; a stale one is refused too.
  for (const args of [
    { reply: root },
    { reply: nested },
    { reply: root, channel: "chan" },
  ])
    await expect(
      callTool(client, context, "send", {
        audience: "everyone",
        text: "hi",
        ...args,
      }),
    ).rejects.toThrow(refused);
  for (const parent of [root, nested])
    await expect(
      callTool(client, context, "reply_in_subthread", {
        audience: "everyone",
        text: "hi",
        parent,
      }),
    ).rejects.toThrow("This chat stays at the top level: use send instead.");
  expect(published).toEqual([]);
  await callTool(client, context, "send", { audience: "everyone", text: "hi" });
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "there",
    reply: elsewhere,
  });
  expect(published.map((sent) => sent.tags)).toEqual([
    [["h", "chan"]],
    [
      ["h", "other"],
      ["e", elsewhere, "", "reply"],
    ],
  ]);
});

it("reads the current thread with each message's latest edit", async () => {
  const { client } = fake([
    ...community,
    event({
      kind: 40003,
      created_at: 120,
      content: "edited",
      tags: [
        ["h", "chan"],
        ["e", nested],
      ],
    }),
    // Newer, but not the author's, so it must not hide the author's edit.
    event({
      id: "e".repeat(64),
      kind: 40003,
      pubkey: bob,
      created_at: 130,
      content: "not theirs",
      tags: [
        ["h", "chan"],
        ["e", nested],
      ],
    }),
  ]);
  const text = (await callTool(
    client,
    { channel: "chan", root },
    "read",
    {},
  )) as string;
  expect(text.split("\n")).toEqual([
    `thread ${root} in chan`,
    `${root} from ${alice} "Alice Smith" at 1970-01-01T00:01Z: `,
    `${nested} from ${alice} "Alice Smith" at 1970-01-01T00:01Z: edited`,
    "The relay returned no older replies.",
  ]);
});

// As a model that fills in every optional field sends it.
it("reads the current thread when optional fields are blank or 0", async () => {
  const { client } = fake(community);
  const blank = (await callTool(client, { channel: "chan", root }, "read", {
    channel: "",
    thread: "",
    message_url: "",
    q: "",
    author: "",
    since: 0,
    before: 0,
    before_id: "",
    limit: 5,
  })) as string;
  expect(blank).toBe(
    await callTool(client, { channel: "chan", root }, "read", { limit: 5 }),
  );
  expect(blank).toContain(`thread ${root} in chan`);
});

it.each([
  ["channel", { channel: "chan" }],
  ["search", { q: "hello" }],
  ["current thread", {}],
  ["explicit thread", { thread: nested }],
  ["message link", { message_url: `buzz://message?channel=chan&id=${nested}` }],
  [
    "message search",
    { message_url: `buzz://message?channel=chan&id=${nested}`, q: "hello" },
  ],
] as const)(
  "keeps agent ownership and nested reply context in a %s read",
  async (_, args) => {
    const id = "3".repeat(64);
    const signature = "7".repeat(128);
    const auth = ["auth", bob, "kind=9&created_at<999", "8".repeat(128)];
    const message = event({
      id,
      content: "hello",
      sig: signature,
      tags: [
        ["h", "chan"],
        auth,
        ["e", root, "", "root"],
        ["e", nested, "", "reply"],
      ],
    });
    const { client } = fake([
      ...community,
      message,
      event({
        kind: 40003,
        created_at: 120,
        content: "hello, edited",
        tags: [["e", id]],
      }),
    ]);
    const response = (await respond(
      client,
      { channel: "chan", root },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read", arguments: args },
      },
    )) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(response.result.isError).not.toBe(true);
    const text = response.result.content.map((item) => item.text).join("\n");
    const line = text.split("\n").find((line) => line.startsWith(id));
    expect(line).toContain(`from ${alice} "Alice Smith" claimed owner ${bob}`);
    expect(line).toContain(`reply_to ${nested}`);
    expect(line).toContain("hello, edited");
    if ("channel" in args || "q" in args) expect(line).toContain(`re ${root}`);
    else expect(text.split("\n")[0]).toBe(`thread ${root} in chan`);
    // Human authors and direct replies keep their compact, unambiguous form.
    expect(
      text.split("\n").find((line) => line.startsWith(root)),
    ).not.toContain("owner");
    expect(
      text.split("\n").find((line) => line.startsWith(nested)),
    ).not.toContain("reply_to");
    for (const omitted of [signature, auth[2], auth[3]])
      expect(text).not.toContain(omitted);
    expect(message.tags).toContain(auth);
    expect(message.sig).toBe(signature);
  },
);

const reply = (id: string, created_at: number) =>
  event({
    id,
    created_at,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
const read = (client: BuzzClient, args: Record<string, unknown>) =>
  callTool(client, { channel: "chan", root }, "read", args) as Promise<string>;
/** The arguments a read says to continue with, if it says to. */
const next = (answer: string) => {
  const found = answer.match(/continue with (\{.*\})$/m)?.[1];
  return found ? (JSON.parse(found) as Record<string, unknown>) : undefined;
};

it("searches one author's messages since a time across channels, before the limit", async () => {
  const { client } = fake([
    profile(alice, "Alice Smith"),
    event({ id: "3".repeat(64), created_at: 50, content: "too old" }),
    event({
      id: "4".repeat(64),
      created_at: 200,
      content: "rollout done",
      tags: [["h", "other"]],
    }),
    // Newer messages from someone else that a limit applied first would keep.
    ...["5", "6", "7"].map((n) =>
      event({ id: n.repeat(64), pubkey: bob, created_at: 300 }),
    ),
  ]);
  const answer = await read(client, {
    q: "rollout",
    author: npubEncode(alice),
    since: 100,
    limit: 2,
  });
  expect(answer).toBe(
    `${"4".repeat(64)} from ${alice} "Alice Smith" in other at 1970-01-01T00:03Z: rollout done`,
  );
  // Without a channel, search still spans every channel it can read.
  expect(client.query).toHaveBeenCalledWith([
    {
      kinds: [9, 40002, 45001, 45003],
      search: "rollout",
      limit: 2,
      authors: [alice],
      since: 100,
    },
  ]);
  // A full page says more may match.
  expect(await read(client, { q: "x", limit: 1 })).toMatch(
    /\nResult limit reached; more matches may exist\. Narrow with channel, author, since or before\.$/,
  );
});

it("tells apart people with the same name, and where each message is", async () => {
  const { client } = fake([
    profile(alice, "Sam"),
    profile(bob, "Sam"),
    event({ id: "3".repeat(64), content: "ship it" }),
    event({
      id: "4".repeat(64),
      pubkey: bob,
      created_at: 120,
      content: "ship it too",
      tags: [
        ["h", "other"],
        ["e", root, "", "reply"],
      ],
    }),
  ]);
  expect((await read(client, { q: "ship" })).split("\n")).toEqual([
    `${"3".repeat(64)} from ${alice} "Sam" in chan at 1970-01-01T00:01Z: ship it`,
    `${"4".repeat(64)} from ${bob} "Sam" in other re ${root} at 1970-01-01T00:02Z: ship it too`,
  ]);
  // A channel read names the channel once, and each reply's thread.
  expect(
    (await read(client, { channel: "other", author: bob, since: 110 })).split(
      "\n",
    ),
  ).toEqual([
    "channel other",
    `${"4".repeat(64)} from ${bob} "Sam" re ${root} at 1970-01-01T00:02Z: ship it too`,
    "The relay returned no older messages.",
  ]);
});

it("pages a thread to its start, each reply once, through timestamp ties", async () => {
  const tied = ["4", "5", "6"].map((n) => n.repeat(64));
  const replies = [
    reply("3".repeat(64), 110),
    ...tied.map((id) => reply(id, 120)),
    reply("7".repeat(64), 130),
  ];
  const { client } = fake([
    profile(alice, "Alice Smith"),
    event({ id: root, created_at: 90 }),
    ...replies,
  ]);
  const ids = (answer: string) =>
    answer
      .split("\n")
      .slice(1, -1)
      .map((line) => line.slice(0, 64));
  const pages: string[][] = [];
  let args: Record<string, unknown> | undefined = { limit: 2 };
  let last = "";
  while (args) {
    last = await read(client, args);
    expect(last.split("\n")[0]).toBe(`thread ${root} in chan`);
    pages.push(ids(last));
    args = next(last);
    if (args) expect(last).toMatch(/\nOlder replies remain; continue with /);
    expect(pages.length).toBeLessThan(5);
  }
  // The root is on the first page only, and never counts toward its limit.
  expect(pages).toEqual([
    [root, tied[0], "7".repeat(64)],
    [tied[1], tied[2]],
    ["3".repeat(64)],
  ]);
  expect(last.split("\n").at(-1)).toBe("The relay returned no older replies.");
  // Exactly a limit of replies, with the root besides, is the whole thread.
  const whole = await read(client, { limit: replies.length });
  expect(ids(whole)).toHaveLength(replies.length + 1);
  expect(whole.split("\n").at(-1)).toBe("The relay returned no older replies.");
  // `before` alone bounds a thread read too, inclusively.
  expect(ids(await read(client, { thread: tied[1], before: 120 }))).toEqual([
    "3".repeat(64),
    ...tied,
  ]);
});

it("refuses read arguments it cannot apply, saying how to fix them", async () => {
  const { client } = fake(community);
  for (const [args, error] of [
    [{ q: "x", author: "alice" }, "author must be a hex pubkey or npub"],
    [{ q: "x", author: 7 }, "author must be a hex pubkey or npub"],
    [{ q: "x", since: "friday" }, "since must be Unix seconds"],
    [{ q: "x", since: -1 }, "since must be Unix seconds"],
    [{ q: "x", since: 1.5 }, "since must be Unix seconds"],
    [{ q: "x", since: 1_760_000_000_000 }, "since must be Unix seconds"],
    [{ q: "x", since: 200, before: 100 }, "since must not be after before"],
    [{ channel: "chan", before_id: root }, "before_id needs before"],
    [{ channel: "chan", before: 1, before_id: "x" }, "before_id must be"],
    [
      { q: "x", before: 1, before_id: root },
      "before_id pages thread and channel reads",
    ],
    [
      { author: alice },
      "author and since filter a search (q) or a channel read",
    ],
    [
      { thread: root, since: 1 },
      "author and since filter a search (q) or a channel read",
    ],
  ] as const)
    await expect(read(client, args), JSON.stringify(args)).rejects.toThrow(
      error,
    );
  expect(client.query).not.toHaveBeenCalled();
});

it("takes back its own reaction", async () => {
  const reaction = event({
    id: "9".repeat(64),
    kind: 7,
    pubkey: me,
    content: "👍",
    tags: [["e", root]],
  });
  const { client, published } = fake([...community, reaction]);
  await callTool(client, {}, "react", { id: root, emoji: "👍", off: true });
  expect(published).toEqual([
    { kind: 5, content: "", tags: [["e", reaction.id]] },
  ]);
});

it("replaces memory only at the version it was shown, newer than the entry it replaces", async () => {
  const { client } = fake();
  const shown = await callTool(client, {}, "mem_get", { slug: "notes" });
  const version = /^version: ([0-9a-f]{16})\n\nold$/.exec(String(shown))?.[1];
  // The version is the start of the SHA-256 of the text.
  expect(version).toBe(
    createHash("sha256").update("old").digest("hex").slice(0, 16),
  );
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toThrow(
    "mem/notes exists. Read it with mem_get, keep what still holds, and pass its version as expected.",
  );
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: "new",
      expected: "0".repeat(16),
    }),
  ).rejects.toThrow(/^mem\/notes changed since version 0{16}\. Read it again/);
  // Writing back the whole mem_get reply would save its header.
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: `${shown}\nnew`,
      expected: version,
    }),
  ).rejects.toThrow(
    "Leave out the version line from mem_get; pass the version as expected.",
  );
  expect(client.remember).not.toHaveBeenCalled();
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: "new",
      expected: version,
    }),
  ).resolves.toBe(`saved; version ${await memoryVersion("new")}`);
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 50);
  // Every read is of the one entry by its slug, not the whole listing.
  expect(vi.mocked(client.memories).mock.calls).toEqual([
    ["mem/notes"],
    ["mem/notes"],
    ["mem/notes"],
    ["mem/notes"],
  ]);
  // Without an entry, expected names nothing to replace.
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: false });
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "gone",
      text: "x",
      expected: version,
    }),
  ).rejects.toThrow(
    "No memory mem/gone to replace; leave out expected to create it.",
  );
});

it("deletes memory only at the version it was shown, and never core", async () => {
  const { client } = fake();
  await expect(
    callTool(client, {}, "mem_rm", { slug: "notes", expected: "0".repeat(16) }),
  ).rejects.toThrow(
    "mem/notes changed since version 0000000000000000. Read it again with mem_get before you delete it.",
  );
  await expect(
    callTool(client, {}, "mem_rm", { slug: "core", expected: "0".repeat(16) }),
  ).rejects.toThrow("core cannot be deleted; replace it with mem_set.");
  await expect(
    callTool(client, {}, "mem_rm", { slug: "notes" }),
  ).rejects.toThrow("expected is required.");
  expect(client.remember).not.toHaveBeenCalled();
  await expect(
    callTool(client, {}, "mem_rm", {
      slug: "notes",
      expected: await memoryVersion("old"),
    }),
  ).resolves.toBe("deleted mem/notes");
  // A tombstone, dated after the entry it deletes.
  expect(client.remember).toHaveBeenCalledWith("mem/notes", null, 50);
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: true });
  await expect(
    callTool(client, {}, "mem_rm", { slug: "gone", expected: "0".repeat(16) }),
  ).rejects.toThrow("Memory mem/gone could not be read; try again.");
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: false });
  await expect(
    callTool(client, {}, "mem_rm", { slug: "gone", expected: "0".repeat(16) }),
  ).rejects.toThrow("No memory mem/gone.");
  // Recreating a deleted entry is dated after its tombstone.
  vi.mocked(client.memories).mockResolvedValue({
    entries: [],
    deleted: [{ slug: "mem/gone", createdAt: 70 }],
    partial: false,
  });
  await callTool(client, {}, "mem_set", { slug: "gone", text: "back" });
  expect(client.remember).toHaveBeenLastCalledWith("mem/gone", "back", 70);
});

it("refuses to overwrite core that another session changed since this one read it", async () => {
  const { client } = fake();
  let core = "I am Gander.";
  vi.mocked(client.memories).mockImplementation(async () => ({
    entries: [{ slug: "core", body: core, createdAt: 10 }],
    partial: false,
  }));
  const first = await memoryVersion(core);
  // Another session of the agent adds a line after this one read `core`.
  core = "I am Gander.\nShip on Fridays.";
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: "I am Gander.\nUse pnpm.",
      expected: first,
    }),
  ).rejects.toThrow(`core changed since version ${first}.`);
  expect(client.remember).not.toHaveBeenCalled();
  // Merging into what is there now saves, and says how big core is.
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: `${core}\nUse pnpm.`,
      expected: await memoryVersion(core),
    }),
  ).resolves.toMatch(/^saved; version [0-9a-f]{16}; core is 39 bytes\.$/);
  core = "x".repeat(12_000);
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: "y".repeat(12_345),
      expected: await memoryVersion(core),
    }),
  ).resolves.toMatch(
    /; core is 12\.3 KB, over the ~10 KB target\. Move detail you do not need every turn to a mem\/ slug\.$/,
  );
});

it("searches all memory for entries with every word, newest first", async () => {
  const { client } = fake();
  const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
  const entries: Memory[] = [
    { slug: "core", body: "I am Gander.\nRelease on Fridays.", createdAt: 30 },
    {
      slug: "mem/release",
      body: "Release steps\nTag, then RELEASE notes.\nunrelated",
      createdAt: 20,
    },
    { slug: "mem/old", body: `fridays only\n${long}`, createdAt: 10 },
    ...Array.from({ length: 21 }, (_, i) => ({
      slug: `mem/bulk/${i}`,
      body: "bulk",
      createdAt: i,
    })),
  ];
  vi.mocked(client.memories).mockResolvedValue({ entries, partial: false });
  const at = (seconds: number) =>
    `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`;
  await expect(callTool(client, {}, "mem_get", { q: "release" })).resolves.toBe(
    [
      `core ${at(30)}`,
      "  Release on Fridays.",
      `mem/release ${at(20)}`,
      "  Release steps",
      "  Tag, then RELEASE notes.",
    ].join("\n"),
  );
  // Every word must match, in the slug or the text.
  await expect(
    callTool(client, {}, "mem_get", { q: "Fridays  release" }),
  ).resolves.toBe(`core ${at(30)}\n  Release on Fridays.`);
  // A long line is cut around its match.
  const cut = await callTool(client, {}, "mem_get", { q: "needle" });
  expect(cut).toBe(`mem/old ${at(10)}\n  …${long.slice(161, 321)}…`);
  expect(String(cut)).toContain("needle");
  // Twenty entries at most, then how many more.
  const bulk = String(await callTool(client, {}, "mem_get", { q: "bulk" }));
  expect(
    bulk.split("\n").filter((line) => line.startsWith("mem/")),
  ).toHaveLength(20);
  expect(bulk).toMatch(/^mem\/bulk\/20 /);
  expect(bulk).toMatch(/\n1 more; add words to q to narrow it\.$/);
  await expect(callTool(client, {}, "mem_get", { q: "zebra" })).resolves.toBe(
    "No memory matches zebra.",
  );
  await expect(
    callTool(client, {}, "mem_get", { q: "release", slug: "core" }),
  ).rejects.toThrow("q searches all memory; leave out slug.");
  await expect(callTool(client, {}, "mem_get", { q: " " })).rejects.toThrow(
    "q needs a word to search for.",
  );
  vi.mocked(client.memories).mockResolvedValue({ entries, partial: true });
  await expect(callTool(client, {}, "mem_get", { q: "steps" })).resolves.toBe(
    `mem/release ${at(20)}\n  Release steps\nThis search is incomplete: some memory could not be read.`,
  );
  await expect(callTool(client, {}, "mem_get", { q: "zebra" })).rejects.toThrow(
    "Memory could not be read; try again.",
  );
});

it("never reports memory cut short by a limit as missing", async () => {
  const { client } = fake();
  const partial = (entries: Memory[]) =>
    vi.mocked(client.memories).mockResolvedValue({ entries, partial: true });
  partial([]);
  await expect(callTool(client, {}, "mem_get", {})).rejects.toThrow(
    "Memory could not be read; try again.",
  );
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).rejects.toThrow("Memory mem/notes could not be read; try again.");
  // A write needs the entry it replaces: a partial read that missed it, or a
  // failed read, writes nothing.
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toThrow("Memory mem/notes could not be read; try again.");
  // A failed lookup reaches the caller as it is, so denial or a lost
  // connection is not reported as a retryable read.
  const denied = new Error("Buzz is not connected");
  vi.mocked(client.memories).mockRejectedValueOnce(denied);
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toBe(denied);
  expect(client.remember).not.toHaveBeenCalled();
  partial([{ slug: "mem/a", body: "a", createdAt: 0 }]);
  await expect(callTool(client, {}, "mem_get", {})).resolves.toMatch(
    /^mem\/a .*\nThis list is incomplete: some memory could not be read\.$/,
  );
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: false });
  await expect(callTool(client, {}, "mem_get", {})).resolves.toBe("No memory.");
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).resolves.toBe("No memory mem/notes.");
  // Only a complete read that confirms the entry is missing writes it fresh.
  await callTool(client, {}, "mem_set", { slug: "notes", text: "new" });
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 0);
});

it("answers MCP requests, reporting a failed call as a tool error", async () => {
  const { client } = fake(community);
  const init = await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
  );
  expect(init).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  const list = (await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((tool) => tool.name)).toContain("send");
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { text: "hi" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "channel is required here." }],
      isError: true,
    },
  });
});

it("replies in the channel of the message it answers", async () => {
  const elsewhere = event({ id: "3".repeat(64), tags: [["h", "other"]] });
  const { client, published } = fake([...community, elsewhere]);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: elsewhere.id,
    text: "over here",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "other"],
    ["e", elsewhere.id, "", "reply"],
  ]);
});

it("refuses a memory slug the community would not list", async () => {
  const { client } = fake();
  await expect(
    callTool(client, {}, "mem_set", { slug: "My Notes", text: "x" }),
  ).rejects.toThrow("Bad slug");
});

it("lists its tools before it can call them", async () => {
  const list = (await respond(
    undefined,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: unknown[] } };
  // Every app session lists the same tools: the Buzz, attention, Solo worker,
  // plugin and settings tools.
  expect(list.result.tools).toHaveLength(
    TOOLS.length +
      ATTENTION_TOOLS.length +
      SOLO_WORKER_TOOLS.length +
      PLUGIN_TOOLS.length +
      SETTINGS_TOOLS.length,
  );
  await expect(
    respond(
      undefined,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read", arguments: {} },
      },
    ),
  ).resolves.toMatchObject({ result: { isError: true } });
});

it("shows a media image to the agent, and gives any media's saved path", async () => {
  const { client } = fake();
  const png = btoa(String.fromCharCode(...PNG));
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "media_get", arguments: { url: "abc.png" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        {
          type: "text",
          text: `Saved /cache/abc.png (image/png, ${PNG.length} bytes).`,
        },
      ],
    },
  });
  expect(client.media).toHaveBeenCalledWith("abc.png");
  await expect(
    callTool(client, {}, "media_get", { url: "abc.mp4" }),
  ).resolves.toBe(
    "Saved /cache/abc.mp4 (video/mp4, 3 bytes). Open it with your own tools.",
  );
});

const room = "0e4c2f1a-8b3d-4c5e-9f60-718293a4b5c6";
type Tags = readonly (readonly string[])[];
/** A community that makes the channel changes it accepts, refusing any that
 * target a pubkey in `refused`. */
function relay(refused: Readonly<Record<string, string>> = {}) {
  const state: BuzzEvent[] = [
    event({
      kind: 39000,
      tags: [
        ["d", room],
        ["name", "plans"],
        ["about", "roadmap"],
        ["t", "stream"],
      ],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", room],
        ["t", "stream"],
        ["p", me, "", "owner"],
        ["p", alice, "", "member"],
      ],
    }),
    profile(alice, "Alice Smith"),
  ];
  // Like the relay, this leaves system channels out of a filter that neither
  // opts in with `#t` nor names them by `#d`, before the filter's limit.
  const { client, published } = fake(state, {
    hidden: (filter, item) =>
      item.tags.some((t) => t[0] === "t" && t[1] === "system") &&
      !(filter["#t"] as string[] | undefined)?.includes("system") &&
      !(filter["#d"] as string[] | undefined)?.includes(
        item.tags[0]?.[1] ?? "",
      ),
  });
  /** Replaces channel `id`'s state event of `kind` with one tagged anew. */
  const put = (kind: number, id: string, change: (tags: Tags) => Tags) => {
    const at = state.findIndex((e) => e.kind === kind && e.tags[0]?.[1] === id);
    const now = state[at];
    if (now)
      state[at] = { ...now, tags: [["d", id], ...change(now.tags.slice(1))] };
  };
  const without = (tags: Tags, key: string) =>
    tags.filter((t) => t[0] !== key && t[1] !== key);
  client.publish = vi.fn(async (template: Template) => {
    const id = template.tags.find((t) => t[0] === "h")?.[1] ?? "";
    const target = template.tags.find((t) => t[0] === "p")?.[1] ?? "";
    // Like the relay, any refused member keeps a whole create out.
    const refusal = (
      template.kind === 9007
        ? template.tags.flatMap(([key, value]) => (key === "p" ? [value] : []))
        : [target]
    ).find((key) => key && refused[key]);
    if (refusal) throw new Error(refused[refusal]);
    published.push(template);
    const { kind } = template;
    if (kind === 9007) {
      // The relay states the channel's type as the first `t` tag of both
      // state events, and privacy as a bare `private` tag.
      const value = (key: string) =>
        template.tags.find((t) => t[0] === key)?.[1];
      const type = ["t", value("channel_type") ?? "stream"];
      // Labels follow the type; `p` members join in the create.
      const labels = template.tags.filter((t) => t[0] === "t");
      const members = template.tags.flatMap(([key, value]) =>
        key === "p" && value ? [["p", value, "", "member"]] : [],
      );
      state.push(
        event({
          kind: 39000,
          tags: [
            ["d", id],
            ["name", value("name") ?? ""],
            type,
            ...labels,
            ...(value("visibility") === "private" ? [["private"]] : []),
          ],
        }),
        event({
          kind: 39002,
          tags: [["d", id], type, ["p", me, "", "owner"], ...members],
        }),
      );
    }
    if (kind === 9000 || kind === 9021) {
      const key = kind === 9021 ? me : target;
      // Like the relay, with no role asked for a member keeps theirs and a
      // new one gets the channel's join_role.
      const tags = (kind: number) =>
        state.find((e) => e.kind === kind && e.tags[0]?.[1] === id)?.tags ?? [];
      const role =
        template.tags.find((t) => t[0] === "role")?.[1] ??
        tags(39002).find((t) => t[0] === "p" && t[1] === key)?.[3] ??
        tags(39000).find((t) => t[0] === "join_role")?.[1] ??
        "member";
      put(39002, id, (tags) => [...without(tags, key), ["p", key, "", role]]);
    }
    if (kind === 9001 || kind === 9022)
      put(39002, id, (tags) => without(tags, kind === 9022 ? me : target));
    if (kind === 9002)
      for (const [key = "", value = ""] of template.tags.slice(1))
        put(39000, id, (tags) => {
          if (key === "visibility")
            return [
              ...without(tags, "private"),
              ...(value === "private" ? [["private"]] : []),
            ];
          return [
            ...without(tags, key),
            ...(value && value !== "false" ? [[key, value]] : []),
          ];
        });
    if (kind === 9008)
      state.splice(
        0,
        state.length,
        ...state.filter((e) => e.tags[0]?.[1] !== id),
      );
    return event({ ...template, pubkey: me, id: "e".repeat(64) });
  });
  return { client, published, state };
}

it("lists channels it can join as well as its own", async () => {
  const { client, state } = relay();
  state.push(
    event({
      kind: 39000,
      tags: [["d", "other"], ["name", "lobby"], ["t", "forum"], ["private"]],
    }),
  );
  await expect(
    callTool(client, {}, "channel_list", { all: true }),
  ).resolves.toBe(`${room} plans\nother lobby (forum, private, not joined)`);
  await expect(callTool(client, {}, "channel_list", {})).resolves.toBe(
    `${room} plans`,
  );
});

it("lists only the channel types asked for", async () => {
  const { client, state } = relay();
  const forum = "7d9a4e3f-5c6b-4d8e-8f1a-2b3c4d5e6f70";
  state.push(
    event({
      kind: 39000,
      tags: [
        ["d", forum],
        ["name", "ideas"],
        ["t", "forum"],
      ],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", forum],
        ["t", "forum"],
        ["p", me, "", "member"],
      ],
    }),
    event({
      kind: 39000,
      tags: [["d", "other"], ["name", "lobby"], ["t", "forum"], ["private"]],
    }),
  );
  await expect(callTool(client, {}, "channel_list", {})).resolves.toBe(
    `${room} plans\n${forum} ideas (forum)`,
  );
  await expect(
    callTool(client, {}, "channel_list", { types: ["forum"] }),
  ).resolves.toBe(`${forum} ideas (forum)`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["stream"], all: true }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["forum"], all: true }),
  ).resolves.toBe(
    `${forum} ideas (forum)\nother lobby (forum, private, not joined)`,
  );
  for (const types of [[], ["channel"], "forum", [7]])
    await expect(
      callTool(client, {}, "channel_list", { types }),
    ).rejects.toThrow(
      "types must list some of stream, forum, dm, workflow, system.",
    );
});

it("keeps a roster signed before NIP-CL joined when listing by type", async () => {
  const { client, state } = relay();
  // NIP-CL: an older roster event can lack the type tag.
  const roster = state.findIndex((e) => e.kind === 39002);
  const old = state[roster] as BuzzEvent;
  state[roster] = { ...old, tags: old.tags.filter((t) => t[0] !== "t") };
  await expect(
    callTool(client, {}, "channel_list", { types: ["stream"] }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["stream"], all: true }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["forum"], all: true }),
  ).resolves.toBe("No channels.");
});

it("lists system channels only when asked, as the relay serves them", async () => {
  const { client, state } = relay();
  const system = "5b7e2c1d-3a4f-4b6c-8d9e-0f1a2b3c4d5e";
  const lobby = "6c8f3d2e-4b5a-4c7d-9e0f-1a2b3c4d5e6f";
  state.push(
    event({
      kind: 39000,
      tags: [["d", system], ["name", "config"], ["t", "system"], ["private"]],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", system],
        ["t", "system"],
        ["p", me, "", "owner"],
      ],
    }),
    event({
      kind: 39000,
      tags: [
        ["d", lobby],
        ["name", "ops"],
        ["t", "system"],
      ],
    }),
  );
  await expect(callTool(client, {}, "channel_list", {})).resolves.toBe(
    `${room} plans`,
  );
  await expect(
    callTool(client, {}, "channel_list", { all: true }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["system"] }),
  ).resolves.toBe(`${system} config (system, private)`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["system"], all: true }),
  ).resolves.toBe(
    `${system} config (system, private)\n${lobby} ops (system, not joined)`,
  );
});

it("creates a system channel", async () => {
  const { client, published } = relay();
  const answer = await callTool(client, {}, "channel_create", {
    name: "config",
    visibility: "private",
    type: "system",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published).toEqual([
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "config"],
        ["visibility", "private"],
        ["channel_type", "system"],
      ],
    },
  ]);
  expect(answer).toBe(`created ${id}`);
  await expect(
    callTool(client, {}, "channel_list", { types: ["system"] }),
  ).resolves.toBe(`${id} config (system, private)`);
  await expect(callTool(client, {}, "channel_list", {})).resolves.toBe(
    `${room} plans`,
  );
  await expect(
    callTool(client, {}, "channel_list", { types: ["stream", "system"] }),
  ).resolves.toBe(`${room} plans\n${id} config (system, private)`);
  await expect(
    callTool(client, {}, "channel_create", {
      name: "config",
      visibility: "private",
      type: "dm",
    }),
  ).rejects.toThrow("type must be stream, forum or system.");
});

it("creates a Solo chat with its members in the create, as Buzz does", async () => {
  const { client, published } = relay();
  const answer = await callTool(client, {}, "channel_create", {
    name: "triage",
    visibility: "private",
    solo: true,
    members: [alice, npubEncode(bob), alice, me],
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published).toEqual([
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "triage"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["t", "buzz.solo"],
        ["t", "buzz.session.named"],
        ["p", alice],
        ["p", bob],
      ],
    },
  ]);
  expect(answer).toBe(
    `created ${id}\nadded ${alice} Alice Smith\nadded ${bob}`,
  );
  await expect(
    callTool(client, {}, "channel_get", { channel: id }),
  ).resolves.toBe(`${id} triage (stream, solo, private)\nyou: owner`);
  await expect(
    callTool(client, {}, "member_list", { channel: id }),
  ).resolves.toBe(`${me}  (owner)\n${alice} Alice Smith\n${bob} `);
  // An ordinary private channel is not Solo.
  await callTool(client, {}, "channel_create", {
    name: "ops",
    visibility: "private",
  });
  const plain = published[1]?.tags[0]?.[1] as string;
  expect(published[1]?.tags.some(([key]) => key === "t" || key === "p")).toBe(
    false,
  );
  await expect(
    callTool(client, {}, "channel_get", { channel: plain }),
  ).resolves.toBe(`${plain} ops (stream, private)\nyou: owner`);
});

it("discovers local workspaces and files only after creating a Solo with explicit members", async () => {
  const { client, published } = relay();
  const file = vi.fn(async () => ({ status: "filed" as const }));
  const list = vi.fn(async () => [{ id: "work", name: "Work" }]);
  const prepare = vi.fn(async () => file);
  client.soloWorkspaces = { list, prepare };
  expect(await callTool(client, {}, "solo_workspace_list", {})).toBe(
    JSON.stringify([{ id: "work", name: "Work" }]),
  );
  const answer = await callTool(client, {}, "channel_create", {
    name: "triage",
    visibility: "private",
    solo: true,
    members: [alice],
    workspace: "work",
  });
  const id = published[0]?.tags[0]?.[1];
  expect(prepare).toHaveBeenCalledExactlyOnceWith("work", [alice], id);
  expect(file).toHaveBeenCalledExactlyOnceWith(id);
  expect(answer).toBe(
    `created ${id}\nadded ${alice} Alice Smith\nfiled in workspace work`,
  );
  expect(published).toHaveLength(1);
  expect(published[0]?.kind).toBe(9007);
});

it("rejects unsupported or invalid workspace placement before publication", async () => {
  const { client, published } = relay();
  const args = {
    name: "triage",
    visibility: "private",
    solo: true,
    members: [alice],
    workspace: "work",
  };
  await expect(callTool(client, {}, "solo_workspace_list", {})).rejects.toThrow(
    "unavailable on this host",
  );
  await expect(callTool(client, {}, "channel_create", args)).rejects.toThrow(
    "unavailable on this host",
  );
  const prepare = vi.fn(async () => {
    throw new Error("No such workspace");
  });
  client.soloWorkspaces = { list: async () => [], prepare };
  await expect(
    callTool(client, {}, "channel_create", {
      ...args,
      solo: false,
      members: undefined,
    }),
  ).rejects.toThrow("workspace is for Solo");
  await expect(callTool(client, {}, "channel_create", args)).rejects.toThrow(
    "No such workspace",
  );
  expect(published).toEqual([]);
});

it.each([
  "deleted target",
  "record full",
  "revision conflict",
  "community changed",
])("keeps the created chat ID when filing fails: %s", async (message) => {
  const { client, published } = relay();
  const file = vi.fn(async () => {
    throw new Error(message);
  });
  client.soloWorkspaces = { list: async () => [], prepare: async () => file };
  const answer = await callTool(client, {}, "channel_create", {
    name: "triage",
    visibility: "private",
    solo: true,
    members: [alice],
    workspace: "work",
  });
  const id = published[0]?.tags[0]?.[1];
  expect(answer).toContain(`created ${id}`);
  expect(answer).toContain(
    `workspace placement unconfirmed and may have completed: ${message}`,
  );
  expect(answer).toContain("do not create another chat");
  expect(published).toHaveLength(1);
  expect(file).toHaveBeenCalledOnce();
});

it.each(["not-filed", "unconfirmed"] as const)(
  "reports structured placement outcome without repeating create: %s",
  async (status) => {
    const { client, published } = relay();
    client.soloWorkspaces = {
      list: async () => [],
      prepare: async () => async () => ({ status, error: "placement stopped" }),
    };
    const answer = await callTool(client, {}, "channel_create", {
      name: "triage",
      visibility: "private",
      solo: true,
      members: [alice],
      workspace: "work",
    });
    expect(answer).toContain(`created ${published[0]?.tags[0]?.[1]}`);
    expect(answer).toContain(
      status === "not-filed"
        ? "created, not filed"
        : "placement unconfirmed and may have completed",
    );
    if (status === "unconfirmed")
      expect(answer).toContain("Inspect or refresh");
    expect(published).toHaveLength(1);
  },
);

it("reports uncertainty after a gated durable placement loses its app lifetime", async () => {
  const { client, published } = relay();
  let release!: () => void;
  const delivered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const enqueued = new Promise<void>((resolve) => {
    started = resolve;
  });
  let durable = false;
  client.soloWorkspaces = {
    list: async () => [],
    prepare: async () => async () => {
      durable = true;
      started();
      await delivered;
      throw new Error("retired after durable placement");
    },
  };
  const pending = callTool(client, {}, "channel_create", {
    name: "triage",
    visibility: "private",
    solo: true,
    members: [alice],
    workspace: "work",
  });
  try {
    await enqueued;
    expect(durable).toBe(true);
    expect(published).toHaveLength(1);
  } finally {
    release();
  }
  const answer = await pending;
  expect(answer).toContain(`created ${published[0]?.tags[0]?.[1]}`);
  expect(answer).toContain("placement unconfirmed and may have completed");
  expect(answer).toContain("Inspect or refresh");
  expect(answer).not.toContain("not filed");
});

it("refuses Solo arguments that do not fit, before publishing", async () => {
  const { client, published } = relay();
  const create = (args: Record<string, unknown>) =>
    callTool(client, {}, "channel_create", {
      name: "x",
      visibility: "private",
      ...args,
    });
  const shape = "A Solo chat is a private stream without about or template.";
  await expect(create({ solo: true, visibility: "open" })).rejects.toThrow(
    shape,
  );
  await expect(create({ solo: true, type: "forum" })).rejects.toThrow(shape);
  await expect(create({ solo: true, about: "notes" })).rejects.toThrow(shape);
  await expect(create({ solo: true, template: "Triage" })).rejects.toThrow(
    shape,
  );
  for (const members of [[alice], ["alice"], alice])
    await expect(create({ members })).rejects.toThrow(
      "members is for Solo chats.",
    );
  await expect(create({ solo: true, members: ["alice"] })).rejects.toThrow(
    "Not a pubkey: alice",
  );
  await expect(create({ solo: true, members: alice })).rejects.toThrow(
    "members must be a list of pubkeys.",
  );
  await expect(create({ solo: "true" })).rejects.toThrow(
    "solo must be true or false.",
  );
  const many = Array.from({ length: 33 }, (_, n) =>
    n.toString(16).padStart(64, "0"),
  );
  await expect(create({ solo: true, members: many })).rejects.toThrow(
    "A Solo chat starts with at most 32 members.",
  );
  expect(published).toEqual([]);
});

it("starts a Solo chat with the relay's maximum of 32 members", async () => {
  const { client, published } = relay();
  const members = Array.from({ length: 32 }, (_, n) =>
    (n + 1).toString(16).padStart(64, "0"),
  );
  await callTool(client, {}, "channel_create", {
    name: "x",
    visibility: "private",
    solo: true,
    members: [...members, me],
  });
  expect(
    published[0]?.tags.filter(([key]) => key === "p").map(([, key]) => key),
  ).toEqual(members);
});

it("creates no Solo chat when a member refuses, and says what it cannot confirm", async () => {
  const { client, published, state } = relay({
    [alice]: "blocked: this agent only joins its owner's channels",
  });
  await expect(
    callTool(client, {}, "channel_create", {
      name: "triage",
      visibility: "private",
      solo: true,
      members: [bob, alice],
    }),
  ).rejects.toThrow("blocked: this agent only joins its owner's channels");
  expect(published).toEqual([]);
  expect(state.filter((e) => e.kind === 39000)).toHaveLength(1);

  vi.useFakeTimers();
  try {
    // A relay without channel labels drops them and keeps the channel.
    const publish = client.publish;
    client.publish = vi.fn(async (template: Template) =>
      publish({
        ...template,
        tags: template.tags.filter(([key]) => key !== "t"),
      }),
    );
    let answer = callTool(client, {}, "channel_create", {
      name: "triage",
      visibility: "private",
      solo: true,
      members: [bob],
    });
    await vi.runAllTimersAsync();
    let id = published.at(-1)?.tags[0]?.[1] as string;
    await expect(answer).resolves.toBe(
      `created ${id}\nThe community did not keep the Solo label, so it is an ordinary private channel.\nadded ${bob}`,
    );
    // A create the community never shows leaves its members unconfirmed.
    client.query = vi.fn(async () => []);
    answer = callTool(client, {}, "channel_create", {
      name: "triage",
      visibility: "private",
      solo: true,
      members: [bob],
    });
    await vi.runAllTimersAsync();
    id = published.at(-1)?.tags[0]?.[1] as string;
    await expect(answer).resolves.toBe(
      `The community accepted channel ${id} but does not show it yet; its members are not confirmed.`,
    );
  } finally {
    vi.useRealTimers();
  }
});

it("finds a channel past the relay's first page, by name and then by ID", async () => {
  const { client, state, published } = relay();
  const channel = (n: number, name: string, created_at: number) => {
    const d = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const id = (k: number) => (k * 1000 + n).toString(16).padStart(64, "0");
    state.push(
      event({
        id: id(1),
        kind: 39000,
        created_at,
        tags: [["d", d], ["name", name], ["private"]],
      }),
      event({
        id: id(2),
        kind: 39002,
        created_at,
        tags: [
          ["d", d],
          ["p", me, "", "bot"],
        ],
      }),
    );
    return d;
  };
  for (let n = 1; n <= 500; n++) channel(n, `busy-${n}`, 1000 + n);
  const fixers = channel(501, "fixers", 10);
  const row = `${fixers} fixers (private)`;
  await expect(
    callTool(client, {}, "channel_list", { q: "fixers" }),
  ).resolves.toBe(row);
  await expect(
    callTool(client, {}, "channel_list", { all: true, q: "FIXERS" }),
  ).resolves.toBe(row);
  await expect(
    callTool(client, {}, "channel_get", { channel: fixers }),
  ).resolves.toBe(`${fixers} fixers (private)\nyou: bot`);
  await expect(
    callTool(client, {}, "canvas_get", { channel: fixers }),
  ).resolves.toBe("No canvas.");
  const unseen =
    "No channel fixers that you can see (it may not be visible yet). If you supplied a name, channel_list with q finds its ID.";
  await expect(
    callTool(client, {}, "channel_get", { channel: "fixers" }),
  ).rejects.toThrow(unseen);
  await expect(
    callTool(client, {}, "canvas_get", { channel: "fixers" }),
  ).rejects.toThrow(unseen);
  await expect(
    callTool(client, {}, "canvas_set", {
      channel: "fixers",
      content: "# Plan",
    }),
  ).rejects.toThrow(unseen);
  expect(published).toEqual([]);
});

/** Large tied-timestamp datasets without the general fake's quadratic matching. */
function channelListing(count: number, joined: boolean) {
  const metadata = Array.from({ length: count }, (_, n) =>
    event({
      id: n.toString(16).padStart(64, "0"),
      kind: 39000,
      tags: [
        ["d", `room-${n}`],
        ["name", n === 0 || n === count - 1 ? "needle" : "busy"],
      ],
    }),
  );
  const memberships = joined
    ? metadata.map((item) =>
        event({
          id: item.id,
          kind: 39002,
          tags: [
            ["d", item.tags[0]?.[1] ?? ""],
            ["p", me],
          ],
        }),
      )
    : [];
  const { client } = fake();
  const cursors = new Map<number, string | undefined>();
  client.query = vi.fn(async ([filter]: readonly Filter[]) => {
    if (!filter) throw new Error("Expected one filter");
    expect(filter.limit).toBeLessThanOrEqual(500);
    const kind = (filter.kinds as number[])[0] as number;
    expect(filter.before_id).toBe(cursors.get(kind));
    const membership = (filter.kinds as number[])[0] === 39002;
    if (membership) expect(filter["#p"]).toEqual([me]);
    const ids = filter["#d"] as string[] | undefined;
    const scope = ids && new Set(ids);
    const source = membership ? memberships : metadata;
    const before = filter.before_id as string | undefined;
    if (before) expect(filter.until).toBe(100);
    const page = source
      .filter(
        (item) =>
          (!before || item.id > before) &&
          (!scope || scope.has(item.tags[0]?.[1] ?? "")),
      )
      .slice(0, filter.limit as number);
    cursors.set(kind, page.at(-1)?.id);
    return page;
  });
  return { client, metadata, memberships };
}

it.each([9_999, 10_000, 10_001])(
  "searches %i metadata events without an oversized reply or hard failure",
  async (count) => {
    const { client } = channelListing(count, false);
    const answer = (await callTool(client, {}, "channel_list", {
      all: true,
      q: "NEEDLE",
    })) as string;
    expect(answer).toContain("room-0 needle (not joined)");
    expect(answer.includes(`room-${count - 1} needle`)).toBe(count <= 10_000);
    expect(answer.includes("Partial channel list")).toBe(count > 10_000);
    expect(answer).not.toContain("busy");
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
    expect(client.query).toHaveBeenCalledTimes(21 + (count >= 10_000 ? 1 : 0));
  },
);

it.each([9_999, 10_000, 10_001])(
  "searches %i memberships within joined scope and reports incomplete scans",
  async (count) => {
    const { client, metadata } = channelListing(count, true);
    metadata.push(
      event({
        kind: 39000,
        tags: [
          ["d", "outside"],
          ["name", "needle"],
        ],
      }),
    );
    const answer = (await callTool(client, {}, "channel_list", {
      q: "needle",
    })) as string;
    expect(answer).toContain("room-0 needle");
    expect(answer.includes(`room-${count - 1} needle`)).toBe(count <= 10_000);
    expect(answer.includes("Partial channel list")).toBe(count > 10_000);
    expect(answer).not.toContain("outside");
    expect(answer).not.toContain("not joined");
  },
);

it("does not claim non-membership when the membership scan is partial", async () => {
  const { client, metadata } = channelListing(10_001, true);
  metadata.splice(0, 10_000);
  await expect(
    callTool(client, {}, "channel_list", { all: true }),
  ).resolves.toContain(
    "room-10000 needle (membership unknown)\nPartial channel list",
  );
});

it("reports a partial search even when no channel matched before the scan limit", async () => {
  const { client } = channelListing(10_001, false);
  await expect(
    callTool(client, {}, "channel_list", { all: true, q: "missing" }),
  ).resolves.toBe(
    "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.",
  );
});

it("keeps transport failures as errors instead of treating them as partial scans", async () => {
  const { client } = channelListing(501, false);
  const query = client.query;
  client.query = vi.fn(async (filters) => {
    if (filters[0]?.before_id) throw new Error("relay unavailable");
    return query(filters);
  });
  await expect(
    callTool(client, {}, "channel_list", { all: true, q: "needle" }),
  ).rejects.toThrow("relay unavailable");
});

it.each([500, 501])(
  "bounds a %i-row listing and labels partial output",
  async (count) => {
    const { client } = channelListing(count, false);
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channel_list", arguments: { all: true } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    const answer =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(
      answer.split("\n").filter((row) => row.startsWith("room-")),
    ).toHaveLength(500);
    expect(answer.includes("Partial channel list")).toBe(count > 500);
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
  },
);

it.each(["x", "界", "😀", '"\\\n'])(
  "bounds MCP text bytes with long %j names, retaining a usable ID",
  async (unit) => {
    const { client, metadata } = channelListing(2, false);
    metadata[0] = event({
      kind: 39000,
      tags: [
        ["d", "oversized"],
        ["name", unit.repeat(20_000)],
      ],
    });
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channel_list", arguments: { all: true, q: unit } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    expect(reply.result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("oversized (details omitted;"),
        },
      ],
    });
    const text =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("Partial channel list");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16_384);
  },
);

it.each([-1, 0, 1])(
  "handles the UTF-8 output boundary at offset %i",
  async (offset) => {
    const { client, metadata } = channelListing(2, false);
    const notice =
      "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.";
    const suffix = " (not joined)";
    const budget = 16_384 - new TextEncoder().encode(notice).length - 1;
    const prefix = "room-0 ";
    const name = "界".repeat(
      Math.floor((budget - prefix.length - suffix.length) / 3),
    );
    const padding =
      budget -
      prefix.length -
      suffix.length -
      new TextEncoder().encode(name).length;
    metadata[0] = event({
      id: "0".repeat(64),
      kind: 39000,
      tags: [
        ["d", "room-0"],
        ["name", name + "x".repeat(padding + offset)],
      ],
    });
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channel_list", arguments: { all: true } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    const answer =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
    expect(answer.includes(name)).toBe(offset <= 0);
    expect(answer).toContain(notice);
    if (offset === 0)
      expect(new TextEncoder().encode(answer).length).toBe(16_384);
  },
);

it("reads an existing canvas without querying channel metadata", async () => {
  const { client } = fake([event({ kind: 40100, content: "# Existing" })]);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_get", {}),
  ).resolves.toBe("# Existing");
  expect(client.query).toHaveBeenCalledExactlyOnceWith([
    { kinds: [40100], "#h": ["chan"], limit: 1 },
  ]);
});

it("waits past the existing canvas timestamp before publishing", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client, published } = fake([
      event({ kind: 40100, content: "old" }),
    ]);
    const publish = client.publish;
    client.publish = vi.fn(async (template) => {
      expect(Date.now()).toBe(101_000);
      return publish(template);
    });
    const write = callTool(client, { channel: "chan" }, "canvas_set", {
      content: "new",
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(write).resolves.toBe("saved");
    expect(published).toEqual([
      { kind: 40100, content: "new", tags: [["h", "chan"]] },
    ]);
    expect(client.query).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps waiting when the timer fires a moment early", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client } = fake([event({ kind: 40100, content: "old" })]);
    const timer = globalThis.setTimeout;
    const early = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((run: () => void, ms: number) =>
        timer(run, Math.max(0, ms - 1))) as typeof setTimeout);
    const publish = client.publish;
    client.publish = vi.fn(async (template) => {
      expect(Date.now()).toBe(101_000);
      return publish(template);
    });
    const write = callTool(client, { channel: "chan" }, "canvas_set", {
      content: "new",
    });
    await vi.advanceTimersByTimeAsync(500);
    early.mockRestore();
    await expect(write).resolves.toBe("saved");
    expect(client.publish).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("publishes the first canvas only after finding visible channel metadata", async () => {
  const { client, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", { content: "first" }),
  ).resolves.toBe("saved");
  expect(client.query).toHaveBeenNthCalledWith(2, [
    { kinds: [39000], "#d": ["chan"], limit: 1 },
  ]);
  expect(published).toEqual([
    { kind: 40100, content: "first", tags: [["h", "chan"]] },
  ]);
});

it("lists canvas revisions newest first, a page at a time", async () => {
  const rows = Array.from({ length: CANVAS_HISTORY_PAGE + 1 }, (_, i) =>
    event({
      kind: 40100,
      id: `${i}`.padStart(64, "0"),
      created_at: 100 + i,
      content: `# Plan ${i}\nbody`,
    }),
  );
  const { client } = fake(rows);
  const page = await callTool(
    client,
    { channel: "chan" },
    "canvas_history",
    {},
  );
  const lines = (page as string).split("\n");
  expect(lines).toHaveLength(CANVAS_HISTORY_PAGE + 3);
  expect(lines[0]).toBe(`version: ${rows[CANVAS_HISTORY_PAGE]?.id}`);
  expect(lines[2]).toBe(
    `${rows[CANVAS_HISTORY_PAGE]?.id} 1970-01-01T00:01Z ${alice} 14B # Plan ${CANVAS_HISTORY_PAGE}`,
  );
  expect(lines[CANVAS_HISTORY_PAGE + 2]).toBe(
    `Older revisions may remain; continue with ${JSON.stringify({ channel: "chan", before: 101, before_id: rows[1]?.id })}`,
  );
  await expect(
    callTool(client, {}, "canvas_history", {
      channel: "chan",
      before: 101,
      before_id: rows[1]?.id,
    }),
  ).resolves.toBe(`${rows[0]?.id} 1970-01-01T00:01Z ${alice} 13B # Plan 0`);
  await expect(
    callTool(client, {}, "canvas_history", {
      channel: "chan",
      before_id: root,
    }),
  ).rejects.toThrow("before_id needs before");
  await expect(
    callTool(client, {}, "canvas_history", { channel: "chan", before: 1e12 }),
  ).rejects.toThrow("Unix seconds");
  // Only the first page is read from the writer.
  const filters = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
    ([[filter]]) => filter,
  );
  expect(filters[0]).toEqual({
    kinds: [40100],
    "#h": ["chan"],
    limit: CANVAS_HISTORY_PAGE,
    consistency: "strong",
  });
  expect(filters[1]).not.toHaveProperty("consistency");
});

it("pages canvas revisions that share a timestamp without gaps", async () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    event({
      kind: 40100,
      id: `${i}`.padStart(64, "0"),
      created_at: 100,
      content: `${i}`,
    }),
  );
  const { client } = fake(rows);
  const first = (await callTool(client, {}, "canvas_history", {
    channel: "chan",
  })) as string;
  const cursor = JSON.parse(first.split("continue with ")[1] ?? "");
  const second = (await callTool(
    client,
    {},
    "canvas_history",
    cursor,
  )) as string;
  const ids = [
    ...first.split("\n").slice(2, 2 + CANVAS_HISTORY_PAGE),
    ...second.split("\n"),
  ].map((line) => line.split(" ")[0]);
  expect(ids).toEqual(rows.map((row) => row.id));
});

it("reads a full canvas_history page of the largest escaped revisions within the agent read cap", async () => {
  const size = (row: BuzzEvent) =>
    new TextEncoder().encode(JSON.stringify(row)).length;
  const largest = (i: number) => {
    const base = event({
      kind: 40100,
      id: `${i}`.padStart(64, "0"),
      pubkey: alice,
      created_at: 1700000000 - i,
      sig: "e".repeat(128),
    });
    // Each quote serializes as two bytes.
    const quotes = Math.floor((CANVAS_MAX_EVENT_BYTES - size(base)) / 2);
    return { ...base, content: '"'.repeat(quotes) };
  };
  const rows = Array.from({ length: CANVAS_HISTORY_PAGE + 1 }, (_, i) =>
    largest(i),
  );
  const [biggest] = rows;
  if (!biggest) throw new Error("no rows");
  expect(size(biggest)).toBeGreaterThan(CANVAS_MAX_EVENT_BYTES - 2);
  expect(size(biggest)).toBeLessThanOrEqual(CANVAS_MAX_EVENT_BYTES);
  const { client } = fake(rows);
  const query = client.query;
  client.query = vi.fn(async (filters: Filter[]) => {
    const page = await query(filters);
    // The bare event array app_agents.rs bounds.
    expect(
      new TextEncoder().encode(JSON.stringify(page)).length,
    ).toBeLessThanOrEqual(CANVAS_READ_BYTES);
    return page;
  });
  const first = (await callTool(client, {}, "canvas_history", {
    channel: "chan",
  })) as string;
  const page = rows.slice(0, CANVAS_HISTORY_PAGE);
  expect(
    first
      .split("\n")
      .slice(2, -1)
      .map((line) => line.split(" ")[0]),
  ).toEqual(page.map((row) => row.id));
  const last = page.at(-1);
  expect(JSON.parse(first.split("continue with ")[1] ?? "")).toEqual({
    channel: "chan",
    before: last?.created_at,
    before_id: last?.id,
  });
});

it("restores a canvas revision guarded by the head it read", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(300_000);
    const old = event({ kind: 40100, id: root, content: "# Old" });
    const head = event({ kind: 40100, id: nested, created_at: 200 });
    const { client, published } = fake([old, head], { keep: true });
    await expect(
      callTool(client, { channel: "chan" }, "canvas_restore", {
        id: root,
        expected: nested,
      }),
    ).resolves.toBe(`restored ${root} as ${"1".padStart(64, "e")}`);
    expect(published).toEqual([
      {
        kind: 40100,
        content: "# Old",
        tags: [
          ["h", "chan"],
          ["expected-revision", nested],
        ],
      },
    ]);
    await expect(
      callTool(client, { channel: "chan" }, "canvas_get", {}),
    ).resolves.toBe("# Old");
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to restore what is not a revision of this canvas", async () => {
  const { client, published } = fake([
    event({ kind: 9, id: root }),
    event({ kind: 40100, id: nested, tags: [["h", "other"]] }),
  ]);
  for (const id of [root, nested, "f".repeat(64)])
    await expect(
      callTool(client, { channel: "chan" }, "canvas_restore", {
        id,
        expected: root,
      }),
    ).rejects.toThrow(`No canvas revision ${id} in chan`);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_restore", {
      id: "x",
      expected: root,
    }),
  ).rejects.toThrow("64-character");
  await expect(
    callTool(client, { channel: "chan" }, "canvas_restore", { id: root }),
  ).rejects.toThrow("expected");
  expect(published).toEqual([]);
});

it("refuses to restore over a canvas saved since the agent read it", async () => {
  const old = event({ kind: 40100, id: root, content: "# Old" });
  const seen = event({ kind: 40100, id: nested, created_at: 200 });
  const { client, published } = fake([old, seen]);
  await callTool(client, { channel: "chan" }, "canvas_history", {});
  // A collaborator saves after the agent read the history.
  (client.query as ReturnType<typeof vi.fn>).mockImplementation(
    async ([filter]: readonly { ids?: string[] }[]) =>
      filter?.ids
        ? [old]
        : [event({ kind: 40100, id: "c".repeat(64), created_at: 300 })],
  );
  await expect(
    callTool(client, { channel: "chan" }, "canvas_restore", {
      id: root,
      expected: nested,
    }),
  ).rejects.toThrow(`The canvas changed since version ${nested}`);
  expect(published).toEqual([]);
});

it("restores only revisions within the canvas size limit", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(300_000);
    const head = event({ kind: 40100, id: nested, created_at: 200 });
    for (const [content, ok] of [
      ["", true],
      ["x".repeat(LIVE_CANVAS_BYTES), true],
      ["x".repeat(LIVE_CANVAS_BYTES + 1), false],
    ] as const) {
      const old = event({ kind: 40100, id: root, content });
      const { client, published } = fake([old, head], { keep: true });
      const restore = callTool(client, { channel: "chan" }, "canvas_restore", {
        id: root,
        expected: nested,
      });
      if (ok) await expect(restore).resolves.toMatch(/^restored /);
      else await expect(restore).rejects.toThrow("over the canvas limit");
      expect(published).toHaveLength(ok ? 1 : 0);
    }
  } finally {
    vi.useRealTimers();
  }
});

it("annotates the canvas history and restore tools", () => {
  const find = (name: string) => TOOLS.find((item) => item.name === name);
  expect(find("canvas_history")?.annotations).toEqual({ readOnlyHint: true });
  expect(find("canvas_restore")?.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
  });
});

it("reports a restore that another canvas write overtook", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(300_000);
    const old = event({ kind: 40100, id: root, content: "# Old" });
    const later = event({ kind: 40100, id: nested, created_at: 999 });
    const { client } = fake([old]);
    const publish = client.publish;
    client.publish = vi.fn(async (template) => {
      const signed = await publish(template);
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue([later]);
      return signed;
    });
    await expect(
      callTool(client, { channel: "chan" }, "canvas_restore", {
        id: root,
        expected: root,
      }),
    ).resolves.toBe("That revision is already the canvas.");
    const { client: other } = fake([
      old,
      event({ kind: 40100, id: "d".repeat(64), created_at: 200 }),
    ]);
    const otherPublish = other.publish;
    other.publish = vi.fn(async (template) => {
      const signed = await otherPublish(template);
      (other.query as ReturnType<typeof vi.fn>).mockResolvedValue([later]);
      return signed;
    });
    await expect(
      callTool(other, { channel: "chan" }, "canvas_restore", {
        id: root,
        expected: "d".repeat(64),
      }),
    ).rejects.toThrow(
      `conflict: the restore was received, but another canvas (${nested})`,
    );
  } finally {
    vi.useRealTimers();
  }
});

it("reports an accepted restore whose read-back fails", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(300_000);
    const old = event({ kind: 40100, id: root, content: "# Old" });
    const head = event({ kind: 40100, id: nested, created_at: 200 });
    const { client } = fake([old, head]);
    const publish = client.publish;
    let saved = "";
    client.publish = vi.fn(async (template) => {
      const signed = await publish(template);
      saved = signed.id;
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("socket closed"),
      );
      return signed;
    });
    const restore = callTool(client, { channel: "chan" }, "canvas_restore", {
      id: root,
      expected: nested,
    });
    await expect(restore).rejects.toThrow(/^restored /);
    await expect(restore).rejects.toThrow(
      `restored ${root} as ${saved}, but the canvas could not be read back to confirm it is current: socket closed`,
    );
  } finally {
    vi.useRealTimers();
  }
});

it("reads and replaces the canvas of a named channel or the current one", async () => {
  const { client, published } = fake([
    event({ kind: 40100, content: "# Existing" }),
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_get", {}),
  ).resolves.toBe("# Existing");
  await expect(
    callTool(client, {}, "canvas_get", { channel: "chan" }),
  ).resolves.toBe("# Existing");
  await expect(callTool(client, {}, "canvas_get", {})).rejects.toThrow(
    "channel is required here.",
  );
  await expect(
    callTool(client, {}, "canvas_set", { content: "x" }),
  ).rejects.toThrow("channel is required here.");
  await expect(
    callTool(client, {}, "canvas_set", { path: "plan.md" }),
  ).rejects.toThrow("channel is required here.");
  expect(client.read).not.toHaveBeenCalled();
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", {}),
  ).rejects.toThrow("Give content or path.");
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", { text: "old name" }),
  ).rejects.toThrow("Give content or path.");
  expect(() => callTool(client, { channel: "chan" }, "canvas", {})).toThrow(
    "No tool canvas",
  );
  expect(published).toEqual([]);

  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", { path: "plan.md" }),
  ).resolves.toBe("saved");
  expect(client.read).toHaveBeenCalledWith("plan.md");
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", { content: "" }),
  ).resolves.toBe("saved");
  expect(published).toEqual([
    { kind: 40100, content: "# plan.md", tags: [["h", "chan"]] },
    { kind: 40100, content: "", tags: [["h", "chan"]] },
  ]);
});

it("creates a channel from its owner's template, reporting each agent it could not add", async () => {
  const { client, published } = relay({
    [bob]: "policy:owner_only — only the agent owner can add this agent",
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "# Plan", agents: [alice, bob, me] },
  ]);
  const answer = await callTool(client, {}, "channel_create", {
    name: "#launch ",
    visibility: "private",
    template: "launch",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published).toEqual([
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "launch"],
        ["visibility", "private"],
        ["channel_type", "stream"],
      ],
    },
    {
      kind: 40100,
      content: "# Plan",
      tags: [
        ["h", id],
        ["expected-revision", "none"],
      ],
    },
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", id],
        ["p", alice],
      ],
    },
  ]);
  expect(answer).toBe(
    [
      `created ${id}`,
      "started the Canvas",
      `added ${alice} Alice Smith`,
      `not added ${bob}: policy:owner_only — only the agent owner can add this agent`,
    ].join("\n"),
  );
});

it("adds no template agents when it cannot start the Canvas", async () => {
  const { client, published } = relay();
  const publish = client.publish;
  client.publish = vi.fn(async (template: Template) => {
    if (template.kind === 40100) throw new Error("canvas refused");
    return publish(template);
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "# Plan", agents: [alice] },
  ]);
  const answer = await callTool(client, {}, "channel_create", {
    name: "launch",
    visibility: "private",
    template: "Launch",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published.map((template) => template.kind)).toEqual([9007]);
  expect(answer).toBe(
    `created ${id}\nCanvas not started, so no agents were added: canvas refused`,
  );
});

it("creates nothing from a template it cannot name exactly", async () => {
  const { client, published } = relay();
  const create = (template: string) =>
    callTool(client, {}, "channel_create", {
      name: "x",
      visibility: "open",
      template,
    });
  await expect(create("a")).rejects.toThrow(
    "Channel templates are kept in Buzz Desktop and are unavailable here.",
  );
  client.templates = vi.fn(async () => [
    { name: "Team", canvas: "", agents: [] },
    { name: "team", canvas: "", agents: [] },
  ]);
  await expect(create("TEAM")).rejects.toThrow(
    "2 templates are named TEAM; your owner should rename one.",
  );
  await expect(create("other")).rejects.toThrow(
    "No template named other. Templates: Team, team.",
  );
  expect(published).toEqual([]);
});

it("refuses channel arguments that do not fit, before publishing", async () => {
  const { client, published } = relay();
  const channel = (name: string, args: Record<string, unknown>) =>
    callTool(client, { channel: room }, name, args);
  await expect(
    channel("channel_delete", { channel_id: "other" }),
  ).rejects.toThrow("channel_id cannot be used with channel_delete.");
  await expect(
    channel("channel_create", { name: "x", visibility: "open", topic: "t" }),
  ).rejects.toThrow("topic cannot be used with channel_create.");
  await expect(channel("channel_create", { name: "x" })).rejects.toThrow(
    "visibility must be open or private.",
  );
  await expect(
    channel("channel_create", { name: "#", visibility: "open" }),
  ).rejects.toThrow("Enter a channel name");
  await expect(
    channel("channel_create", { name: "x", visibility: "open", ttl: 1.5 }),
  ).rejects.toThrow("ttl must be a whole number of seconds.");
  await expect(
    channel("channel_create", {
      name: "x",
      visibility: "open",
      join_role: "admin",
    }),
  ).rejects.toThrow("join_role must be member or guest.");
  await expect(
    channel("channel_create", {
      name: "x",
      visibility: "private",
      join_role: "guest",
    }),
  ).rejects.toThrow("join_role guest is for open channels.");
  await expect(
    channel("channel_update", { visibility: "private", join_role: "guest" }),
  ).rejects.toThrow("join_role guest is for open channels.");
  await expect(channel("channel_update", {})).rejects.toThrow(
    "Give name, about, visibility, ttl, join_role, topic or purpose.",
  );
  await expect(
    channel("channel_update", { join_role: "owner" }),
  ).rejects.toThrow("join_role must be member or guest.");
  await expect(
    callTool(client, { channel: "chan" }, "channel_leave", {}),
  ).rejects.toThrow("Invalid channel ID");
  expect(published).toEqual([]);
});

it("shows a channel's details and changes them as the channel shows", async () => {
  const { client, published } = relay();
  const context = { channel: room };
  await expect(callTool(client, context, "channel_get", {})).resolves.toBe(
    `${room} plans (stream, open)\nabout: roadmap\nyou: owner`,
  );
  await expect(
    callTool(client, context, "channel_update", {
      name: "launch",
      about: "",
      visibility: "private",
      ttl: 3600,
    }),
  ).resolves.toBe(`updated ${room}`);
  expect(published[0]?.tags).toEqual([
    ["h", room],
    ["name", "launch"],
    ["about", ""],
    ["visibility", "private"],
    ["ttl", "3600"],
  ]);
  await expect(callTool(client, context, "channel_get", {})).resolves.toBe(
    `${room} launch (stream, private, archives after 3600s idle)\nyou: owner`,
  );
  await expect(
    callTool(client, { channel: "gone" }, "channel_get", {}),
  ).rejects.toThrow(
    "No channel gone that you can see (it may not be visible yet).",
  );
});

it("makes a channel an announce channel and back", async () => {
  const { client, published } = relay();
  const context = { channel: room };
  await expect(
    callTool(client, context, "channel_update", { join_role: "guest" }),
  ).resolves.toBe(`updated ${room}`);
  await expect(callTool(client, context, "channel_get", {})).resolves.toBe(
    `${room} plans (stream, open, join as guest)\nabout: roadmap\nyou: owner`,
  );
  await expect(
    callTool(client, context, "channel_update", { join_role: "member" }),
  ).resolves.toBe(`updated ${room}`);
  expect(published.map((template) => template.tags)).toEqual([
    [
      ["h", room],
      ["join_role", "guest"],
    ],
    [
      ["h", room],
      ["join_role", "member"],
    ],
  ]);
});

it("creates an announce channel after adding its template's agents", async () => {
  const { client, published, state } = relay();
  client.templates = vi.fn(async () => [
    { name: "Team", canvas: "", agents: [alice] },
  ]);
  const answer = await callTool(client, {}, "channel_create", {
    name: "team",
    visibility: "open",
    join_role: "guest",
    template: "Team",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  // Set last: an agent added with no role would otherwise join as a guest.
  expect(published.map((template) => [template.kind, template.tags])).toEqual([
    [
      9007,
      [
        ["h", id],
        ["name", "team"],
        ["visibility", "open"],
        ["channel_type", "stream"],
      ],
    ],
    [
      9000,
      [
        ["h", id],
        ["p", alice],
      ],
    ],
    [
      9002,
      [
        ["h", id],
        ["join_role", "guest"],
      ],
    ],
  ]);
  expect(answer).toBe(
    [
      `created ${id}`,
      `added ${alice} Alice Smith`,
      "new people join as guests",
    ].join("\n"),
  );
  await expect(
    callTool(client, { channel: id }, "channel_get", {}),
  ).resolves.toBe(`${id} team (stream, open, join as guest)\nyou: owner`);
  const roster = () =>
    state.find((e) => e.kind === 39002 && e.tags[0]?.[1] === id)?.tags;
  expect(roster()).toContainEqual(["p", alice, "", "member"]);
  // Now anyone added with no role is a guest, and the answer says so.
  await expect(
    callTool(client, { channel: id }, "member_add", { pubkeys: [bob] }),
  ).resolves.toBe(`added ${bob} as guest`);
  expect(roster()).toContainEqual(["p", bob, "", "guest"]);
});

it("sets join_role when the template's Canvas is refused, and says when it cannot", async () => {
  const { client, published } = relay();
  const publish = client.publish;
  client.publish = vi.fn(async (template: Template) => {
    if (template.kind === 40100) throw new Error("canvas refused");
    return publish(template);
  });
  client.templates = vi.fn(async () => [
    { name: "Team", canvas: "# Plan", agents: [alice] },
  ]);
  const create = () =>
    callTool(client, {}, "channel_create", {
      name: "team",
      visibility: "open",
      join_role: "guest",
      template: "Team",
    });
  let answer = await create();
  let id = published[0]?.tags[0]?.[1] as string;
  expect(published.map((template) => template.kind)).toEqual([9007, 9002]);
  expect(answer).toBe(
    `created ${id}\nCanvas not started, so no agents were added: canvas refused\nnew people join as guests`,
  );
  const query = client.query;
  client.query = vi.fn(async (filters: readonly Filter[]) => {
    if (filters.some((f) => (f.kinds as number[]).includes(39000)))
      throw new Error("kind 39000 unavailable");
    return query(filters);
  });
  answer = await create();
  id = published.at(-1)?.tags[0]?.[1] as string;
  expect(published.at(-1)?.kind).toBe(9007);
  expect(answer).toBe(
    `The community accepted channel ${id} but its state could not be read back: kind 39000 unavailable; the template was not applied; join_role was not set.`,
  );
});

it("reports a new channel whose join_role was refused", async () => {
  const { client, published } = relay();
  const publish = client.publish;
  client.publish = vi.fn(async (template: Template) => {
    if (template.kind === 9002) throw new Error("restricted: admins only");
    return publish(template);
  });
  const answer = await callTool(client, {}, "channel_create", {
    name: "news",
    visibility: "open",
    join_role: "guest",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published.map((template) => template.kind)).toEqual([9007]);
  expect(answer).toBe(
    `created ${id}\njoin_role not set: restricted: admins only`,
  );
  // member is the default, so it needs no second event.
  await callTool(client, {}, "channel_create", {
    name: "chat",
    visibility: "open",
    join_role: "member",
  });
  expect(published.map((template) => template.kind)).toEqual([9007, 9007]);
});

it("leaves, joins, archives, unarchives and deletes a channel", async () => {
  const { client, published } = relay();
  const context = { channel: room };
  for (const [action, done] of [
    ["leave", "left"],
    ["join", "joined"],
    ["archive", "archived"],
    ["unarchive", "unarchived"],
    ["delete", "deleted"],
  ])
    await expect(
      callTool(client, context, `channel_${action}`, {}),
    ).resolves.toBe(`${done} ${room}`);
  expect(published.map((template) => template.kind)).toEqual([
    9022, 9021, 9002, 9002, 9008,
  ]);
  expect(published[2]?.tags).toEqual([
    ["h", room],
    ["archived", "true"],
  ]);
});

it("reports a change the community accepted but does not show", async () => {
  vi.useFakeTimers();
  try {
    const { client } = fake([]);
    const answer = callTool(client, { channel: room }, "channel_archive", {});
    await vi.runAllTimersAsync();
    await expect(answer).resolves.toBe(
      "The community accepted archive but does not show it yet.",
    );
    expect(client.query).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

it("adds members with a role and removes others, reporting each", async () => {
  const { client, published } = relay({ [nested]: "restricted: not an admin" });
  const added = await callTool(client, { channel: room }, "member_add", {
    pubkeys: [bob, nested],
    role: "admin",
  });
  const removed = await callTool(client, { channel: room }, "member_remove", {
    pubkeys: [alice],
  });
  expect(published).toEqual([
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", room],
        ["p", bob],
        ["role", "admin"],
      ],
    },
    {
      kind: 9001,
      content: "",
      tags: [
        ["h", room],
        ["p", alice],
      ],
    },
  ]);
  expect(added).toBe(
    [
      `added ${bob} as admin`,
      `not added ${nested}: restricted: not an admin`,
    ].join("\n"),
  );
  expect(removed).toBe(`removed ${alice} Alice Smith`);
  await expect(
    callTool(client, { channel: room }, "member_add", { pubkeys: [nested] }),
  ).rejects.toThrow(`not added ${nested}: restricted: not an admin`);
});

it("changes each member once, however their key is written", async () => {
  const { client, published } = relay();
  expect(
    await callTool(client, { channel: room }, "member_add", {
      pubkeys: [bob, bob.toUpperCase()],
    }),
  ).toBe(`added ${bob}`);
  expect(
    await callTool(client, { channel: room }, "member_remove", {
      pubkeys: [alice, alice.toUpperCase()],
    }),
  ).toBe(`removed ${alice} Alice Smith`);
  expect(published.map((template) => template.kind)).toEqual([9000, 9001]);
});

it("refuses member changes that do not fit, before publishing", async () => {
  const { client, published } = relay();
  const call = (name: string, args: Record<string, unknown>) =>
    callTool(client, { channel: room }, name, args);
  await expect(call("member_add", { pubkeys: [me] })).rejects.toThrow(
    "For yourself, use channel_join or channel_leave.",
  );
  await expect(call("member_remove", { pubkeys: [me] })).rejects.toThrow(
    "For yourself, use channel_join or channel_leave.",
  );
  await expect(call("member_add", { pubkeys: ["Bob"] })).rejects.toThrow(
    "Not a pubkey: Bob",
  );
  await expect(call("member_add", { pubkeys: [] })).rejects.toThrow(
    "pubkeys is required.",
  );
  await expect(
    call("member_add", { pubkeys: [bob], role: "root" }),
  ).rejects.toThrow("role must be one of owner, admin, member, guest, bot.");
  await expect(
    call("member_remove", { pubkeys: [alice], role: "admin" }),
  ).rejects.toThrow("role cannot be used with member_remove.");
  await expect(
    call("member_add", {
      pubkeys: Array.from({ length: 51 }, (_, i) =>
        i.toString(16).padStart(64, "0"),
      ),
    }),
  ).rejects.toThrow("Change at most 50 members at a time.");
  expect(published).toEqual([]);
});

it("lists a channel's members a page at a time, naming only that page", async () => {
  const roster = Array.from({ length: 5 }, (_, i) =>
    i.toString(16).padStart(64, "d"),
  );
  const { client } = fake([
    event({
      kind: 39002,
      tags: [
        ["d", room],
        ...roster.map((key, i) => ["p", key, "", i === 1 ? "admin" : "member"]),
      ],
    }),
    ...roster.map((key, i) => profile(key, `Person ${i}`)),
  ]);
  const list = (args: Record<string, unknown>) =>
    callTool(client, { channel: room }, "member_list", args);
  expect(await list({ limit: 2 })).toBe(
    [
      `${roster[0]} Person 0`,
      `${roster[1]} Person 1 (admin)`,
      `3 more; continue with ${JSON.stringify({ channel: room, limit: 2, offset: 2 })}`,
    ].join("\n"),
  );
  expect(client.query).toHaveBeenLastCalledWith([
    { kinds: [0], authors: roster.slice(0, 2), limit: 2 },
  ]);
  expect(await list({ limit: 2, offset: 4 })).toBe(`${roster[4]} Person 4`);
  expect(await list({ offset: 5 })).toBe("No members.");
  // The default page holds the whole roster.
  expect(await list({})).toBe(
    roster
      .map((key, i) => `${key} Person ${i}${i === 1 ? " (admin)" : ""}`)
      .join("\n"),
  );
  for (const offset of [-1, 1.5, "2"])
    await expect(list({ offset })).rejects.toThrow(
      "offset must be a whole number, 0 or more.",
    );
});

it("defaults to the current channel only when channel is left out", async () => {
  const { client, published } = relay();
  const call = (name: string, args: unknown) =>
    respond(
      client,
      { channel: room },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    );
  for (const [name, args, message] of [
    ["channel_delete", { channel: 123 }, "channel must be a channel ID."],
    ["channel_delete", { channel: "   " }, "channel must be a channel ID."],
    ...[null, [], true, 42, ""].map(
      (args) =>
        ["channel_delete", args, "arguments must be an object."] as const,
    ),
    [
      "member_remove",
      { channel: null, pubkeys: [alice] },
      "channel must be a channel ID.",
    ],
    [
      "member_remove",
      { pubkeys: [alice, 123] },
      "pubkeys must be a list of pubkeys.",
    ],
    ["member_add", { pubkeys: alice }, "pubkeys must be a list of pubkeys."],
    [
      "member_list",
      { channel_id: room },
      "channel_id cannot be used with member_list.",
    ],
    [
      "channel_create",
      { name: "x", visibility: "open", about: 5 },
      "about must be text.",
    ],
  ] as const)
    await expect(call(name, args)).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining(message) }],
      },
    });
  expect(published).toEqual([]);
});

it("keeps what it changed when a read after the change fails", async () => {
  const { client, published } = relay();
  const query = client.query;
  let failing = [0];
  client.query = vi.fn(async (filters: readonly Filter[]) => {
    if (
      filters.some((f) =>
        (f.kinds as number[]).some((kind) => failing.includes(kind)),
      )
    )
      throw new Error(`kind ${failing} unavailable`);
    return query(filters);
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "", agents: [bob] },
  ]);
  const create = () =>
    callTool(client, {}, "channel_create", {
      name: "launch",
      visibility: "open",
      template: "Launch",
    });
  // A display name that cannot be read leaves the pubkey.
  let answer = await create();
  let id = published.at(-2)?.tags[0]?.[1] as string;
  expect(answer).toBe(`created ${id}\nadded ${bob}`);
  // A roster that cannot be read leaves each accepted change unconfirmed.
  failing = [39002];
  answer = await create();
  id = published.at(-2)?.tags[0]?.[1] as string;
  expect(answer).toBe(
    `created ${id}\n${bob}: the community accepted it but its state could not be read back: kind 39002 unavailable`,
  );
  // A channel that cannot be read back still names the channel created.
  failing = [39000];
  answer = await create();
  id = published.at(-1)?.tags[0]?.[1] as string;
  expect(published.at(-1)?.kind).toBe(9007);
  expect(answer).toBe(
    `The community accepted channel ${id} but its state could not be read back: kind 39000 unavailable; the template was not applied.`,
  );
  await expect(
    callTool(client, { channel: room }, "channel_archive", {}),
  ).resolves.toBe(
    "The community accepted archive but its state could not be read back: kind 39000 unavailable.",
  );
  await expect(
    callTool(client, { channel: room }, "channel_update", {
      topic: "x",
    }),
  ).rejects.toThrow("kind 39000 unavailable");
});

it("lists, opens and closes tabs for the working channel's threads", async () => {
  const reply = event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
  const elsewhere = event({ id: bob, tags: [["h", "other"]] });
  // The reader takes the last marked root and ignores case.
  const remarked = event({
    id: "3".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", alice, "", "root"],
      ["e", root, "", "root"],
      ["e", nested, "", "reply"],
    ],
  });
  const uppercase = event({
    id: "4".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", alice.toUpperCase(), "", "reply"],
    ],
  });
  const { client } = fake([
    event({ id: root }),
    reply,
    elsewhere,
    remarked,
    uppercase,
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {}),
  ).rejects.toThrow("Tabs are kept in Buzz Desktop and are unavailable here.");
  const tabs = {
    list: vi.fn(() => [
      { root, pane: "side", shown: true },
      { root: alice, pane: "main", name: "Launch plan", shown: false },
    ]),
    open: vi.fn(() => true),
    close: vi.fn((): "closed" | "missing" | "shown" => "shown"),
    rename: vi.fn(() => true),
  };
  client.tabs = tabs;
  await expect(callTool(client, {}, "tabs", {})).rejects.toThrow(
    "Tabs need a channel to work in.",
  );
  expect(await callTool(client, { channel: "chan" }, "tabs", {})).toBe(
    `${root} side (shown)\n${alice} main "Launch plan"`,
  );
  expect(tabs.list).toHaveBeenCalledWith("chan");
  // A reply opens its thread's root.
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "open",
      thread: nested,
    }),
  ).toBe(`opened ${root}`);
  expect(tabs.open).toHaveBeenCalledWith("chan", root);
  // Another channel's thread never gets a tab here.
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "open",
      thread: bob,
    }),
  ).rejects.toThrow(`${bob} is not in this channel.`);
  expect(tabs.open).toHaveBeenCalledTimes(1);
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "close",
      thread: root,
    }),
  ).rejects.toThrow("Your owner is looking at that tab, so it stays open.");
  expect(tabs.close).toHaveBeenLastCalledWith("chan", root);
  tabs.close.mockReturnValue("missing");
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "close",
      thread: root,
    }),
  ).toBe("not open");
  // A reply renames its thread's tab; no name restores the automatic title.
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: nested,
      name: " Launch plan ",
    }),
  ).toBe("renamed");
  expect(tabs.rename).toHaveBeenLastCalledWith("chan", root, "Launch plan");
  for (const [message, expected] of [
    [remarked, root],
    [uppercase, alice],
  ] as const) {
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: message.id,
      name: "Plan",
    });
    expect(tabs.rename).toHaveBeenLastCalledWith("chan", expected, "Plan");
  }
  tabs.rename.mockReturnValue(false);
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: root,
    }),
  ).toBe("not open");
  expect(tabs.rename).toHaveBeenLastCalledWith("chan", root, "");
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: root,
      name: 1,
    }),
  ).rejects.toThrow("name must be text.");
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "move",
      thread: root,
    }),
  ).rejects.toThrow("action must be open, close or rename.");
});

it("finds users through the community's name search, in its order", async () => {
  const { client } = fake(community);
  // Name search ranks Bob's exact match above a later Alice match.
  client.searchProfiles = vi.fn(async () => [
    profile(bob, "Wes"),
    profile(alice, "Wesley"),
  ]);
  const found = await callTool(client, {}, "users", { q: "Wes" });
  expect(found).toBe(`${bob} Wes\n${alice} Wesley`);
  expect(client.searchProfiles).toHaveBeenCalledWith("wes", 100);
  expect(client.query).not.toHaveBeenCalled();
});

it("finds users with NIP-50 search where the community has no name search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => undefined);
  // The fake ignores `search`; the name filter keeps only matching names.
  expect(await callTool(client, {}, "users", { q: "alice" })).toBe(
    `${alice} Alice Smith`,
  );
  expect(client.query).toHaveBeenCalledWith([
    { kinds: [0], search: "alice", limit: 100 },
  ]);
});

it("finds a name longer than the name search's limit with NIP-50 search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => []);
  // 100 code points (200 UTF-16 units) is the longest name search accepts.
  const longest = "😀".repeat(100);
  await callTool(client, {}, "users", { q: longest });
  expect(client.searchProfiles).toHaveBeenCalledWith(longest, 100);
  expect(client.query).not.toHaveBeenCalled();
  const over = `${longest}w`;
  expect(await callTool(client, {}, "users", { q: over })).toBe("No users.");
  expect(client.searchProfiles).toHaveBeenCalledTimes(1);
  expect(client.query).toHaveBeenCalledWith([
    { kinds: [0], search: over, limit: 100 },
  ]);
});

it("reads users by id without the name search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => []);
  expect(await callTool(client, {}, "users", { ids: [bob] })).toBe(
    `${bob} Bob`,
  );
  expect(client.searchProfiles).not.toHaveBeenCalled();
});

it("refuses ids with q, and more than 100 ids", async () => {
  const { client } = fake(community);
  await expect(
    callTool(client, {}, "users", { ids: [bob], q: "alice" }),
  ).rejects.toThrow("Give ids or q, not both.");
  const ids = Array.from({ length: 101 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  await expect(callTool(client, {}, "users", { ids })).rejects.toThrow(
    "Give at most 100 ids.",
  );
  expect(client.query).not.toHaveBeenCalled();
});

const note = (
  pubkey: string,
  name: string,
  created_at: number,
  extra: string[][] = [],
  content = `${name} by ${pubkey.slice(0, 1)}`,
) =>
  event({
    id: `${pubkey.slice(0, 1)}${created_at}`.padEnd(64, "0"),
    kind: 30023,
    pubkey,
    created_at,
    content,
    tags: [["d", name], ["title", `${name} title`], ...extra],
  });

it("reads a shared note by name, from whichever author has it", async () => {
  const { client } = fake([
    ...community,
    note(alice, "pr-recipe", 200, [
      ["summary", "how to open a PR"],
      ["t", "git"],
    ]),
    note(alice, "pr-recipe", 150),
  ]);
  await expect(
    callTool(client, {}, "notes_get", { name: "pr-recipe" }),
  ).resolves.toBe(
    [
      `30023:${alice}:pr-recipe by Alice Smith, 1970-01-01T00:03Z`,
      "title: pr-recipe title",
      "summary: how to open a PR",
      "tags: git",
      "",
      "pr-recipe by a",
    ].join("\n"),
  );
  await expect(
    callTool(client, {}, "notes_get", { name: "missing" }),
  ).resolves.toBe("No note missing.");
  await expect(
    callTool(client, {}, "notes_get", { name: "Bad Name" }),
  ).rejects.toThrow("Bad note name Bad Name");
});

it("asks which author's note when several share a name", async () => {
  const { client } = fake([
    ...community,
    profile(me, "Bob"),
    note(alice, "recipe", 200),
    note(bob, "recipe", 300),
  ]);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe" }),
  ).rejects.toThrow(
    `2 authors have a note recipe; give author or latest.\n${bob} Bob`,
  );
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", latest: true }),
  ).resolves.toMatch(/\nrecipe by b$/);
  // An author by display name, pubkey or npub.
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: "alice smith",
    }),
  ).resolves.toMatch(/\nrecipe by a$/);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: bob }),
  ).resolves.toMatch(/\nrecipe by b$/);
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: npubEncode(bob),
    }),
  ).resolves.toMatch(/\nrecipe by b$/);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: "Carol" }),
  ).rejects.toThrow("No one is named Carol.");
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: "Bob" }),
  ).rejects.toThrow(
    /^2 people are named Bob; give their npub\.\nnpub1\w+\nnpub1\w+$/,
  );
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: bob,
      latest: true,
    }),
  ).rejects.toThrow("Give author or latest, not both.");
});

it("lists your notes by default, or everyone's, newest first", async () => {
  const { client } = fake([
    ...community,
    note(me, "mine", 200, [["t", "ops"]]),
    note(me, "older", 100),
    note(alice, "hers", 300, [["t", "ops"]]),
  ]);
  await expect(callTool(client, {}, "notes_get", {})).resolves.toBe(
    `mine ${me}  1970-01-01T00:03Z mine title\nolder ${me}  1970-01-01T00:01Z older title`,
  );
  await expect(
    callTool(client, {}, "notes_get", { author: "all", tag: "ops" }),
  ).resolves.toBe(
    `hers ${alice} Alice Smith 1970-01-01T00:05Z hers title\nmine ${me}  1970-01-01T00:03Z mine title`,
  );
  expect(vi.mocked(client.query).mock.calls.at(-2)?.[0]).toEqual([
    { kinds: [30023], "#t": ["ops"], limit: 50 },
  ]);
  const { client: empty } = fake(community);
  await expect(callTool(empty, {}, "notes_get", {})).resolves.toBe("No notes.");
});

it("publishes a note in the CLI's shape, keeping what an update leaves out", async () => {
  const { client, published } = fake(community, { keep: true });
  await expect(
    callTool(client, {}, "notes_set", { name: "plan", text: "draft" }),
  ).rejects.toThrow("title is required for a new note.");
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      text: " ",
    }),
  ).rejects.toThrow("A note needs text.");
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      summary: "the plan",
      tags: ["ops", "q4"],
      path: "plan.md",
    }),
  ).resolves.toBe(`saved 30023:${me}:plan`);
  expect(published).toEqual([
    {
      kind: 30023,
      content: "# plan.md",
      tags: [
        ["d", "plan"],
        ["title", "Plan"],
        ["summary", "the plan"],
        ["t", "ops"],
        ["t", "q4"],
        ["published_at", expect.stringMatching(/^\d+$/)],
      ],
    },
  ]);

  const prior = note(me, "plan", 100, [
    ["summary", "the plan"],
    ["t", "ops"],
    ["published_at", "90"],
  ]);
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const { client: again, published: updates } = fake([...community, prior], {
    keep: true,
  });
  try {
    await callTool(again, {}, "notes_set", { name: "plan", text: "v2" });
    // The next version waits for the second after v2.
    const v3 = callTool(again, {}, "notes_set", {
      name: "plan",
      text: "v3",
      title: "New",
      summary: "",
      tags: [],
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(v3).resolves.toBe(`saved 30023:${me}:plan`);
  } finally {
    vi.useRealTimers();
  }
  expect(updates).toEqual([
    {
      kind: 30023,
      content: "v2",
      tags: [
        ["d", "plan"],
        ["title", "plan title"],
        ["summary", "the plan"],
        ["t", "ops"],
        ["published_at", "90"],
      ],
    },
    {
      kind: 30023,
      content: "v3",
      tags: [
        ["d", "plan"],
        ["title", "New"],
        ["summary", ""],
        ["published_at", "90"],
      ],
    },
  ]);
  // Only your own note is the one an update replaces.
  expect(vi.mocked(again.query).mock.calls[0]?.[0]).toEqual([
    {
      kinds: [30023],
      authors: [me],
      "#d": ["plan"],
      limit: 1,
      consistency: "strong",
    },
  ]);
});

it("reports a conflict when another write of the same second wins", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client, published } = fake([...community, note(me, "plan", 100)], {
      keep: true,
    });
    // Both read version 100 and wait for second 101. The relay keeps the
    // lower id of the two and accepts the other as a duplicate.
    const first = callTool(client, {}, "notes_set", {
      name: "plan",
      text: "mine",
    });
    const second = callTool(client, {}, "notes_set", {
      name: "plan",
      text: "theirs",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toBe(`saved 30023:${me}:plan`);
    expect(await second).toBeInstanceOf(Error);
    expect(((await second) as Error).message).toBe(
      `conflict: note plan now holds another version (${"1".padStart(64, "e")}, 1970-01-01T00:01Z), not this text. Read it with notes_get, then write again.`,
    );
    expect(published.map((template) => template.content)).toEqual([
      "mine",
      "theirs",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("checks a note write against the writer, not a lagging replica", async () => {
  const { client } = fake([...community, note(me, "plan", 100)], {
    keep: true,
  });
  // A replica still holds version 100; only the writer has the new one.
  const writer = client.query;
  const stale = note(me, "plan", 100);
  client.query = vi.fn(async (filters: readonly Filter[]) =>
    filters.every((filter) => filter.consistency === "strong")
      ? writer(filters)
      : [stale],
  );
  await expect(
    callTool(client, {}, "notes_set", { name: "plan", text: "v2" }),
  ).resolves.toBe(`saved 30023:${me}:plan`);
  expect(client.query).toHaveBeenCalledTimes(2);
});

it("reports a conflict when the note is gone after a write", async () => {
  const { client } = fake(community);
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      text: "v1",
    }),
  ).rejects.toThrow(
    "conflict: note plan was not found after this write. Read it with notes_get, then write again.",
  );
});

it("dates a note deletion after the note it deletes", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    // Another writer of this key, with its clock ahead, saved second 102.
    const { client, published } = fake([...community, note(me, "plan", 102)]);
    let done = false;
    const deleting = callTool(client, {}, "notes_rm", { name: "plan" }).then(
      (result) => {
        done = true;
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(deleting).resolves.toBe(`deleted 30023:${me}:plan`);
    expect(published).toHaveLength(1);
    expect(vi.mocked(client.query).mock.calls[0]?.[0]).toEqual([
      {
        kinds: [30023],
        authors: [me],
        "#d": ["plan"],
        limit: 1,
        consistency: "strong",
      },
    ]);
    // A note dated too far ahead is not waited out.
    const { client: ahead, published: none } = fake([
      ...community,
      note(me, "plan", 200),
    ]);
    await expect(
      callTool(ahead, {}, "notes_rm", { name: "plan" }),
    ).rejects.toThrow("The note was just changed; try again.");
    expect(none).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("deletes only your own note, by its address", async () => {
  const { client, published } = fake([
    ...community,
    note(me, "plan", 100),
    note(alice, "hers", 100),
  ]);
  await expect(
    callTool(client, {}, "notes_rm", { name: "hers" }),
  ).rejects.toThrow("You have no note hers.");
  await expect(
    callTool(client, {}, "notes_rm", { name: "plan" }),
  ).resolves.toBe(`deleted 30023:${me}:plan`);
  expect(published).toEqual([
    { kind: 5, content: "", tags: [["a", `30023:${me}:plan`]] },
  ]);
});

// The hive channel: Bob administers it, and Owner's agent Alice joins it.
const ownerKey = new Uint8Array(32).fill(7);
const owner = bytesToHex(schnorr.getPublicKey(ownerKey));
const attested = async (agent: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${agent}:`),
  );
  return [
    "auth",
    owner,
    "",
    bytesToHex(schnorr.sign(new Uint8Array(digest), ownerKey)),
  ];
};
const hive = (roles: Readonly<Record<string, string>>) =>
  event({
    kind: 39002,
    tags: [
      ["d", "chan"],
      ...Object.entries(roles).map(([p, r]) => ["p", p, "", r]),
    ],
  });
const repo = (
  pubkey: string,
  d: string,
  channels: string[],
  extra: string[][] = [],
) =>
  event({
    kind: 30617,
    pubkey,
    id: d.padEnd(64, "0"),
    tags: [["d", d], ...channels.map((c) => ["buzz-channel", c]), ...extra],
  });
const git = (client: BuzzClient, header = "Authorization: Nostr abc") => {
  const gitAuth = vi.fn(async (owner: string, name: string) => ({
    url: `https://relay/git/${owner}/${name}.git`,
    header,
  }));
  client.gitAuth = gitAuth;
  return gitAuth;
};

/** A fake relay over `events` that then serves what `client` publishes. */
const announcing = (events: BuzzEvent[]) => {
  const { client, published } = fake(events);
  client.publish = vi.fn(async (template: Template) => {
    published.push(template);
    const created = event({
      ...template,
      pubkey: client.pubkey,
      id: published.length.toString(16).padStart(64, "e"),
      created_at: 2_000_000_000 + published.length,
    });
    events.push(created);
    return created;
  });
  return { client, published };
};

it("gives the channel's repository and a Git header signed for it", async () => {
  const { client } = fake([
    hive({ [bob]: "admin", [alice]: "member" }),
    repo(bob, "hive", ["chan"]),
    // Access follows the first binding, so this one belongs elsewhere.
    repo(bob, "other", ["elsewhere", "chan"]),
    // Any member may bind a repository; the channel trusts only its leads.
    repo(alice, "impostor", ["chan"]),
  ]);
  const gitAuth = git(client);
  const answer = await callTool(client, { channel: "chan" }, "repo", {});
  expect(gitAuth).toHaveBeenCalledWith(bob, "hive");
  const url = `https://relay/git/${bob}/hive.git`;
  expect(answer).toBe(
    [
      `hive: ${url}`,
      "For the next 60 seconds, pass these headers to each git command (call again for a new one; never save it):",
      `git -c http.${url}.extraHeader='Authorization: Nostr abc' clone ${url}`,
    ].join("\n"),
  );
});

it("passes each Git header line, sign-in evidence included", async () => {
  const { client } = fake([
    hive({ [bob]: "admin" }),
    repo(bob, "hive", ["chan"]),
  ]);
  git(client, "Authorization: Nostr abc\nNostr-Federated-Identity: Bearer xyz");
  const answer = await callTool(client, { channel: "chan" }, "repo", {});
  const url = `https://relay/git/${bob}/hive.git`;
  expect(answer).toContain(
    `git -c http.${url}.extraHeader='Authorization: Nostr abc' -c http.${url}.extraHeader='Nostr-Federated-Identity: Bearer xyz' clone ${url}`,
  );
});

it("trusts a lead's agent, and asks which when there are several", async () => {
  const { client } = fake([
    hive({ [bob]: "admin", [owner]: "owner", [alice]: "member" }),
    repo(alice, "hive", ["chan"], [await attested(alice)]),
    repo(bob, "b", ["chan"]),
  ]);
  const gitAuth = git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow(`Choose repo: ${bob}/b, ${alice}/hive`);
  await callTool(client, { channel: "chan" }, "repo", {
    repo: `${alice}/hive`,
  });
  expect(gitAuth).toHaveBeenCalledWith(alice, "hive");
});

it("creates one protected repository for a channel it leads", async () => {
  const { client, published } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin" }),
  ]);
  const gitAuth = git(client);
  for (const create of [".hive", "a..b", "a/b", "h".repeat(65)])
    await expect(
      callTool(client, { channel: "chan" }, "repo", { create }),
    ).rejects.toThrow("create must be");
  await expect(
    callTool(client, { channel: "hidden" }, "repo", { create: "hive" }),
  ).rejects.toThrow();
  expect(published).toEqual([]);
  await callTool(client, { channel: "chan" }, "repo", { create: "hive" });
  expect(published).toEqual([
    {
      kind: 30617,
      content: "",
      tags: [
        ["d", "hive"],
        ["name", "hive"],
        ["buzz-channel", "chan"],
        ["buzz-protect", "refs/heads/**", "no-force-push", "no-delete"],
      ],
    },
  ]);
  expect(gitAuth).toHaveBeenCalledWith(me, "hive");
});

it("never moves its own repository, or starts a second one", async () => {
  const { client, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin", [bob]: "admin" }),
    repo(me, "hive", ["elsewhere"]),
  ]);
  git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("You already have a repository named hive.");
  expect(published).toEqual([]);
  const { client: bound } = fake([
    hive({ [bob]: "admin" }),
    repo(bob, "hive", ["chan"]),
  ]);
  git(bound);
  await expect(
    callTool(bound, { channel: "chan" }, "repo", { create: "again" }),
  ).rejects.toThrow("already has a repository");
  await expect(
    callTool(bound, { channel: "empty" }, "repo", {}),
  ).rejects.toThrow("has no repository from its owners or admins");
});

it("lets only a lead or a lead's agent start the channel's repository", async () => {
  const { client, published } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "member", [owner]: "owner" }),
  ]);
  git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("Only a channel's owner or an admin, or their agent");
  expect(published).toEqual([]);
  Object.assign(client, { owner });
  await callTool(client, { channel: "chan" }, "repo", { create: "hive" });
  expect(published).toHaveLength(1);
});

it("reads past a page of untrusted repositories, and never guesses past five", async () => {
  const spam = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      event({
        kind: 30617,
        pubkey: alice,
        id: i.toString(16).padStart(64, "a"),
        created_at: 1000 + i,
        tags: [
          ["d", `spam${i}`],
          ["buzz-channel", "chan"],
        ],
      }),
    );
  const { client } = fake([
    hive({ [bob]: "admin", [me]: "admin" }),
    ...spam(150),
    repo(bob, "hive", ["chan"]),
  ]);
  const gitAuth = git(client);
  await callTool(client, { channel: "chan" }, "repo", {});
  await callTool(client, { channel: "chan" }, "repo", { repo: `${bob}/hive` });
  expect(gitAuth).toHaveBeenNthCalledWith(1, bob, "hive");
  expect(gitAuth).toHaveBeenNthCalledWith(2, bob, "hive");

  const { client: flooded, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [bob]: "admin", [me]: "admin" }),
    ...spam(500),
    repo(bob, "hive", ["chan"]),
  ]);
  git(flooded);
  await expect(
    callTool(flooded, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow("could not all be read");
  await expect(
    callTool(flooded, { channel: "chan" }, "repo", { create: "mine" }),
  ).rejects.toThrow("could not all be read");
  expect(published).toEqual([]);
});

it("starts one repository at a time, from the relay's writer, and confirms it", async () => {
  const led = (channel: string) => [
    event({ kind: 39000, id: channel.padEnd(64, "1"), tags: [["d", channel]] }),
    event({
      kind: 39002,
      id: channel.padEnd(64, "2"),
      tags: [
        ["d", channel],
        ["p", me, "", "admin"],
      ],
    }),
  ];
  const { client, published } = announcing([...led("chan"), ...led("other")]);
  git(client);
  const results = await Promise.allSettled([
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
    callTool(client, { channel: "other" }, "repo", { create: "hive" }),
  ]);
  expect(published).toHaveLength(1);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe(
    "You already have a repository named hive.",
  );
  const reads = vi
    .mocked(client.query)
    .mock.calls.flatMap(([filters]) => filters)
    .filter((filter) =>
      (filter.kinds as number[] | undefined)?.includes(30617),
    );
  expect(reads.every((filter) => filter.consistency === "strong")).toBe(true);

  // Another session of it rebinds the name before the relay is read back.
  const { client: raced } = announcing(led("chan"));
  git(raced);
  const publish = raced.publish;
  raced.publish = vi.fn(async (template: Template) => {
    const created = await publish(template);
    await publish({
      ...template,
      tags: template.tags.map((t) =>
        t[0] === "buzz-channel" ? ["buzz-channel", "elsewhere"] : t,
      ),
    });
    return created;
  });
  await expect(
    callTool(raced, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("hive was announced, but the relay binds it elsewhere.");
});

it("says how to get the header when only that failed", async () => {
  const { client } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin" }),
  ]);
  client.gitAuth = vi.fn(async () => {
    throw new Error("offline.");
  });
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow(
    "Started hive, but its Git header failed: offline. Call repo again without create.",
  );
});

it("refuses Git where the host holds no key", async () => {
  const { client } = fake([
    hive({ [bob]: "admin" }),
    repo(bob, "hive", ["chan"]),
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow("Git access needs Buzz Desktop.");
});

it("validates creation inputs and reports hosts without agent creation", async () => {
  const { client } = fake([]);
  await expect(
    callTool(client, {}, "agent_create", {
      type: "codex/codex",
      name: "Child",
    }),
  ).rejects.toThrow("unavailable");
  await expect(callTool(client, {}, "agent_types", {})).rejects.toThrow(
    "unavailable",
  );
  client.createAgent = vi.fn();
  for (const args of [{}, { type: "x", name: " " }, { type: 1, name: "Child" }])
    await expect(callTool(client, {}, "agent_create", args)).rejects.toThrow(
      "required",
    );
  expect(client.createAgent).not.toHaveBeenCalled();
  await callTool(client, {}, "agent_create", { type: "x", name: "Child" });
  await callTool(client, {}, "agent_create", {
    type: "x",
    name: "Child",
    instructions: "Review PRs.",
  });
  expect(client.createAgent).toHaveBeenNthCalledWith(1, {
    type: "x",
    name: "Child",
  });
  expect(client.createAgent).toHaveBeenNthCalledWith(2, {
    type: "x",
    name: "Child",
    instructions: "Review PRs.",
  });
});

it("hands off to the agent in another of its conversations it can see", async () => {
  const solo = event({
    kind: 39000,
    tags: [["d", "solo"], ["t", "stream"], ["t", "buzz.solo"], ["private"]],
  });
  const reply = event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
  const other = "3".repeat(64);
  const inSolo = event({ id: "4".repeat(64), tags: [["h", "solo"]] });
  const { client } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    solo,
    event({ id: root }),
    reply,
    event({ id: other, tags: [["h", "elsewhere"]] }),
    inSolo,
  ]);
  const wake = (context: object, args: object) =>
    callTool(client, context, "self_handoff", { text: "carry on", ...args });
  await expect(wake({}, { channel: "chan" })).rejects.toThrow("unavailable");
  client.handoff = vi.fn();
  await expect(wake({}, { channel: "nope" })).rejects.toThrow(
    "No channel nope",
  );
  await expect(
    wake({}, { channel: "chan", thread: "9".repeat(64) }),
  ).rejects.toThrow("No message");
  await expect(wake({}, { channel: "chan", thread: other })).rejects.toThrow(
    `${other} is not in chan.`,
  );
  await expect(wake({}, { channel: "chan" })).rejects.toThrow(
    "thread is required outside a Solo chat.",
  );
  await expect(
    wake({ channel: "chan", root }, { channel: "chan", thread: nested }),
  ).rejects.toThrow("That is this conversation.");
  // A session with no root, as in a Solo chat, a DM or channel scope, or one
  // marked whole, is the whole channel, whatever thread is named.
  for (const context of [
    { channel: "solo", topLevel: true },
    { channel: "chan" },
    { channel: "chan", root: "5".repeat(64), wholeChannel: true },
  ])
    await expect(
      wake(context, { channel: context.channel, thread: inSolo.id }),
    ).rejects.toThrow(
      context.channel === "solo" ? "That is this conversation." : "is not in",
    );
  await expect(
    wake({ channel: "chan" }, { channel: "chan", thread: nested }),
  ).rejects.toThrow("That is this conversation.");
  await expect(
    wake(
      { channel: "chan", root: "5".repeat(64), wholeChannel: true },
      { channel: "chan", thread: nested },
    ),
  ).rejects.toThrow("That is this conversation.");
  await expect(
    callTool(client, {}, "self_handoff", { channel: "chan", thread: root }),
  ).rejects.toThrow("text is required.");
  expect(client.handoff).not.toHaveBeenCalled();
  // Any message of the thread names its root, and the wake says where it
  // came from.
  await wake(
    { channel: "solo", topLevel: true },
    { channel: "chan", thread: nested },
  );
  await wake({ channel: "chan", root }, { channel: "solo" });
  await wake({}, { channel: "chan", thread: root });
  expect(vi.mocked(client.handoff).mock.calls).toEqual([
    [{ channel: "chan", root, text: "carry on", from: { channel: "solo" } }],
    [{ channel: "solo", text: "carry on", from: { channel: "chan", root } }],
    [{ channel: "chan", root, text: "carry on", from: {} }],
  ]);
});
it("reads agents and teams and drafts team changes without members", async () => {
  const { client } = fake([]);
  for (const name of ["agent_read", "team_read"])
    await expect(callTool(client, {}, name, {})).rejects.toThrow("unavailable");
  client.readAgents = vi.fn(async () => []);
  client.readTeams = vi.fn(async () => ({
    id: "t",
    name: "Crew",
    instructions: "",
    members: [],
    synced: true,
    revision: "r",
  }));
  client.updateTeam = vi.fn(async () => ({
    requestId: "draft",
    saved: false as const,
  }));
  expect(await callTool(client, {}, "agent_read", {})).toBe("[]");
  expect(client.readAgents).toHaveBeenCalledWith(undefined);
  expect(
    JSON.parse(
      (await callTool(client, {}, "team_read", { team: "Crew" })) as string,
    ),
  ).toMatchObject({ id: "t", revision: "r" });
  expect(client.readTeams).toHaveBeenCalledWith("Crew");
  await expect(callTool(client, {}, "team_update", {})).rejects.toThrow(
    "required",
  );
  await callTool(client, {}, "team_update", {
    team: "Crew",
    name: " ",
    instructions: "",
    members: ["x"],
  });
  expect(client.updateTeam).toHaveBeenCalledWith({
    team: "Crew",
    instructions: "",
  });
});
it("validates change drafts and passes only the proposed fields", async () => {
  const { client } = fake([]);
  await expect(
    callTool(client, {}, "agent_update", { agent: "Child", name: "Kid" }),
  ).rejects.toThrow("unavailable");
  client.updateAgent = vi.fn(async () => ({
    requestId: "draft",
    saved: false as const,
  }));
  for (const args of [{}, { agent: " ", name: "Kid" }, { agent: 1 }])
    await expect(callTool(client, {}, "agent_update", args)).rejects.toThrow(
      "required",
    );
  expect(client.updateAgent).not.toHaveBeenCalled();
  await callTool(client, {}, "agent_update", {
    agent: " Child ",
    name: " Kid ",
    type: " ",
    instructions: "Review PRs.",
  });
  expect(client.updateAgent).toHaveBeenCalledWith({
    agent: "Child",
    name: "Kid",
    instructions: "Review PRs.",
  });
  await callTool(client, {}, "agent_update", {
    agent: "Child",
    instructions: "",
  });
  expect(client.updateAgent).toHaveBeenLastCalledWith({
    agent: "Child",
    instructions: "",
  });
});

it("uploads a proposed picture as the agent once its draft is valid", async () => {
  const { client } = fake([]);
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]);
  const read = client.read;
  client.read = vi.fn(async (path: string) =>
    path === "/tmp/me.png" || path === "kid.png" ? image : read(path),
  );
  const pictures: string[] = [];
  const saved = async (input: { picture?: () => Promise<string> }) => {
    if (input.picture) pictures.push(await input.picture());
    return { requestId: "draft", saved: false as const };
  };
  client.updateAgent = vi.fn(saved);
  client.createAgent = vi.fn(saved);
  await expect(
    callTool(client, {}, "agent_update", { agent: "Child", picture: "me.png" }),
  ).rejects.toThrow("Picture proposals are unavailable");
  expect(client.updateAgent).not.toHaveBeenCalled();
  client.uploadPicture = vi.fn(async (_data: Uint8Array, type: string) => ({
    url: "https://relay/media/x.png",
    sha256: "ab",
    size: 7,
    type,
  }));
  // A text file, and a PNG signature cut short that the preparer would
  // pass through unchanged.
  for (const picture of ["notes.md", "short.png"])
    for (const [name, args] of [
      ["agent_update", { agent: "Child" }],
      ["agent_create", { type: "codex/codex", name: "Child" }],
    ] as const)
      await expect(
        callTool(client, {}, name, { ...args, picture }),
      ).rejects.toThrow("PNG, JPEG, GIF or WebP");
  expect(client.uploadPicture).not.toHaveBeenCalled();
  expect(pictures).toEqual([]);
  await callTool(client, {}, "agent_update", {
    agent: "Child",
    picture: "/tmp/me.png",
  });
  await callTool(client, {}, "agent_create", {
    type: "codex/codex",
    name: "Kid",
    picture: "kid.png",
  });
  expect(client.uploadPicture).toHaveBeenCalledWith(image, "image/png");
  expect(client.upload).not.toHaveBeenCalled();
  expect(pictures).toEqual([
    "https://relay/media/x.png",
    "https://relay/media/x.png",
  ]);
  expect(client.updateAgent).toHaveBeenLastCalledWith({
    agent: "Child",
    picture: expect.any(Function),
  });
  expect(client.createAgent).toHaveBeenLastCalledWith({
    type: "codex/codex",
    name: "Kid",
    picture: expect.any(Function),
  });
});

it("nests a reply under a message inside a thread, naming the root and the parent", async () => {
  const { client, published } = fake([
    ...community,
    event({ id: root, tags: [["h", "other"]] }),
  ]);
  // The parent's channel wins over where the agent is working.
  await callTool(client, { channel: "elsewhere" }, "reply_in_subthread", {
    audience: "everyone",
    parent: nested,
    text: "@Bob take this one",
    files: ["shot.png"],
  });
  expect(published[0]?.tags.slice(0, 4)).toEqual([
    ["h", "chan"],
    ["e", root, "", "root"],
    ["e", nested, "", "reply"],
    ["p", bob],
  ]);
  expect(published[0]?.tags[4]?.[0]).toBe("imeta");
});

it.each(["everyone", "agents"])(
  "replies under a thread's root as send does, for audience %s",
  async (audience) => {
    const { client, published } = fake(community);
    const context = { channel: "chan", root };
    await callTool(client, context, "reply_in_subthread", {
      parent: root,
      audience,
      text: "@Alice Smith hi",
    });
    await callTool(client, context, "send", {
      audience,
      text: "@Alice Smith hi",
    });
    expect(published[0]).toEqual(published[1]);
    expect(published[0]?.tags).toEqual([
      ["h", "chan"],
      ["e", root, "", "reply"],
      ["p", alice],
      ...(audience === "agents" ? [["audience", "agents"]] : []),
    ]);
  },
);

it("tags a nested reply for agents only, signing its request", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "reply_in_subthread", {
    parent: nested,
    audience: "agents",
    request: "f".repeat(64),
    text: "a",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "root"],
    ["e", nested, "", "reply"],
    ["audience", "agents"],
    ["buzz:request", "f".repeat(64)],
  ]);
});

it.each([undefined, "humans"])(
  "refuses a nested reply whose audience is %s, publishing nothing",
  async (audience) => {
    const { client, published } = fake(community);
    await expect(
      callTool(client, { channel: "chan", root }, "reply_in_subthread", {
        parent: nested,
        audience,
        text: "hi",
      }),
    ).rejects.toThrow("audience must be everyone or agents.");
    expect(published).toEqual([]);
  },
);

it("keeps nested replies out of a top-level chat and to channel members", async () => {
  const { client, published } = fake(community);
  await expect(
    callTool(
      client,
      { channel: "chan", topLevel: true },
      "reply_in_subthread",
      { parent: nested, audience: "everyone", text: "hi" },
    ),
  ).rejects.toThrow("This chat stays at the top level");
  await expect(
    callTool(client, { channel: "chan", root }, "reply_in_subthread", {
      audience: "everyone",
      parent: nested,
      text: "hi @Carol",
    }),
  ).rejects.toThrow("No single channel member is @carol");
  expect(published).toEqual([]);
});

it("starts a thread under a top-level message that is not the current root", async () => {
  const other = event({ id: "5".repeat(64), tags: [["h", "chan"]] });
  const { client, published } = fake([...community, other]);
  await callTool(client, { channel: "chan", root }, "reply_in_subthread", {
    audience: "everyone",
    parent: other.id,
    text: "a",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", other.id, "", "reply"],
  ]);
});

it("nests under parents as the relay reads their root, whatever the markers or case", async () => {
  const remarked = event({
    id: "3".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", alice, "", "root"],
      ["e", root, "", "root"],
      ["e", nested, "", "reply"],
    ],
  });
  const uppercase = event({
    id: "4".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", root.replace(/1/g, "A"), "", "reply"],
    ],
  });
  const { client, published } = fake([...community, remarked, uppercase]);
  const context = { channel: "chan", root };
  await callTool(client, context, "reply_in_subthread", {
    audience: "everyone",
    parent: remarked.id,
    text: "a",
  });
  await callTool(client, context, "reply_in_subthread", {
    audience: "everyone",
    parent: uppercase.id,
    text: "b",
  });
  expect(published.map((sent) => sent.tags.slice(1))).toEqual([
    [
      ["e", root, "", "root"],
      ["e", remarked.id, "", "reply"],
    ],
    [
      ["e", root.replace(/1/g, "a"), "", "root"],
      ["e", uppercase.id, "", "reply"],
    ],
  ]);
});

it("finds an uppercase parent and writes its id in lowercase", async () => {
  const lettered = "ab".repeat(32);
  const child = "cd".repeat(32);
  const { client, published } = fake([
    ...community,
    event({ id: lettered }),
    event({
      id: child,
      tags: [
        ["h", "chan"],
        ["e", lettered, "", "reply"],
      ],
    }),
  ]);
  const context = { channel: "chan", root: lettered };
  await callTool(client, context, "reply_in_subthread", {
    audience: "everyone",
    parent: child.toUpperCase(),
    text: "a",
  });
  await callTool(client, context, "reply_in_subthread", {
    audience: "everyone",
    parent: lettered.toUpperCase(),
    text: "b",
  });
  expect(published.map((sent) => sent.tags)).toEqual([
    [
      ["h", "chan"],
      ["e", lettered, "", "root"],
      ["e", child, "", "reply"],
    ],
    [
      ["h", "chan"],
      ["e", lettered, "", "reply"],
    ],
  ]);
});

it("refuses a parent it cannot find, publishing nothing", async () => {
  const { client, published } = fake(community);
  await expect(
    callTool(client, { channel: "chan", root }, "reply_in_subthread", {
      audience: "everyone",
      parent: "9".repeat(64),
      text: "hi",
    }),
  ).rejects.toThrow(`No message ${"9".repeat(64)}.`);
  expect(published).toEqual([]);
});

it("needs the message to reply under", async () => {
  const { client, published } = fake(community);
  await expect(
    callTool(client, { channel: "chan", root }, "reply_in_subthread", {
      audience: "everyone",
      text: "hi",
    }),
  ).rejects.toThrow("parent is required");
  expect(published).toEqual([]);
});

it("deletes only the given message, one target per deletion", async () => {
  const mine = event({ id: root, pubkey: me, created_at: 100 });
  const copy = event({
    id: nested,
    pubkey: me,
    created_at: 101,
    tags: [
      ["h", "chan"],
      ["buzz:copy-of", root],
    ],
  });
  const { client, published } = fake([mine, copy]);
  expect(
    await callTool(client, { channel: "chan" }, "delete", { id: nested }),
  ).toContain("deleted");
  expect(published).toEqual([
    {
      kind: 5,
      content: "",
      tags: [
        ["h", "chan"],
        ["e", nested],
        ["k", "9"],
      ],
    },
  ]);
});

it("marks delete as destructive, also as a session lists it", () => {
  for (const tools of [TOOLS, sessionTools()])
    expect(tools.find((tool) => tool.name === "delete")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
});

it("refuses to delete another author's message", async () => {
  const { client, published } = fake([event({ id: root, pubkey: alice })]);
  await expect(
    callTool(client, { channel: "chan" }, "delete", { id: root }),
  ).rejects.toThrow("Only your own messages can be deleted.");
  expect(published).toEqual([]);
});

it("saves a canvas of exactly the live limit in UTF-8 bytes, and refuses one byte over", async () => {
  const { client, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
  ]);
  const exact = "é".repeat(LIVE_CANVAS_BYTES / 2);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", { content: exact }),
  ).resolves.toBe("saved");
  expect(published).toHaveLength(1);
  await expect(
    callTool(client, { channel: "chan" }, "canvas_set", {
      content: `${exact.slice(1)}xyz`,
    }),
  ).rejects.toThrow(`over its limit of ${LIVE_CANVAS_BYTES} bytes`);
  expect(published).toHaveLength(1);
});

it("addresses a new reaction to the actual message author and fails before publishing if the target is unavailable", async () => {
  const { client, published } = fake([event({ id: root, pubkey: alice })]);
  await callTool(client, {}, "react", { id: root, emoji: "❤️" });
  expect(published).toEqual([
    {
      kind: 7,
      content: "❤️",
      tags: [
        ["e", root],
        ["p", alice],
      ],
    },
  ]);
  await expect(
    callTool(client, {}, "react", { id: nested, emoji: "❤️" }),
  ).rejects.toThrow("No message");
  expect(published).toHaveLength(1);
});
