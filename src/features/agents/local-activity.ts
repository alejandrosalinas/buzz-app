export const REPLY_CORRELATION_MS = 120_000;

export type LocalWorkState =
  | "waiting"
  | "working"
  | "done"
  | "error"
  | "superseded"
  | "stopped";
/** `stopped`: the owner's Stop ended the turn, as its harness reports it. */
export type WorkOutcome = Readonly<{
  ok: boolean;
  error?: string;
  stopped?: true;
}>;
/** A harness step: its own tool name and, when known, what it acts on. */
export type WorkStep = Readonly<{ tool: string; target?: string }>;
export type LocalWork = Readonly<{
  scope: string;
  agent: string;
  channelId: string;
  messageId: string;
  threadRootId: string;
  /** The request is in this thread; absent means channel-level work. */
  thread?: true;
  /** The request is in a relay-verified Solo chat, not a DM or channel. */
  soloChat?: true;
  /** The Solo chat's existing display name when this work started. */
  conversationName?: string;
  state: LocalWorkState;
  startedAt: number;
  /** This run's messages still awaiting publication acknowledgement. */
  publishing?: number;
  /** Recent messages this run published here; their relay echoes are not separate alerts. */
  replyMessages?: readonly Readonly<{ id: string; acknowledgedAt: number }>[];
  /** Recent publication IDs retained with this work entry for transcript navigation,
   * independently of notification echo expiry. Capped at 512 per entry. */
  publishedMessageIds?: readonly string[];
  error?: string;
  /** Latest live step, as the harness named it; display only. */
  step?: WorkStep;
  /** The owner hid this error here; the outcome remains as evidence. */
  dismissed?: true;
  /** Its harness can stop the turn it is in. */
  stoppable?: true;
  /** It can be asked again once it fails. */
  retryable?: true;
}>;
const settled = (state: LocalWorkState) =>
  state === "done" ||
  state === "error" ||
  state === "superseded" ||
  state === "stopped";
export type LocalAgentSource = {
  work(): readonly LocalWork[];
  subscribeWork(listener: () => void): () => void;
  /** Hides one already-seen error on this device; never changes its outcome. */
  dismissError?(work: Pick<LocalWork, "scope" | "agent" | "messageId">): void;
  /** Stops the turn this unsettled request is in, then shows it stopped. */
  interrupt?(
    work: Pick<LocalWork, "scope" | "agent" | "messageId">,
  ): Promise<void>;
  /** Asks again for this failed request, which begins it again; throws when
   * it can't be. */
  retry?(work: Pick<LocalWork, "scope" | "agent" | "messageId">): void;
};

