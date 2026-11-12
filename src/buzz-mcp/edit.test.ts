import { afterEach, expect, it, vi } from "vitest";
import { bytesToHex } from "nostr-tools/utils";
import { eventDto } from "../features/relay/events";
import { keypair, signed } from "../features/relay/testing";
import { nodeClient } from "./node";
import { callTool } from "./tools";
import type { BuzzEvent } from "./client";

const agent = keypair();
const owner = keypair();
const channel = "00000000-0000-4000-8000-000000000001";
const file = [
  "imeta",
  "url https://relay.example.org/media/private.png",
  `x ${"a".repeat(64)}`,
];

function fixture(kind = 9) {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const original = signed(agent, {
    kind,
    content: "original",
    tags: [["h", channel], file],
    created_at: 1_799_999_999,
  });
  let latest: BuzzEvent | null = null;
  let answer: unknown;
  let lookupStatus = 200;
  let accepted = true;
  const published: BuzzEvent[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/events")) {
      const event = eventDto(body);
      published.push(event);
      if (accepted) latest = event;
      return Response.json({
        accepted,
        message: accepted ? "" : "file not publishable by signer",
      });
    }
    const auth = String(
      (init.headers as Record<string, string>).authorization,
    ).slice(6);
    expect(
      eventDto(JSON.parse(Buffer.from(auth, "base64").toString())).pubkey,
    ).toBe(agent.pubkey);
    if (body[0].effective_edit) {
      expect(body).toEqual([
        {
          kinds: [9, 40002, 40008, 45001, 45003],
          ids: [original.id],
          "#h": [channel],
          effective_edit: 1,
          consistency: "strong",
        },
      ]);
      return Response.json(
        answer === undefined
          ? { effective_edit: 1, original, edit: latest }
          : answer,
        { status: lookupStatus },
      );
    }
    return Response.json([original]);
  });
  vi.stubGlobal("fetch", fetcher);
  const client = nodeClient({
    relay: "wss://relay.example.org",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
  return {
    original,
    client,
    published,
    fetcher,
    edit: () =>
      callTool(client, { channel }, "edit", {
        id: original.id,
        text: "edited",
      }),
    setLatest: (tags: string[][], created_at = 1_800_000_000) => {
      latest = signed(agent, {
        kind: 40003,
        content: "prior",
        tags: [
          ["h", channel],
          ["e", "invalid"],
          ["e", original.id.toUpperCase()],
          ...tags,
        ],
        created_at,
      });
      return latest;
    },
    answer: (value: unknown, status = 200) => {
      answer = value;
      lookupStatus = status;
    },
    refuse: () => {
      accepted = false;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([9, 40002, 40008, 45001, 45003])(
  "retains current private attachments across successive MCP edits of kind %s",
  async (kind) => {
    const f = fixture(kind);
    await f.edit();
    expect(f.published[0]?.tags).toContainEqual(file);
    const replacement = [
      "imeta",
      "url https://relay.example.org/media/replacement.png",
      `x ${"b".repeat(64)}`,
    ];
    const head = f.setLatest([replacement]);
    const second = f.edit();
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(f.published[1]?.created_at).toBeGreaterThan(head.created_at);
    expect(f.published[1]?.tags.filter((t) => t[0] === "imeta")).toEqual([
      replacement,
    ]);
    f.setLatest([], 1_800_000_001);
    const third = f.edit();
    await vi.advanceTimersByTimeAsync(1000);
    await third;
    const fourth = f.edit();
    await vi.advanceTimersByTimeAsync(1000);
    await fourth;
    expect(
      f.published.slice(2).map((e) => e.tags.filter((t) => t[0] === "imeta")),
    ).toEqual([[], []]);
    expect(
      f.published.every(
        (e) =>
          e.pubkey === agent.pubkey &&
          e.tags.some((t) => t[0] === "auth" && t[1] === owner.pubkey),
      ),
    ).toBe(true);
  },
);

it.each([
  ["old relay array", [], 200],
  ["missing edit", { effective_edit: 1 }, 200],
  ["wrong version", { effective_edit: 2, edit: null }, 200],
  ["404", { error: "message not found" }, 404],
  ["lookup failure", { error: "database unavailable" }, 503],
])(
  "aborts before message signing/publication on %s",
  async (_, response, status) => {
    const f = fixture();
    f.answer(response, status as number | undefined);
    await expect(f.edit()).rejects.toThrow();
    expect(f.published).toEqual([]);
    expect(
      f.fetcher.mock.calls.every(([url]) => !url.endsWith("/events")),
    ).toBe(true);
  },
);

it.each([
  "target",
  "channel",
  "kind",
  "signature",
  "replacement target",
  "replacement channel",
  "replacement kind",
])("rejects a signed snapshot with invalid %s", async (fault) => {
  const f = fixture();
  let original = f.original;
  let edit: BuzzEvent | null = null;
  if (fault === "target")
    original = signed(agent, { ...original, content: "another" });
  if (fault === "channel")
    original = signed(agent, { ...original, tags: [["h", "elsewhere"]] });
  if (fault === "kind") original = signed(agent, { ...original, kind: 7 });
  if (fault === "signature") original = { ...original, sig: "0".repeat(128) };
  if (fault.startsWith("replacement"))
    edit = signed(agent, {
      kind: fault === "replacement kind" ? 7 : 40003,
      content: "bad",
      tags: [
        ["h", fault.endsWith("channel") ? "elsewhere" : channel],
        ["e", fault.endsWith("target") ? "f".repeat(64) : original.id],
      ],
    });
  f.answer({ effective_edit: 1, original, edit });
  await expect(f.edit()).rejects.toThrow();
  expect(f.published).toEqual([]);
});

it("refuses an excessively future head instead of extending its timeline", async () => {
  const f = fixture();
  f.setLatest([file], 1_800_000_010);
  await expect(f.edit()).rejects.toThrow(/clock catches up/);
  expect(f.published).toEqual([]);
});

it.each([40003, 7, 45002])(
  "rejects unsupported original kind %s without publication",
  async (kind) => {
    const f = fixture(kind);
    await expect(f.edit()).rejects.toThrow("wrong original");
    expect(f.published).toEqual([]);
  },
);

it("reports signer media denial without retrying or stripping the attachments", async () => {
  const f = fixture();
  f.refuse();
  await expect(f.edit()).rejects.toThrow("file not publishable by signer");
  expect(f.published).toHaveLength(1);
  expect(f.published[0]?.tags).toContainEqual(file);
});
