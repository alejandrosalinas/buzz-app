import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import { nativeIdentityEnabled } from "../identity/service";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** Native deadline in milliseconds, 1–180000. Defaults to 30000. */
  timeoutMs?: number;
}>;
/** A multipart POST of one local `.tar.gz` file in the home directory, with
 * text fields beside it, to an origin the plugin declares. */
export type HostUpload = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  fields?: Readonly<Record<string, string>>;
  file: Readonly<{
    /** The form field it is sent as. */
    field: string;
    /** An absolute path. */
    path: string;
    /** The file name the form gives it. */
    name: string;
    contentType: string;
  }>;
}>;
/** One in-memory multipart part plus bounded text fields. Desktop only. */
export type HostByteUpload = Readonly<{
  url: string;
  /** 1–256 ASCII letters/digits/dots/underscores/hyphens; no leading dot. */
  field: string;
  /** One filename with the same safe characters; no leading dot or path. */
  name: string;
  /** Exactly image/png, image/jpeg or image/webp, matching the bytes' signature. */
  contentType: string;
  /** At most 16 text fields, safe names, each value at most 8192 UTF-8 bytes. */
  fields?: Readonly<Record<string, string>>;
}>;
export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export type HostRequestOnceOptions = Readonly<{
  callId: string;
  /** Synchronous final caller check. Only literal true permits dispatch. */
  isEligible?: () => boolean;
}>;
/** GET-only raw bytes from an exact declared HTTPS origin. Desktop only. */
export type HostByteRequest = Readonly<{
  url: string;
  /** Required integer byte cap, 1–16777216. */
  maxBytes: number;
  /** 1–30000 milliseconds; defaults to 30000. */
  timeoutMs?: number;
}>;
export type HostByteResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;
export type HostSavedBytes = Readonly<{
  path: string;
  size: number;
  sha256: string;
  /** Host wall-clock Unix milliseconds, not a deletion timer. */
  expiresAt: number;
}>;
/** Reusable NIP-OA proof for one agent key; preparing it does not submit it. */
export type NipOaAuthorization = readonly [
  "auth",
  ownerPubkey: string,
  conditions: string,
  signature: string,
];
export type ProcessProtection = Readonly<{
  readOnlyPaths: readonly string[];
  hiddenPaths: readonly string[];
}>;
/** The variable a Buzz credential is handed over in. */
export const CREDENTIAL_ENV = "BUZZ_CREDENTIAL_PROVIDER";
export type HostProcessOptions = Readonly<{
  /** Follow the arguments the manifest declares. */
  args?: readonly string[];
  /** An absolute directory or one under home written `~/…`; created if missing. */
  cwd?: string;
  /** Added to the app's environment; `null` removes a variable. */
  env?: Readonly<Record<string, string | null>>;
  /** Run with one app-held MCP session and an agent-scoped `buzz` on PATH. */
  mcp?: Pick<HostMcpServer, "url" | "headers">;
  /** Native macOS containment for a protected worker and its descendants. */
  protection?: ProcessProtection;
  /** Hand it a Buzz credential (`BUZZ_CREDENTIAL_PROVIDER`) that acts for no
   * one until `actAs` names one of the plugin's agents. Not on Windows. */
  agentCredential?: boolean;
  /** Set by agent protection: the agent a protected engine is launched for.
   * Native checks that the agent's saved protection names this plugin. */
  protectedAgent?: Readonly<{ pubkey: string; relay: string }>;
  /** Secrets native code holds, set in its environment after `env`; one that
   * is not saved is left unset. Each is only for the processes it belongs
   * to: `anthropic-api-key` (`ANTHROPIC_API_KEY`) for Buzz's Claude. */
  secrets?: readonly "anthropic-api-key"[];
  onStdout?(data: string): void;
  onStderr?(data: string): void;
}>;
export type HostProcess = Readonly<{
  write(data: string): Promise<void>;
  /** Writes any final `data`, then closes stdin. */
  end(data?: string): Promise<void>;
  /** Asks it to stop, then kills it and its descendants. */
  kill(): Promise<void>;
  /** Only with `agentCredential`: lets its credential act as this agent of
   * the plugin's type from now on. A process acts as one agent only. */
  actAs?(agent: Readonly<{ pubkey: string; relay: string }>): Promise<void>;
  /** For a host several agents share: the `BUZZ_CREDENTIAL_PROVIDER` value
   * for only this agent's tool processes, never the host's own environment.
   * The same each call; revoked once the host exits. Undefined on Windows. */
  toolCredential?(
    agent: Readonly<{ pubkey: string; relay: string }>,
  ): Promise<string | undefined>;
  /** The exit code once it exits; null when a signal ended it. */
  exited: Promise<number | null>;
}>;
/** UTF-16 units per process write: at most 3 UTF-8 bytes each, so a piece
 * stays under the host's 1 MiB write limit. */
