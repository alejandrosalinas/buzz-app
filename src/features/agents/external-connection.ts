import type {
  HostMcpServer,
  McpAuthorization,
  McpPairing,
} from "../host/service";
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
    version: 1 | 2;
    client: string;
    scope: readonly ExternalScope[];
    code_challenge_method: "S256";
    resume?: Readonly<{ id: string; counter: number; proof: string }>;
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
      [...url.searchParams.keys()].some(
        (key) => ![...keys, "pairing_id", "counter", "proof"].includes(key),
      ) ||
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
      !["1", "2"].includes(value.version ?? "") ||
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
    const resumed = ["pairing_id", "counter", "proof"].some((key) =>
      url.searchParams.has(key),
    );
    if (
      resumed &&
      (value.version !== "2" ||
        !opaque.test(value.pairing_id ?? "") ||
        !opaque.test(value.proof ?? "") ||
        !/^[1-9][0-9]{0,14}$/.test(value.counter ?? "") ||
        ["pairing_id", "counter", "proof"].some(
          (key) => url.searchParams.getAll(key).length !== 1,
        ))
    )
      return null;
    return {
      version: Number(value.version) as 1 | 2,
      ...(resumed
        ? {
            resume: {
              id: value.pairing_id as string,
              counter: Number(value.counter),
              proof: value.proof as string,
            },
          }
        : {}),
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
  pairing?: McpPairing | undefined;
}>;
type Host = {
  connect: Agents["connectExternal"];
  deny(request: McpAuthorization): Promise<void>;
  pairing?(
    operation: "get" | "resume" | "revoke",
    request?: McpAuthorization,
  ): Promise<McpPairing | null>;
};
const nativeRequest = ({
  callback,
  state,
  code_challenge,
  version,
  client,
  resume,
}: ExternalAuthorization) => ({
  callback,
  state,
  code_challenge,
  ...(version === 2 ? { durable_client: client } : {}),
  ...(resume ? { resume } : {}),
});

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
  let generation = 0;
  let resuming: { request: ExternalAuthorization; viewer: string } | undefined;
  const closeSession = async () => {
    generation++;
    controller?.abort();
    controller = undefined;
    const previous = server;
    server = undefined;
    update({ ...state, grant: undefined });
    await previous?.close();
  };
  const revoke = async () => {
    generation++;
    resuming = undefined;
    try {
      if (state.pairing && !host?.pairing)
        throw new Error("Saved approval is unavailable.");
      await host?.pairing?.("revoke");
      update({ ...state, pairing: undefined });
      await closeSession();
    } catch {
      update({
        ...state,
        error: "Cannot revoke the saved approval. Retry in Buzz.",
      });
    }
  };
  const resume = async () => {
    const incoming = resuming,
      bound = host;
    if (!incoming || !bound?.pairing) return;
    resuming = undefined;
    let attemptGeneration = generation;
    let candidate: HostMcpServer | undefined;
    let candidateController: AbortController | undefined;
    let connected = false;
    try {
      const pairing = await bound.pairing("resume", {
        callback: incoming.request.callback,
        state: incoming.request.state,
        code_challenge: incoming.request.code_challenge,
        resume: incoming.request.resume as NonNullable<
          ExternalAuthorization["resume"]
        >,
      });
      if (generation !== attemptGeneration || host !== bound) return;
      if (
        !pairing ||
        pairing.approval.viewer !== incoming.viewer ||
        pairing.approval.client !== incoming.request.client ||
        JSON.stringify(pairing.approval.scopes) !==
          JSON.stringify(incoming.request.scope)
      )
        throw new Error("The saved approval does not match this request.");
      attemptGeneration = ++generation;
      update({
        ...state,
        pairing,
        ...(!state.grant
          ? {
              grant: {
                client: pairing.approval.client,
                agent: pairing.approval.agent,
                phase: "ended" as const,
              },
            }
          : {}),
      });
      const attempt = new AbortController();
      candidateController = attempt;
      const result = await bound.connect(
        pairing.approval.agent,
        attempt.signal,
        () => {
          connected = true;
          if (server === candidate && state.grant)
            update({ ...state, grant: { ...state.grant, phase: "connected" } });
        },
        pairing.approval.scopes,
      );
      candidate = result;
      if (generation !== attemptGeneration || host !== bound) {
        attempt.abort();
        await result.close();
        return;
      }
      if (!result.authorize) {
        await result.close();
        throw new Error("External authorization is unavailable.");
      }
      await result.authorize({
        ...nativeRequest(incoming.request),
        approval: pairing.approval,
      });
      if (generation !== attemptGeneration || host !== bound) {
        attempt.abort();
        await result.close();
        return;
      }
      const previous = server,
        previousController = controller;
      controller = attempt;
      server = result;
      previousController?.abort();
      await previous?.close();
      if (generation !== attemptGeneration || host !== bound) return;
      const grant: Grant = {
        client: pairing.approval.client,
        agent: pairing.approval.agent,
        phase: connected ? "connected" : "waiting",
      };
      update({ ...state, pairing, grant, error: undefined });
      void result.closed.then(() => {
        if (server !== result) return;
        attempt.abort();
        server = undefined;
        update({ ...state, grant: { ...grant, phase: "ended" } });
      });
    } catch {
      if (generation === attemptGeneration)
        update({
          ...state,
          error:
            "Cannot restore this connection. Check the saved approval and selected community.",
        });
    } finally {
      if (candidate && candidate !== server) {
        candidateController?.abort();
        await candidate.close();
      }
    }
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
      if (next.pairing) {
        const loadedGeneration = generation;
        void next
          .pairing("get")
          .then((pairing) => {
            if (host !== next || generation !== loadedGeneration) return;
            update({
              ...state,
              pairing: pairing ?? undefined,
              ...(pairing && !state.grant
                ? {
                    grant: {
                      client: pairing.approval.client,
                      agent: pairing.approval.agent,
                      phase: "ended" as const,
                    },
                  }
                : {}),
            });
          })
          .catch(() => {
            if (host === next)
              update({
                ...state,
                error: "Cannot read saved external approval.",
              });
          });
      }
      void resume();
      return () => {
        if (host !== next) return;
        void deny().catch(() => {});
        host = undefined;
        void closeSession();
        update({ available: false });
      };
    },
    open(request: ExternalAuthorization, viewer: string) {
      if (request.resume) {
        if (resuming?.request.state === request.state) return;
        resuming = { request, viewer };
        void resume();
        return;
      }
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
      const closing = closeSession();
      const attemptGeneration = generation;
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
        if (controller !== attempt || generation !== attemptGeneration) return;
        await bound.pairing?.("revoke");
        if (controller !== attempt || generation !== attemptGeneration) return;
        update({ ...state, pairing: undefined });
        const result = await bound.connect(
          agent,
          attempt.signal,
          () => {
            if (controller === attempt && generation === attemptGeneration)
              update({ ...state, grant: { ...grant, phase: "connected" } });
          },
          pending.request.scope,
        );
        if (controller !== attempt || generation !== attemptGeneration) {
          await result.close();
          return;
        }
        server = result;
        void result.closed.then(() => {
          if (server !== result) return;
          attempt.abort();
          server = undefined;
          update({ ...state, grant: { ...grant, phase: "ended" } });
        });
        if (!result.authorize)
          throw new Error("This Buzz host cannot authorize external apps.");
        try {
          await result.authorize(nativeRequest(pending.request));
        } finally {
          if (pending.request.version === 2 && bound.pairing) {
            const pairing = await bound.pairing("get");
            if (controller === attempt && generation === attemptGeneration)
              update({ ...state, pairing: pairing ?? undefined });
          }
        }
        if (
          controller === attempt &&
          generation === attemptGeneration &&
          state.grant?.phase === "starting"
        )
          update({ ...state, grant: { ...grant, phase: "waiting" } });
      } catch {
        if (controller !== attempt || generation !== attemptGeneration) return;
        attempt.abort();
        const closing = server;
        server = undefined;
        await closing?.close();
        if (controller !== attempt || generation !== attemptGeneration) return;
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