/** App-owned local facts. No relay publication, inference, polling or process control. */
export function createLocalAgentActivity() {
  let work: readonly LocalWork[] = [];
  const workListeners = new Set<() => void>();
  const entries = new Map<symbol, LocalWork>();
  /** How to stop each stoppable request's turn, until it settles. */
  const stops = new Map<symbol, () => Promise<void>>();
  /** How to ask each retryable request again, while its row is kept. */
  const retries = new Map<symbol, () => void>();
  const replyTimers = new Map<symbol, ReturnType<typeof setTimeout>>();
  const publish = () => {
    work = Object.freeze([...entries.values()]);
    for (const listener of workListeners) listener();
  };
  const subscribe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const reader: LocalAgentSource = {
    work: () => work,
    subscribeWork: (listener) => subscribe(workListeners, listener),
    dismissError({ scope, agent, messageId }) {
      for (const [id, row] of entries)
        if (
          row.state === "error" &&
          !row.dismissed &&
          row.scope === scope &&
          row.agent === agent &&
          row.messageId === messageId
        ) {
          entries.set(id, Object.freeze({ ...row, dismissed: true }));
          publish();
          return;
        }
    },
    async interrupt({ scope, agent, messageId }) {
      for (const [id, row] of entries) {
        const stop = stops.get(id);
        if (
          !stop ||
          row.scope !== scope ||
          row.agent !== agent ||
          row.messageId !== messageId
        )
          continue;
        await stop();
        const current = entries.get(id);
        if (!current || settled(current.state)) return;
        stops.delete(id);
        const { step: _step, stoppable: _stoppable, ...rest } = current;
        entries.set(id, Object.freeze({ ...rest, state: "stopped" }));
        publish();
        return;
      }
    },
    retry({ scope, agent, messageId }) {
      for (const [id, row] of entries) {
        const retry = retries.get(id);
        if (
          retry &&
          row.state === "error" &&
          row.scope === scope &&
          row.agent === agent &&
          row.messageId === messageId
        )
          return retry();
      }
      throw new Error("This request can't be retried");
    },
  };
  return {
    reader,
    begin(
      input: Omit<
        LocalWork,
        | "state"
        | "startedAt"
        | "publishing"
        | "replyMessages"
        | "publishedMessageIds"
        | "error"
        | "dismissed"
        | "stoppable"
        | "retryable"
      >,
      retry?: () => void,
    ) {
      // Keep the newest accepted handling of one exact message; late completions
      // retain their own token and cannot overwrite its replacement. A retry
      // still owns the prior attempt's fresh reply IDs, because those relay
      // echoes may arrive after the activity row is replaced.
      let replaced: LocalWork | undefined;
      for (const [id, row] of entries)
        if (
          row.scope === input.scope &&
          row.agent === input.agent &&
          row.messageId === input.messageId
        ) {
          replaced = row;
          entries.delete(id);
          stops.delete(id);
          retries.delete(id);
          clearTimeout(replyTimers.get(id));
          replyTimers.delete(id);
        }
      // Display budget only, independent of execution. Old settled evidence goes first.
      if (entries.size >= 512) {
        const victim =
          [...entries].find(([, row]) => settled(row.state)) ??
          entries.entries().next().value;
        if (victim) {
          entries.delete(victim[0]);
          stops.delete(victim[0]);
          retries.delete(victim[0]);
          clearTimeout(replyTimers.get(victim[0]));
          replyTimers.delete(victim[0]);
        }
      }
      const id = Symbol();
      if (retry) retries.set(id, retry);
      const expireReplies = () => {
        replyTimers.delete(id);
        const current = entries.get(id);
        if (!current?.replyMessages?.length) return;
        const now = Date.now();
        const replyMessages = current.replyMessages.filter(
          (item) => now - item.acknowledgedAt <= REPLY_CORRELATION_MS,
        );
        if (replyMessages.length !== current.replyMessages.length) {
          const { replyMessages: _replyMessages, ...rest } = current;
          entries.set(
            id,
            Object.freeze({
              ...rest,
              ...(replyMessages.length ? { replyMessages } : {}),
            }),
          );
          publish();
        }
        const oldest = replyMessages[0];
        if (oldest)
          replyTimers.set(
            id,
            setTimeout(
              expireReplies,
              Math.max(
                0,
                oldest.acknowledgedAt + REPLY_CORRELATION_MS - Date.now() + 1,
              ),
            ),
          );
      };
      const startedAt = Math.max(Date.now(), (replaced?.startedAt ?? -1) + 1);
      const replyMessages = replaced?.replyMessages?.filter(
        (item) => startedAt - item.acknowledgedAt <= REPLY_CORRELATION_MS,
      );
      entries.set(
        id,
        Object.freeze({
          ...input,
          state: "waiting",
          startedAt,
          ...(replyMessages?.length ? { replyMessages } : {}),
          ...(replaced?.publishedMessageIds
            ? { publishedMessageIds: replaced.publishedMessageIds }
            : {}),
          ...(retry ? { retryable: true } : {}),
        }),
      );
      const oldest = replyMessages?.[0];
      if (oldest)
        replyTimers.set(
          id,
          setTimeout(
            expireReplies,
            Math.max(
              0,
              oldest.acknowledgedAt + REPLY_CORRELATION_MS - Date.now() + 1,
            ),
          ),
        );
      publish();
      const update = (
        state: LocalWorkState,
        error?: string,
        step?: WorkStep,
      ) => {
        const current = entries.get(id);
        if (!current || settled(current.state)) return;
        if (settled(state)) stops.delete(id);
        const next = step ?? (state === "working" ? current.step : undefined);
        if (
          current.state === state &&
          current.error === error &&
          current.step?.tool === next?.tool &&
          current.step?.target === next?.target
        )
          return;
        const { step: _step, stoppable, ...rest } = current;
        entries.set(
          id,
          Object.freeze({
            ...rest,
            ...(stoppable && !settled(state) ? { stoppable } : {}),
            state,
            ...(error ? { error: error.slice(0, 500) } : {}),
            ...(next ? { step: next } : {}),
          }),
        );
        publish();
      };
      return {
        channelId: input.channelId,
        started: () => update("working"),
        confirmSolo: (conversationName?: string) => {
          const current = entries.get(id);
          if (!current || current.soloChat) return;
          entries.set(
            id,
            Object.freeze({
              ...current,
              soloChat: true,
              ...(conversationName?.trim()
                ? { conversationName: conversationName.trim() }
                : {}),
            }),
          );
          publish();
        },
        sending: () => {
          const current = entries.get(id);
          if (!current) return () => {};
          entries.set(
            id,
            Object.freeze({
              ...current,
              publishing: (current.publishing ?? 0) + 1,
            }),
          );
          publish();
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            const latest = entries.get(id);
            if (!latest?.publishing) return;
            const publishing = latest.publishing - 1;
            const { publishing: _publishing, ...rest } = latest;
            entries.set(
              id,
              Object.freeze({ ...rest, ...(publishing ? { publishing } : {}) }),
            );
            publish();
          };
        },
        reply: (messageId: string) => {
          const current = entries.get(id);
          if (
            !current ||
            current.replyMessages?.some((item) => item.id === messageId)
          )
            return;
          const now = Date.now();
          const replyMessages = [
            ...(current.replyMessages ?? []).filter(
              (item) => now - item.acknowledgedAt <= REPLY_CORRELATION_MS,
            ),
            Object.freeze({ id: messageId, acknowledgedAt: now }),
          ];
          const publishedMessageIds = Object.freeze(
            [
              ...new Set([...(current.publishedMessageIds ?? []), messageId]),
            ].slice(-512),
          );
          entries.set(
            id,
            Object.freeze({ ...current, replyMessages, publishedMessageIds }),
          );
          clearTimeout(replyTimers.get(id));
          const oldest = replyMessages[0];
          if (oldest)
            replyTimers.set(
              id,
              setTimeout(
                expireReplies,
                Math.max(
                  0,
                  oldest.acknowledgedAt + REPLY_CORRELATION_MS - Date.now() + 1,
                ),
              ),
            );
          publish();
        },
        // Keep the exact request outcome after the harness acknowledges a
        // newer message, without presenting the earlier work as successful.
        supersede: () => update("superseded"),
        /** Latest live step reported by the plugin; display only. */
        step: (tool: string, target?: string) => {
          const name = tool.trim().slice(0, 80);
          const on = target?.trim().replace(/\s+/g, " ").slice(0, 160);
          if (name)
            update("working", undefined, {
              tool: name,
              ...(on ? { target: on } : {}),
            });
        },
        finish: (result: WorkOutcome) =>
          update(
            result.stopped ? "stopped" : result.ok ? "done" : "error",
            result.ok
              ? undefined
              : result.error || "Could not finish this request",
          ),
        /** The harness's way to stop this request's turn, offered as Stop. */
        interruptible: (stop: () => Promise<void>) => {
          const current = entries.get(id);
          if (!current || settled(current.state)) return;
          stops.set(id, stop);
          if (current.stoppable) return;
          entries.set(id, Object.freeze({ ...current, stoppable: true }));
          publish();
        },
        remove: () => {
          stops.delete(id);
          retries.delete(id);
          clearTimeout(replyTimers.get(id));
          replyTimers.delete(id);
          if (entries.delete(id)) publish();
        },
      };
    },
    clear(scope?: string, agent?: string) {
      let changed = false;
      for (const [id, row] of entries)
        if (
          (!scope || row.scope === scope) &&
          (!agent || row.agent === agent)
        ) {
          entries.delete(id);
          stops.delete(id);
          retries.delete(id);
          clearTimeout(replyTimers.get(id));
          replyTimers.delete(id);
          changed = true;
        }
      if (changed) publish();
    },
  };
}
export type LocalAgentActivity = ReturnType<typeof createLocalAgentActivity>;

