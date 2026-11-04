import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpServer } from "../host/service";
import type { Agents } from "./service";
import {
  createExternalApps,
  parseExternalAuthorization,
  type ExternalAuthorization,
} from "./external-connection";

const request: ExternalAuthorization = {
  version: 1,
  client: "Test client",
  callback: "http://127.0.0.1:1234/buzz/authorize",
  state: "A".repeat(43),
  scope: ["read", "post"],
  code_challenge: `${"B".repeat(42)}A`,
  code_challenge_method: "S256",
};
const uri = () =>
  `buzz://mcp-authorize?${new URLSearchParams({ version: "1", client: request.client, callback: request.callback, state: request.state, scope: "read post", code_challenge: request.code_challenge, code_challenge_method: "S256" })}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function transport() {
  const ended = deferred<void>();
  return {
    url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer test-only-token" }],
    closed: ended.promise,
    authorize: vi.fn(async () => {}),
    close: vi.fn(async () => ended.resolve()),
  };
}
afterEach(() => vi.useRealTimers());
it("parses the generic authorization request without a bearer", () => {
  expect(parseExternalAuthorization(uri())).toEqual(request);
});
it.each(["read", "post", "create", "read create", "read post create"])(
  "parses explicitly requested access without adding scopes (%s)",
  (scope) => {
    const url = new URL(uri());
    url.searchParams.set("scope", scope);
    expect(parseExternalAuthorization(url.href)?.scope).toEqual(
      scope.split(" "),
    );
  },
);
it.each([
  ["callback", "http://localhost:1234/buzz/authorize"],
  ["callback", "https://127.0.0.1:1234/buzz/authorize"],
  ["callback", "http://127.0.0.1:1234/buzz/authorize?x=1"],
  ["callback", "http://127.0.0.1:80/buzz/authorize"],
  ["callback", "http://user@127.0.0.1:1234/buzz/authorize"],
  ["code_challenge_method", "plain"],
  ["scope", "read files"],
  ["scope", "read read"],
  ["scope", "create create"],
  ["scope", "create manage"],
  ["state", "short"],
  ["client", ""],
  ["version", "2"],
])("rejects invalid %s in the authorization link", (key, value) => {
  const url = new URL(uri());
  url.searchParams.set(key, value);
  expect(parseExternalAuthorization(url.href)).toBeNull();
});
it("rejects ambiguous and extra link fields", () => {
  expect(parseExternalAuthorization(`${uri()}&scope=read`)).toBeNull();
  expect(parseExternalAuthorization(`${uri()}&token=secret`)).toBeNull();
  expect(
    parseExternalAuthorization(
      uri().replace("mcp-authorize?", "mcp-authorize/extra/../?"),
    ),
  ).toBeNull();
});
it.each([
  { scope: ["read", "post"] },
  { scope: ["create"] },
  { scope: ["read", "post", "create"] },
] as const)(
  "requires approval for exactly $scope and hides transport credentials",
  async ({ scope }) => {
    const server = transport(),
      connect = vi.fn(async () => server),
      deny = vi.fn(async () => {});
    const connection = createExternalApps();
    connection.bind({ connect, deny });
    connection.open({ ...request, scope }, "viewer");
    expect(connect).not.toHaveBeenCalled();
    await connection.approve("test-agent");
    expect(connect).toHaveBeenCalledWith(
      "test-agent",
      expect.any(AbortSignal),
      expect.any(Function),
      scope,
    );
    expect(server.authorize).toHaveBeenCalledWith({
      callback: request.callback,
      state: request.state,
      code_challenge: request.code_challenge,
    });
    expect(JSON.stringify(connection.snapshot())).not.toContain(
      "test-only-token",
    );
    connection.open({ ...request, state: "B".repeat(43) }, "viewer");
    expect(server.close).not.toHaveBeenCalled();
    await connection.deny();
    expect(deny).toHaveBeenCalledOnce();
    expect(server.close).not.toHaveBeenCalled();
    expect(connection.snapshot().grant?.phase).toBe("waiting");
    await connection.revoke();
    expect(server.close).toHaveBeenCalled();
  },
);
it("closes a server that starts after revocation", async () => {
  const pending = deferred<HostMcpServer>(),
    started = deferred<void>();
  const server = transport();
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      started.resolve();
      return pending.promise;
    },
    deny: async () => {},
  });
  connection.open(request, "viewer");
  const approving = connection.approve("test-agent");
  try {
    await started.promise;
    await connection.revoke();
  } finally {
    pending.resolve(server);
  }
  await approving;
  expect(server.close).toHaveBeenCalledOnce();
  expect(server.authorize).not.toHaveBeenCalled();
});
it("denies and expires requests without creating a grant", async () => {
  vi.useFakeTimers();
  const connect = vi.fn(),
    deny = vi.fn(async () => {});
  const connection = createExternalApps();
  connection.bind({ connect, deny });
  connection.open(request, "viewer");
  await connection.deny();
  expect(deny).toHaveBeenCalledOnce();
  connection.open(request, "viewer");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(connection.snapshot().pending).toBeUndefined();
  expect(deny).toHaveBeenCalledTimes(2);
  expect(connect).not.toHaveBeenCalled();
});
it.each([false, true])(
  "closes the grant when callback delivery fails (closed first: %s)",
  async (closedFirst) => {
    const server = transport();
    server.authorize.mockImplementationOnce(async () => {
      if (closedFirst) await server.close();
      throw new Error("callback failed");
    });
    const connection = createExternalApps();
    connection.bind({ connect: async () => server, deny: async () => {} });
    connection.open(request, "viewer");
    await connection.approve("test-agent");
    expect(server.close).toHaveBeenCalled();
    expect(connection.snapshot().error).toContain("Start setup again");
  },
);

it("keeps a replacement grant visible while an older failure closes", async () => {
  const first = transport(),
    second = transport();
  const started = deferred<void>(),
    finish = deferred<void>();
  const close = first.close;
  first.authorize.mockRejectedValueOnce(new Error("callback failed"));
  first.close = vi.fn(async () => {
    started.resolve();
    await finish.promise;
    await close();
  });
  const connect = vi
    .fn<Agents["connectExternal"]>()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(async (_agent, _signal, connected) => {
      connected();
      return second;
    });
  const connection = createExternalApps();
  connection.bind({ connect, deny: async () => {} });
  connection.open(request, "viewer");
  const failed = connection.approve("first-agent");
  try {
    await started.promise;
    connection.open(
      { ...request, client: "Second client", state: "B".repeat(43) },
      "viewer",
    );
    await connection.approve("second-agent");
    expect(connection.snapshot().grant).toMatchObject({
      agent: "second-agent",
      phase: "connected",
    });
  } finally {
    finish.resolve();
    await failed;
  }
  expect(connection.snapshot().grant).toMatchObject({
    agent: "second-agent",
    phase: "connected",
  });
  expect(connection.snapshot().error).toBeUndefined();
  await connection.revoke();
  expect(second.close).toHaveBeenCalledOnce();
});
