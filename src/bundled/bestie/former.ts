import type { Agent, Agents } from "../../features/agents/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { FEATURES, featureState, memory } from "./features";
import { privateChannels } from "./PrivateChannels";
import {
  cannotEdit,
  type FeatureAgents,
  featurePresent,
  instructionsOf,
  saveFeature,
} from "./save";
import { inCommunity, savedBestie } from "./saved";
import { readView, writeView } from "../../shared/view-state";

type ReconcileAgents = FeatureAgents & Pick<Agents, "snapshot" | "subscribe">;

const FORMER = "bestie:former";
/** The agents this device has seen as the community's Bestie, newest last. */
function seenAsBestie(scope: string) {
  const value = readView<unknown>(scope, FORMER, []);
  return Array.isArray(value)
    ? value.filter((pubkey): pubkey is string => typeof pubkey === "string")
    : [];
}
function rememberBestie(scope: string, pubkey: string) {
  const seen = seenAsBestie(scope);
  if (!seen.includes(pubkey))
    writeView(scope, FORMER, [...seen, pubkey].slice(-20));
}

/** Hosted agents' instructions as last read from their provider, by pubkey,
 * with the order the read started in. Their config isn't on this device, so
 * Former Bestie tells from these whether one still has a Bestie section on.
 * No `instructions` means a read failed before any succeeded: nothing shows
 * that the agent has nothing left on. */
type HostedRead = Readonly<{ order: number; instructions?: string }>;
const hostedRead = new Map<string, HostedRead>();
const hostedListeners = new Set<() => void>();
let hostedReads = 0;

/** Starts recording one read of a hosted agent's instructions. Call it before
 * asking the provider, then `read` or `failed` with what it answered. A read
 * started before the one last recorded changes nothing when it ends, so a
 * slow background read never replaces what a later save left. A failure never
 * replaces instructions already read. */
export function startHostedRead(pubkey: string) {
  const order = ++hostedReads;
  const record = (instructions?: string) => {
    const last = hostedRead.get(pubkey);
    if (last && last.order > order) return;
    if (instructions === undefined && last?.instructions !== undefined) return;
    hostedRead.set(pubkey, {
      order,
      ...(instructions !== undefined && { instructions }),
    });
    if (!last || last.instructions !== instructions)
      for (const listener of [...hostedListeners]) listener();
  };
  return {
    read: (instructions: string) => record(instructions),
    failed: () => record(),
  };
}

/** Calls `listener` when a hosted agent's recorded instructions change. */
export function subscribeHostedInstructions(listener: () => void) {
  hostedListeners.add(listener);
  return () => {
    hostedListeners.delete(listener);
  };
}

/** Forgets every hosted agent's recorded instructions, for tests. */
export function forgetHostedInstructions() {
  hostedRead.clear();
}

/** Reads the instructions of each hosted agent this device saw as Bestie,
 * once per connection, when its provider holds them. A former one then shows
 * Former Bestie while its memory is on, before its tabs are opened. */
export function readFormerHosted(
  relay: RelayData,
  agents: FeatureAgents & Pick<Agents, "snapshot" | "subscribe">,
) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const tried = new Set<string>();
  let session = relay.snapshot().session;
  const reconcile = () => {
    if (signal.aborted) return;
    const { session: next, scope } = relay.snapshot();
    if (next !== session) {
      session = next;
      tried.clear();
    }
    if (!scope) return;
    const seen = seenAsBestie(scope);
    for (const agent of agents.snapshot().agents) {
      if (
        agent.place !== "hosted" ||
        tried.has(agent.pubkey) ||
        !seen.includes(agent.pubkey)
      )
        continue;
      const hosted = agents.hostedInstructions?.(agent.pubkey);
      if (!hosted) continue;
      tried.add(agent.pubkey);
      const recording = startHostedRead(agent.pubkey);
      hosted.get(signal).then(
        (instructions) => {
          if (!signal.aborted) recording.read(instructions);
        },
        (error: unknown) => {
          if (signal.aborted) return;
          // Its Former Bestie tab then shows, and reads again with a Retry.
          recording.failed();
          console.warn("A former Bestie's instructions weren't read", error);
        },
      );
    }
  };
  const stopAgents = agents.subscribe(reconcile);
  const stopRelay = relay.subscribe(reconcile);
  reconcile();
  return () => {
    lifetime.abort();
    stopAgents();
    stopRelay();
  };
}

/** Whether `agent`, which isn't Bestie, was one and still has something on
 * that the Former Bestie tab can turn off. A Bestie section in its
 * instructions shows it was Bestie, on any device, and is on. Membership of
 * one of the viewer's private channels counts only for an agent this device
 * saw as Bestie: nothing records which channels Bestie's switches added. A
 * hosted agent's instructions are as last read from its provider; one whose
 * read failed counts as on until a read succeeds. */
export function formerWithSettings(
  agent: Agent,
  { session, scope }: RelaySnapshot,
) {
  const hosted =
    agent.place === "hosted" ? hostedRead.get(agent.pubkey) : undefined;
  // A failed read doesn't show that nothing is on, so the tab stays to read
  // again.
  if (hosted && hosted.instructions === undefined) return true;
  const instructions =
    agent.place === "hosted"
      ? (hosted?.instructions ?? "")
      : instructionsOf(agent);
  if (FEATURES.some((feature) => featureState(instructions, feature) !== "off"))
    return true;
  return (
    !!scope &&
    seenAsBestie(scope).includes(agent.pubkey) &&
    privateChannels(
      session.channels.list().channels,
      session.viewer ?? "",
      agent.pubkey,
    ).joined.length > 0
  );
}

