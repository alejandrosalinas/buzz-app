import { describe, expect, it, vi } from "vitest";
import type { AgentPlugins } from "../plugins/requests";
import type { BuzzClient, Context } from "./client";
import { callSessionTool, sessionTools } from "./session-tools";

const fake = (plugins: Partial<AgentPlugins>, publish = vi.fn()) =>
  ({ pubkey: "a", key: "a", plugins, publish }) as unknown as BuzzClient;
const call = (
  client: BuzzClient,
  name: string,
  args = {},
  context: Context = {},
) => callSessionTool(client, context, name, args);
const BROWSER = "https://github.com/squareup/buzz-plugin-browser";

describe("plugin tools", () => {
  it("load on search", () => {
    const listed = sessionTools().filter((tool) =>
      tool.name.startsWith("plugin_"),
    );
    expect(listed.map(({ name, load }) => [name, load])).toEqual([
      ["plugin_list", "search"],
      ["plugin_discover", "search"],
      ["plugin_disable", "search"],
      ["plugin_request", "search"],
      ["plugin_request_status", "search"],
    ]);
  });

  it("refuse on a host without plugins", async () => {
    const client = { pubkey: "a", key: "a" } as unknown as BuzzClient;
    for (const name of [
      "plugin_list",
      "plugin_discover",
      "plugin_disable",
      "plugin_request",
      "plugin_request_status",
    ])
      await expect(
        call(client, name, { repository: "owner/x" }),
      ).rejects.toThrow("Plugin management is unavailable on this host");
  });

  it("list the device's plugins", async () => {
    const plugins = { plugins: [{ id: "example", enabled: true }] };
    const client = fake({ list: vi.fn(async () => plugins) as never });
    expect(JSON.parse((await call(client, "plugin_list")) as string)).toEqual(
      plugins,
    );
  });

  it("discover a repository's candidates", async () => {
    const discover = vi.fn(async () => ({ commit: "c", candidates: [] }));
    const client = fake({ discover: discover as never });
    await call(client, "plugin_discover", {
      repository: " owner/x ",
      reference: "main",
    });
    expect(discover).toHaveBeenCalledWith("owner/x", "main");
    await expect(call(client, "plugin_discover")).rejects.toThrow(
      "repository is required",
    );
  });

  it("disable a plugin by id", async () => {
    const disable = vi.fn(async (id: string) => ({ id, enabled: false }));
    const client = fake({ disable: disable as never });
    expect(
      JSON.parse(
        (await call(client, "plugin_disable", { id: "example" })) as string,
      ),
    ).toEqual({ id: "example", enabled: false });
    await expect(call(client, "plugin_disable")).rejects.toThrow(
      "id is required",
    );
  });

  it("request a change and read its status", async () => {
    const request = vi.fn(async () => ({
      requestId: "r",
      applied: false,
      action: "install",
      pluginName: "Browser",
    }));
    const status = vi.fn(() => ({ state: "pending" }));
    const client = fake({ request, status } as never);
    expect(
      JSON.parse(
        (await call(client, "plugin_request", {
          action: "install",
          repository: BROWSER,
          reason: "Open the staging site",
        })) as string,
      ),
    ).toEqual({ requestId: "r", applied: false });
    expect(request).toHaveBeenCalledWith({
      action: "install",
      id: undefined,
      repository: BROWSER,
      reference: undefined,
      path: undefined,
      commit: undefined,
      reason: "Open the staging site",
    });
    await expect(
      call(client, "plugin_request", { action: "explode", reason: "x" }),
    ).rejects.toThrow("action must be one of install, update, enable, remove");
    expect(
      JSON.parse(
        (await call(client, "plugin_request_status", {
          requestId: "r",
        })) as string,
      ),
    ).toEqual({ state: "pending" });
    expect(status).toHaveBeenCalledWith("r");
  });

  describe("plugin_request in a conversation", () => {
    const request = vi.fn(async () => ({
      requestId: "5d1f0b8e-8c2a-4a39-9a54-0f6a4e7e6c11",
      applied: false,
      action: "install",
      pluginName: "Browser",
    }));
    const args = {
      action: "install",
      repository: BROWSER,
      reason: " Open the staging site ",
    };

    it("posts a tagged message in the channel, signed as the agent", async () => {
      const publish = vi.fn(async () => ({ id: "m" }));
      const client = fake({ request } as never, publish);
      await call(client, "plugin_request", args, {
        channel: "chan",
        topLevel: true,
      });
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        kind: 9,
        content: "Requested: install Browser — Open the staging site",
        tags: [
          ["h", "chan"],
          ["plugin-request", "5d1f0b8e-8c2a-4a39-9a54-0f6a4e7e6c11"],
        ],
      });
    });

    it("posts into the thread the agent is working in", async () => {
      const publish = vi.fn(async () => ({ id: "m" }));
      const client = fake({ request } as never, publish);
      await call(client, "plugin_request", args, {
        channel: "chan",
        root: "thread",
      });
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: [
            ["h", "chan"],
            ["e", "thread", "", "reply"],
            ["plugin-request", "5d1f0b8e-8c2a-4a39-9a54-0f6a4e7e6c11"],
          ],
        }),
      );
    });

    it("posts nothing without a conversation", async () => {
      const publish = vi.fn();
      const client = fake({ request } as never, publish);
      await call(client, "plugin_request", args);
      expect(publish).not.toHaveBeenCalled();
    });

    it("keeps the request and says so when the post fails", async () => {
      const publish = vi.fn(async () => {
        throw new Error("relay refused");
      });
      const client = fake({ request } as never, publish);
      const result = JSON.parse(
        (await call(client, "plugin_request", args, {
          channel: "chan",
        })) as string,
      );
      expect(result).toMatchObject({
        requestId: "5d1f0b8e-8c2a-4a39-9a54-0f6a4e7e6c11",
        notice: expect.stringContaining("relay refused"),
      });
    });
  });
});