const WRITE_UNITS = 256 * 1024;
type ProcessEvent =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number | null };
/** Answers one JSON-RPC message an agent sent: with the JSON-RPC response,
 * or `undefined` for a notification, which needs none. */
export type McpHandler = (message: unknown) => Promise<unknown>;
/** A loopback MCP server (Streamable HTTP) whose messages the plugin answers.
 * It belongs to the plugin and stops when the plugin unloads. */
export type HostMcpServer = Readonly<{
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  /** What the agent must send with each request, as ACP's `mcpServers` and
   * MCP clients take them. */
  headers: readonly Readonly<{ name: string; value: string }>[];
  close(): Promise<void>;
  /** Resolves once it has stopped. */
  closed: Promise<void>;
  authorize?(request: McpAuthorization): Promise<void>;
}>;
export type McpAuthorization = Readonly<{
  callback: string;
  state: string;
  code_challenge: string;
  approval?: McpApproval;
  resume?: Readonly<{ id: string; counter: number; proof: string }>;
  durable_client?: string;
}>;
export type McpApproval = Readonly<{
  client: string;
  viewer: string;
  agent: string;
  community: string;
  scopes: readonly ("read" | "post" | "create" | "agent")[];
}>;
export type McpPairing = Readonly<{
  id: string;
  approval: McpApproval;
  expires_at: number;
}>;
type McpEvent =
  | { type: "message"; request: number; body: string }
  | { type: "closed" };
/** Share one MCP session among cooperating clients holding the token.
 * This permits token reuse after initialization. The handler must bind identity
 * itself and grant every client the same authority. Defaults to false. */
export type HostMcpOptions = Readonly<{ sharedSession?: boolean }>;
export interface Host {
  externalMcpPairing?(
    operation: "get" | "resume" | "revoke",
    request?: McpAuthorization,
  ): Promise<McpPairing | null>;
  denyMcpAuthorization?(request: McpAuthorization): Promise<void>;
  runCommand(id: string, input?: string): Promise<string | null>;
  /** Starts a process the manifest declares in `host.processes`. It lives until
   * it exits, is killed, or the plugin unloads. Desktop only. */
  spawn?: (id: string, options?: HostProcessOptions) => Promise<HostProcess>;
  /** Starts a loopback MCP server whose messages `handler` answers, for a
   * plugin whose manifest declares `host.mcp`. Desktop only. */
  serveMcp?: (
    handler: McpHandler,
    options?: HostMcpOptions,
  ) => Promise<HostMcpServer>;
  /** Reads a file of at most 50 MB, for a plugin whose manifest declares
   * `host.files`. `path` is absolute, `~/…`, or relative to `cwd`, which is
   * absolute or `~/…`. A missing file rejects with "No such file". Desktop
   * only. */
  readFile?: (
    path: string,
    options?: Readonly<{ cwd?: string }>,
  ) => Promise<Uint8Array>;
  /** `path`, absolute or `~/…`, as an absolute directory without symbolic
   * links, created if missing, for a plugin whose manifest declares
   * `host.files`. Desktop only. */
  resolveDirectory?: (path: string) => Promise<string>;
  request(input: HostRequest): Promise<HostResponse>;
  /** POST-only, desktop and compatible native host required. A repeated call
   * authority rejects with unknown outcome, never resubmits or caches success.
   * Blocks IPC-fallback resends only, not fresh calls or upstream retries.
   * Also send callId as a server idempotency key when the server supports it. */
  requestOnce?: (
    input: HostRequest,
    options: HostRequestOnceOptions,
  ) => Promise<HostResponse>;
  /** Protected multipart POST; no file grant, IPC fallback or automatic retry.
   * Copies 1–16777216 bytes before awaiting native authority. */
  uploadBytesOnce?: (
    bytes: Uint8Array,
    input: HostByteUpload,
    options: HostRequestOnceOptions,
  ) => Promise<HostResponse>;
  /** No automatic replay protection or text/array fallback. */
  requestBytes?: (input: HostByteRequest) => Promise<HostByteResponse>;
  /** Requires host.managedFiles, not host.files. Keep bytes immutable through
   * hashing/save. An ambiguous failure must not be automatically retried. */
  saveBytes?: (
    bytes: Uint8Array,
    input: Readonly<{ sha256: string }>,
  ) => Promise<HostSavedBytes>;
  /** Removes this plugin's own managed file. Await attachment sends first;
   * Conservatively refuses app-wide while any plugin's host.readFile call or
   * process named read/read-protected is active, regardless of program/path. */
  deleteManagedFile?: (path: string) => Promise<void>;
  /** Uploads a file as `request` sends a body. Desktop only. */
  upload?: (input: HostUpload) => Promise<HostResponse>;
  prepareRemoteAgentAuthorization?: (
    agentPubkey: string,
    signal?: AbortSignal,
  ) => Promise<NipOaAuthorization>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Host;
  }
}

