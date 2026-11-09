import {
  type AttentionValue,
  interestSlug,
  watchSlug,
} from "../../features/agents/attention";
import type { Agent, Agents } from "../../features/agents/service";
import {
  FEATURES,
  type Feature,
  featureState,
  hasFeature,
  restoredFeature,
  withFeature,
} from "./features";

/** What saving a feature needs. A caller of agents here only can leave out
 * `hostedInstructions`. */
export type FeatureAgents = Pick<Agents, "save" | "types"> &
  Partial<Pick<Agents, "hostedInstructions">>;

/** The agent's instructions, as its synced editor shows them. */
export function instructionsOf(agent: Agent) {
  const { instructions } = (agent.config ?? {}) as { instructions?: unknown };
  return typeof instructions === "string" ? instructions : "";
}

/** Why the agent's instructions can't take a feature here, if they can't.
 * `feature` is the one to add, which a hosted agent's provider may take if it
 * has no timer; without it, only an agent here can be edited. */
export function cannotEdit(
  agents: FeatureAgents,
  agent: Agent,
  feature?: Feature,
) {
  // A remote agent's instructions and timers aren't on this device: its
  // provider, or the device it runs on, holds them. A hosted agent's provider
  // may let its instructions be edited, but its timers never run here.
  if (agent.place !== "here")
    return agent.place === "hosted" &&
      feature &&
      !feature.timer &&
      agents.hostedInstructions?.(agent.pubkey)
      ? undefined
      : "Not available with remote agents yet.";
  // A type without `adopt` has no instructions, as `updateKind` says.
  if (!agents.types().find(({ key }) => key === agent.type)?.adopt)
    return "This agent's type has no instructions to add this to.";
  // Without a confirmed copy its instructions aren't shown, so a save here
  // would replace them.
  return agent.configProblem;
}

/** Whether `agent` has `feature` on: its section, and its timer if it has
 * one. Half of one, such as a timer deleted in Watching, reads as off. */
export function featureOn(agent: Agent, feature: Feature) {
  return (
    hasFeature(instructionsOf(agent), feature) &&
    (!feature.timer || !!agent.attention[watchSlug(feature.timer.id)])
  );
}

/** Whether any of the feature's parts is there: its section, whole or
 * edited, or its timer. */
export function featurePresent(agent: Agent, feature: Feature) {
  return (
    featureState(instructionsOf(agent), feature) !== "off" ||
    (!!feature.timer && !!agent.attention[watchSlug(feature.timer.id)])
  );
}

/** Turns `feature` on or off as its switch does, revising the synced
 * instructions as their editor would. Off also turns off the features that
 * require it. A timer is delivered to `channel`, the owner's DM with the
 * agent. With `timerOnly`, the instructions, which each of the agent's
 * communities shares, are left as they are. Attention is saved first: if the
 * instructions then fail to save, On undoes its timer, and the half Off
 * leaves reads as off, which turning it either way finishes. On refuses a
 * section edited by hand: Restore puts it back first. Once `signal` aborts,
 * the instructions aren't saved. */
export async function saveFeature(
  agents: FeatureAgents,
  agent: Agent,
  feature: Feature,
  on: boolean,
  {
    channel,
    timerOnly = false,
    signal,
  }: { channel?: string; timerOnly?: boolean; signal?: AbortSignal } = {},
) {
  if (on && featureState(instructionsOf(agent), feature) === "edited")
    throw new Error(
      `${feature.title} was edited in Instructions; restore it first.`,
    );
  const off = on
    ? []
    : [feature, ...FEATURES.filter(({ requires }) => requires === feature.id)];
  const attention: Record<string, AttentionValue | null> = {};
  for (const { timer } of off)
    for (const slug of timer
      ? [interestSlug(timer.id), watchSlug(timer.id)]
      : [])
      if (agent.attention[slug]) attention[slug] = null;
  const timer = on && feature.timer;
  if (timer) {
    if (!channel) throw new Error("A check-in needs your DM with the agent.");
    attention[interestSlug(timer.id)] = {
      type: "interest",
      instructions: timer.interest,
    };
    attention[watchSlug(timer.id)] = {
      type: "timer",
      interest_id: timer.id,
      prompt: timer.prompt,
      enabled: true,
      interval_secs: timer.everySecs,
      armed_at: Math.floor(Date.now() / 1000),
      max_occurrences: null,
      expires_at: null,
      channel,
    };
  }
  if (Object.keys(attention).length)
    await agents.save(agent.key, { attention });
  if (timerOnly) return;
  const instructions = instructionsOf(agent);
  const next = on
    ? withFeature(instructions, feature, true)
    : off.reduce((text, item) => withFeature(text, item, false), instructions);
  if (next === instructions) return;
  // The caller may have stopped while Attention saved.
  signal?.throwIfAborted();
  try {
    await saveInstructions(agents, agent, next);
  } catch (cause) {
    // A failed On undoes what it saved, so no timer runs behind a switch
    // that reads off.
    if (timer)
      await agents
        .save(agent.key, {
          attention: Object.fromEntries(
            Object.keys(attention).map((slug) => [
              slug,
              agent.attention[slug]?.value ?? null,
            ]),
          ),
        })
        .catch(() => {
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)} Its timer may still be saved; remove it below.`,
          );
        });
    throw cause;
  }
}

/** Puts back the feature's section edited by hand, as the editor would save
 * it. */
export async function restoreFeature(
  agents: FeatureAgents,
  agent: Agent,
  feature: Feature,
) {
  const next = restoredFeature(instructionsOf(agent), feature);
  if (next === undefined)
    throw new Error(`Fix ${feature.title}'s markers in Instructions.`);
  await saveInstructions(agents, agent, next);
}

/** Saves `instructions` as the next revision of the copy `agent` shows, or,
 * for a hosted agent, through its provider. */
function saveInstructions(
  agents: FeatureAgents,
  agent: Agent,
  instructions: string,
) {
  if (agent.place === "hosted") {
    const hosted = agents.hostedInstructions?.(agent.pubkey);
    if (!hosted) throw new Error("Not available with remote agents yet.");
    // Its provider replaces the copy this switch shows, never a newer one.
    return hosted.set(instructions, instructionsOf(agent));
  }
  return agents.save(agent.key, {
    config: { ...(agent.config as object), instructions },
    ...(agent.configBase && { base: agent.configBase }),
  });
}
