import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostService, type Host } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pluginContext() {
  const root = new Context();
  new HostService(root);
  return {
    root,
    plugin: root.extend({
      pluginOwner: { id: "example.plugin", revision: "abc" },
    }),
  };
}

it("prepares a structured NIP-OA proof with the native identity without a community", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const authorization = ["auth", identity, "", "ef".repeat(64)];
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(authorization);
  expect(
    await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).toEqual(authorization);
  expect(invoke).toHaveBeenNthCalledWith(1, "identity_restore");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "identity_prepare_remote_agent_authorization",
    { owner: identity, agentPubkey },
  );
});

it.each([
  { mode: "browser", tauri: false, live: undefined },
  { mode: "live desktop", tauri: true, live: "1" },
])(
  "uses the dev broker identity for $mode authorization without a selected relay",
  async ({ tauri, live }) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    vi.mocked(isTauri).mockReturnValue(tauri);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    const fetcher = vi.fn(async (_url: string, _input?: RequestInit) =>
      Response.json({ viewer: identity }),
    );
    fetcher
      .mockResolvedValueOnce(Response.json({ viewer: identity }))
      .mockResolvedValueOnce(Response.json(authorization));
    vi.stubGlobal("fetch", fetcher);
    const { plugin } = pluginContext();
    expect(
      await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).toEqual(authorization);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/relay/identity");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/relay/prepare-remote-agent-authorization",
    );
    const input = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(input.body))).toEqual({
      owner: identity,
      agentPubkey,
    });
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("does not sign invalid, self, missing-identity or pre-canceled requests", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const { plugin } = pluginContext();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.("invalid"),
  ).rejects.toThrow("64 lowercase hex");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(identity);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(identity),
  ).rejects.toThrow("must differ");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).rejects.toThrow("Set up your identity");
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey, cancel.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["identity_restore", "identity_prepare_remote_agent_authorization"])(
  "fences cancellation during %s",
  async (command) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((name) =>
      name === command
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(identity),
    );
    const { plugin } = pluginContext();
    const cancel = new AbortController();
    const pending = plugin.host.prepareRemoteAgentAuthorization?.(
      agentPubkey,
      cancel.signal,
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      cancel.abort();
    } finally {
      release?.(command === "identity_restore" ? identity : authorization);
    }
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledTimes(
      command === "identity_restore" ? 1 : 2,
    );
  },
);

it.each(["different owner", "nonempty conditions", "malformed signature"])(
  "rejects an invalid authorization: %s",
  async (scenario) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = [
      "auth",
      scenario === "different owner" ? agentPubkey : identity,
      scenario === "nonempty conditions" ? "kind=0" : "",
      scenario === "malformed signature" ? "invalid" : "ef".repeat(64),
    ];
    const { plugin } = pluginContext();
    vi.mocked(invoke)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(authorization);
    await expect(
      plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).rejects.toThrow("Invalid remote agent authorization");
  },
);

it("uses the calling plugin identity and preserves bounded command output", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue("ready \n");
  await expect(plugin.host.runCommand("status")).resolves.toBe("ready \n");
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "status",
  });
});

it("keeps native command failures and browser calls nullable", async () => {
  const { root, plugin } = pluginContext();
  vi.mocked(invoke).mockRejectedValue(new Error("secret stderr"));
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  await expect(root.host.runCommand("status")).resolves.toBeNull();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("passes review decisions as stdin data while keeping the command fixed", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue('{"accepted":true}');
  const input =
    '{"id":"action-a","choice":"allow_once","text":"$(touch injected)"}';
  await plugin.host.runCommand("review", input);
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "review",
    input,
  });
});

it("routes HTTPS requests with plugin identity and rejects browser requests", async () => {
  const { plugin } = pluginContext();
  const response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  vi.mocked(invoke).mockResolvedValue(response);
  const request = {
    url: "https://api.example.com/graphql",
    method: "POST" as const,
    headers: { Authorization: "Bearer token" },
    body: "{}",
  };
  await expect(plugin.host.request(request)).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "example.plugin",
    revision: "abc",
    request,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.request(request)).rejects.toThrow(/desktop plugin/);
});

it.each(["request", "upload"] as const)(
  "normalizes native %s string failures and preserves existing Errors",
  async (operation) => {
    const { plugin } = pluginContext();
    const input = { url: "https://api.example.com/" };
    const call = () =>
      operation === "request"
        ? plugin.host.request(input)
        : plugin.host.upload?.({
            ...input,
            file: {
              field: "artifact",
              path: "/home/me/artifact.tar.gz",
              name: "artifact.tar.gz",
              contentType: "application/gzip",
            },
          });
    const message =
      operation === "request"
        ? "Host request timed out"
        : "Files are not declared";
    vi.mocked(invoke).mockRejectedValueOnce(message);
    await expect(call()).rejects.toEqual(new Error(message));
    const error = new Error("Native failure");
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
  },
);