/** The signed-in owner's NIP-OA proof for `agentPubkey`, from native
 * identity or the web relay proxy. */
export async function prepareRemoteAgentAuthorization(
  agentPubkey: string,
  signal?: AbortSignal,
): Promise<NipOaAuthorization> {
  signal?.throwIfAborted();
  if (!/^[0-9a-f]{64}$/.test(agentPubkey))
    throw new Error("Agent pubkey must be 64 lowercase hex characters");
  const native = nativeIdentityEnabled();
  const owner = native
    ? await invoke<string | null>("identity_restore")
    : (
        await (
          await fetch("/api/relay/identity", { signal: signal ?? null })
        ).json()
      ).viewer;
  signal?.throwIfAborted();
  if (typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))
    throw new Error("Set up your identity first");
  if (owner === agentPubkey)
    throw new Error("Owner and agent pubkeys must differ");
  let tag: NipOaAuthorization;
  if (native) {
    try {
      tag = await invoke<NipOaAuthorization>(
        "identity_prepare_remote_agent_authorization",
        { owner, agentPubkey },
      );
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  } else {
    const response = await fetch(
      "/api/relay/prepare-remote-agent-authorization",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, agentPubkey }),
        signal: signal ?? null,
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Owner authorization failed");
    tag = result;
  }
  signal?.throwIfAborted();
  if (
    !Array.isArray(tag) ||
    tag.length !== 4 ||
    tag[0] !== "auth" ||
    tag[1] !== owner ||
    tag[2] !== "" ||
    typeof tag[3] !== "string" ||
    !/^[0-9a-f]{128}$/.test(tag[3])
  )
    throw new Error("Invalid remote agent authorization");
  return tag;
}

type CallContext = Readonly<{ boot: string; page: number }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const callContexts = new WeakMap<
  Context["fiber"],
  {
    context: Promise<CallContext>;
    activation: string;
    disposed: boolean;
  }
>();

export class HostService extends Service implements Host {
  constructor(context: Context) {
    super(context, "host");
  }

  prepareRemoteAgentAuthorization(agentPubkey: string, signal?: AbortSignal) {
    return prepareRemoteAgentAuthorization(agentPubkey, signal);
  }

