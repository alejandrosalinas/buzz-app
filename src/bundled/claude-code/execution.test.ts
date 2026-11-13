import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentExecution } from "../../features/agents/execution";
import { ClaudeProcess } from "./claude";
import { executionSpawn } from "./execution";
import { ClaudeRuntime, DEFAULT_CONFIG } from "./runtime";
import { localStore } from "../../features/agents/store";
import { fileStore } from "../../features/agents/state";
import type {
  Agent,
  AgentHandle,
  Delivery,
  Agents,
} from "../../features/agents/service";
import type { AgentReads } from "../../features/agents/reads";

async function guestFixture() {
  const directory = await mkdtemp(join(tmpdir(), "buzz-claude-execution-"));
  const children: ReturnType<typeof spawn>[] = [];
  const output: string[] = [];
  const guest: AgentExecution = {
    workspace: directory,
    signal: new AbortController().signal,
    resolveDirectory: async (path) => path,
    readFile: async () => new Uint8Array(),
    dispose: async () => {
      for (const child of children) child.kill();
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once("exit", resolve)),
        ),
      );
    },
    spawn: async (program, options) => {
      expect(program).toBe("node");
      expect(options?.env).toBeUndefined();
      const child = spawn(process.execPath, [...(options?.args ?? [])], {
        cwd: options?.cwd,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          ANTHROPIC_API_KEY: "guest-test-sign-in",
          CLAUDECODE: "stale-session",
        },
        stdio: "pipe",
      });
      children.push(child);
      child.stdout.on("data", (data) => options?.onStdout?.(String(data)));
      child.stderr.on("data", (data) => {
        output.push(String(data));
        options?.onStderr?.(String(data));
      });
      return {
        write: (data) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
        end: async (data) => {
          child.stdin.end(data);
        },
        kill: async () => {
          child.kill();
        },
        exited: new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        ),
      };
    },
  };
  await writeFile(
    join(directory, "claude"),
    `#!${process.execPath}
const {createInterface} = require('node:readline');
const {appendFileSync,existsSync,writeFileSync} = require('node:fs');
const flag = (name) => process.argv[process.argv.indexOf(name)+1];
const resume = process.argv.includes('--resume') ? flag('--resume') : undefined;
const session = resume || (process.argv.includes('--session-id') ? flag('--session-id') : 'session-1');
const log = (value) => appendFileSync('wire.jsonl',JSON.stringify(value)+'\\n');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(0); }
if (process.env.ANTHROPIC_API_KEY !== 'guest-test-sign-in' || process.env.CLAUDECODE) process.exit(2);
const send = (wire) => console.log(JSON.stringify({...wire,session_id:session}));
log({launch:process.argv});
const result = () => send({type:'result', subtype:'success', session_id:'session-1'});
createInterface({input:process.stdin}).on('line', (line) => {
  const wire = JSON.parse(line);
  log(wire);
  if (wire.testComplete) { result(); return; }
  if (wire.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:wire.request_id,response:{models:[{value:'haiku'}]}}});
    if (wire.request.subtype === 'interrupt') {
      send({type:'result',subtype:'error_during_execution',is_error:true,terminal_reason:'aborted_tools',session_id:'session-1'});
    }
  } else if (wire.type === 'user') {
    if (resume && !existsSync(session+'.saved')) { process.stderr.write('No conversation found'); process.exit(1); }
    writeFileSync(session+'.saved','saved');
    send({type:'system',subtype:'init',session_id:'session-1',model:'haiku'});
    if (wire.message.content === 'hold' || wire.message.content.includes('hold-request') || (wire.message.content === '/compact' && existsSync('hold-compact'))) return;
    send({type:'control_request',request_id:'tool',request:{subtype:'mcp_message',server_name:'buzz',message:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:wire.message.content.includes('read-path-request')?'send':'read',arguments:{path:'proof.bin',audience:'everyone'}}}}});
  } else if (wire.type === 'control_response') {
    if (wire.response.request_id === 'tool') {
      process.stderr.write(JSON.stringify(wire.response.response));
      send({type:'control_request',request_id:'hook',request:{subtype:'hook_callback',callback_id:'buzz:PermissionRequest',input:{session_id:'session-1',tool_name:'Read'}}});
    } else if (wire.response.request_id === 'hook') {
      process.stderr.write(JSON.stringify(wire.response.response));
      result();
    }
  }
});
`,
    { mode: 0o700 },
  );
  return {
    guest,
    directory,
    output,
    finish: () => {
      for (const child of children)
        if (
          !child.killed &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.stdin?.write(`${JSON.stringify({ testComplete: true })}\n`);
    },
    wires: async () =>
      (await readFile(join(directory, "wire.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: async () => {
      await guest.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("carries Claude tools, hooks and Stop over guest stdio with guest authentication", async () => {
  const { guest, directory, output, cleanup } = await guestFixture();
  const tools = vi.fn(async () => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "guest-file" }] },
  }));
  const hook = vi.fn(async () => ({
    decision: "deny",
    reason: "test decision",
  }));
  const claude = await ClaudeProcess.start(executionSpawn(guest), {
    cwd: directory,
    systemPrompt: "test",
    tools,
    hook,
  });
  try {
    expect(await claude.models()).toEqual([{ value: "haiku" }]);
    await expect(claude.send("read")).resolves.toEqual({ ok: true });
    expect(tools).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ method: "tools/call" }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(hook).toHaveBeenCalledWith("session-1", "PermissionRequest", {
      session_id: "session-1",
      tool_name: "Read",
    });
    await vi.waitFor(() => {
      expect(output.join("")).toContain("guest-file");
      expect(output.join("")).toContain("test decision");
    });
    const held = claude.send("hold");
    await vi.waitFor(() => expect(claude.active).toBe(true));
    await claude.interrupt();
    await expect(held).resolves.toMatchObject({ ok: true, stopped: true });
    await expect(claude.send("read again")).resolves.toEqual({ ok: true });
  } finally {
    await claude.kill();
    await claude.exited;
    await cleanup();
  }
});

