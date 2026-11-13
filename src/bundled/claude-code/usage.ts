// The token use of an agent's Claude Code sessions, read from the transcripts
// Claude Code keeps on this computer. Claude Code owns the files; nothing here
// writes them. What each file said is kept while the app runs, so a later read
// opens only the files changed since.
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { limited, withRevision } from "../../features/agents/session-usage";
import type { Host } from "../../features/host/service";
import type { Spawn } from "./claude";
import { readProject } from "./history";
import { type SessionsPlace, workspaceProject } from "./transcript";

type Json = Record<string, unknown>;
/** Files read at once, by every agent's read together: the app refuses more
 * than 16 native reads at a time. */
const READERS = 8;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
/** A file's entries, and how many of its finished lines are not JSON. A
 * partial last line is still being written. */
function lines(file: string) {
  const all = file.split("\n");
  const entries: Json[] = [];
  let unreadable = 0;
  all.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = object(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      if (index < all.length - 1) unreadable += 1;
    }
  });
  return { entries, unreadable };
}
const promptText = (content: unknown) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((block) => str(object(block)?.text))
        .join("\n");

/** Where the session started in Buzz and for which agent, from its first
 * prompt's context; undefined when Buzz did not start it. */
export function buzzStart(entries: readonly Json[]) {
  const first = entries.find(
    (entry) => entry.type === "user" && !entry.isMeta && !entry.isSidechain,
  );
  const context = promptSections(
    promptText(object(first?.message)?.content),
  ).find((section) => section.tag === "context")?.body;
  const field = (name: string) =>
    context?.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
  const channel = field("Channel");
  if (!channel) return undefined;
  const root = field("Session scope") === "thread" && field("Thread root");
  return {
    agent: field("Agent"),
    channelId: channel.match(/\(#([^)]+)\)$/)?.[1] ?? channel,
    ...(root ? { root } : {}),
  };
}

const COUNTS = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheWrite: "cache_creation_input_tokens",
} as const;

/** What one transcript file says, kept in place of its text. Each model
 * request once, keyed by its message and request ids when it has them:
 * Claude Code repeats a streamed response's usage on every content block's
 * line. */
export type Digest = Readonly<{
  start?: ReturnType<typeof buzzStart>;
  title?: string;
  unreadable: number;
  /** Its earliest and latest entry times. */
  times?: Readonly<{ first: number; last: number }>;
  observations: readonly (readonly [string | undefined, UsageObservation])[];
  spawned: readonly string[];
}>;

function observations(entries: readonly Json[]) {
  const seen = new Map<string, UsageObservation>();
  const unkeyed = new Set<string>();
  for (const entry of entries) {
    const message = object(entry.message);
    const usage = object(message?.usage);
    const model = str(message?.model);
    const at = Date.parse(str(entry.timestamp));
    if (entry.type !== "assistant" || !usage || !model || !at) continue;
    if (model === "<synthetic>") continue;
    const counts = {
      ...Object.fromEntries(
        Object.entries(COUNTS).map(([name, field]) => [name, usage[field]]),
      ),
      cacheWrite1h: object(usage.cache_creation)?.ephemeral_1h_input_tokens,
    };
    const requestId = str(entry.requestId) || str(message?.id);
    const key = `${str(message?.id)}:${str(entry.requestId)}`;
    const observation: UsageObservation = {
      ...(requestId ? { requestId } : {}),
      at,
      model,
      tokens: Object.fromEntries(
        Object.entries(counts).flatMap(([name, raw]) => {
          const value = count(raw);
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    };
    if (key === ":") {
      const own = `#${seen.size}`;
      unkeyed.add(own);
      seen.set(own, observation);
    } else seen.set(key, observation);
  }
  return [...seen].map(
    ([key, value]) => [unkeyed.has(key) ? undefined : key, value] as const,
  );
}

/** The transcript names, `agent-<id>`, of the subagents the entries record
 * spawning. */
const spawned = (entries: readonly Json[]) =>
  entries.flatMap((entry) => {
    const agentId = str(object(entry.toolUseResult)?.agentId);
    return /^[\w-]+$/.test(agentId) ? [`agent-${agentId}`] : [];
  });

function digest(file: string): Digest {
  const { entries, unreadable } = lines(file);
  let times: { first: number; last: number } | undefined;
  for (const entry of entries) {
    const at = Date.parse(str(entry.timestamp));
    if (!(at > 0)) continue;
    times ??= { first: at, last: at };
    times.first = Math.min(times.first, at);
    times.last = Math.max(times.last, at);
  }
  let title: string | undefined;
  for (const entry of entries)
    if (entry.type === "ai-title" && str(entry.aiTitle).trim())
      title = str(entry.aiTitle).trim();
  return {
    start: buzzStart(entries),
    ...(title ? { title } : {}),
    unreadable,
    ...(times && { times }),
    observations: observations(entries),
    spawned: spawned(entries),
  };
}

/** A session's usage from its file's digest and its subagents' by name
 * (undefined when one is gone), when Buzz started it for `agent`. */
function combine(
  id: string,
  main: Digest,
  subagents: ReadonlyMap<string, Digest | undefined>,
  agent: string,
  saved: boolean,
): Omit<SessionUsage, "revision"> | undefined {
  const { start } = main;
  if (!start || (start.agent ? start.agent !== agent : !saved))
    return undefined;
  const all = [main];
  const gaps: string[] = [];
  for (const subagent of subagents.values()) {
    if (subagent === undefined) gaps.push("A subagent’s transcript is gone");
    else all.push(subagent);
  }
  for (const name of new Set(all.flatMap((file) => file.spawned)))
    if (!subagents.has(name)) gaps.push("A subagent’s transcript is gone");
  const skipped = all.reduce((sum, file) => sum + file.unreadable, 0);
  if (skipped)
    gaps.push(
      `${skipped} transcript line${skipped === 1 ? "" : "s"} unreadable`,
    );
  const times = all.flatMap((file) => file.times ?? []);
  if (!times.length) return undefined;
  const seen = new Map<string, UsageObservation>();
  for (const file of all)
    for (const [key, observation] of file.observations)
      seen.set(key ?? `${seen.size}`, observation);
  return {
    id,
    channelId: start.channelId,
    ...(start.root ? { root: start.root } : {}),
    ...(main.title ? { title: main.title } : {}),
    startedAt: Math.min(...times.map((time) => time.first)),
    lastAt: Math.max(...times.map((time) => time.last)),
    gaps,
    observations: [...seen.values()],
  };
}

/** A session file's usage, with its subagents' files by name (undefined when
 * one is gone), when Buzz started it for `agent`. A subagent the session
 * recorded spawning without a file is gone too. A saved session also counts
 * when its prompt does not name an agent, as prompts did before agents were
 * named. */
export function sessionUsage(
  id: string,
  file: string,
  subagents: ReadonlyMap<string, string | undefined>,
  agent: string,
  saved: boolean,
): Omit<SessionUsage, "revision"> | undefined {
  return combine(
    id,
    digest(file),
    new Map(
      [...subagents].map(([name, text]) => [
        name,
        text === undefined ? undefined : digest(text),
      ]),
    ),
    agent,
    saved,
  );
}

export type UsageHost = Readonly<{
  spawn: Spawn;
  readFile: NonNullable<Host["readFile"]>;
}>;

const reader = limited(READERS);

/** The agent's Buzz sessions in its workspace's Claude Code history, active
 * since `since`. `saved` are the session ids this app saved for it. */
export async function readUsage(
  host: UsageHost,
  workspace: SessionsPlace,
  agent: string,
  saved: readonly string[],
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const { spawn } = host;
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project) return [];
  const current = await readProject(spawn, project);
  signal.throwIfAborted();
  // A session it could not search may be the agent's: fail, not undercount.
  if (current.incomplete) throw current.incomplete;
  const named = [...current.starts]
    .filter(([, start]) => start.agent === agent)
    .map(([name]) => name);
  const savedNames = new Set(
    saved.filter((id) => /^[\w-]+$/.test(id)).map((id) => `${id}.jsonl`),
  );
  const read = (path: string) => {
    let pending = current.digests.get(path);
    if (pending) return pending;
    pending = reader(async () => {
      try {
        return digest(
          new TextDecoder().decode(
            await host.readFile(`~/.claude/projects/${project}/${path}`),
          ),
        );
      } catch (error) {
        if (/no such file/i.test(error instanceof Error ? error.message : ""))
          return undefined;
        throw error;
      }
    });
    current.digests.set(path, pending);
    // A failed read is tried again next time.
    pending.catch(() => {
      if (current.digests.get(path) === pending) current.digests.delete(path);
    });
    return pending;
  };
  const found: SessionUsage[] = [];
  const queue = [...new Set([...savedNames, ...named])];
  // One file at a time per worker: a read stopped takes no more files, and
  // ones it started still fill the cache.
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      signal.throwIfAborted();
      const main = await read(name);
      if (!main) continue;
      const id = name.slice(0, -".jsonl".length);
      const subagents = new Map<string, Digest | undefined>();
      for (const path of current.subagents.get(id) ?? []) {
        signal.throwIfAborted();
        subagents.set(
          path.slice(path.lastIndexOf("/") + 1, -".jsonl".length),
          await read(path),
        );
      }
      const session = combine(id, main, subagents, agent, savedNames.has(name));
      if (session && session.lastAt >= since)
        found.push(await withRevision(session));
    }
  };
  await Promise.all(Array.from({ length: READERS }, worker));
  signal.throwIfAborted();
  return found.sort((a, b) => b.lastAt - a.lastAt);
}