/** Calls `listener` when who is in the viewer's private channels changes,
 * across reconnections, but not for each new message in them. */
export function subscribePrivateMembers(
  relay: RelayData,
  listener: () => void,
) {
  const members = (session: RelaySession) =>
    privateChannels(session.channels.list().channels, session.viewer ?? "", "")
      .others.map(({ id, members = [] }) => `${id}:${[...members].sort()}`)
      .sort()
      .join(" ");
  let session = relay.snapshot().session;
  let last = members(session);
  const changed = () => {
    const next = members(session);
    if (next === last) return;
    last = next;
    listener();
  };
  const follow = () => {
    session.channels.ensureList();
    return session.channels.subscribeList(changed);
  };
  let stop = follow();
  const stopRelay = relay.subscribe(() => {
    const next = relay.snapshot().session;
    if (next === session) return;
    stop();
    session = next;
    stop = follow();
    changed();
  });
  return () => {
    stopRelay();
    stop();
  };
}

/** Stops the check-ins of each agent here that isn't the community's Bestie,
 * whenever the saved Bestie or the agents change. A choice made on another
 * device counts once this device reads the account again, which it does once
 * per connection. It acts only on the account's choice once known: a Bestie,
 * or a saved none, when every agent here is stopped. An account with no
 * record never chose, so nobody counts as former, nor while the choice is
 * loading, unreadable or being saved, or kept only on this device, where an
 * automatic pick looks the same. An agent also in another
 * community, where it may be Bestie, loses only its timer here, as its
 * instructions are shared. Memory and channels stay as they are. */
export function stopFormerCheckIns(relay: RelayData, agents: ReconcileAgents) {
  const bestie = savedBestie(relay);
  const checkIns = FEATURES.filter(({ timer }) => timer);
  /** Agents being saved, and what each was like when last tried, so a state
   * is tried once per connection, and a save that left it as it was doesn't
   * loop. */
  const saving = new Set<string>();
  const tried = new Map<string, string>();
  // Saves under way when the plugin stops start nothing more.
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let session = relay.snapshot().session;
  const reconcile = () => {
    if (signal.aborted) return;
    const relaySnapshot = relay.snapshot();
    if (relaySnapshot.session !== session) {
      session = relaySnapshot.session;
      tried.clear();
    }
    if (!session.mainAgent) return;
    // Not while the account is read, can't be, or a choice here is saved.
    if (!bestie.known()) return;
    const current = bestie.snapshot();
    // An account with no record never chose a Bestie, so none is former. An
    // agent here may be Bestie in another community, which shares its
    // instructions.
    if (!current && !bestie.recorded()) return;
    if (current && relaySnapshot.scope)
      rememberBestie(relaySnapshot.scope, current);
    const { agents: here, running = [] } = agents.snapshot();
    for (const agent of here) {
      const on = checkIns.filter((feature) => featurePresent(agent, feature));
      const seen = JSON.stringify([instructionsOf(agent), agent.attention]);
      if (
        !on.length ||
        agent.pubkey === current ||
        agent.place !== "here" ||
        saving.has(agent.key) ||
        tried.get(agent.key) === seen ||
        cannotEdit(agents, agent) ||
        !inCommunity(agent, relaySnapshot)
      )
        continue;
      const timerOnly = running.some(
        (other) =>
          other.pubkey === agent.pubkey && !inCommunity(other, relaySnapshot),
      );
      saving.add(agent.key);
      tried.set(agent.key, seen);
      // Not while the agents are telling their listeners of a change.
      void Promise.resolve()
        .then(async () => {
          for (const feature of on) {
            // Each save starts from the agent as the last one left it, and
            // stops if the saved Bestie changed or stopped being known
            // meanwhile, as when it is made Bestie again.
            const fresh = agents
              .snapshot()
              .agents.find((each) => each.key === agent.key);
            if (signal.aborted || !fresh) return;
            if (!bestie.known() || bestie.snapshot() !== current) {
              // Tried again once the saved Bestie is known.
              tried.delete(agent.key);
              return;
            }
            await saveFeature(agents, fresh, feature, false, {
              timerOnly,
              signal,
            });
          }
        })
        .catch((error: unknown) => {
          if (!signal.aborted)
            console.warn("A former Bestie's check-ins didn't stop", error);
        })
        .finally(() => {
          saving.delete(agent.key);
          // What changed while it saved.
          reconcile();
        });
    }
  };
  const stopBestie = bestie.subscribe(reconcile);
  const stopAgents = agents.subscribe(reconcile);
  const stopRelay = relay.subscribe(reconcile);
  reconcile();
  return () => {
    lifetime.abort();
    stopBestie();
    stopAgents();
    stopRelay();
  };
}

/** Turns Remembers you on for a local agent this device just made Bestie,
 * unless its type can't take it or it already has it. */
export function rememberNewBestie(
  relay: RelayData,
  agents: ReconcileAgents,
  pubkey: string,
) {
  const agent = agents
    .snapshot()
    .agents.find(
      (candidate) =>
        candidate.pubkey === pubkey &&
        candidate.place === "here" &&
        inCommunity(candidate, relay.snapshot()),
    );
  if (
    !agent ||
    cannotEdit(agents, agent) ||
    // Never a second section, even beside one edited by hand.
    featureState(instructionsOf(agent), memory) !== "off"
  )
    return Promise.resolve();
  return saveFeature(agents, agent, memory, true);
}