async function remoteFixture() {
  const guest = await guestFixture();
  const readRemote = vi
    .spyOn(guest.guest, "readFile")
    .mockResolvedValue(new TextEncoder().encode("remote-file"));
  const data = new Map<string, string>();
  const storage = localStore({
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as Storage);
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "b".repeat(64),
    name: "Claude",
    config: DEFAULT_CONFIG,
  } as Agent;
  const handle = {
    ...agent,
    publish: vi.fn(async () => ({})),
  } as unknown as AgentHandle;
  const reads = {
    connection: {},
    scope: "test-community",
    channel: async () => ({ dm: true, members: [] }),
    soloChat: async () => false,
    read: async () => [],
    channelLabel: () => undefined,
    workflowAuthority: () => undefined,
    name: () => undefined,
    memoryListing: async () => ({ entries: [], partial: false }),
  } as unknown as AgentReads;
  const control = {
    connected: true,
    bound: true,
    inspect: async () => {},
    open: async () => {},
    dispose: async (_key: string) => {},
    save: async () => {},
  };
  const sessions: { key: string; intent: string }[] = [];
  const disposed: string[] = [];
  const connect: Agents["execution"] = async (_agent, session) => {
    sessions.push({ key: session.key, intent: session.intent });
    await control.open();
    const lifetime = new AbortController();
    return {
      ...guest.guest,
      signal: lifetime.signal,
      dispose: async () => {
        disposed.push(session.key);
        lifetime.abort();
        await control.dispose(session.key);
      },
    };
  };
  const local = vi.fn(async () => {
    throw new Error("Local Claude must stay unused");
  });
  const create = () =>
    new ClaudeRuntime(
      { spawn: local },
      () => (control.connected ? reads : undefined),
      async () => null,
      fileStore(
        new Map(),
        async (key, value) => {
          await control.save();
          await storage.set(key, value);
        },
        storage.add,
        storage.read,
        storage.scan,
      ),
      undefined,
      undefined,
      undefined,
      async () => ({}),
      connect,
      async () => {
        await control.inspect();
        return { provider: "test/remote" };
      },
      () => control.bound,
    );
  let runtime = create();
  runtime.sync([agent]);
  const waits: Promise<unknown>[] = [];
  let handovers = 0;
  const deliver = async (
    content = "hello",
    signal = new AbortController().signal,
    channel = "room",
  ) => {
    const event = {
      id: "c".repeat(64),
      pubkey: agent.owner,
      kind: 9,
      created_at: 1,
      content,
      tags: [["h", channel]],
    };
    await runtime.run({
      agent: handle,
      config: DEFAULT_CONFIG,
      channelId: channel,
      trigger: { type: "mention", event },
      signal,
      workingUntil: (work: Promise<unknown>) => {
        handovers++;
        waits.push(work);
      },
    } as unknown as Delivery);
    await Promise.all(waits.splice(0));
  };
  return {
    ...guest,
    agent,
    handle,
    sessions,
    disposed,
    control,
    local,
    readRemote,
    deliver,
    get runtime() {
      return runtime;
    },
    get handovers() {
      return handovers;
    },
    restart: async () => {
      await runtime.retire(agent.key);
      runtime.dispose();
      control.bound = true;
      runtime = create();
      runtime.sync([agent]);
    },
    cleanup: async () => {
      control.dispose = async () => {};
      await runtime.retire(agent.key);
      runtime.dispose();
      await guest.cleanup();
    },
  };
}

