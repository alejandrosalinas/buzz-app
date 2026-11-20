import type { SessionControls } from "./session-control";
import type { AgentKey } from "../agents/membership";
import type { AgentStore } from "../agents/store";

export type SessionScope = "thread" | "channel" | "community";

// Channel ids cannot contain this reserved prefix. Agent membership supplies
// the community boundary; this key never names a relay channel.
export const COMMUNITY_SESSION = "@community";

export const sessionScope = (value: unknown): SessionScope =>
  value === "community" || value === "channel" ? value : "thread";

/** Selects harness identity without changing the request's reply destination. */
export function scopedSessionKey(
  scope: SessionScope,
  channelId: string,
  root?: string,
) {
  return scope === "community"
    ? COMMUNITY_SESSION
    : scope === "thread" && root
      ? `${channelId}/${root}`
      : channelId;
}

export const scopeOfSession = (key: string, channelId: string): SessionScope =>
  key === COMMUNITY_SESSION
    ? "community"
    : key === channelId
      ? "channel"
      : "thread";

const sourceKey = (agent: AgentKey) =>
  `buzz.agents.community-session-source.v1:${agent}`;

/** Navigation metadata only. It never selects a session or grants access. */
export async function rememberCommunitySource(
  storage: AgentStore,
  agent: AgentKey,
  key: string,
  channelId: string,
) {
  if (key === COMMUNITY_SESSION)
    await storage
      .set(sourceKey(agent), channelId)
      .catch((error: unknown) =>
        console.warn("Community session source could not be saved", error),
      );
}

export function sessionSource(
  storage: AgentStore,
  agent: AgentKey,
  key: string,
): { channelId: string; root?: string; community?: true } {
  if (key === COMMUNITY_SESSION)
    return {
      channelId: storage.get(sourceKey(agent)) ?? "",
      community: true as const,
    };
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
}

type Policy = {
  solo: boolean;
  handed: Promise<unknown>;
  settled: Promise<unknown>;
  cancel(): void;
};

/** Independent wakes keep their cancellation owner but join the ownership drain. */
export function standaloneTurn<T>(
  policies: Map<string, Policy>,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
  changed: () => void = () => {},
) {
  const shared = policies.get(COMMUNITY_SESSION);
  const key = `once:${crypto.randomUUID()}`;
  const cancel = new AbortController();
  const lifetime = AbortSignal.any([signal, cancel.signal]);
  const done = Promise.resolve().then(async () => {
    await shared?.settled;
    if (shared) lifetime.throwIfAborted();
    return run(lifetime);
  });
  const policy = {
    solo: false,
    handed: done,
    settled: done.catch(() => undefined),
    cancel: () => cancel.abort(),
  };
  policies.set(key, policy);
  void policy.settled.then(() => {
    policies.delete(key);
    changed();
  });
  return (
    shared ? abortable(shared.settled, lifetime) : Promise.resolve()
  ).then(() => done);
}

/** An unaddressed wake joins the shared lifetime with no tool destination.
 * Its tools cannot replace a conversation's defaults until that turn ends. */
export async function communityTurn<T>(
  policies: Map<string, Policy>,
  signal: AbortSignal,
  controls: SessionControls,
  control: string,
  run: (signal: AbortSignal) => Promise<T>,
  changed: () => void = () => {},
) {
  const prior = [...policies.values()];
  const shared = policies.get(COMMUNITY_SESSION);
  const cancel = new AbortController();
  const lifetime = AbortSignal.any([signal, cancel.signal]);
  const done = Promise.resolve().then(async () => {
    await Promise.all(prior.map((policy) => policy.settled));
    lifetime.throwIfAborted();
    let result!: T;
    await controls.deliver(control, async () => {
      lifetime.throwIfAborted();
      result = await run(lifetime);
    }).done;
    return result;
  });
  const policy = {
    solo: false,
    handed: done,
    settled: done.catch(() => undefined),
    cancel: () => {
      shared?.cancel();
      cancel.abort();
    },
  };
  policies.set(COMMUNITY_SESSION, policy);
  // Keep the ordering barrier until prior work drains, even when this caller
  // has already left because its deadline expired.
  void policy.settled.then(() => {
    if (policies.get(COMMUNITY_SESSION) !== policy) return;
    policies.delete(COMMUNITY_SESSION);
    changed();
  });
  return abortable(done, lifetime);
}

/** Release the caller on cancellation; the work retains its ordering barrier. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