it("reads files and resolves directories as the calling plugin", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(new Uint8Array([0, 255]).buffer)
    .mockResolvedValueOnce("/home/me/.buzz")
    .mockRejectedValueOnce("notes.md: No such file");
  await expect(
    plugin.host.readFile?.("./a.png", { cwd: "~/.buzz" }),
  ).resolves.toEqual(new Uint8Array([0, 255]));
  expect(invoke).toHaveBeenCalledWith("plugin_host_read_file", {
    id: "example.plugin",
    revision: "abc",
    path: "./a.png",
    cwd: "~/.buzz",
  });
  await expect(plugin.host.resolveDirectory?.("~/.buzz")).resolves.toBe(
    "/home/me/.buzz",
  );
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_resolve_directory", {
    id: "example.plugin",
    revision: "abc",
    path: "~/.buzz",
  });
  // Callers tell a missing file by its message, so it arrives as an Error.
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /No such file/,
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /desktop plugin/,
  );
});

it("lists the binding's configured repositories folder as the calling plugin, never a path it names", async () => {
  const viewer = "a".repeat(64);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
  });
  const { root, plugin } = pluginContext();
  const binding = {
    scope: `https://one.example:${viewer}`,
    viewer,
    incarnation: "1",
  };
  const rows = [
    { name: "app", path: "/home/me/code/app", displayPath: "~/code/app" },
  ];
  const { signal } = new AbortController();
  vi.mocked(invoke).mockResolvedValue(rows);
  await expect(plugin.host.repositoryFolders?.(binding, signal)).resolves.toBe(
    rows,
  );
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_repository_folders", {
    id: "example.plugin",
    revision: "abc",
    path: "~/.buzz/REPOS",
  });
  stored.set(
    `buzz-community-repositories.v1:${JSON.stringify(["https://one.example", viewer])}`,
    "~/code",
  );
  await plugin.host.repositoryFolders?.(binding, signal);
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_repository_folders", {
    id: "example.plugin",
    revision: "abc",
    path: "~/code",
  });
  vi.mocked(invoke).mockClear();
  await expect(
    plugin.host.repositoryFolders?.({ ...binding, scope: "none" }, signal),
  ).rejects.toThrow(/community and account/);
  await expect(root.host.repositoryFolders?.(binding, signal)).rejects.toThrow(
    /desktop plugin/,
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(
    plugin.host.repositoryFolders?.(binding, signal),
  ).rejects.toThrow(/desktop plugin/);
  expect(invoke).not.toHaveBeenCalled();
});

it("starts a declared process as the calling plugin and streams it", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const process = await plugin.host.spawn?.("agent", {
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_spawn", {
    id: "example.plugin",
    revision: "abc",
    processId: "agent",
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    protection: null,
    agentCredential: false,
    protectedAgent: null,
    onEvent: spawn.onEvent,
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
  });
  expect(process?.actAs).toBeUndefined();
  spawn.onEvent.onmessage({ type: "stdout", data: "out" });
  spawn.onEvent.onmessage({ type: "stderr", data: "err" });
  expect(stdout).toEqual(["out"]);
  expect(stderr).toEqual(["err"]);

  vi.mocked(invoke).mockResolvedValue(undefined);
  await process?.write("line\n");
  await process?.end();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "line\n",
    close: false,
  });
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "",
    close: true,
  });
  spawn.onEvent.onmessage({ type: "exit", code: 0 });
  await expect(process?.exited).resolves.toBe(0);
});

it("asks native for an agent credential and binds it to one agent", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent", {
    agentCredential: true,
  });
  expect(invoke).toHaveBeenCalledWith(
    "plugin_host_process_spawn",
    expect.objectContaining({ agentCredential: true }),
  );

  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await process?.actAs?.({ pubkey: "ab".repeat(32), relay: "wss://relay" });
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_process_bind_agent", {
    id: "example.plugin",
    handle: 7,
    pubkey: "ab".repeat(32),
    relay: "wss://relay",
  });
});