it("resumes a saved target before its first post-restart compaction and gives New a fresh key", async () => {
  const f = await remoteFixture();
  try {
    expect(await f.runtime.models(f.agent.key)).toMatchObject({
      current: "",
      models: [],
    });
    await f.runtime.session(f.agent, { channelId: "room" }, "compact");
    expect(f.sessions).toEqual([]);
    await f.deliver();
    const saved = f.runtime.conversations(f.agent.key)[0];
    expect(saved?.sessionId).toBeTruthy();
    await f.restart();
    await f.runtime.session(f.agent, { channelId: "room" }, "compact");
    f.output.length = 0;
    await f.deliver("read-path-request");
    await vi.waitFor(() => expect(f.output.join("")).toContain("mcp_response"));
    expect(f.readRemote, f.output.join("")).toHaveBeenCalledWith("proof.bin", {
      cwd: f.directory,
    });
    expect(f.handle.publish).toHaveBeenCalledWith(
      expect.objectContaining({ content: "remote-file" }),
      expect.any(Function),
    );
    expect(f.runtime.conversations(f.agent.key)[0]?.sessionId).toBe(
      saved?.sessionId,
    );
    expect(f.sessions[1]).toEqual({
      key: f.sessions[0]?.key,
      intent: "existing",
    });
    expect(
      (await f.wires()).some(
        (wire) =>
          Array.isArray(wire.launch) && wire.launch.includes("--resume"),
      ),
    ).toBe(true);
    await f.runtime.session(f.agent, { channelId: "room" }, "new");
    await f.runtime.session(f.agent, { channelId: "room" }, "compact");
    expect(f.sessions).toHaveLength(2);
    await f.deliver();
    expect(f.sessions[2]?.key).not.toBe(f.sessions[0]?.key);
    expect(f.sessions[2]?.intent).toBe("new");
    expect(f.local).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("interrupts remote work with a stale binding cache and no relay scope", async () => {
  const f = await remoteFixture();
  const pending = f.deliver("hold-request");
  try {
    await vi.waitFor(() =>
      expect(f.runtime.sessions(f.agent.key)).toEqual([
        { key: "room", busy: true },
      ]),
    );
    f.control.bound = false;
    f.control.connected = false;
    expect(f.runtime.sessionState(f.agent, { channelId: "room" })).toBe(
      "active",
    );
    await f.runtime.session(f.agent, { channelId: "room" }, "interrupt");
    await pending;
    expect(f.runtime.sessionState(f.agent, { channelId: "room" })).toBe("idle");
  } finally {
    f.control.connected = true;
    await f.cleanup();
  }
});

it("interrupts remote compaction and retains accepted work past its handover deadline", async () => {
  const f = await remoteFixture();
  await f.deliver();
  await writeFile(join(f.directory, "hold-compact"), "");
  const compactions = async () =>
    (await f.wires()).filter(
      (wire) =>
        wire.type === "user" &&
        (wire.message as { content?: string })?.content === "/compact",
    ).length;
  try {
    const compact = f.runtime.session(
      f.agent,
      { channelId: "room" },
      "compact",
    );
    const cancelled = expect(compact).rejects.toThrow("interrupted");
    await vi.waitFor(async () => expect(await compactions()).toBe(1));
    await f.runtime.session(f.agent, { channelId: "room" }, "interrupt");
    await cancelled;
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(f.agent, { channelId: "room" })).toBe(
        "idle",
      ),
    );
    const again = f.runtime.session(f.agent, { channelId: "room" }, "compact");
    await vi.waitFor(async () => expect(await compactions()).toBe(2));
    const expired = new AbortController();
    const baseline = f.handovers;
    const accepted = f.deliver("hello", expired.signal);
    await vi.waitFor(() => expect(f.handovers).toBeGreaterThan(baseline));
    expired.abort(new Error("handover deadline"));
    f.finish();
    await again;
    await accepted;
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(f.agent, { channelId: "room" })).toBe(
        "idle",
      ),
    );
    expect(f.handle.publish).not.toHaveBeenCalled();
  } finally {
    f.finish();
    await f.cleanup();
  }
});

