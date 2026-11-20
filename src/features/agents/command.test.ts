import { describe, expect, it, vi } from "vitest";
import { spawnAgentCommand } from "./command";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const closed = deferred<void>();
  const exited = deferred<number | null>();
  const connection = {
    url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer agent" }],
    closed: closed.promise,
    close: vi.fn(async () => {
      closed.resolve();
    }),
  };
  const process = {
    exited: exited.promise,
    kill: vi.fn(async () => {}),
    write: vi.fn(),
    end: vi.fn(),
  };
  let changed = () => {};
  const unsubscribe = vi.fn();
  const host = {
    connect: vi.fn(async (_signal: AbortSignal) => connection),
    spawn: vi.fn(async (_options: object) => process),
    check: vi.fn(),
    subscribe: vi.fn((listener: () => void) => {
      changed = listener;
      return unsubscribe;
    }),
  };
  return {
    host,
    process,
    connection,
    closed,
    exited,
    unsubscribe,
    changed: () => changed(),
    controller: new AbortController(),
  };
}

describe("agent command lifetime", () => {
  it("passes one agent connection to the declared process, preserving output and cwd", async () => {
    const f = fixture();
    const onStdout = vi.fn();
    const process = await spawnAgentCommand(f.host, {
      signal: f.controller.signal,
      channel: "destination",
      root: "thread",
      args: ["-c", "buzz tools"],
      cwd: "/work",
      env: { MODE: "test" },
      onStdout,
    });
    expect(f.host.spawn).toHaveBeenCalledWith({
      args: ["-c", "buzz tools"],
      cwd: "/work",
      env: { MODE: "test" },
      onStdout,
      mcp: { url: f.connection.url, headers: f.connection.headers },
    });
    expect(process.exited).toBe(f.process.exited);
    f.exited.resolve(0);
    await vi.waitFor(() => expect(f.connection.close).toHaveBeenCalled());
    expect(f.unsubscribe).toHaveBeenCalled();
  });
  it.each(["abort", "stop", "closed", "kill"])(
    "revokes the connection and stops descendants on %s",
    async (reason) => {
      const f = fixture();
      const process = await spawnAgentCommand(f.host, {
        signal: f.controller.signal,
      });
      if (reason === "abort") f.controller.abort();
      if (reason === "stop") {
        f.host.check.mockImplementation(() => {
          throw Error("Agent stopped");
        });
        f.changed();
      }
      if (reason === "closed") f.closed.resolve();
      if (reason === "kill") await process.kill();
      await vi.waitFor(() => expect(f.process.kill).toHaveBeenCalled());
      expect(f.connection.close).toHaveBeenCalled();
    },
  );
  it("kills a process that finishes starting after cancellation", async () => {
    const f = fixture();
    const starting = deferred<typeof f.process>();
    f.host.spawn.mockReturnValue(starting.promise);
    const pending = spawnAgentCommand(f.host, { signal: f.controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.host.spawn).toHaveBeenCalled());
    f.controller.abort();
    starting.resolve(f.process);
    await vi.waitFor(() => expect(f.process.kill).toHaveBeenCalled());
    f.exited.resolve(null);
    await rejected;
    expect(f.process.kill).toHaveBeenCalled();
    expect(f.connection.close).toHaveBeenCalled();
  });
  it("closes the connection when spawn fails", async () => {
    const f = fixture();
    f.host.spawn.mockRejectedValue(Error("Process is not declared"));
    await expect(
      spawnAgentCommand(f.host, { signal: f.controller.signal }),
    ).rejects.toThrow("not declared");
    expect(f.connection.close).toHaveBeenCalled();
  });
  it("does not start with a cancelled or substituted identity", async () => {
    const f = fixture();
    await expect(
      spawnAgentCommand(f.host, {
        signal: f.controller.signal,
        env: { BUZZ_PRIVATE_KEY: "owner" },
      }),
    ).rejects.toThrow("identity variables");
    f.controller.abort();
    await expect(
      spawnAgentCommand(f.host, { signal: f.controller.signal }),
    ).rejects.toThrow();
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(f.host.spawn).not.toHaveBeenCalled();
  });
});