/** One aggregation for all local channel/thread/message status presentations. */
/** Received, or handed over but not yet on a first step: shown as breathing "Starting". */
export function breathing(row: Pick<LocalWork, "state" | "step"> | undefined) {
  return row?.state === "waiting" || (row?.state === "working" && !row.step);
}

export function localActivity(
  snapshot: { local?: readonly LocalWork[] } | undefined,
  channelId: string,
  threadRootId?: string,
) {
  const rows = (snapshot?.local ?? []).filter(
    (row) =>
      row.channelId === channelId &&
      (!threadRootId || row.threadRootId === threadRootId),
  );
  const agents = new Map<string, LocalWork>();
  const rank = {
    superseded: 0,
    stopped: 0,
    done: 0,
    error: 1,
    waiting: 2,
    working: 3,
  };
  for (const row of rows) {
    const previous = agents.get(row.agent);
    if (!previous || rank[row.state] > rank[previous.state])
      agents.set(row.agent, row);
  }
  return agents;
}
export function localWorkLabel(
  row: Pick<LocalWork, "state" | "error" | "step">,
) {
  if (row.state === "superseded") return "Continued on a later message";
  if (row.state === "stopped") return "Stopped";
  return row.state === "waiting"
    ? "Received · waiting to start"
    : row.state === "working"
      ? row.step
        ? stepText(row.step)
        : "Starting"
      : row.state === "error"
        ? row.error || "Could not finish this request"
        : "Finished";
}

