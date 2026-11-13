import { expect, it, vi } from "vitest";
import {
  createDeviceSettings,
  type SettingValue,
} from "../shared/device-settings";
import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import { SETTINGS_TOOLS } from "./settings";
import { BUZZ_SESSION, sessionTools } from "./session-tools";
import { TOOLS } from "./tools";

/** A client whose settings are a catalog these tools have never heard of. */
function withSettings() {
  let value: SettingValue = "calm";
  const write = vi.fn((next: SettingValue) => {
    value = next;
  });
  const catalog = createDeviceSettings([
    {
      key: "example.mood",
      description: "A mood.",
      schema: { type: "string", enum: ["calm", "busy"] },
      read: () => ({ value }),
      write,
    },
  ]);
  return { client: { settings: catalog } as unknown as BuzzClient, write };
}

const call = async (
  client: BuzzClient | undefined,
  name: string,
  args: unknown = {},
) =>
  (
    (await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    )) as {
      result: { content: { text: string }[]; isError?: boolean };
    }
  ).result;
const names = async (client: BuzzClient | undefined) =>
  (
    (await respond(client, {}, { id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map(({ name }) => name);

it("lists, gets and sets whatever settings the host defines", async () => {
  const { client, write } = withSettings();
  const listed = await call(client, "settings_list");
  expect(JSON.parse(listed.content[0]?.text ?? "")).toEqual([
    {
      key: "example.mood",
      description: "A mood.",
      schema: { type: "string", enum: ["calm", "busy"] },
      value: "calm",
      saved: true,
    },
  ]);
  const set = await call(client, "settings_set", {
    key: "example.mood",
    value: "busy",
  });
  expect(set.isError).toBeUndefined();
  expect(JSON.parse(set.content[0]?.text ?? "")).toMatchObject({
    value: "busy",
    saved: true,
  });
  expect(write).toHaveBeenCalledExactlyOnceWith("busy");
  const got = await call(client, "settings_get", { key: "example.mood" });
  expect(JSON.parse(got.content[0]?.text ?? "").value).toBe("busy");
});

it("refuses unknown keys, values outside the schema and stray arguments, changing nothing", async () => {
  const { client, write } = withSettings();
  for (const [args, error] of [
    [{ key: "example.other", value: "busy" }, /No Buzz setting/],
    [{ key: "example.mood", value: "Busy" }, /example.mood takes/],
    [{ key: "example.mood", value: 1 }, /example.mood takes/],
    [{ key: "example.mood" }, /example.mood takes/],
    [
      { key: "example.mood", value: "busy", force: true },
      /force cannot be used/,
    ],
  ] as const) {
    const result = await call(client, "settings_set", args);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(error);
  }
  expect(
    (await call(client, "settings_list", { key: "example.mood" })).isError,
  ).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("lists the tools only where settings can change, and refuses them elsewhere", async () => {
  const { client } = withSettings();
  const without = {} as BuzzClient;
  const tools = SETTINGS_TOOLS.map(({ name }) => name);
  expect(await names(client)).toEqual(expect.arrayContaining(tools));
  // A process started ahead of its agent lists them as the agent's will.
  const settings = async (client: BuzzClient | undefined) =>
    (await names(client)).filter((name) => tools.includes(name));
  expect(await settings(undefined)).toEqual(await settings(client));
  expect((await names(without)).filter((name) => tools.includes(name))).toEqual(
    [],
  );
  for (const name of ["settings_list", "settings_set"]) {
    const refused = await call(without, name, {
      ...(name === "settings_set"
        ? { key: "example.mood", value: "busy" }
        : {}),
    });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]?.text).toMatch(
      /can't be changed from this connection/,
    );
  }
});

it("gives a plugin's tool the agent's client without its settings", async () => {
  const { client } = withSettings();
  const seen = vi.fn<(client: BuzzClient) => void>();
  const added = [
    {
      name: "plugin_tool",
      description: "A plugin's tool.",
      inputSchema: { type: "object" },
      call: async (given: BuzzClient) => {
        seen(given);
        return "done";
      },
    },
  ];
  await respond(
    client,
    {},
    { id: 1, method: "tools/call", params: { name: "plugin_tool" } },
    added,
  );
  expect(seen).toHaveBeenCalledOnce();
  expect(seen.mock.calls[0]?.[0]).not.toHaveProperty("settings");
});

it("keeps settings out of the standalone server and reserves their names", () => {
  const tools = SETTINGS_TOOLS.map(({ name }) => name);
  for (const name of tools) {
    expect(TOOLS.some((tool) => tool.name === name)).toBe(false);
    expect(BUZZ_SESSION.tools.some((tool) => tool.name === name)).toBe(true);
  }
  // Loaded on search, so their definitions cost nothing until needed.
  expect(
    sessionTools()
      .filter(({ name }) => tools.includes(name))
      .map(({ load }) => load),
  ).toEqual(["search", "search", "search"]);
});