  async runCommand(id: string, input?: string): Promise<string | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri()) return null;
    try {
      return await invoke<string | null>("plugin_host_run_command", {
        id: owner.id,
        revision: owner.revision,
        commandId: id,
        ...(input === undefined ? {} : { input }),
      });
    } catch {
      return null;
    }
  }

  // A method, not a field: `this.ctx` is then the calling plugin's scope.
  async spawn(
    id: string,
    { onStdout, onStderr, ...options }: HostProcessOptions = {},
  ): Promise<HostProcess> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Processes require an installed desktop plugin");
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    const onEvent = new Channel<ProcessEvent>((event) => {
      if (event.type === "exit") return exit(event.code);
      // A throw here would stall the channel, so no later output or exit
      // would arrive.
      try {
        if (event.type === "stdout") onStdout?.(event.data);
        else onStderr?.(event.data);
      } catch (error) {
        console.error(`Process ${id} output handler failed`, error);
      }
    });
    const handle = await invoke<number>("plugin_host_process_spawn", {
      id: owner.id,
      revision: owner.revision,
      processId: id,
      args: options.args ?? [],
      cwd: options.cwd ?? null,
      env: options.env ?? null,
      mcp: options.mcp ?? null,
      protection: options.protection ?? null,
      agentCredential: options.agentCredential ?? false,
      protectedAgent: options.protectedAgent ?? null,
      ...(options.secrets?.length && { secrets: options.secrets }),
      onEvent,
    });
    // The host takes at most 1 MiB a write, so a longer one goes in pieces,
    // queued so no other write lands between them.
    let queue: Promise<unknown> = Promise.resolve();
    const write = (data: string, close: boolean) => {
      const written = queue.then(async () => {
        let at = 0;
        do {
          let end = Math.min(data.length, at + WRITE_UNITS);
          // A piece must not split a surrogate pair.
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1] ?? ""))
            end--;
          await invoke<void>("plugin_host_process_write", {
            id: owner.id,
            handle,
            data: data.slice(at, end),
            close: close && end === data.length,
          });
          at = end;
        } while (at < data.length);
      });
      queue = written.catch(() => undefined);
      return written;
    };
    const kill = () =>
      invoke<void>("plugin_host_process_kill", { id: owner.id, handle }).catch(
        // Already gone.
        () => undefined,
      );
    // The plugin's processes end with it, including one that started as it
    // was unloading.
    let release: () => void;
    try {
      release = this.ctx.effect(() => () => void kill(), `process ${id}`);
    } catch (error) {
      void kill();
      throw error;
    }
    void exited.then(() => release());
    return Object.freeze({
      write: (data: string) => write(data, false),
      end: (data = "") => write(data, true),
      kill,
      ...(options.agentCredential && {
        actAs: ({
          pubkey,
          relay,
        }: Readonly<{ pubkey: string; relay: string }>) =>
          invoke<void>("plugin_host_process_bind_agent", {
            id: owner.id,
            handle,
            pubkey,
            relay,
          }),
      }),
      toolCredential: async ({
        pubkey,
        relay,
      }: Readonly<{ pubkey: string; relay: string }>) =>
        (await invoke<string | null>("plugin_host_process_tool_credential", {
          id: owner.id,
          handle,
          pubkey,
          relay,
        })) ?? undefined,
      exited,
    });
  }

  // A method, not a field: `this.ctx` is then the calling plugin's scope.
  async serveMcp(
    handler: McpHandler,
    options?: HostMcpOptions,
  ): Promise<HostMcpServer> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("MCP servers require an installed desktop plugin");
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let handle: number | undefined;
    const answer = async (request: number, body: string) => {
      const send = (reply: string | null) =>
        invoke<void>("plugin_host_mcp_reply", {
          id: owner.id,
          handle,
          request,
          body: reply,
        });
      const reply = await answerMcp(handler, body);
      try {
        await send(reply === undefined ? null : JSON.stringify(reply));
      } catch (error) {
        // A reply that will not encode or is too large still answers the
        // request, so the agent is not left waiting. When the agent has
        // stopped waiting, this fails too.
        await send(JSON.stringify(mcpError(requestId(body), error))).catch(
          () => undefined,
        );
      }
    };
    const onEvent = new Channel<McpEvent>((event) => {
      if (event.type === "closed") stopped();
      // Only an agent given the token, which `serve` returns, can send one.
      else void answer(event.request, event.body);
    });
    const server = await invoke<{ handle: number; url: string; token: string }>(
      "plugin_host_mcp_serve",
      {
        id: owner.id,
        revision: owner.revision,
        onEvent,
        ...(options?.sharedSession ? { sharedSession: true } : {}),
      },
    );
    handle = server.handle;
    const close = () =>
      invoke<void>("plugin_host_mcp_close", {
        id: owner.id,
        handle: server.handle,
      }).catch(
        // Already stopped.
        () => undefined,
      );
    let release: () => void;
    try {
      release = this.ctx.effect(() => () => void close(), "MCP server");
    } catch (error) {
      void close();
      throw error;
    }
    void closed.then(() => release());
    return Object.freeze({
      url: server.url,
      headers: Object.freeze([
        Object.freeze({
          name: "Authorization",
          value: `Bearer ${server.token}`,
        }),
      ]),
      close,
      closed,
      authorize: (request: McpAuthorization) =>
        invoke<void>("plugin_host_mcp_authorize", {
          id: owner.id,
          revision: owner.revision,
          handle: server.handle,
          request,
        }).catch(rethrow),
    });
  }

  async denyMcpAuthorization(request: McpAuthorization) {
    const {
      durable_client: _client,
      approval: _approval,
      resume: _resume,
      ...callback
    } = request;
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("External authorization requires Buzz desktop");
    await invoke<void>("plugin_host_mcp_authorize", {
      id: owner.id,
      revision: owner.revision,
      handle: null,
      request: callback,
    }).catch(rethrow);
  }

  async externalMcpPairing(
    operation: "get" | "resume" | "revoke",
    request?: McpAuthorization,
  ): Promise<McpPairing | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("External approval requires Buzz desktop");
    return invoke<McpPairing | null>("plugin_host_mcp_pairing", {
      id: owner.id,
      revision: owner.revision,
      operation,
      request: request ?? null,
    }).catch(rethrow);
  }

  // Methods, not fields: `this.ctx` is then the calling plugin's scope.
  async readFile(
    path: string,
    { cwd }: Readonly<{ cwd?: string }> = {},
  ): Promise<Uint8Array> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Files require an installed desktop plugin");
    const data = await invoke<ArrayBuffer>("plugin_host_read_file", {
      id: owner.id,
      revision: owner.revision,
      path,
      cwd: cwd ?? null,
    }).catch(rethrow);
    return new Uint8Array(data);
  }

  async resolveDirectory(path: string): Promise<string> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Files require an installed desktop plugin");
    return invoke<string>("plugin_host_resolve_directory", {
      id: owner.id,
      revision: owner.revision,
      path,
    }).catch(rethrow);
  }

  async request(input: HostRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host requests require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_request", {
      id: owner.id,
      revision: owner.revision,
      request: input,
    }).catch(rethrow);
  }

  async requestOnce(
    input: HostRequest,
    { callId, isEligible }: HostRequestOnceOptions,
  ): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Protected requests require an installed desktop plugin");
    if (input.method !== "POST" || !UUID.test(callId))
      throw new Error(
        "Protected requests require POST and a canonical UUID callId",
      );
    return protectedCall(this.ctx, callId, isEligible, (once) =>
      invoke<HostResponse>("plugin_host_request", {
        id: owner.id,
        revision: owner.revision,
        request: input,
        once,
      }),
    );
  }

  async uploadBytesOnce(
    bytes: Uint8Array,
    input: HostByteUpload,
    { callId, isEligible }: HostRequestOnceOptions,
  ): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Protected requests require an installed desktop plugin");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > BYTE_LIMIT
    )
      throw new Error("Invalid upload bytes");
    // Pin both the bytes and metadata before waiting for authority or eligibility.
    const snapshot = new Uint8Array(bytes);
    const metadata = asciiJson({
      id: owner.id,
      revision: owner.revision,
      upload: input,
    });
    if (metadata.length > UPLOAD_METADATA_LIMIT - 512)
      throw new Error("Upload metadata is too large");
    return protectedCall(this.ctx, callId, isEligible, (once) =>
      invoke<HostResponse>("plugin_host_upload_bytes_once", snapshot, {
        headers: {
          // Append authority to the already pinned JSON object without reserializing input.
          "x-buzz-upload": `${metadata.slice(0, -1)},"once":${asciiJson(once)}}`,
        },
      }),
    );
  }

  async requestBytes(input: HostByteRequest): Promise<HostByteResponse> {
    const ctx = this.ctx;
    const owner = ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Byte requests require an installed desktop plugin");
    if (
      !Number.isInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > BYTE_LIMIT ||
      (input.timeoutMs !== undefined &&
        (!Number.isInteger(input.timeoutMs) ||
          input.timeoutMs < 1 ||
          input.timeoutMs > 30000))
    )
      throw new Error("Invalid byte request limits");
    const lifetime = byteLifetime(ctx);
    try {
      const frame = await invoke<unknown>("plugin_host_request_bytes", {
        id: owner.id,
        revision: owner.revision,
        request: input,
      }).catch(rethrow);
      lifetime.active();
      return decodeByteFrame(frame, input.maxBytes);
    } finally {
      lifetime.release();
    }
  }

  async saveBytes(
    bytes: Uint8Array,
    { sha256 }: Readonly<{ sha256: string }>,
  ): Promise<HostSavedBytes> {
    const ctx = this.ctx;
    const owner = ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Managed saves require an installed desktop plugin");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > BYTE_LIMIT ||
      !/^[0-9a-f]{64}$/.test(sha256)
    )
      throw new Error("Invalid managed save bytes or SHA256");
    const size = bytes.byteLength;
    const lifetime = byteLifetime(ctx);
    try {
      const saved = await invoke<HostSavedBytes>(
        "plugin_host_save_bytes",
        bytes,
        {
          headers: {
            "x-buzz-plugin-id": owner.id,
            "x-buzz-plugin-revision": owner.revision,
            "x-buzz-sha256": sha256,
          },
        },
      ).catch(rethrow);
      lifetime.active();
      if (
        !saved ||
        typeof saved.path !== "string" ||
        !saved.path ||
        saved.path.includes("\0") ||
        saved.size !== size ||
        saved.sha256 !== sha256 ||
        !Number.isSafeInteger(saved.expiresAt) ||
        saved.expiresAt <= 0
      )
        throw new Error("Invalid managed save result; outcome unknown");
      return saved;
    } finally {
      lifetime.release();
    }
  }

  async deleteManagedFile(path: string): Promise<void> {
    const ctx = this.ctx;
    const owner = ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Managed deletion requires an installed desktop plugin");
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw new Error("Invalid managed file path");
    const lifetime = byteLifetime(ctx);
    try {
      await invoke<void>("plugin_host_delete_managed_file", {
        id: owner.id,
        revision: owner.revision,
        path,
      }).catch(rethrow);
      lifetime.active();
    } finally {
      lifetime.release();
    }
  }

  async upload(input: HostUpload): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host uploads require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_upload", {
      id: owner.id,
      revision: owner.revision,
      upload: input,
    }).catch(rethrow);
  }
}

