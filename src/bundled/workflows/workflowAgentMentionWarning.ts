import { parse as yamlParse } from "yaml";
import type { WorkflowMentionMember } from "./WorkflowMessageText";

/** NIP-11 `workflow_agent_mentions`: `owner` lets only runs the owner or a
 * timer started, with only message and delay steps, direct agents. */
export type WorkflowAgentMentions = "any" | "owner";

/** A missing or unknown value is an older relay's: every run may. */
export function workflowAgentMentions(
  info: Record<string, unknown>,
): WorkflowAgentMentions {
  return info.workflow_agent_mentions === "owner" ? "owner" : "any";
}

const WHY =
  "This community limits which workflows can use agents, so other people can't use yours.";
export const OWNER_RUNS_WARNING = `Agents you mention respond only when you start this workflow, not when someone else does. ${WHY}`;
export const WEBHOOK_WARNING = `Agents won't respond to workflows started by a webhook. ${WHY}`;
export const STEPS_WARNING = `Agents won't respond to this workflow because it has steps other than Send Message and Delay. ${WHY}`;

const PERSON_TRIGGERS = new Set([
  "message_posted",
  "reaction_added",
  "diff_posted",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const extendsName = (c: string | undefined) =>
  c !== undefined && /[\p{Alphabetic}\p{N}_]/u.test(c);
// Rust's `char::to_lowercase`, which folds each code point on its own.
const fold = (c: string) => [...c.toLowerCase()];

/** The members `text` names, as the relay's `resolve_mention_pubkeys` matches
 * them: an `@` at the start or after whitespace or `(`, the exact name in any
 * case, not followed by a letter, digit or `_`; longer names first, each span
 * once; a name two members share names no one. */
export function resolveWorkflowMentions<
  M extends Pick<WorkflowMentionMember, "pubkey" | "name">,
>(text: string, members: readonly M[]): M[] {
  const byName = new Map<string, M | null>();
  for (const member of members) {
    if (!member.name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""))
      continue;
    const key = member.name.toLowerCase();
    const known = byName.get(key);
    byName.set(
      key,
      known === undefined || known?.pubkey === member.pubkey ? member : null,
    );
  }
  const chars = [...text];
  const consumed = chars.map(() => false);
  const hits: [number, M][] = [];
  const names = [...members].sort(
    (a, b) => [...b.name].length - [...a.name].length,
  );
  const matchLength = (start: number, name: readonly string[]) => {
    let at = start;
    let index = 0;
    while (index < name.length) {
      const c = chars[at];
      if (c === undefined) return undefined;
      for (const folded of fold(c))
        if (name[index++] !== folded) return undefined;
      at++;
    }
    return at - start;
  };
  for (const { name } of names) {
    const folded = [...name.toLowerCase()];
    if (!folded.length) continue;
    for (let at = 0; at < chars.length; ) {
      const left =
        at === 0 ||
        /\p{White_Space}/u.test(chars[at - 1] ?? "") ||
        chars[at - 1] === "(";
      const length =
        chars[at] === "@" && left && !consumed[at]
          ? matchLength(at + 1, folded)
          : undefined;
      if (length === undefined || extendsName(chars[at + 1 + length])) {
        at++;
        continue;
      }
      const member = byName.get(name.toLowerCase());
      if (member) hits.push([at, member]);
      consumed.fill(true, at, at + 1 + length);
      at += 1 + length;
    }
  }
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map(([, m]) => m))];
}

/** What owner-only agent mentions means for this definition's agent
 * mentions, as the relay decides it: by trigger and every step's action. */
export function getAgentMentionWarning(
  yaml: string,
  members: readonly WorkflowMentionMember[],
  mode: WorkflowAgentMentions,
): string | null {
  if (mode !== "owner" || !members.some((member) => member.agent)) return null;
  let definition: Record<string, unknown> | undefined;
  try {
    definition = record(yamlParse(yaml));
  } catch {
    return null;
  }
  const steps = Array.isArray(definition?.steps)
    ? definition.steps.map(record)
    : [];
  const mentions = steps.some((step) => {
    const text = step?.action === "send_message" ? step.text : undefined;
    return (
      typeof text === "string" &&
      resolveWorkflowMentions(text, members).some((member) => member.agent)
    );
  });
  if (!mentions) return null;
  const trigger = record(definition?.trigger)?.on;
  // A webhook run never directs agents, whatever its steps.
  if (trigger === "webhook") return WEBHOOK_WARNING;
  if (
    steps.some(
      (step) => step?.action !== "send_message" && step?.action !== "delay",
    )
  )
    return STEPS_WARNING;
  return typeof trigger === "string" && PERSON_TRIGGERS.has(trigger)
    ? OWNER_RUNS_WARNING
    : null;
}
