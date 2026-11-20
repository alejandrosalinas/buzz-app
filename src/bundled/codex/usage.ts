// The token use of an agent's Codex threads, read from the rollout files Codex
// keeps on this computer. Codex owns the files; nothing here writes them.
// What each thread said is kept while the app runs, so a later read opens only
// the rollouts of threads Codex updated since.
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { limited, withRevision } from "../../features/agents/session-usage";
import type { Host } from "../../features/host/service";
import type { AppServer, Spawn } from "./rpc";
import { withServer } from "./transcript";

type Json = Record<string, unknown>;
type Thread = { id: string; path: string | null; updatedAt: number };
/** Files read at once, by every agent's read together: the app refuses more
 * than 16 native reads at a time, and Claude's usage reads take 8. */
const READERS = 4;
/** How long after Codex last updated a thread its rollout is read again:
 * Codex keeps the time to the second, so a line written in the same second as
 * a read would leave the time unchanged. */
const SETTLE_MS = 2_000;

/** A thread's usage as a read left it, and the update times it was read at. */
type Read = Readonly<{ stamp: string; session?: SessionUsage | undefined }>;
/** Per host and agent, by thread id; a plugin that reloads starts over. */
const cache = new WeakMap<Spawn, Map<string, Map<string, Read>>>();
const reader = limited(READERS);

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const text = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .map((part) => str(object(part)?.text))
    .join("\n");

/** Where Buzz started the thread, and what was asked, from its first prompt. */
function buzzStart(prompt: string) {
  const sections = promptSections(prompt);
  let context: Json | undefined;
  try {
    context = object(
      JSON.parse(sections.find((part) => part.tag === "context")?.body ?? ""),
    );
  } catch {
    return undefined;
  }
  const channelId = str(context?.channel_id);
  if (
    !channelId &&
    !(context?.session_scope === "community" && str(context.agent))
  )
    return undefined;
  // Before agents joined several communities, every thread was its home's.
  const agent = str(context?.agent) || undefined;
  const root = str(context?.session_thread);
  let title = "";
  for (const { body } of sections) {
    const request = /^Request: (".*")$/m.exec(body)?.[1];
    if (!request) continue;
    try {
      title = str(JSON.parse(request)).split("\n")[0]?.trim() ?? "";
    } catch {}
    break;
  }
  return {
    agent,
    place: {
      ...(channelId ? { channelId } : {}),
      ...(root ? { root } : {}),
      ...(title ? { title } : {}),
    },
  };
}

/** Adds a rollout's model responses to `observations`, and says whose it is:
 * Buzz's agent's when its developer instructions open with the agent's
 * pubkey. Codex records each response's tokens once, its input including the
 * cached part. */
function read(file: string, agent: string, observations: UsageObservation[]) {
  // A teammate's pubkey can appear in the team section; the agent's own
  // opens a line of its instructions.
  const identity = new RegExp(`^You are .* \\(pubkey ${agent}\\)`, "m");
  let mine = false;
  let start: ReturnType<typeof buzzStart>;
  let model = "";
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  let unreadable = 0;
  const lines = file.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      // A partial last line is still being written.
      if (index < lines.length - 1) unreadable += 1;
      continue;
    }
    const payload = object(entry?.payload);
    const at = Date.parse(str(entry?.timestamp));
    if (!entry || !payload || !at) continue;
    first = Math.min(first, at);
    last = Math.max(last, at);
    if (entry.type === "turn_context") model = str(payload.model) || model;
    if (entry.type === "response_item" && payload.type === "message") {
      const prompt = text(payload.content);
      if (payload.role === "developer" && identity.test(prompt)) mine = true;
      if (payload.role === "user" && !start) start = buzzStart(prompt);
    }
    const usage = object(payload.usage);
    if (entry.type !== "token_usage_record" || !usage) continue;
    const prompt = count(usage.input_tokens);
    const cacheRead = count(usage.cached_input_tokens);
    const cacheWrite = count(usage.cache_write_input_tokens);
    const output = count(usage.output_tokens);
    const requestId = str(payload.response_id);
    observations.push({
      ...(requestId ? { requestId } : {}),
      at,
      model: model || "codex",
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
    });
  }
  return { mine, start, first, last, unreadable };
}

/** A thread's usage, with the subagent threads it spawned (undefined when
 * one's rollout is gone), when Buzz started it for `agent` in this
 * community: its threads in the agent's other communities are theirs. */