/** Fallback phrases for steps without a target. No model rewrites harness text. */
const verbs: Record<string, string> = {
  Bash: "Running a command",
  Shell: "Running a command",
  Read: "Reading a file",
  Write: "Writing a file",
  Edit: "Editing a file",
  MultiEdit: "Editing a file",
  NotebookEdit: "Editing a notebook",
  Grep: "Searching files",
  Glob: "Finding files",
  WebFetch: "Reading a web page",
  WebSearch: "Searching the web",
  Task: "Running a subtask",
  Agent: "Running a subtask",
  TodoWrite: "Updating its plan",
  Thinking: "Thinking",
  "Writing reply": "Writing a reply",
};
/** Readable "doing what" wording. Fixed lookup over the harness's own tool
 * names and targets; Claude's command descriptions are already plain English. */
const readable: Record<string, (target: string) => string> = {
  Bash: (t) => t,
  Shell: (t) => `Running ${t}`,
  Read: (t) => `Reading ${t}`,
  Write: (t) => `Writing ${t}`,
  Edit: (t) => `Editing ${t}`,
  MultiEdit: (t) => `Editing ${t}`,
  NotebookEdit: (t) => `Editing ${t}`,
  Grep: (t) => `Searching for ${t}`,
  ListFiles: (t) => `Listing files in ${t}`,
  ImageView: (t) => `Viewing ${t}`,
  Glob: (t) => `Finding ${t}`,
  WebFetch: (t) => `Reading ${t}`,
  WebSearch: (t) => `Searching the web for ${t}`,
  Task: (t) => `Subagent · ${t}`,
  Agent: (t) => `Subagent · ${t}`,
};
const untargeted: Record<string, string> = {
  send: "Sending a message",
  send_message: "Sending a message",
  read: "Reading the conversation",
  TodoWrite: "Updating its plan",
  ListFiles: "Listing files",
  ImageView: "Viewing an image",
  Compacting: "Compacting its context",
};
export function stepText(step: WorkStep) {
  const phrase = step.target && readable[step.tool];
  if (phrase && step.target) return phrase(step.target);
  const known = untargeted[step.tool] ?? verbs[step.tool];
  if (known) return known;
  return step.target ? `${step.tool} · ${step.target}` : step.tool;
}
