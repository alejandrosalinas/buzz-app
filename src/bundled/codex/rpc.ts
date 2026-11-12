import { writeJSON } from "../../features/agent-protection/json-stream";
import type { Model } from "./config";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;
export type Wire = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
};

export type ToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};
export type ToolReply = {
  success: boolean;
  contentItems: (
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  )[];
};

/** Codex's answer refusing a request, which it therefore did not carry out. */
export class Refused extends Error {}
/** A line over the connection's frame, which closes it. */
export class Oversized extends Error {
  constructor() {
    super("Codex output frame is too large");
  }
}

/** One request owner for the JSONL app-server connection. No Node sidecar. */
export class AppServer {
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private process?: HostProcess;
  private failure?: Error;
  private buffer = "";
  private stderr = "";
  private listeners = new Set<(message: Wire) => void>();
  private closing?: Promise<void> | undefined;
  private gone = false;
  private opened?: [Spawn, string | undefined, boolean];

  constructor(
    private readonly toolCall?: (call: ToolCall) => Promise<ToolReply>,
  ) {}

  /** The credential for only this agent's commands, never app-server's own
   * environment. */
  toolCredential(agent: Readonly<{ pubkey: string; relay: string }>) {
    return this.process?.toolCredential?.(agent);
  }

  async open(spawn: Spawn, cwd?: string, protectedRuntime = false) {
    if (this.failure) throw this.failure;
    this.opened = [spawn, cwd, protectedRuntime];
    this.process = await spawn("app-server", {
      ...(cwd ? { cwd } : {}),
      onStdout: (data) => this.read(data),
      onStderr: (data) => {
        this.stderr = (this.stderr + data).slice(-4000);
      },
    });
    void this.process.exited.then((code) => {
      this.gone = true;
      this.fail(
        new Error(this.stderr.trim() || `Codex exited (${code ?? "signal"})`),
      );
    });
    if (this.failure) {
      await this.close();
      throw this.failure;
    }
    const initialized = await this.request<{ userAgent?: string }>(
      "initialize",
      {
        clientInfo: {
          name: "buzz_codex_plugin",
          title: "Buzz Codex",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
            "item/plan/delta",
            "item/commandExecution/outputDelta",
            "item/fileChange/outputDelta",
          ],
        },
      },
    );
    if (
      protectedRuntime &&
      !initialized.userAgent?.includes("buzz-protection-v2")
    ) {
      await this.close();
      throw new Error("This Codex build lacks mandatory security hooks");
    }
    await this.send({ method: "initialized" });
    return this;
  }
  /** Closes this connection and opens a fresh app-server as before. */
  async reopen() {
    if (!this.opened) throw new Error("Codex is not connected");
    const [spawn, cwd, protectedRuntime] = this.opened;
    await this.close();
    delete this.process;
    delete this.failure;
    this.closing = undefined;
    this.gone = false;
    this.buffer = this.stderr = "";
    return this.open(spawn, cwd, protectedRuntime);
  }
  /** Whether the process has exited. */
  get exited() {
    return this.gone;
  }
  onMessage(listener: (message: Wire) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private read(data: string) {
    // Always return to Tauri's channel handler, including malformed output or
    // a throwing consumer; otherwise the final exit event can be stranded.
    try {
      this.buffer += data;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        if (newline > 4 * 1024 * 1024) throw new Oversized();
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message: Wire = JSON.parse(line);
        const waiter =
          typeof message.id === "number" && !message.method
            ? this.pending.get(message.id)
            : undefined;
        if (waiter) {
          this.pending.delete(message.id as number);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Refused(message.error.message));
          else waiter.resolve(message.result);
        } else if (message.id != null && message.method) {
          if (message.method === "item/tool/call" && this.toolCall) {
            void this.replyTool(message, this.toolCall).catch((error) =>
              this.fail(error),
            );
            continue;
          }
          void this.send({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Buzz Codex runs with approvalPolicy=never; interactive requests are unsupported",
            },
          }).catch((error) => this.fail(error));
        } else this.emit(message);
      }
      if (this.buffer.length > 4 * 1024 * 1024) throw new Oversized();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  }
  private async replyTool(
    message: Wire,
    handler: (call: ToolCall) => Promise<ToolReply>,
  ) {
    let reply: ToolReply;
    try {
      reply = await handler(message.params as ToolCall);
    } catch (error) {
      reply = {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    if (message.id == null) return;
    await this.send({ id: message.id, result: reply });
  }
  private emit(message: Wire) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Codex notification handler failed", error);
      }
    }
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.emit({
      method: "connection/closed",
      params: { message: error.message },
    });
  }
  send(message: Wire) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.process)
      return Promise.reject(new Error("Codex is not connected"));
    return writeJSON(this.process, message);
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      void this.send({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  close(): Promise<void> {
    this.fail(new Error("Codex connection closed"));
    if (!this.process) return Promise.resolve();
    if (this.closing) return this.closing;
    const process = this.process;
    const closing = (async () => {
      // EOF lets Codex stop its separately grouped background terminals.
      const timer = setTimeout(() => void process.kill(), 3000);
      try {
        await process.end().catch(() => process.kill());
        await process.exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    this.closing = closing;
    // A close that failed to stop the process is attempted again by the next.
    void closing.catch(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    return closing;
  }
}

/** Whether Codex lacks an OpenAI sign-in that its model provider needs. A provider set with
 * `requires_openai_auth = false` brings its own credentials, so Codex asks for no sign-in. */
export async function needsSignIn(rpc: AppServer) {
  const { account, requiresOpenaiAuth } = await rpc.request<{
    account: unknown;
    requiresOpenaiAuth?: boolean;
  }>("account/read");
  return !account && requiresOpenaiAuth !== false;
}

export async function listModels(rpc: AppServer) {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: Model[]; nextCursor: string | null } =
      await rpc.request("model/list", { limit: 100, cursor });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}
