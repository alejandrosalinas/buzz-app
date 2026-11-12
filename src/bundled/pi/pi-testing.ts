// A fake Pi host for tests: each process it spawns answers the plugin's
// requests with the test's handlers, one JSON message a line, as host.mjs
// does, and can call the plugin's tools and send it events.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type Request = Readonly<{
  id: number;
  method: string;
  params: Record<string, unknown>;
}>;
export type Handler = (
  params: Record<string, unknown>,
  process: FakeProcess,
) => unknown;

export type FakeProcess = {
  id: string;
  options: HostProcessOptions;
  requests: Request[];
  ended: boolean;
  killed: boolean;
  /** The launcher's line: the host source and the packages it installs. */
  launched?: { host: string; package: string; lock: string };
  /** Sends the plugin one message, as stdout. */
  send(message: object): void;
  /** Calls one of the plugin's tools and resolves with its answer. */
  tool(
    params: object,
    method?: string,
  ): Promise<{ result?: unknown; error?: string }>;
  /** Exits, saying `stderr` last. */
  exit(code: number | null, stderr?: string): void;
};

export function fakeHost(
  handlers: Readonly<Record<string, Handler>> = {},
  options: Readonly<{ ready?: boolean; close?: boolean }> = {},
) {
  const processes: FakeProcess[] = [];
  const spawn = async (
    id: string,
    spawnOptions: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    let gone = false;
    let buffer = "";
    let called = 0;
    const answers = new Map<
      string,
      (answer: { result?: unknown; error?: string }) => void
    >();
    const process: FakeProcess = {
      id,
      options: spawnOptions,
      requests: [],
      ended: false,
      killed: false,
      send: (message) => {
        if (!gone) spawnOptions.onStdout?.(`${JSON.stringify(message)}\n`);
      },
      tool: (params, method = "tool") =>
        new Promise((resolve) => {
          const id = `h${++called}`;
          answers.set(id, resolve);
          process.send({ id, method, params });
        }),
      exit: (code, stderr) => {
        if (gone) return;
        if (stderr) spawnOptions.onStderr?.(stderr);
        gone = true;
        exit(code);
      },
    };
    processes.push(process);
    const handle = async (request: Request) => {
      process.requests.push(request);
      const handler = handlers[request.method];
      try {
        process.send({
          id: request.id,
          result: (await handler?.(request.params, process)) ?? {},
        });
      } catch (error) {
        process.send({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const write = async (data: string) => {
      if (gone) throw new Error("closed");
      buffer += data;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        // The first line is the launcher's: what it installs and runs.
        if (!process.launched && !spawnOptions.protection)
          process.launched = message;
        else if (message.method) void handle(message);
        else {
          answers.get(message.id)?.(message);
          answers.delete(message.id);
        }
      }
    };
    if (options.ready !== false)
      queueMicrotask(() => process.send({ method: "ready", params: {} }));
    return {
      write,
      end: async () => {
        process.ended = true;
        if (options.close) process.exit(0);
      },
      kill: async () => {
        process.killed = true;
        process.exit(null);
      },
      exited,
    };
  };
  return {
    spawn,
    processes,
    /** Every request the plugin made, of `method`, across processes. */
    requests: (method: string) =>
      processes.flatMap((item) =>
        item.requests.filter((request) => request.method === method),
      ),
  };
}

/** A promise the test settles. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
