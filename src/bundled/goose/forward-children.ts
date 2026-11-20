import type { ForwardChildRegistered } from "../../features/host/forward";

/** goose's native delegate tool, as its `tool_call` names it in
 * `_meta.goose.toolCall.toolName`; its title may add a source or be
 * generated (goose 1.57.0 `conversion.rs`). */
const DELEGATE = "delegate";

export type ForwardChildren = Readonly<{
  /** `registerForwardChild` bound to this generation's owner and id. */
  register: (call: string, child: string) => Promise<ForwardChildRegistered>;
  /** Shows why a child could not be registered on the turn. */
  failed: (reason: string) => void;
}>;

/** Registers the children goose delegates during one forwarded prompt, as
 * its `observe` as the generation's parent session's. One per
 * generation, so the delegate calls it trusts are this prompt's. Only a live
 * `delegate` call announced earlier in the prompt registers: goose strips
 * `subagentSessionId` from every other tool's result (goose 1.57.0
 * `lease.rs`), and replayed or out-of-prompt updates are ignored. */
export function forwardChildren({ register, failed }: ForwardChildren) {
  const delegates = new Set<string>();
  let stopped = false;
  /** The first failure, kept whatever `failed` does with it. */
  let failure: string | undefined;
  /** Registrations not yet answered, none of which ever rejects. */
  const pending = new Set<Promise<void>>();
  // Kept first, then shown once and never again from its own error. A
  // `failed` that throws stops registration too: nothing more is trusted.
  const report = (reason: string) => {
    failure ??= reason;
    try {
      failed(reason);
    } catch (error) {
      stopped = true;
      console.error("A goose child registration failure went unreported", {
        reason,
        error,
      });
    }
  };
  const observe = (update: Record<string, unknown>, prompting: boolean) => {
    if (!prompting || stopped) return;
    const call = update.toolCallId;
    if (typeof call !== "string") return;
    if (update.sessionUpdate === "tool_call") {
      const meta = update._meta as {
        goose?: { toolCall?: { toolName?: unknown } };
      };
      if (meta?.goose?.toolCall?.toolName === DELEGATE) delegates.add(call);
      return;
    }
    const meta = update._meta as { goose?: { subagentSessionId?: unknown } };
    const child = meta?.goose?.subagentSessionId;
    if (
      update.sessionUpdate !== "tool_call_update" ||
      update.status !== "completed" ||
      typeof child !== "string" ||
      !delegates.has(call)
    )
      return;
    // Nothing escapes the update: a throw, rejection or bad result fails
    // the turn visibly instead.
    let registering: Promise<ForwardChildRegistered>;
    try {
      registering = register(call, child);
    } catch (error) {
      report(String(error));
      return;
    }
    const answered = registering.then(
      (registered) => {
        if (registered.type === "registered") return;
        if (registered.reason === "generation_revoked") stopped = true;
        report(registered.reason);
      },
      (error) => report(String(error)),
    );
    pending.add(answered);
    void answered.finally(() => pending.delete(answered));
  };
  /** The turn's registration failure, once every registration started has
   * been answered. The caller awaits it after the prompt and before
   * reporting success, so a failed registration fails the turn even when
   * nothing else would notice. */
  const settled = async () => {
    while (pending.size) await Promise.all(pending);
    return failure;
  };
  return { observe, settled };
}
