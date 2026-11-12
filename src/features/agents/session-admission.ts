import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { JsonValue } from "../navigation/targets";
import type { RelayEvent } from "../relay/events";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export type AgentSessionSource = Readonly<{
  channelId: string;
  root?: string;
}>;

export type AgentSessionAdmission = Readonly<{
  agent: AgentKey;
  owner: string;
  harness: string;
  source: AgentSessionSource;
  /** The native conversation scope. It can include several source threads. */
  conversation: AgentSessionSource;
  invocationId: string;
  event?: RelayEvent;
  sessionKey: string;
  intent: "new" | "existing";
  resumed: boolean;
  /** The host adopts a source lifetime with no saved logical association. */
  adopted: boolean;
  association?: JsonValue;
  signal: AbortSignal;
}>;

export type AgentSessionAssociation = Readonly<{
  sessionKey: string;
  router: string;
  association: JsonValue;
}>;

type AdmissionRequest = Omit<
  AgentSessionAdmission,
  "sessionKey" | "intent" | "association" | "adopted"
>;
export type AgentSessionRouter = Readonly<{
  id: string;
  /** Opens local keyed storage. This must not wait for a sidebar or relay. */
  ready(): Promise<void>;
  matches(
    input: Pick<
      AgentSessionAdmission,
      "agent" | "owner" | "harness" | "source"
    >,
  ): boolean;
  /** Saves the local association before returning. Undefined leaves the run unchanged. */
  prepare(input: AgentSessionAdmission): Promise<
    | Readonly<{
        association: JsonValue;
        context?: string;
      }>
    | undefined
  >;
}>;

export const SESSION_ADMISSION_PREFIX = "buzz.agents.session-admission.v1:";
type Pointer = Readonly<{
  sessionKey: string;
  adopted?: true;
  resetting?: true;
}>;
type Saved = AgentSessionAssociation &
  Readonly<{
    context?: string;
    contextAcknowledged?: true;
  }>;

function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The saved agent session association is invalid");
  }
}

const keyFor = (agent: AgentKey, harness: string, source: AgentSessionSource) =>
  SESSION_ADMISSION_PREFIX +
  JSON.stringify([
    "source",
    agent,
    harness,
    source.channelId,
    source.root ?? null,
  ]);
const savedKey = (sessionKey: string) =>
  SESSION_ADMISSION_PREFIX + JSON.stringify(["session", sessionKey]);