const UPLOAD_METADATA_LIMIT = 16 * 1024;
// HTTP IPC headers are ASCII; JSON escapes preserve Unicode field values.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function protectedCall<T>(
  ctx: Context,
  callId: string,
  isEligible: HostRequestOnceOptions["isEligible"],
  dispatch: (
    once: CallContext & { activation: string; callId: string },
  ) => Promise<T>,
): Promise<T> {
  if (!ctx.pluginOwner || !isTauri())
    throw new Error("Protected requests require an installed desktop plugin");
  if (!UUID.test(callId))
    throw new Error("Protected requests require a canonical UUID callId");
  let state = callContexts.get(ctx.fiber);
  const active = () => {
    if (ctx.fiber.uid === null || state?.disposed)
      throw new Error("Protected request owner is inactive; outcome unknown");
  };
  active();
  if (!state) {
    state = {
      context: invoke<CallContext>("plugin_host_call_context").catch(rethrow),
      activation: crypto.randomUUID(),
      disposed: false,
    };
    const lifetime = state;
    ctx.effect(
      () => () => {
        lifetime.disposed = true;
        if (callContexts.get(ctx.fiber) === lifetime)
          callContexts.delete(ctx.fiber);
      },
      "protected host calls",
    );
    callContexts.set(ctx.fiber, state);
  }
  // Cache failures too: refreshing native authority must never be an implicit retry.
  const context = await state.context;
  active();
  if (
    !context ||
    !UUID.test(context.boot) ||
    !Number.isSafeInteger(context.page) ||
    context.page < 0
  )
    throw new Error(
      "Compatible native protected-request context is unavailable",
    );
  if (isEligible !== undefined) {
    try {
      const eligible = isEligible();
      if (eligible !== true) {
        // Invalid async callbacks still fail closed; observe any rejection.
        void Promise.resolve(eligible).catch(() => {});
        throw new Error();
      }
    } catch {
      throw new Error("Protected request caller eligibility refused");
    }
    active();
  }
  const result = await dispatch({
    ...context,
    activation: state.activation,
    callId,
  }).catch(rethrow);
  active();
  return result;
}

