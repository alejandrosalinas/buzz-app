import { localActivity, localWorkLabel, localWorkRoot } from "./local-activity";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { activityTranscript, type ToolItem } from "./activity-transcript";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
const verbs: Record<string, string> = {
  read: "Reading",
  edit: "Editing",
  delete: "Deleting",
  move: "Moving",
  search: "Searching",
  fetch: "Fetching",
  execute: "Running a command",
  think: "Working",
};

function toolLabel(tool: ToolItem): string {
  if (tool.permission && !tool.permission.outcome)
    return "Waiting for permission";
  if (tool.status === "pending") return "Preparing a tool";
  // These local MCP tools publish kind=other. Recognize only their exact names;
  // never infer an action by parsing an arbitrary shell command or tool title.
  const localKind: Record<string, string> = {
    "buzz-dev-mcp__read_file": "read",
    "buzz-dev-mcp__str_replace": "edit",
    "buzz-dev-mcp__shell": "execute",
  };
  const local = Object.hasOwn(localKind, tool.title)
    ? localKind[tool.title]
    : undefined;
  const kind = local ?? tool.kind;
  const verb =
    (Object.hasOwn(verbs, kind) ? verbs[kind] : undefined) ?? "Running a tool";
  // Compact UI never displays raw arguments, commands, or full local paths.
  let path = tool.paths[0];
  if (!path && local && kind !== "execute") {
    try {
      const input: unknown = JSON.parse(tool.input);
      if (
        input &&
        typeof input === "object" &&
        "path" in input &&
        typeof input.path === "string"
      )
        path = input.path;
    } catch {
      /* Missing or elided tool input keeps the generic label. */
    }
  }
  const file = path
    ?.split(/[\\/]/)
    .pop()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted file labels.
    ?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, 80);
  return file && ["read", "edit", "delete", "move"].includes(kind)
    ? `${verb} ${file}`
    : verb;
}

export type CurrentActivity = {
  label: string;
  detailAvailability: "available" | "no-current-step" | "typing-only";
  /** Null is the channel conversation; undefined is genuinely unknown. */
  roots: (string | null | undefined)[];
};

/** Existing live evidence only. Channel views include threads; thread views do not. */
export function currentActivity(
  snapshot: Snapshot | undefined,
  entries: readonly TypingEntry[],
  knownAgents: ReadonlySet<string>,
  channelId: string,
  threadRootId?: string,
  includeThreads = true,
  channelThreadRoots?: ReadonlySet<string>,
): ReadonlyMap<string, CurrentActivity> {
  const agents = new Map<string, CurrentActivity>();
  const add = (agent: string, root: string | null | undefined) => {
    const activity: CurrentActivity = agents.get(agent) ?? {
      label: "Working",
      detailAvailability: "typing-only",
      roots: [],
    };
    if (!activity.roots.includes(root)) activity.roots.push(root);
    agents.set(agent, activity);
    return activity;
  };
  const matches = (channel: string | null, root?: string) =>
    channel === channelId &&
    (threadRootId ? root === threadRootId : includeThreads || !root);
  const listening = snapshot?.status === "listening";
  const working = listening
    ? snapshot.turns.filter(
        (turn) => turn.channelId === channelId && turn.state === "working",
      )
    : [];
  const ownerTyping = listening
    ? snapshot.typing.filter(
        (entry) =>
          entry.working && matches(entry.channelId, entry.threadRootId),
      )
    : [];
  for (const entry of ownerTyping) add(entry.agent, entry.threadRootId ?? null);
  for (const entry of entries) {
    if (
      matches(entry.channelId, entry.threadRootId) &&
      (knownAgents.has(entry.pubkey) ||
        ownerTyping.some((owner) => owner.agent === entry.pubkey) ||
        working.some((turn) => turn.agent === entry.pubkey))
    )
      add(entry.pubkey, entry.threadRootId ?? null);
  }
  const records = snapshot?.records ?? [];
  for (const agent of new Set(working.map((turn) => turn.agent))) {
    const transcript = activityTranscript(records, { agent, channelId }).turns;
    const tools: ToolItem[] = [];
    for (const evidence of working.filter((turn) => turn.agent === agent)) {
      const turn = transcript.find((turn) => turn.turnId === evidence.turnId);
      if (
        turn?.endedAt ||
        (threadRootId
          ? turn?.threadRootId !== threadRootId
          : !includeThreads && !!turn?.threadRootId)
      )
        continue;
      const detail = add(agent, turn?.threadRootId);
      detail.detailAvailability = "no-current-step";
      tools.push(
        ...(turn?.items.filter(
          (item): item is ToolItem =>
            item.type === "tool" &&
            !!(item.title || item.kind) &&
            (item.status === "in_progress" || item.status === "pending"),
        ) ?? []),
      );
    }
    const activity = agents.get(agent);
    const firstTool = tools[0];
    if (activity && firstTool) {
      activity.detailAvailability = "available";
      activity.label =
        tools.length > 1
          ? `Running ${tools.length} tools`
          : toolLabel(firstTool);
    }
  }
  const localSnapshot =
    !threadRootId && !includeThreads
      ? {
          local: (snapshot?.local ?? []).filter(
            (row) => !row.thread && !channelThreadRoots?.has(row.threadRootId),
          ),
        }
      : snapshot;
  const local = localActivity(localSnapshot, channelId, threadRootId);
  for (const [agent, work] of local) {
    agents.delete(agent);
    if (work.state !== "working" && work.state !== "waiting") continue;
    const roots = [
      ...new Set(
        (localSnapshot?.local ?? [])
          .filter(
            (row) =>
              row.agent === agent &&
              row.channelId === channelId &&
              (!threadRootId || row.threadRootId === threadRootId) &&
              (row.state === "working" || row.state === "waiting"),
          )
          .map((row) => localWorkRoot(row) ?? null),
      ),
    ];
    agents.set(agent, {
      label: localWorkLabel(work),
      detailAvailability: "available",
      roots,
    });
  }
  return agents;
}

/** Each request an agent is working on in one conversation, as its exact
 * trigger IDs. As in currentActivity, the agent's local requests here
 * supersede its remote turns. */
export function workingRequests(
  snapshot: Snapshot | undefined,
  agent: string,
  channelId: string,
  threadRootId?: string,
  includeThreads = true,
): string[][] {
  const local = (snapshot?.local ?? []).filter(
    (row) =>
      row.agent === agent &&
      row.channelId === channelId &&
      (threadRootId
        ? row.threadRootId === threadRootId
        : includeThreads || !row.thread),
  );
  if (local.length)
    return local
      .filter((row) => row.state === "working" || row.state === "waiting")
      .map((row) => [row.messageId]);
  if (snapshot?.status !== "listening") return [];
  return snapshot.turns
    .filter(
      (turn) =>
        turn.agent === agent &&
        turn.state === "working" &&
        turn.channelId === channelId &&
        (threadRootId
          ? turn.threadRootId === threadRootId
          : includeThreads || !turn.threadRootId),
    )
    .map((turn) => [...(turn.triggeringEventIds ?? [])]);
}
