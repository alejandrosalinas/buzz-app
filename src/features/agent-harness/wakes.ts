// Subscription wakes share prompt framing and cancellation checks across
// harnesses. The runner owns Interest lanes and conversation delivery; this
// module also runs subscriptions without an address through AgentType.runOnce.
import {
  ATTENTION_REVIEW,
  catchUpPrompt,
  timerPrompt,
  sourcePrompt,
  watchPrompt,
} from "./attention-prompt";
import type { AgentHandle, Trigger, TurnResult } from "../agents/service";
import { pluginInstructions } from "./plugin-instructions";

export type WakeTrigger = Exclude<
  Trigger,
  { type: "mention" | "plugin" | "attention" }
>;
/** Runs one standalone turn, `key` naming it (`watch/ID`, `catch-up/ID` or
 * `timer/ID`). It calls `prompt` once it is ready to start the turn, and
 * starts none when it gives undefined: the wake is no longer wanted. */
export type RunOnce = (
  key: string,
  prompt: () => Promise<string | undefined>,
) => Promise<TurnResult>;

/** Runs `trigger` with `runOnce`, in the lane the runner holds for it.
 * Settles when its turn ends, or at once when it no longer runs. The host
 * says whether it is still `current`, asked as it starts and again while its
 * prompt is built: a wake whose watch or timer was disabled or removed, whose
 * watch changed or no longer matches, or whose agent's attention went off,
 * while it waited does not run. `harness` names the agent type in logs. */
export async function wake(
  agent: AgentHandle,
  trigger: WakeTrigger,
  current: () => boolean,
  runOnce: RunOnce,
  harness: string,
): Promise<TurnResult> {
  const id = trigger.slug.replace(/^watch\//, "");
  if (!current()) return { ok: true };
  try {
    const result = await runOnce(`${trigger.type}/${id}`, () =>
      wakePrompt(agent, trigger, id, current, { standalone: true }),
    );
    if (!result.ok)
      console.warn(
        `${harness} ${trigger.type} turn failed: ${id}`,
        result.error,
      );
    return result;
  } catch (error) {
    console.warn(`${harness} ${trigger.type} turn failed: ${id}`, error);
    return { ok: false, error: "The turn failed" };
  }
}

/** The prompt for a wake as its watch or timer now is, with the end-of-turn
 * review, or undefined when it should no longer run. A `standalone` turn's
 * prompt is the whole turn, so it also has the instructions plugins give the
 * agent; a conversation's turn adds them itself. */
export async function wakePrompt(
  agent: AgentHandle,
  trigger: WakeTrigger,
  id: string,
  stillCurrent: () => boolean,
  { standalone = false }: Readonly<{ standalone?: boolean }> = {},
) {
  const { attention } = agent;
  if (!stillCurrent()) return undefined;
  const current = (await attention.show(trigger.slug)).object;
  const type =
    trigger.type === "timer"
      ? "timer"
      : trigger.type === "source"
        ? "source"
        : "event";
  if (!current || current.type !== type) return undefined;
  const interest = (await attention.show(`interest/${current.interest_id}`))
    .object;
  const instructions =
    interest?.type === "interest"
      ? { instructions: interest.instructions }
      : {};
  const text =
    trigger.type === "source"
      ? sourcePrompt({
          id,
          provider: trigger.watch.provider,
          text: trigger.text,
          ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
          interest: current.interest_id,
          ...instructions,
          conversation: !!current.channel,
        })
      : trigger.type === "watch"
        ? watchPrompt({
            id,
            interest: current.interest_id,
            ...instructions,
            conversation: !!current.channel,
            event: trigger.event,
            ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
          })
        : trigger.type === "catch-up"
          ? catchUpPrompt({
              id,
              interest: current.interest_id,
              ...instructions,
              conversation: !!current.channel,
              events: trigger.events,
              skipped: !!trigger.skipped,
            })
          : timerPrompt({
              id,
              interest: current.interest_id,
              prompt: current.type === "timer" ? current.prompt : "",
              ...instructions,
              spent: trigger.spent,
              conversation: current.type === "timer" && !!current.channel,
            });
  // Asked again: the attention can change while it is read.
  if (!stillCurrent()) return undefined;
  return [
    text,
    standalone ? pluginInstructions(agent.instructions?.()) : undefined,
    ATTENTION_REVIEW,
  ]
    .filter(Boolean)
    .join("\n\n");
}