const BYTE_LIMIT = 16 * 1024 * 1024;

/** Per-operation cooperative lifetime, deliberately independent of POST context. */
function byteLifetime(ctx: Context) {
  let disposed = false;
  const active = () => {
    if (disposed || ctx.fiber.uid === null)
      throw new Error("Byte operation owner is inactive; outcome unknown");
  };
  active();
  const release = ctx.effect(
    () => () => {
      disposed = true;
    },
    "host byte operation",
  );
  return { active, release };
}

function decodeByteFrame(frame: unknown, maxBytes: number): HostByteResponse {
  // Check transport before creating a view: fallback arrays must not be copied.
  if (
    !(frame instanceof ArrayBuffer) ||
    frame.byteLength < 4 ||
    frame.byteLength > 4 + 20 * 1024 + maxBytes
  )
    throw new Error("A compatible raw byte response is required");
  const length = new DataView(frame).getUint32(0, false);
  if (
    length < 1 ||
    length > 20 * 1024 ||
    length > frame.byteLength - 4 ||
    frame.byteLength - 4 - length > maxBytes
  )
    throw new Error("Invalid byte response framing");
  const metadata: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(frame, 4, length),
    ),
  );
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid byte response metadata");
  const { status, headers } = metadata as {
    status: number;
    headers: Record<string, unknown>;
  };
  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  )
    throw new Error("Invalid byte response status or headers");
  const entries = Object.entries(headers);
  const encoder = new TextEncoder();
  let headerBytes = 0;
  if (entries.length > 64) throw new Error("Too many byte response headers");
  for (const [name, value] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      name === "set-cookie" ||
      typeof value !== "string" ||
      /[\0\r\n]/.test(value)
    )
      throw new Error("Invalid byte response header");
    headerBytes +=
      encoder.encode(name).byteLength + encoder.encode(value).byteLength;
  }
  if (headerBytes > 16 * 1024)
    throw new Error("Byte response headers are too large");
  return {
    status,
    headers: headers as Record<string, string>,
    body: new Uint8Array(frame, 4 + length),
  };
}

/** A native command's failure, which arrives as its message, as an Error. */
function rethrow(error: unknown): never {
  throw typeof error === "string" ? new Error(error) : error;
}

/** The reply to one HTTP body, which carries one message: MCP has no batches
 * since its 2025-06-18 revision. A handler that throws answers a request with
 * an internal error. */
export async function answerMcp(
  handler: McpHandler,
  body: string,
): Promise<unknown> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
  }
  try {
    return await handler(message);
  } catch (error) {
    const id = (message as { id?: unknown } | null)?.id;
    return id === undefined || id === null ? undefined : mcpError(id, error);
  }
}

/** The id of the request in `body`, or `null` when it has none. */
function requestId(body: string): unknown {
  try {
    return (JSON.parse(body) as { id?: unknown } | null)?.id ?? null;
  } catch {
    return null;
  }
}

function mcpError(id: unknown, error: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