/** Logical lifetimes survive harness reconnects. Each invocation keeps its own key. */
export function createSessionAdmissions(root: Context, storage: AgentStore) {
  const routers = createContributions<AgentSessionRouter>(root);
  const pending = new Map<string, Promise<Saved | undefined>>();
  let stopped = false;
  root.effect(() => () => {
    stopped = true;
  });
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (stopped) throw new Error("Agent session admission is stopped");
  };
  return {
    register(ctx: Context, router: AgentSessionRouter) {
      if (
        !ctx.pluginOwner ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(router.id) ||
        typeof router.ready !== "function" ||
        typeof router.matches !== "function" ||
        typeof router.prepare !== "function"
      )
        throw new Error(
          "A session router needs an id, ready, matches and prepare",
        );
      routers.register(ctx, router);
    },
    async prepare(input: AdmissionRequest) {
      check(input.signal);
      const pointerKey = keyFor(input.agent, input.harness, input.conversation);
      if (!routers.snapshot().length && storage.get(pointerKey) === null)
        return;
      const candidates = routers.snapshot();
      await Promise.all(candidates.map((router) => router.ready()));
      check(input.signal);
      const invocationKey =
        SESSION_ADMISSION_PREFIX +
        JSON.stringify([
          "invocation",
          input.agent,
          input.harness,
          input.invocationId,
        ]);
      const pointerText = await storage.read(pointerKey);
      const existing =
        pointerText === null ? undefined : parse<Pointer>(pointerText);
      if (existing) {
        if (!existing.sessionKey || existing.resetting)
          throw new Error(
            "The agent session reset is incomplete. Use New again before sending a message.",
          );
        const receipt = await storage.read(invocationKey);
        if (receipt !== null && parse<string>(receipt) !== existing.sessionKey)
          throw new Error(
            "This request belongs to an earlier session. Send a new message to continue.",
          );
      }
      const savedText = existing
        ? await storage.read(savedKey(existing.sessionKey))
        : null;
      const prior = savedText === null ? undefined : parse<Saved>(savedText);
      const matches = candidates.filter((router) =>
        prior ? router.key === prior.router : router.matches(input),
      );
      if (matches.length > 1)
        throw new Error("More than one plugin routes this agent session");
      const router = matches[0];
      if (!router && !prior) return;
      const firstKey = JSON.stringify([
        input.agent,
        input.harness,
        input.invocationId,
      ]);
      const pointer = parse<Pointer>(
        await storage.add(
          pointerKey,
          JSON.stringify({
            sessionKey: firstKey,
            adopted: true,
          }),
        ),
      );
      if (!pointer.sessionKey || pointer.resetting)
        throw new Error(
          "The agent session reset is incomplete. Use New again before sending a message.",
        );
      const sessionKey = parse<string>(
        await storage.add(invocationKey, JSON.stringify(pointer.sessionKey)),
      );
      if (
        typeof sessionKey !== "string" ||
        !sessionKey ||
        sessionKey.length > 1024
      )
        throw new Error("The saved agent session key is invalid");
      if (sessionKey !== pointer.sessionKey)
        throw new Error(
          "This request belongs to an earlier session. Send a new message to continue.",
        );
      const prepare = async () => {
        const text = await storage.read(savedKey(sessionKey));
        const prior = text === null ? undefined : parse<Saved>(text);
        if (
          prior &&
          (prior.sessionKey !== sessionKey ||
            prior.router !== (router?.key ?? prior.router))
        )
          throw new Error("The agent session belongs to another router");
        check(input.signal);
        if (!router) {
          if (!prior)
            throw new Error("The agent session router is unavailable");
          return prior;
        }
        const result = await router.prepare({
          ...input,
          sessionKey,
          intent: prior || pointer.adopted ? "existing" : "new",
          adopted: !prior && !!pointer.adopted,
          ...(prior ? { association: structuredClone(prior.association) } : {}),
        });
        check(input.signal);
        if (!routers.snapshot().includes(router))
          throw new Error("The agent session router changed");
        if (!result) {
          if (prior)
            throw new Error(
              "The plugin cannot restore this agent session association",
            );
          return;
        }
        if (result.context !== undefined && typeof result.context !== "string")
          throw new Error("Agent session context must be text");
        const association = JSON.stringify(result.association);
        if (
          association === undefined ||
          (prior && association !== JSON.stringify(prior.association))
        )
          throw new Error("The agent session association cannot change");
        if (prior) return prior;
        const saved: Saved = {
          sessionKey,
          router: router.key,
          association: result.association,
          ...(result.context ? { context: result.context } : {}),
        };
        return parse<Saved>(
          await storage.add(savedKey(sessionKey), JSON.stringify(saved)),
        );
      };
      const active = pending.get(sessionKey) ?? prepare();
      pending.set(sessionKey, active);
      let saved: Saved | undefined;
      try {
        saved = await active;
      } finally {
        if (pending.get(sessionKey) === active) pending.delete(sessionKey);
      }
      check(input.signal);
      if (!saved) return;
      let acknowledged = !!saved.contextAcknowledged;
      return Object.freeze({
        acknowledged: () => {
          if (acknowledged || !saved?.context) return;
          acknowledged = true;
          void storage
            .set(
              savedKey(saved.sessionKey),
              JSON.stringify({ ...saved, contextAcknowledged: true }),
            )
            .catch((error) =>
              console.error(
                `Agent ${input.agent} session ${sessionKey} context acknowledgement was not saved`,
                error,
              ),
            );
        },
        session: Object.freeze({
          sessionKey: saved.sessionKey,
          router: saved.router,
          association: structuredClone(saved.association),
        }),
        ...(!saved.contextAcknowledged && saved.context
          ? { context: saved.context }
          : {}),
      });
    },
    async reset(
      agent: AgentKey,
      harness: string,
      source: AgentSessionSource,
      run: () => Promise<void>,
    ) {
      const key = keyFor(agent, harness, source);
      if (!routers.snapshot().length && storage.get(key) === null) return run();
      const text = await storage.read(key);
      if (text === null) return run();
      const prior = parse<Pointer>(text);
      const sessionKey = prior.resetting
        ? prior.sessionKey
        : crypto.randomUUID();
      await storage.set(key, JSON.stringify({ sessionKey, resetting: true }));
      await run();
      await storage.set(key, JSON.stringify({ sessionKey }));
    },
  };
}