it("cancels an admitted remote handoff before its connection returns", async () => {
  const f = await remoteFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let inspections = 0;
  let opening = false;
  const spawn = vi.spyOn(f.guest, "spawn");
  f.control.inspect = async () => {
    if (++inspections === 2 && !opening) {
      entered();
      await gate;
    }
  };
  f.control.open = async () => {
    opening = true;
    entered();
    await gate;
  };
  const sent = f.deliver();
  const cancelled = expect(sent).rejects.toThrow("stopped");
  try {
    await waiting;
    await f.runtime.session(f.agent, { channelId: "room" }, "interrupt");
  } finally {
    release();
  }
  try {
    await cancelled;
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("retires every remote conversation when one cleanup fails and retries only the failure", async () => {
  const f = await remoteFixture();
  try {
    await f.deliver();
    await f.deliver("hello", undefined, "another-room");
    const [first, second] = f.sessions;
    if (!first || !second) throw new Error("Both remote sessions must exist");
    f.control.dispose = async (key) => {
      if (key === first.key) throw new Error("cleanup refused");
    };
    await expect(f.runtime.retire(f.agent.key)).rejects.toThrow(
      "cleanup failed",
    );
    expect(f.disposed).toEqual(expect.arrayContaining([first.key, second.key]));
    f.control.dispose = async () => {};
    await f.runtime.retire(f.agent.key);
    expect(f.disposed.filter((key) => key === first.key)).toHaveLength(2);
    expect(f.disposed.filter((key) => key === second.key)).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it("clears remote turn ownership after a failed durable save", async () => {
  const f = await remoteFixture();
  try {
    await f.deliver();
    let refused = false;
    f.control.save = async () => {
      if (!refused) {
        refused = true;
        throw new Error("disk unavailable");
      }
    };
    await f.deliver();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(f.agent, { channelId: "room" })).toBe(
        "idle",
      ),
    );
    expect(f.handle.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("disk unavailable"),
      }),
    );
    await f.runtime.session(f.agent, { channelId: "room" }, "new");
    await f.deliver();
    expect(f.sessions).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

it("cancels a remote New action while the prior target cleanup waits", async () => {
  const f = await remoteFixture();
  await f.deliver();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.control.dispose = async () => {
    entered();
    await gate;
  };
  const reset = f.runtime.session(f.agent, { channelId: "room" }, "new");
  const cancelled = expect(reset).rejects.toThrow("interrupted");
  try {
    await cleaning;
    await f.runtime.session(f.agent, { channelId: "room" }, "interrupt");
  } finally {
    release();
  }
  try {
    await cancelled;
    expect(f.sessions).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it("rejects retired remote work queued behind a New save", async () => {
  const f = await remoteFixture();
  await f.deliver();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.control.save = async () => {
    entered();
    await gate;
  };
  const reset = f.runtime.session(f.agent, { channelId: "room" }, "new");
  let queued: Promise<void> | undefined;
  try {
    await saving;
    const before = f.handovers;
    queued = f.deliver("retired-request");
    await vi.waitFor(() => expect(f.handovers).toBeGreaterThan(before));
    await f.runtime.retire(f.agent.key);
  } finally {
    release();
  }
  try {
    await reset;
    await queued;
    expect(f.sessions).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