export function rolloutUsage(
  id: string,
  file: string,
  subagents: readonly (string | undefined)[],
  agent: Readonly<{ key: string; pubkey: string }>,
): Omit<SessionUsage, "revision"> | undefined {
  const observations: UsageObservation[] = [];
  const thread = read(file, agent.pubkey, observations);
  if (!thread.mine || !thread.start || !thread.last) return undefined;
  if ((thread.start.agent ?? agent.pubkey) !== agent.key) return undefined;
  let { first, last, unreadable } = thread;
  const gaps: string[] = [];
  for (const subagent of subagents) {
    if (subagent === undefined) {
      gaps.push("A subagent’s rollout is gone");
      continue;
    }
    const spent = read(subagent, agent.pubkey, observations);
    first = Math.min(first, spent.first);
    last = Math.max(last, spent.last);
    unreadable += spent.unreadable;
  }
  if (unreadable)
    gaps.push(
      `${unreadable} rollout line${unreadable === 1 ? "" : "s"} unreadable`,
    );
  return {
    id,
    ...thread.start.place,
    startedAt: first,
    lastAt: last,
    gaps,
    observations,
  };
}

/** Every thread `thread/list` finds with `params`, a page at a time. */
async function list(rpc: AppServer, params: Json) {
  const found: Thread[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: Thread[]; nextCursor: string | null } =
      await rpc.request("thread/list", {
        ...params,
        // Without `modelProviders`, Codex lists only its default provider's
        // threads, which can leave out every thread the agent ran. Without
        // `useStateDbOnly`, it reads every rollout file before filtering.
        modelProviders: [],
        limit: 50,
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
    found.push(...page.data);
    cursor = page.data.length ? page.nextCursor : null;
  } while (cursor);
  return found;
}

/** The subagent threads `parent` spawned, and theirs. */
async function spawned(rpc: AppServer, parent: string): Promise<Thread[]> {
  const children = await list(rpc, { parentThreadId: parent });
  const nested = await Promise.all(
    children.map((child) => spawned(rpc, child.id)),
  );
  return [...children, ...nested.flat()];
}

export type UsageHost = Readonly<{
  spawn: Spawn;
  readFile: NonNullable<Host["readFile"]>;
}>;

/** The agent's Codex threads in use since `since`, found by the agent's name
 * in their thread names and kept when their rollout names its pubkey and
 * was started for this membership. */
export async function readUsage(
  host: UsageHost,
  agent: Readonly<{ key: string; pubkey: string; name: string }>,
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const { spawn } = host;
  const queue = await withServer(spawn, signal, async (rpc) => {
    const named = await list(rpc, { searchTerm: `· ${agent.name}` });
    return Promise.all(
      named
        .filter((thread) => thread.updatedAt * 1000 >= since)
        .map(async (thread) => ({
          thread,
          subagents: await spawned(rpc, thread.id),
        })),
    );
  });
  const rollout = async ({ path }: Thread) => {
    if (!path?.endsWith(".jsonl")) return undefined;
    try {
      const file = await reader(() => {
        signal.throwIfAborted();
        return host.readFile(path);
      });
      signal.throwIfAborted();
      return new TextDecoder().decode(file);
    } catch (error) {
      signal.throwIfAborted();
      if (/no such file/i.test(error instanceof Error ? error.message : ""))
        return undefined;
      throw error;
    }
  };
  const agents = cache.get(spawn) ?? new Map<string, Map<string, Read>>();
  cache.set(spawn, agents);
  const earlier = agents.get(agent.key) ?? new Map<string, Read>();
  const reads = new Map<string, Read>();
  const startedAt = Date.now();
  const found: SessionUsage[] = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const threads = [next.thread, ...next.subagents];
      const stamp = JSON.stringify(
        threads.map(({ id, path, updatedAt }) => [id, path, updatedAt]),
      );
      let read = earlier.get(next.thread.id);
      if (read?.stamp !== stamp) {
        const file = await rollout(next.thread);
        if (file === undefined) continue;
        const subagents = await Promise.all(next.subagents.map(rollout));
        const session = rolloutUsage(next.thread.id, file, subagents, agent);
        read = { stamp, session: session && (await withRevision(session)) };
      }
      // A thread updated within the last moments is read again next time.
      if (
        threads.every(
          ({ updatedAt }) => updatedAt * 1000 < startedAt - SETTLE_MS,
        )
      )
        reads.set(next.thread.id, read);
      if (read.session && read.session.lastAt >= since)
        found.push(read.session);
    }
  };
  await Promise.all(Array.from({ length: READERS }, worker));
  agents.set(agent.key, reads);
  return found.sort((a, b) => b.lastAt - a.lastAt);
}
