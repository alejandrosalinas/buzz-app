import { expect, it, vi } from "vitest";
import { BESTIE_TOOLS } from "./bestie";
import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import { sessionTools } from "./session-tools";
import { TOOLS } from "./tools";

const agent = "b".repeat(64);
const none = { device: null, account: null, here: false };
function withBestie() {
  const bestie = {
    read: vi.fn(async () => none),
    set: vi.fn(async (pubkey: string) => ({
      device: pubkey,
      account: pubkey,
      here: true,
    })),
    clear: vi.fn(async () => none),
  };
  return { client: { bestie } as unknown as BuzzClient, bestie };
}

const call = async (client: BuzzClient, name: string, args: unknown = {}) =>
  (
    (await respond(
      client,
      {},
      { id: 1, method: "tools/call", params: { name, arguments: args } },
    )) as { result: { content: { text: string }[]; isError?: boolean } }
  ).result;
const names = async (client: BuzzClient | undefined) =>
  (
    (await respond(client, {}, { id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map(({ name }) => name);

it("reads, sets and clears the owner's Bestie, answering with its state", async () => {
  const { client, bestie } = withBestie();
  const set = await call(client, "bestie_set", { agent });
  expect(set.isError).toBeUndefined();
  expect(JSON.parse(set.content[0]?.text ?? "")).toEqual({
    device: agent,
    account: agent,
    here: true,
  });
  expect(bestie.set).toHaveBeenCalledExactlyOnceWith(agent);
  for (const name of ["bestie_get", "bestie_clear"])
    expect(
      JSON.parse((await call(client, name)).content[0]?.text ?? ""),
    ).toEqual(none);
  expect(bestie.read).toHaveBeenCalledOnce();
  expect(bestie.clear).toHaveBeenCalledOnce();
});

it("refuses stray arguments, a missing agent and connections without a Bestie, changing nothing", async () => {
  const { client, bestie } = withBestie();
  for (const [name, args, error] of [
    ["bestie_set", {}, /agent must be/],
    ["bestie_set", { agent: 1 }, /agent must be/],
    ["bestie_set", { agent, force: true }, /force cannot be used/],
    ["bestie_clear", { agent }, /agent cannot be used/],
  ] as const) {
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(error);
  }
  expect(bestie.set).not.toHaveBeenCalled();
  expect(bestie.clear).not.toHaveBeenCalled();
  const refused = await call({} as BuzzClient, "bestie_set", { agent });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]?.text).toMatch(/can't be changed from this/);
});

it("lists the tools on search only where the Bestie can change, and keeps it from plugins' tools", async () => {
  const { client } = withBestie();
  const tools = BESTIE_TOOLS.map(({ name }) => name);
  const bestie = async (client: BuzzClient | undefined) =>
    (await names(client)).filter((name) => tools.includes(name));
  expect(await bestie(client)).toEqual(tools);
  // A process started ahead of its agent lists them as the agent's will.
  expect(await bestie(undefined)).toEqual(tools);
  expect(await bestie({} as BuzzClient)).toEqual([]);
  expect(TOOLS.some((tool) => tools.includes(tool.name))).toBe(false);
  expect(
    sessionTools()
      .filter(({ name }) => tools.includes(name))
      .map(({ load }) => load),
  ).toEqual(["search", "search", "search"]);
  const seen = vi.fn<(client: BuzzClient) => void>();
  await respond(
    client,
    {},
    { id: 1, method: "tools/call", params: { name: "plugin_tool" } },
    [
      {
        name: "plugin_tool",
        description: "A plugin's tool.",
        inputSchema: { type: "object" },
        call: async (given: BuzzClient) => {
          seen(given);
          return "done";
        },
      },
    ],
  );
  expect(seen.mock.calls[0]?.[0]).not.toHaveProperty("bestie");
});
