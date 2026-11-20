import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../host/service";

/** Composes existing connection and process owners; no separate command registry. */
export async function spawnAgentCommand(
  host: {
    connect(signal: AbortSignal): Promise<HostMcpServer>;
    spawn(options: HostProcessOptions): Promise<HostProcess>;
    check(): void;
    subscribe(changed: () => void): () => void;
  },
  {
    signal,
    channel: _channel,
    root: _root,
    ...options
  }: Omit<HostProcessOptions, "mcp"> & {
    signal: AbortSignal;
    channel?: string | undefined;
    root?: string | undefined;
  },
): Promise<HostProcess> {
  signal.throwIfAborted();
  for (const name of Object.keys(options.env ?? {}))
    if (/^(BUZZ_|NOSTR_)/i.test(name))
      throw new Error("Agent command identity variables are supplied by Buzz");
  host.check();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const unsubscribe = host.subscribe(() => {
    try {
      host.check();
    } catch (error) {
      controller.abort(error);
    }
  });
  let connection: HostMcpServer | undefined;
  let process: HostProcess | undefined;
  let started: HostProcess | undefined;
  const stop = () => {
    lifetime.removeEventListener("abort", stop);
    unsubscribe();
    const running = process;
    const endpoint = connection;
    process = undefined;
    connection = undefined;
    controller.abort();
    return Promise.all([running?.kill(), endpoint?.close()]).then(() => {});
  };
  lifetime.addEventListener("abort", stop, { once: true });
  try {
    connection = await host.connect(lifetime);
    lifetime.throwIfAborted();
    void connection.closed.then(stop);
    const running = await host.spawn({
      ...options,
      mcp: { url: connection.url, headers: connection.headers },
    });
    started = process = running;
    host.check();
    lifetime.throwIfAborted();
    void running.exited.then(stop);
    return Object.freeze({
      ...running,
      kill: stop,
    });
  } catch (error) {
    try {
      await stop();
    } finally {
      // A late handle can still be exiting after the stop request returns.
      await started?.exited;
    }
    throw error;
  }
}
