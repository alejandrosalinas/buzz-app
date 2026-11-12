import { EvidenceTransfer } from "./evidence";
import type { HostMcpServer, McpHandler } from "../host/service";
import {
  ALL_PHASES,
  ProtectionDenied,
  type AgentProtection,
  type ProtectionAction,
} from "./service";

export function protectionEnvironment(protection: AgentProtection) {
  const phases = protection.phases ?? ALL_PHASES;
  return {
    BUZZ_SECURITY_CONTEXT: phases.context ? "1" : "0",
    BUZZ_SECURITY_TOOL: phases.tool ? "1" : "0",
    BUZZ_SECURITY_TOOL_RESULT: phases["tool-result"] ? "1" : "0",
  };
}

/** Ordered evidence from one authenticated worker. Uploaded content cannot
 * choose policy, reviewer or requesting identity. */
export function protectionChannel(protection: AgentProtection) {
  protection.assertAvailable();
  const lifetime = new AbortController();
  let pending = 0;
  const transfers = new Map<
    string,
    {
      stream: EvidenceTransfer;
      abort: AbortController;
      result: Promise<boolean>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const drop = (id: string, error: unknown) => {
    const transfer = transfers.get(id);
    if (!transfer) return;
    transfers.delete(id);
    clearTimeout(transfer.timer);
    transfer.abort.abort();
    transfer.stream.fail(error);
  };
  lifetime.signal.addEventListener(
    "abort",
    () => {
      for (const id of transfers.keys())
        drop(id, new Error("Security bridge closed"));
    },
    { once: true },
  );
  // Numbers checks as they start, so a turn can tell its own from earlier ones.
  let started = 0;
  // Why the provider denied a session's model input, and in which check,
  // until its runtime takes it to tell people why the turn stopped. One nobody
  // takes ages out, as at most as many as can be checked at once are kept.
  const explained = new Map<string, { reason: string; check: number }>();
  const handler: McpHandler = async (message) => {
    const call = message as {
      id?: string;
      method?: string;
      params?: ProtectionAction;
    };
    if (call?.method === "initialize")
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "buzz-security", version: "2" },
        },
      };
    if (call?.method === "notifications/initialized") return undefined;
    if (call?.method === "ping")
      return { jsonrpc: "2.0", id: call.id, result: {} };
    if (call?.method?.startsWith("buzz/security/evidence/")) {
      if (
        typeof call.id !== "string" ||
        !call.params ||
        typeof call.params !== "object"
      )
        throw new Error("Invalid evidence request");
      const params = call.params as unknown as Record<string, unknown>;
      const reply = (result: unknown) => ({
        jsonrpc: "2.0",
        id: call.id,
        result,
      });
      if (call.method === "buzz/security/evidence/begin") {
        if (
          pending >= 16 ||
          transfers.size >= 16 ||
          !["kind,session", "id,kind,session"].includes(
            Object.keys(params).sort().join(),
          ) ||
          (params.id !== undefined &&
            (typeof params.id !== "string" ||
              !/^[a-f0-9-]{36}$/.test(params.id) ||
              transfers.has(params.id))) ||
          !["context", "tool", "tool-result"].includes(String(params.kind)) ||
          typeof params.session !== "string" ||
          !params.session ||
          params.session.length > 4096
        )
          throw new Error("Invalid evidence admission");
        protection.assertAvailable();
        const action = { kind: params.kind, session: params.session } as Omit<
          ProtectionAction,
          "content"
        >;
        // Disabled phases exchange no evidence but still require the current lease.
        if (protection.phases?.[action.kind] === false)
          return reply({ skipped: true });
        const id =
          typeof params.id === "string" ? params.id : crypto.randomUUID();
        const stream = new EvidenceTransfer();
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, lifetime.signal]);
        const check = ++started;
        pending++;
        // `checkEvidence` denies unless the provider consumed all of it.
        const result = protection
          .checkEvidence(action, stream, signal)
          .then(
            () => {
              // A settled check takes no more chunks.
              stream.fail(new Error("Evidence check ended"));
              return true;
            },
            (error) => {
              stream.fail(error);
              if (
                action.kind === "context" &&
                error instanceof ProtectionDenied &&
                error.reason &&
                (explained.get(action.session)?.check ?? 0) < check
              ) {
                explained.delete(action.session);
                explained.set(action.session, { reason: error.reason, check });
                if (explained.size > 16)
                  explained.delete(explained.keys().next().value ?? "");
              }
              return false;
            },
          )
          .finally(() => {
            pending--;
          });
        const timer = setTimeout(
          () => drop(id, new Error("Evidence transfer expired")),
          310_000,
        );
        transfers.set(id, { stream, abort, result, timer });
        return reply({ id, chunkBytes: stream.chunkBytes });
      }
      const id = typeof params.id === "string" ? params.id : "";
      const transfer = transfers.get(id);
      if (!transfer) throw new Error("Unknown or expired evidence transfer");
      try {
        protection.assertAvailable();
        if (call.method === "buzz/security/evidence/chunk") {
          if (
            Object.keys(params).sort().join() !== "data,id,sequence" ||
            typeof params.data !== "string" ||
            params.data.length >
              4 * Math.ceil(transfer.stream.chunkBytes / 3) ||
            !Number.isSafeInteger(params.sequence) ||
            Number(params.sequence) < 0
          )
            throw new Error("Invalid evidence chunk");
          const bytes = Uint8Array.from(atob(params.data), (char) =>
            char.charCodeAt(0),
          );
          await transfer.stream.push(Number(params.sequence), bytes);
          return reply({ accepted: true });
        }
        if (call.method === "buzz/security/evidence/finish") {
          if (
            Object.keys(params).sort().join() !== "bytes,id,sequence" ||
            !Number.isSafeInteger(params.sequence) ||
            !Number.isSafeInteger(params.bytes)
          )
            throw new Error("Invalid evidence completion");
          transfer.stream.finish(Number(params.sequence), Number(params.bytes));
          const allowed = await transfer.result;
          protection.assertAvailable();
          transfers.delete(id);
          clearTimeout(transfer.timer);
          return reply({ allowed });
        }
        if (
          call.method === "buzz/security/evidence/cancel" &&
          Object.keys(params).join() === "id"
        ) {
          drop(id, new Error("Evidence transfer cancelled"));
          return reply({ allowed: false });
        }
        throw new Error("Invalid evidence operation");
      } catch (error) {
        drop(id, error);
        throw error;
      }
    }
    throw new Error("Invalid native security request");
  };
  return {
    handler,
    close() {
      lifetime.abort();
    },
    /** Starts a turn of `session`. What it returns takes the reason given for
     * denying model input in a check started since, if any. */
    explainer(session: string) {
      const since = started;
      return () => {
        const denial = explained.get(session);
        explained.delete(session);
        return denial && denial.check > since ? denial.reason : undefined;
      };
    },
  };
}

export async function nativeProtectionBridge(
  serve: (handler: McpHandler) => Promise<HostMcpServer>,
  protection: AgentProtection,
) {
  const channel = protectionChannel(protection);
  const server = await serve(channel.handler);
  void server.closed.then(() => channel.close());
  const authorization = server.headers.find(
    (header) => header.name.toLowerCase() === "authorization",
  )?.value;
  if (!authorization?.startsWith("Bearer ")) {
    channel.close();
    await server.close();
    throw new Error("The native security bridge has no authentication");
  }
  return {
    env: {
      ...protectionEnvironment(protection),
      BUZZ_SECURITY_URL: server.url,
      BUZZ_SECURITY_TOKEN: authorization.slice(7),
    },
    explainer: channel.explainer,
    async close() {
      channel.close();
      await server.close();
    },
  };
}
