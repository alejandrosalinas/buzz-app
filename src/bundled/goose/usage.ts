// The token use of an agent's goose sessions, as goose records it on each of
// their replies. goose owns the sessions; nothing here writes them. What each
// session said is kept while the app runs, so a later read exports only the
// sessions goose updated since.
import {
  promptMessage,
  promptSections,
} from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import { abortable } from "./sessions";
import {
  type GooseHistory,
  type GooseSessionRow,
  type Message,
  ownerOf,
} from "./transcript";

type Json = Record<string, unknown>;
/** How long after goose last updated a session it is exported again: goose
 * keeps the time to the second, so a message saved in the same second as an
 * export would leave the time unchanged. */
const SETTLE_MS = 2_000;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Where Buzz started the session, and what was asked, from its first
 * prompt's context and event. A watch's or timer's one-off session has no
 * channel. */
function buzzStart(messages: readonly Message[]) {
  const first = messages.find(
    (message) =>
      message.role === "user" && message.metadata?.userVisible !== false,
  );
  const sections = promptSections(
    (first?.content ?? []).map((block) => str(block.text)).join("\n"),
  );
  const field = (name: string) =>
    sections
      .find((section) => section.tag === "context")
      ?.body.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]
      ?.trim();
  const channelId = field("Channel")?.match(/\(#([^)]+)\)$/)?.[1];
  if (
    !channelId &&
    field("Session scope") !== "community" &&
    field("Scope") !== "standalone"
  )
    return undefined;
  const root = field("Session scope") === "thread" && field("Thread root");
  const title = promptMessage(sections).text.split("\n", 1)[0]?.trim();
  return {
    ...(channelId ? { channelId } : {}),
    ...(root ? { root } : {}),
    ...(title ? { title } : {}),
  };
}

/** A session's model requests. goose counts a reply's cached prompt tokens in
 * its input, and prices the replies it can. */
export function sessionUsage(
  id: string,
  messages: readonly Message[],
): Omit<SessionUsage, "revision"> | undefined {
  const start = buzzStart(messages);
  const times = messages.map((message) => message.created * 1000);
  if (!start || !times.length) return undefined;
  const observations: UsageObservation[] = [];
  for (const message of messages) {
    const usage = object(message.metadata?.usage);
    if (message.role !== "assistant" || !usage) continue;
    const inference = object(message.metadata?.inference);
    const prompt = count(usage.inputTokens);
    const cacheRead = count(usage.cacheReadTokens);
    const cacheWrite = count(usage.cacheWriteTokens);
    const output = count(usage.outputTokens);
    const cost = usage.cost;
    observations.push({
      ...(message.id ? { requestId: message.id } : {}),
      at: message.created * 1000,
      model:
        str(inference?.requestedModel) ||
        str(inference?.resolvedModel) ||
        "goose",
      tokens: {
        // The uncached input is known only with both cache counts.
        ...(prompt !== undefined &&
        cacheRead !== undefined &&
        cacheWrite !== undefined
          ? { input: Math.max(0, prompt - cacheRead - cacheWrite) }
          : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      },
      ...(typeof cost === "number" && Number.isFinite(cost)
        ? { cost: { usd: cost, source: str(usage.costSource) || "goose" } }
        : {}),
    });
  }
  return {
    id,
    ...start,
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    gaps: [],
    observations,
  };
}

/** One goose session as a read left it. */
type Read = Readonly<{
  /** When goose last updated it, as its listing said. */
  at: number;
  /** Whether that was long enough before the read that it is final. */
  settled: boolean;
  /** The agent its first prompt names. */
  owner?: string | undefined;
  session?: SessionUsage | undefined;
}>;
/** One workspace's sessions as the app's earlier reads left them. */
type Workspace = {
  reads: Map<string, Read>;
  /** The read under way, which every agent's read meanwhile shares; it stops
   * once all of them are cancelled. */
  reading?:
    | { done: Promise<void>; readers: number; stop: AbortController }
    | undefined;
};
/** Per history, so a plugin that reloads starts over. */
const cache = new WeakMap<GooseHistory, Map<string, Workspace>>();

/** Brings `state` up to date with goose's listing of `workspaces`: only the
 * sessions new or updated since the last read are exported again. */
async function refresh(
  history: GooseHistory,
  workspaces: readonly string[],
  state: Workspace,
  since: number,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  const kept = (row: GooseSessionRow) => {
    const read = state.reads.get(row.sessionId);
    return read?.settled && read.at === row.at ? read : undefined;
  };
  const { rows, messages } = await history.workspace(
    workspaces,
    since,
    (row) => !kept(row),
    signal,
  );
  const reads = new Map<string, Read>();
  for (const row of rows) {
    const read = messages.get(row.sessionId);
    const earlier = kept(row);
    if (!read) {
      if (earlier) reads.set(row.sessionId, earlier);
      continue;
    }
    const session = sessionUsage(row.sessionId, read);
    reads.set(row.sessionId, {
      at: row.at,
      settled: row.at < startedAt - SETTLE_MS,
      owner: ownerOf(read),
      session: session && (await withRevision(session)),
    });
  }
  state.reads = reads;
}

/** The agent's goose sessions used since `since`, in `workspace` and in the
 * `folders` its conversations were given. Every agent shares the workspace's
 * listing; an agent with folders also reads its own, of those folders only,
 * so a workspace's sessions are exported once however many agents have
 * folders. */
export async function readUsage(
  history: GooseHistory,
  agent: string,
  workspace: string,
  since: number,
  signal: AbortSignal,
  folders: readonly string[] = [],
): Promise<SessionUsage[]> {
  signal.throwIfAborted();
  const read = (key: string, paths: readonly string[]) =>
    listing(history, key, paths, since, signal);
  // A folder that is the workspace itself is in the shared listing already.
  const own = await abortable(history.elsewhere(workspace, folders), signal);
  const states = await Promise.all([
    read(workspace, [workspace]),
    ...(own.length ? [read(JSON.stringify([workspace, agent]), own)] : []),
  ]);
  // By id: a session the two listings both name is one.
  const sessions = new Map<string, SessionUsage>();
  for (const state of states)
    for (const { owner, session } of state.reads.values())
      if (owner === agent && session && session.lastAt >= since)
        sessions.set(session.id, session);
  return [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The listing kept under `key`, of goose's sessions in `paths`, once the read
 * under way, or a new one, brings it up to date. */
async function listing(
  history: GooseHistory,
  key: string,
  paths: readonly string[],
  since: number,
  signal: AbortSignal,
): Promise<Workspace> {
  const workspaces = cache.get(history) ?? new Map<string, Workspace>();
  cache.set(history, workspaces);
  let state = workspaces.get(key);
  if (!state) {
    state = { reads: new Map() };
    workspaces.set(key, state);
  }
  const current = state;
  let reading = current.reading;
  // One stopped because every agent waiting on it was cancelled is ending; a
  // read that starts meanwhile, as when the page opens again, starts anew.
  if (!reading || reading.stop.signal.aborted) {
    const stop = new AbortController();
    const started: NonNullable<Workspace["reading"]> = {
      readers: 0,
      stop,
      done: refresh(history, paths, current, since, stop.signal).finally(() => {
        if (current.reading === started) current.reading = undefined;
      }),
    };
    current.reading = reading = started;
  }
  const shared = reading;
  shared.readers += 1;
  const leave = () => {
    shared.readers -= 1;
    if (!shared.readers) shared.stop.abort(signal.reason);
  };
  signal.addEventListener("abort", leave, { once: true });
  try {
    await abortable(shared.done, signal);
  } finally {
    if (!signal.aborted) {
      signal.removeEventListener("abort", leave);
      shared.readers -= 1;
    }
  }
  return current;
}
