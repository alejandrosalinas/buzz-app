import type { HostMcpServer, McpAuthorization } from "../host/service";
import type { AgentKey } from "./membership";
import type { Agents } from "./service";
import { communityDestination } from "../communities/destination";

export function externalMcpEnabled(community: string | null) {
  if (!community) return false;
  try {
    return (import.meta.env.VITE_BUZZ_EXTERNAL_MCP_COMMUNITIES ?? "")
      .split(" ")
      .includes(communityDestination(community).url);
  } catch {
    return false;
  }
}

export type ExternalScope = "read" | "post" | "create";
export type ExternalAuthorization = McpAuthorization &
  Readonly<{
    version: 1;
    client: string;
    scope: readonly ExternalScope[];
    code_challenge_method: "S256";
  }>;
const opaque = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const keys = [
  "version",
  "client",
  "callback",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
];
export function parseExternalAuthorization(
  raw: string,
): ExternalAuthorization | null {
  try {
    if (raw.length > 4096 || !/^buzz:\/\/mcp-authorize\/?\?/.test(raw))
      return null;
    const url = new URL(raw);
    if (
      url.hostname !== "mcp-authorize" ||
      !["", "/"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1)
    )
      return null;
    const value = Object.fromEntries(url.searchParams);
    const callback =
      /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/buzz\/authorize$/.exec(
        value.callback ?? "",
      );
    const scope = value.scope?.split(" ") ?? [];
    if (
      value.version !== "1" ||
      !value.client?.trim() ||
      value.client.length > 80 ||
      [...value.client].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      !callback ||
      Number(callback[1]) < 1024 ||
      Number(callback[1]) > 65535 ||
      !opaque.test(value.state ?? "") ||
      !opaque.test(value.code_challenge ?? "") ||
      value.code_challenge_method !== "S256" ||
      !scope.length ||
      new Set(scope).size !== scope.length ||
      scope.some(
        (item) => item !== "read" && item !== "post" && item !== "create",
      )
    )
      return null;
    return {
      version: 1,
      client: value.client,
      callback: value.callback as string,
      state: value.state as string,
      code_challenge: value.code_challenge as string,
      code_challenge_method: "S256",
      scope: scope as ExternalScope[],
    };
  } catch {
    return null;
  }
}
type Pending = Readonly<{
  request: ExternalAuthorization;
  viewer: string;
  expires: number;
}>;
type Grant = Readonly<{
  client: string;
  agent: AgentKey;
  phase: "starting" | "waiting" | "connected" | "ended";
}>;
type State = Readonly<{
  pending?: Pending | undefined;
  grant?: Grant | undefined;
  available: boolean;
  error?: string | undefined;
}>;
type Host = {
  connect: Agents["connectExternal"];
  deny(request: McpAuthorization): Promise<void>;
};
const nativeRequest = ({
  callback,
  state,
  code_challenge,
}: ExternalAuthorization) => ({ callback, state, code_challenge });

/** The app owns consent; the bundled Agents plugin owns the native MCP permission. */
export function createExternalApps() {
  let state: State = { available: false };
  let host: Host | undefined;
  let controller: AbortController | undefined;
  let server: HostMcpServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const clearPending = () => {
    clearTimeout(timer);
    timer = undefined;
    update({ ...state, pending: undefined });
  };
  const deny = async () => {
    const pending = state.pending;
    clearPending();
    if (pending && host) await host.deny(nativeRequest(pending.request));
  };
  const revoke = async () => {
    controller?.abort();
    controller = undefined;
    const previous = server;
    server = undefined;
    update({ ...state, grant: undefined });
    await previous?.close();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind(next: Host) {
      host = next;
      update({ ...state, available: true });
      return () => {
        if (host !== next) return;
        void deny().catch(() => {});
        host = undefined;
        void revoke();
        update({ available: false });
      };
    },
    open(request: ExternalAuthorization, viewer: string) {
      if (state.pending?.request.state === request.state) return;
      void deny().catch(() => {});
      const pending = { request, viewer, expires: Date.now() + 300_000 };
      update({ ...state, pending, error: undefined });
      timer = setTimeout(() => {
        if (state.pending === pending) void deny().catch(() => {});
      }, 300_000);
    },
    deny,
    revoke,
    clearError() {
      update({ ...state, error: undefined });
    },
    async approve(agent: AgentKey) {
      const pending = state.pending,
        bound = host;
      if (!pending || !bound || pending.expires <= Date.now()) {
        update({
          ...state,
          error:
            "This request has ended. Start setup again in the external app.",
        });
        return;
      }
      clearPending();
      const closing = revoke();
      const attempt = new AbortController();
      controller = attempt;
      const grant: Grant = {
        client: pending.request.client,
        agent,
        phase: "starting",
      };
      update({ ...state, grant, error: undefined });
      try {
        await closing;
        if (controller !== attempt) return;
        const result = await bound.connect(
          agent,
          attempt.signal,
          () => {
            if (controller === attempt)
              update({ ...state, grant: { ...grant, phase: "connected" } });
          },
          pending.request.scope,
        );
        if (controller !== attempt) {
          await result.close();
          return;
        }
        server = result;
        void result.closed.then(() => {
          if (controller !== attempt) return;
          attempt.abort();
          server = undefined;
          update({ ...state, grant: { ...grant, phase: "ended" } });
        });
        if (!result.authorize)
          throw new Error("This Buzz host cannot authorize external apps.");
        await result.authorize(nativeRequest(pending.request));
        if (controller === attempt && state.grant?.phase === "starting")
          update({ ...state, grant: { ...grant, phase: "waiting" } });
      } catch {
        if (controller !== attempt) return;
        attempt.abort();
        const closing = server;
        server = undefined;
        await closing?.close();
        if (controller !== attempt) return;
        controller = undefined;
        update({
          ...state,
          grant: { ...grant, phase: "ended" },
          error: "Authorization failed. Start setup again in the external app.",
        });
      }
    },
  };
}
export type ExternalApps = ReturnType<typeof createExternalApps>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    externalApps: ExternalApps;
  }
}