it("writes a long input in order, in pieces the host accepts", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  // A pair straddles the first boundary.
  const long = `${"a".repeat(256 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
  await Promise.all([process?.write(long), process?.write("next\n")]);
  expect(pieces).toHaveLength(5);
  expect(pieces.every((piece) => new Blob([piece]).size <= 1024 * 1024)).toBe(
    true,
  );
  expect(pieces[0]?.endsWith("a")).toBe(true);
  expect(pieces.join("")).toBe(`${long}next\n`);
});

it("keeps delivering process events after an output handler throws", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const process = await plugin.host.spawn?.("agent", {
    onStdout: () => {
      throw new Error("handler bug");
    },
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(() =>
    spawn.onEvent.onmessage({ type: "stdout", data: "out" }),
  ).not.toThrow();
  expect(error).toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(undefined);
  spawn.onEvent.onmessage({ type: "exit", code: 1 });
  await expect(process?.exited).resolves.toBe(1);
  error.mockRestore();
});

it("kills a plugin's processes when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValue(3);
  await host.spawn?.("agent");
  vi.mocked(invoke).mockClear();
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 3,
  });
});

it("kills a process that started as its plugin unloaded", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  let started!: (handle: number) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_process_spawn"
      ? new Promise((resolve) => {
          started = resolve;
        })
      : Promise.resolve(undefined),
  );
  const spawning = host.spawn?.("agent");
  await fiber.dispose();
  started(4);
  await expect(spawning).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 4,
  });
});

it("refuses processes outside the desktop app", async () => {
  const { root, plugin } = pluginContext();
  await expect(root.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  expect(invoke).not.toHaveBeenCalled();
});

it.each([false, true])(
  "serves MCP as the calling plugin with sharedSession=%s",
  async (sharedSession) => {
    const { plugin } = pluginContext();
    vi.mocked(invoke).mockResolvedValueOnce({
      handle: 4,
      url: "http://127.0.0.1:5000/mcp",
      token: "secret",
    });
    const handler = vi.fn(async (message: unknown) => {
      const { id } = message as { id?: number };
      return id === undefined ? undefined : { jsonrpc: "2.0", id, result: {} };
    });
    const server = await plugin.host.serveMcp?.(handler, { sharedSession });
    const [, serve] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { onEvent: { onmessage(event: unknown): void } },
    ];
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_serve", {
      id: "example.plugin",
      revision: "abc",
      onEvent: serve.onEvent,
      ...(sharedSession ? { sharedSession: true } : {}),
    });
    expect(server?.url).toBe("http://127.0.0.1:5000/mcp");
    expect(server?.headers).toEqual([
      { name: "Authorization", value: "Bearer secret" },
    ]);

    vi.mocked(invoke).mockResolvedValue(undefined);
    serve.onEvent.onmessage({
      type: "message",
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    });
    serve.onEvent.onmessage({
      type: "message",
      request: 2,
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });
    serve.onEvent.onmessage({ type: "message", request: 3, body: "{" });
    await vi.waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThanOrEqual(4),
    );
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"result":{}}',
    });
    // A notification is accepted without a body.
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 2,
      body: null,
    });
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 3,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    });

    await server?.close();
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
      id: "example.plugin",
      handle: 4,
    });
    serve.onEvent.onmessage({ type: "closed" });
    await expect(server?.closed).resolves.toBeUndefined();
  },
);

it("answers a failed MCP request with a JSON-RPC error", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async () => {
    throw new Error("relay down");
  });
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":"a","method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a",
        error: { code: -32603, message: "relay down" },
      }),
    }),
  );
});

it("answers with an error when a reply cannot be delivered", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async (message) => ({
    jsonrpc: "2.0",
    id: (message as { id: unknown }).id,
    result: { count: 1n },
  }));
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  // A reply the native side refuses as too large takes the same path.
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32603,
          message: "Do not know how to serialize a BigInt",
        },
      }),
    }),
  );
});

it("closes a plugin's MCP servers when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 6, url: "u", token: "t" });
  await host.serveMcp?.(async () => undefined);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
    id: "example.plugin",
    handle: 6,
  });
});

const onceContext = { boot: "12345678-1234-4234-8234-123456789abc", page: 1 };
const onceInput = {
  url: "https://example.test/submit",
  method: "POST" as const,
  body: "{}",
};
const callId = "abcdefab-1234-4234-8234-123456789abc";
const onceReply = { status: 200, headers: {}, body: "accepted" };

async function oncePlugin() {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  return { root, host, fiber };
}

it("passes recorded POST identity unchanged, shares context only within its calling fiber and never retries", async () => {
  const first = await oncePlugin();
  const second = await oncePlugin();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "plugin_host_call_context" ? onceContext : onceReply,
  );
  try {
    await expect(
      first.host.requestOnce?.(onceInput, { callId }),
    ).resolves.toEqual(onceReply);
    await first.host.requestOnce?.(onceInput, { callId });
    await second.host.requestOnce?.(onceInput, { callId });
    const contexts = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "plugin_host_call_context");
    const requests = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "plugin_host_request");
    expect(contexts).toHaveLength(2);
    const payloads = requests.map(
      ([, body]) =>
        body as {
          request: unknown;
          once: { activation: string; callId: string };
        },
    );
    expect(payloads[0]?.request).toBe(onceInput);
    expect(payloads[0]?.once).toEqual({
      ...onceContext,
      activation: expect.any(String),
      callId,
    });
    expect(payloads[1]?.once).toEqual(payloads[0]?.once);
    expect(payloads[2]?.once.activation).not.toBe(payloads[0]?.once.activation);
    vi.mocked(invoke).mockRejectedValueOnce(
      "Host call already consumed; outcome unknown",
    );
    await expect(
      first.host.requestOnce?.(onceInput, { callId }),
    ).rejects.toThrow("already consumed");
    expect(invoke).toHaveBeenCalledTimes(6);
  } finally {
    await first.fiber.dispose();
    await second.fiber.dispose();
  }
});

it.each(["restart", "config update"] as const)(
  "starts fresh protected authority after a real Cordis %s on the same fiber",
  async (change) => {
    const { host, fiber } = await oncePlugin();
    const uid = fiber.uid;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "plugin_host_call_context" ? onceContext : onceReply,
    );
    try {
      await expect(host.requestOnce?.(onceInput, { callId })).resolves.toEqual(
        onceReply,
      );
      if (change === "restart") await fiber.restart();
      else await fiber.update({ revision: "next" });
      expect(fiber.uid).toBe(uid);
      const nextId = "abcdefab-1234-4234-8234-123456789abd";
      await expect(
        host.requestOnce?.(onceInput, { callId: nextId }),
      ).resolves.toEqual(onceReply);
      const requests = protectedInvokes().map(
        ([, body]) =>
          body as {
            once: { activation: string; callId: string };
          },
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]?.once.callId).toBe(nextId);
      expect(requests[1]?.once.activation).not.toBe(
        requests[0]?.once.activation,
      );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "plugin_host_call_context"),
      ).toHaveLength(2);
    } finally {
      await fiber.dispose();
    }
  },
);

it.each(["context", "reply"] as const)(
  "does not revive a captured protected lifetime waiting for %s after Cordis restart",
  async (phase) => {
    const { host, fiber } = await oncePlugin();
    let release!: (value: typeof onceContext | typeof onceReply) => void;
    const held = new Promise<typeof onceContext | typeof onceReply>(
      (resolve) => {
        release = resolve;
      },
    );
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let holding = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "plugin_host_call_context")
        return holding && phase === "context"
          ? held
          : Promise.resolve(onceContext);
      if (holding && phase === "reply") {
        started();
        return held;
      }
      return Promise.resolve(onceReply);
    });
    const stale = host.requestOnce?.(onceInput, { callId });
    const refused = expect(stale).rejects.toThrow("inactive");
    try {
      if (phase === "reply") await dispatched;
      await fiber.restart();
      holding = false;
      const nextId = "abcdefab-1234-4234-8234-123456789abd";
      await expect(
        host.requestOnce?.(onceInput, { callId: nextId }),
      ).resolves.toEqual(onceReply);
      release(phase === "context" ? onceContext : onceReply);
      await refused;
      // Finishing the old call cannot discard or rebind the new activation.
      await expect(
        host.requestOnce?.(onceInput, {
          callId: "abcdefab-1234-4234-8234-123456789abe",
        }),
      ).resolves.toEqual(onceReply);
      const requests = protectedInvokes().map(
        ([, body]) =>
          body as {
            once: { activation: string; callId: string };
          },
      );
      expect(requests).toHaveLength(phase === "context" ? 2 : 3);
      const fresh = requests.filter(({ once }) => once.callId !== callId);
      expect(fresh[1]?.once.activation).toBe(fresh[0]?.once.activation);
      if (phase === "reply")
        expect(fresh[0]?.once.activation).not.toBe(
          requests[0]?.once.activation,
        );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "plugin_host_call_context"),
      ).toHaveLength(2);
    } finally {
      release(phase === "context" ? onceContext : onceReply);
      await refused;
      await fiber.dispose();
    }
  },
);

it.each([
  undefined,
  { boot: "not-a-uuid", page: 1 },
  { ...onceContext, page: -1 },
  { ...onceContext, page: 1.5 },
])(
  "refuses invalid native context %j without dispatching POST",
  async (context) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockResolvedValue(context);
    try {
      await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
        "context is unavailable",
      );
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        "plugin_host_call_context",
      );
    } finally {
      await fiber.dispose();
    }
  },
);

it("fails closed and caches old-native context errors without fallback or authority refresh", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke).mockRejectedValue(
    "Command plugin_host_call_context not found",
  );
  try {
    for (let i = 0; i < 2; i++)
      await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
        "not found",
      );
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_host_call_context");
  } finally {
    await fiber.dispose();
  }
});

it("does not retry when newer frontend meets a native request command rejecting once", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke)
    .mockResolvedValueOnce(onceContext)
    .mockRejectedValueOnce("Protected request unsupported");
  try {
    await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
      "unsupported",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    await fiber.dispose();
  }
});

it("refuses non-POST and noncanonical call identities before asking native for authority", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    for (const request of [
      { ...onceInput, method: "GET" as const },
      { url: onceInput.url },
    ])
      await expect(host.requestOnce?.(request, { callId })).rejects.toThrow(
        "require POST",
      );
    for (const id of [callId.toUpperCase(), callId.replaceAll("-", ""), ""])
      await expect(
        host.requestOnce?.(onceInput, { callId: id }),
      ).rejects.toThrow("canonical UUID");
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
      "desktop plugin",
    );
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("blocks a captured protected call immediately when real Cordis disposal begins", async () => {
  const { host, fiber } = await oncePlugin();
  const disposing = fiber.dispose();
  await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
    "inactive",
  );
  await disposing;
  expect(invoke).not.toHaveBeenCalled();
});

it("does not dispatch after context resolves during Cordis disposal", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const request = host.requestOnce?.(onceInput, { callId });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_host_call_context");
  const disposed = fiber.dispose();
  release(onceContext);
  await expect(request).rejects.toThrow("inactive");
  await disposed;
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("suppresses a queued successful response when Cordis disposes before its continuation", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceReply) => void;
  let started!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_call_context"
      ? Promise.resolve(onceContext)
      : new Promise((resolve) => {
          release = resolve;
          started();
        }),
  );
  const request = host.requestOnce?.(onceInput, { callId });
  await dispatch;
  release(onceReply);
  const disposed = fiber.dispose();
  await expect(request).rejects.toThrow("inactive");
  await disposed;
  expect(invoke).toHaveBeenCalledTimes(2);
});

function byteFrame(
  body = new Uint8Array([0, 159, 255]),
  metadata: unknown = { status: 418, headers: { "x-test": "bytes" } },
) {
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new ArrayBuffer(4 + meta.length + body.length);
  new DataView(frame).setUint32(0, meta.length, false);
  new Uint8Array(frame, 4, meta.length).set(meta);
  new Uint8Array(frame, 4 + meta.length).set(body);
  return frame;
}
const byteInput = { url: "https://example.test/bytes", maxBytes: 3 };
const byteHash = "a".repeat(64);
const byteSaved = {
  path: "/private/plugin-artifacts/file",
  size: 3,
  sha256: byteHash,
  expiresAt: 2_000_000_000_000,
};

it("returns a non-text body view without a clone, accepts empty bodies and never obtains POST context", async () => {
  const { fiber, host } = await oncePlugin();
  const frame = byteFrame();
  vi.mocked(invoke)
    .mockResolvedValueOnce(frame)
    .mockResolvedValueOnce(byteFrame(new Uint8Array()));
  try {
    const result = await host.requestBytes?.(byteInput);
    expect(result).toMatchObject({
      status: 418,
      headers: { "x-test": "bytes" },
    });
    expect(result?.body).toEqual(new Uint8Array([0, 159, 255]));
    expect(result?.body.buffer).toBe(frame);
    expect((await host.requestBytes?.(byteInput))?.body.length).toBe(0);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
      "plugin_host_request_bytes",
      "plugin_host_request_bytes",
    ]);
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      request: byteInput,
    });
  } finally {
    await fiber.dispose();
  }
});

it("reads a public page's preview through its own command and validates the timeout first", async () => {
  const { fiber, host } = await oncePlugin();
  const page = { status: 200, preview: { title: "Example" } };
  vi.mocked(invoke).mockResolvedValueOnce(page);
  try {
    await expect(
      host.readPage?.("https://example.test/", { timeoutMs: 5000 }),
    ).resolves.toEqual(page);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      [
        "plugin_host_read_page",
        {
          id: "example.plugin",
          revision: "abc",
          url: "https://example.test/",
          timeoutMs: 5000,
        },
      ],
    ]);
    for (const timeoutMs of [0, 1.5, 30001])
      await expect(
        host.readPage?.("https://example.test/", { timeoutMs }),
      ).rejects.toThrow("Invalid page request");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    await fiber.dispose();
  }
});
it("refuses fallback arrays and corrupted frames before returning any bytes", async () => {
  const { fiber, host } = await oncePlugin();
  const wrongLength = byteFrame();
  new DataView(wrongLength).setUint32(0, wrongLength.byteLength, false);
  const invalidUtf8 = new Uint8Array([0, 0, 0, 1, 255]).buffer;
  const inputs = [
    [0, 0, 0, 1, 0],
    new Uint8Array([1]),
    new ArrayBuffer(3),
    wrongLength,
    invalidUtf8,
    byteFrame(new Uint8Array(4)),
    byteFrame(new Uint8Array(), null),
    byteFrame(new Uint8Array(), { status: 99, headers: {} }),
    byteFrame(new Uint8Array(), { status: 600, headers: {} }),
    byteFrame(new Uint8Array(), { status: 200.5, headers: {} }),
    byteFrame(new Uint8Array(), { status: 200, headers: [] }),
    byteFrame(new Uint8Array(), { status: 200, headers: { x: 1 } }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { "set-cookie": "a=b" },
    }),
    byteFrame(new Uint8Array(), { status: 200, headers: { x: "a\r\nb" } }),
    byteFrame(new Uint8Array(), { status: 200, headers: { "bad name": "x" } }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`h${i}`, "x"]),
      ),
    }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { x: "é".repeat(8192) },
    }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { x: "x".repeat(21 * 1024) },
    }),
  ];
  try {
    for (const input of inputs) {
      vi.mocked(invoke).mockResolvedValueOnce(input);
      await expect(host.requestBytes?.(byteInput)).rejects.toThrow();
    }
    expect(invoke).toHaveBeenCalledTimes(inputs.length);
  } finally {
    await fiber.dispose();
  }
});

it("validates byte limits before IPC and uses only raw top-level save bytes with bounded metadata", async () => {
  const { fiber, host } = await oncePlugin();
  const bytes = new Uint8Array([0, 159, 255]);
  try {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, 16 * 1024 * 1024 + 1])
      await expect(
        host.requestBytes?.({ ...byteInput, maxBytes }),
      ).rejects.toThrow("limits");
    for (const timeoutMs of [0, 1.5, 30001])
      await expect(
        host.requestBytes?.({ ...byteInput, timeoutMs }),
      ).rejects.toThrow("limits");
    for (const data of [new Uint8Array(), new Uint8Array(16 * 1024 * 1024 + 1)])
      await expect(
        host.saveBytes?.(data, { sha256: byteHash }),
      ).rejects.toThrow("Invalid");
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "g".repeat(64)])
      await expect(host.saveBytes?.(bytes, { sha256 })).rejects.toThrow(
        "Invalid",
      );
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValueOnce(byteSaved);
    await expect(
      host.saveBytes?.(bytes, { sha256: byteHash }),
    ).resolves.toEqual(byteSaved);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "plugin_host_save_bytes",
      bytes,
      {
        headers: {
          "x-buzz-plugin-id": "example.plugin",
          "x-buzz-plugin-revision": "abc",
          "x-buzz-sha256": byteHash,
        },
      },
    );
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toBe(bytes);
  } finally {
    await fiber.dispose();
  }
});

it("rejects malformed save results and never retries unknown saves", async () => {
  const { fiber, host } = await oncePlugin();
  try {
    for (const result of [
      null,
      { ...byteSaved, path: "" },
      { ...byteSaved, size: 2 },
      { ...byteSaved, sha256: "b".repeat(64) },
      { ...byteSaved, expiresAt: 1.5 },
    ]) {
      vi.mocked(invoke).mockResolvedValueOnce(result);
      await expect(
        host.saveBytes?.(new Uint8Array(3), { sha256: byteHash }),
      ).rejects.toThrow("outcome unknown");
    }
    vi.mocked(invoke).mockRejectedValueOnce("reply lost");
    await expect(
      host.saveBytes?.(new Uint8Array(3), { sha256: byteHash }),
    ).rejects.toThrow("reply lost");
    expect(invoke).toHaveBeenCalledTimes(6);
  } finally {
    await fiber.dispose();
  }
});

it.each(["get", "save"] as const)(
  "suppresses queued %s success and refuses captured calls during synchronous Cordis disposal",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = () =>
      kind === "get"
        ? host.requestBytes?.(byteInput)
        : host.saveBytes?.(new Uint8Array(3), { sha256: byteHash });
    const pending = run();
    finish(kind === "get" ? byteFrame() : byteSaved);
    const disposing = fiber.dispose();
    await expect(pending).rejects.toThrow("inactive");
    await expect(run()).rejects.toThrow("inactive");
    expect(invoke).toHaveBeenCalledTimes(1);
    await disposing;
    await fiber.dispose();
  },
);

function deferredOnceContext() {
  let resolve!: (value: typeof onceContext) => void;
  let reject!: (reason: Error) => void;
  const context = new Promise<typeof onceContext>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_call_context"
      ? context
      : Promise.resolve(onceReply),
  );
  return { resolve, reject };
}
const protectedInvokes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_request");

it("final eligibility checks once after deferred context before one exact POST", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  const isEligible = vi.fn(() => true);
  try {
    const options = { callId, isEligible };
    const request = host.requestOnce?.(onceInput, options);
    expect(isEligible).not.toHaveBeenCalled();
    expect(protectedInvokes()).toHaveLength(0);
    held.resolve(onceContext);
    await expect(request).resolves.toEqual(onceReply);
    expect(isEligible).toHaveBeenCalledExactlyOnceWith();
    expect(protectedInvokes()).toEqual([
      [
        "plugin_host_request",
        {
          id: "example.plugin",
          revision: "abc",
          request: onceInput,
          once: { ...onceContext, activation: expect.any(String), callId },
        },
      ],
    ]);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("final eligibility sees true becoming false while native context is pending", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  let eligible = true;
  const isEligible = vi.fn(() => eligible);
  const options = { callId, isEligible };
  const request = host.requestOnce?.(onceInput, options);
  const refused = expect(request).rejects.toThrow("eligibility");
  try {
    expect(isEligible).not.toHaveBeenCalled();
    eligible = false;
    held.resolve(onceContext);
    await refused;
    expect(isEligible).toHaveBeenCalledTimes(1);
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("final eligibility rejects elapsed monotonic deadline before its timer task executes", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let timerRan = false;
  const deadline = performance.now() + 300_000;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 300_000);
  const options = { callId, isEligible: () => performance.now() < deadline };
  const request = host.requestOnce?.(onceInput, options);
  const refused = expect(request).rejects.toThrow("eligibility");
  try {
    // Move the clock, not the task queue: expiry must not depend on the timer.
    vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
    held.resolve(onceContext);
    await refused;
    expect(timerRan).toBe(false);
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    clearTimeout(timer);
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fiber.dispose();
  }
});

it.each([
  "false",
  "undefined",
  "number",
  "string",
  "object",
  "throw",
  "promise",
  "rejected promise",
  "thenable",
])(
  "final eligibility rejects %s without dispatch or unhandled async rejection",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    const held = deferredOnceContext();
    const isEligible = vi.fn(() => {
      switch (kind) {
        case "false":
          return false;
        case "number":
          return 1;
        case "string":
          return "true";
        case "object":
          return {};
        case "throw":
          throw new Error("caller failure");
        case "promise":
          return Promise.resolve(true);
        case "rejected promise":
          return Promise.reject(new Error("async caller failure"));
        case "thenable":
          // biome-ignore lint/suspicious/noThenProperty: Deliberately invalid async callback result must fail closed.
          return { then: (resolve: (value: boolean) => void) => resolve(true) };
        default:
          return undefined;
      }
    });
    const options = { callId, isEligible: isEligible as () => boolean };
    const request = host.requestOnce?.(onceInput, options);
    const refused = expect(request).rejects.toThrow("eligibility");
    try {
      held.resolve(onceContext);
      await refused;
      expect(isEligible).toHaveBeenCalledTimes(1);
      expect(protectedInvokes()).toHaveLength(0);
    } finally {
      held.resolve(onceContext);
      await fiber.dispose();
    }
  },
);

it("final eligibility cannot dispose the calling Cordis fiber and still dispatch", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  let disposing: Promise<void> | undefined;
  const options = {
    callId,
    isEligible: () => {
      disposing = fiber.dispose();
      return true;
    },
  };
  const request = host.requestOnce?.(onceInput, options);
  const refused = expect(request).rejects.toThrow("inactive");
  try {
    held.resolve(onceContext);
    await refused;
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    await disposing;
    await fiber.dispose();
  }
});

it.each(["reject", "invalid"])(
  "final eligibility never runs after %s context",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    const held = deferredOnceContext();
    const isEligible = vi.fn(() => true);
    const options = { callId, isEligible };
    const request = host.requestOnce?.(onceInput, options);
    const refused = expect(request).rejects.toThrow(
      kind === "reject" ? "context rejected" : "context is unavailable",
    );
    try {
      if (kind === "reject") held.reject(new Error("context rejected"));
      else held.resolve({ ...onceContext, page: -1 });
      await refused;
      expect(isEligible).not.toHaveBeenCalled();
      expect(protectedInvokes()).toHaveLength(0);
    } finally {
      held.resolve(onceContext);
      await fiber.dispose();
    }
  },
);

it("final eligibility omission preserves deferred protected dispatch without serializing a predicate", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  try {
    const request = host.requestOnce?.(onceInput, { callId });
    held.resolve(onceContext);
    await expect(request).resolves.toEqual(onceReply);
    expect(protectedInvokes()).toHaveLength(1);
    expect(protectedInvokes()[0]?.[1]).not.toHaveProperty("isEligible");
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("deletes only by the calling installed plugin and suppresses disposed completion", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await host.deleteManagedFile?.(byteSaved.path);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin_host_delete_managed_file",
    {
      id: "example.plugin",
      revision: "abc",
      path: byteSaved.path,
    },
  );
  vi.mocked(invoke).mockClear();
  for (const path of ["", "bad\0path"]) {
    await expect(host.deleteManagedFile?.(path)).rejects.toThrow();
  }
  expect(invoke).not.toHaveBeenCalled();
  let finish!: () => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = host.deleteManagedFile?.(byteSaved.path);
  const disposed = fiber.dispose();
  finish();
  await expect(pending).rejects.toThrow("inactive");
  await disposed;
});

const byteUpload = {
  url: "https://example.test/upload",
  field: "image",
  name: "image.png",
  contentType: "image/png",
  fields: { label: "café" },
};

it("uploads an immutable raw snapshot with shared protected authority and no fallback", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const bytes = new Uint8Array([0, 159, 255]);
  const eligibility = vi.fn(() => true);
  try {
    const pending = host.uploadBytesOnce?.(bytes, byteUpload, {
      callId,
      isEligible: eligibility,
    });
    bytes.fill(1);
    expect(eligibility).not.toHaveBeenCalled();
    release(onceContext);
    vi.mocked(invoke).mockResolvedValueOnce(onceReply);
    await expect(pending).resolves.toEqual(onceReply);
    const [, body, options] = vi.mocked(invoke).mock.calls[1] ?? [];
    expect(body).toEqual(new Uint8Array([0, 159, 255]));
    const metadata = JSON.parse(
      new Headers(options?.headers).get("x-buzz-upload") ?? "",
    );
    expect(metadata).toEqual({
      id: "example.plugin",
      revision: "abc",
      upload: byteUpload,
      once: { ...onceContext, activation: expect.any(String), callId },
    });
    expect(eligibility).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockResolvedValueOnce(onceReply);
    await host.requestOnce?.(onceInput, { callId });
    const post = vi.mocked(invoke).mock.calls[2]?.[1] as { once: unknown };
    expect(post.once).toEqual(metadata.once);
    vi.mocked(invoke).mockRejectedValueOnce("raw IPC unavailable");
    await expect(
      host.uploadBytesOnce?.(bytes, byteUpload, { callId }),
    ).rejects.toThrow("raw IPC");
    expect(invoke).toHaveBeenCalledTimes(4);
  } finally {
    await fiber.dispose();
  }
});

it("serializes upload metadata once and preserves escaped text when adding authority", async () => {
  const { host, fiber } = await oncePlugin();
  const fields = { caption: 'café 😀 "quoted"\r\n\\ trailing }' };
  const toJSON = vi.fn(() => ({ ...byteUpload, fields }));
  vi.mocked(invoke).mockResolvedValueOnce(onceContext);
  vi.mocked(invoke).mockResolvedValueOnce(onceReply);
  try {
    const input = { ...byteUpload, toJSON };
    await host.uploadBytesOnce?.(new Uint8Array([1]), input, { callId });
    expect(toJSON).toHaveBeenCalledTimes(1);
    const header = new Headers(
      vi.mocked(invoke).mock.calls[1]?.[2]?.headers,
    ).get("x-buzz-upload");
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(header ?? "")).toEqual({
      id: "example.plugin",
      revision: "abc",
      upload: { ...byteUpload, fields },
      once: { ...onceContext, activation: expect.any(String), callId },
    });
  } finally {
    await fiber.dispose();
  }
});

it.each([new Uint8Array(), new Uint8Array(16777217), [1, 2]])(
  "refuses invalid upload bytes before acquiring authority",
  async (bytes) => {
    const { host, fiber } = await oncePlugin();
    try {
      await expect(
        host.uploadBytesOnce?.(bytes as Uint8Array, byteUpload, { callId }),
      ).rejects.toThrow("bytes");
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await fiber.dispose();
    }
  },
);

it.each([false, undefined, Promise.resolve(true), new Error("refused")])(
  "fails upload eligibility closed",
  async (eligible) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockResolvedValue(onceContext);
    try {
      await expect(
        host.uploadBytesOnce?.(new Uint8Array([1]), byteUpload, {
          callId,
          isEligible: (() => {
            if (eligible instanceof Error) throw eligible;
            return eligible;
          }) as () => boolean,
        }),
      ).rejects.toThrow("eligibility");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      await fiber.dispose();
    }
  },
);

it("refuses uploads after disposal while native authority is pending", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = host.uploadBytesOnce?.(new Uint8Array([1]), byteUpload, {
    callId,
  });
  await fiber.dispose();
  release(onceContext);
  await expect(pending).rejects.toThrow("inactive");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects oversized upload metadata without IPC", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    await expect(
      host.uploadBytesOnce?.(
        new Uint8Array([1]),
        { ...byteUpload, fields: { large: "x".repeat(16384) } },
        { callId },
      ),
    ).rejects.toThrow("metadata");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("pins upload metadata before authority and suppresses late results after disposal", async () => {
  const { host, fiber } = await oncePlugin();
  let context!: (value: typeof onceContext) => void;
  let finish!: (value: typeof onceReply) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      context = resolve;
    }),
  );
  vi.mocked(invoke).mockImplementationOnce(async (_command, _body, options) => {
    expect(
      JSON.parse(new Headers(options?.headers).get("x-buzz-upload") ?? "")
        .upload.name,
    ).toBe("image.png");
    markStarted();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const upload = { ...byteUpload };
  const pending = host.uploadBytesOnce?.(new Uint8Array([1]), upload, {
    callId,
  });
  upload.name = "changed.png";
  context(onceContext);
  await started;
  await fiber.dispose();
  finish(onceReply);
  await expect(pending).rejects.toThrow("inactive");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["browser", "unowned", "invalid-call-id"])(
  "refuses protected upload in %s",
  async (mode) => {
    const { host, fiber, root } = await oncePlugin();
    if (mode === "browser") vi.mocked(isTauri).mockReturnValue(false);
    try {
      await expect(
        (mode === "unowned" ? root.host : host).uploadBytesOnce?.(
          new Uint8Array([1]),
          byteUpload,
          { callId: mode === "invalid-call-id" ? "INVALID" : callId },
        ),
      ).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await fiber.dispose();
    }
  },
);

it("preserves requestOnce owner-first errors and matches upload owner wording", async () => {
  const { root, plugin } = pluginContext();
  const invalid = { url: onceInput.url, method: "GET" as const };
  const ownerError = "Protected requests require an installed desktop plugin";
  await expect(
    root.host.requestOnce?.(invalid, { callId: "bad" }),
  ).rejects.toThrow(ownerError);
  await expect(
    root.host.uploadBytesOnce?.(new Uint8Array(), byteUpload, {
      callId: "bad",
    }),
  ).rejects.toThrow(ownerError);
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(
    plugin.host.requestOnce?.(invalid, { callId: "bad" }),
  ).rejects.toThrow(ownerError);
  await expect(
    plugin.host.uploadBytesOnce?.(new Uint8Array(), byteUpload, {
      callId: "bad",
    }),
  ).rejects.toThrow(ownerError);
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps an asynchronous streamed message together with queued writes", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  if (!process?.writeStream) throw new Error("Missing streaming process");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const stream = process.writeStream(
    (async function* () {
      yield "first";
      await held;
      yield "last\n";
    })(),
  );
  const next = process.write("next\n");
  await vi.waitFor(() => expect(pieces).toEqual(["first"]));
  release();
  await Promise.all([stream, next]);
  expect(pieces).toEqual(["first", "last\n", "next\n"]);
});

it("stops a process after a failed streamed frame and rejects queued writes", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  if (!process?.writeStream) throw new Error("Missing streaming process");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_process_write")
      pieces.push((args as { data: string }).data);
  });
  const failed = process.writeStream(
    (async function* () {
      yield "partial";
      throw new Error("read failed");
    })(),
  );
  const next = process.write("next\n");
  await expect(failed).rejects.toThrow("read failed");
  await expect(next).rejects.toThrow("read failed");
  expect(pieces).toEqual(["partial"]);
  expect(invoke).toHaveBeenCalledWith(
    "plugin_host_process_kill",
    expect.objectContaining({ handle: 7 }),
  );
});
