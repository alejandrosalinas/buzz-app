// The session files in an agent's Claude Code project directory, and where in
// Buzz each was started, kept while the app runs. Claude Code owns the files;
// nothing here writes them. A later look lists the directory again and
// searches only the files new since.
import { limited } from "../../features/agents/session-usage";
import type { Spawn } from "./claude";
import type { Digest } from "./usage";

/** Minutes a changed-files listing looks back past the previous one, as
 * `find -mmin` counts whole minutes. */
const LIST_SLACK_MINUTES = 2;
/** Files one search names, under the app's 256 process arguments. */
const SEARCH_FILES = 200;
/** Searches run at once, across every project. */
const SEARCHES = 8;

const searching = limited(SEARCHES);

/** Where in Buzz a session was started, from its first prompt's context. */
export type Start = Readonly<{
  channelId: string;
  /** Absent from prompts written before agents were named. */
  agent?: string;
  scope?: string;
  root?: string;
}>;

/** One Claude Code project directory as the app's earlier reads left it. */
export type Project = {
  /** When the latest listing of its files started; a file changed after it
   * is read again. */
  listedAt: number;
  /** The listing under way, which reads made meanwhile share. */
  listing?: Promise<void> | undefined;
  /** Every file the latest listing found. */
  paths: ReadonlySet<string>;
  /** Each session's subagent transcripts, by path. */
  subagents: ReadonlyMap<string, readonly string[]>;
  /** Where each session file's first prompt says it was started. */
  starts: Map<string, Start>;
  /** Session files searched that Buzz did not start, searched again once
   * changed. */
  unstarted: Set<string>;
  /** Why the latest listing could not search some session files, which are
   * in neither `starts` nor `unstarted` and are searched again next time. */
  incomplete?: Error | undefined;
  /** Each file's usage digest by path, undefined when it is gone; dropped
   * here when a listing finds the file changed or gone. */
  digests: Map<string, Promise<Digest | undefined>>;
};
/** Per host, so a plugin that reloads starts over. */
const cache = new WeakMap<Spawn, Map<string, Project>>();

/** The lines a process prints and its exit, failing on any exit but those in
 * `ok`. */
async function output(
  spawn: Spawn,
  id: string,
  project: string,
  args: readonly string[],
  ok: readonly number[],
) {
  let text = "";
  let errors = "";
  const process = await spawn(id, {
    args: [...args],
    cwd: `~/.claude/projects/${project}`,
    onStdout: (data) => {
      text += data;
    },
    onStderr: (data) => {
      errors += data;
    },
  });
  const code = await process.exited;
  const error = new Error(
    `Couldn’t read the Claude Code history: ${errors.trim() || `exit ${code}`}`,
  );
  if (code === null || !ok.includes(code)) throw error;
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  return { lines, code, error, errors };
}

/** The project's `.jsonl` files, subagents' included, changed in the last
 * `minutes` when given. */
const list = (spawn: Spawn, project: string, minutes?: number) =>
  output(
    spawn,
    "list",
    project,
    minutes === undefined ? [] : ["-mmin", `-${minutes}`],
    [0],
  ).then(({ lines }) => lines);

const FIELD =
  /^([^/]+\.jsonl):(Session scope|Channel|Thread root|Agent): (.*)$/;
/** The start or end of a prompt's thread context, which comes before its own. */
const CONTEXT_TAG = /^([^/]+\.jsonl):<(\/?)(?:thread|conversation)-context>$/;

/** Records where each of the session files at `paths` was started, one
 * search for every file: the search stops at a file's first prompt. Returns
 * why the search failed for some files, which it leaves unrecorded. */
async function search(
  spawn: Spawn,
  project: string,
  state: Project,
  paths: readonly string[],
) {
  // No match exits 1. A file it cannot read exits 2 after searching the rest;
  // grep names that file, or, when it names none, any not found started may
  // be it.
  const {
    lines: found,
    code,
    error,
    errors,
  } = await output(spawn, "starts", project, paths, [0, 1, 2]);
  const blamed = paths.filter((name) => errors.includes(`${name}:`));
  const unread = new Set(code === 2 ? (blamed.length ? blamed : paths) : []);
  const fields = new Map<string, Map<string, string>>();
  const quoting = new Set<string>();
  for (const line of found) {
    const [, tagged, end] = CONTEXT_TAG.exec(line) ?? [];
    if (tagged) {
      // The prompt opens with its thread context, so only a start before any
      // other match is its own; its end clears the quoted messages' fields.
      // Later tags are the Canvas's or a message's text.
      if (!end && !fields.has(tagged)) {
        fields.set(tagged, new Map());
        quoting.add(tagged);
      } else if (end && quoting.delete(tagged)) fields.get(tagged)?.clear();
      continue;
    }
    const [, name, field, value] = FIELD.exec(line) ?? [];
    if (!name || !field || value === undefined) continue;
    const named = fields.get(name) ?? new Map<string, string>();
    fields.set(name, named);
    // The first is the opening context's; a later one on its line is quoted.
    if (!named.has(field)) named.set(field, value.trim());
  }
  for (const name of paths) {
    const named = fields.get(name);
    const channel = named?.get("Channel");
    if (!named || (!channel && named.get("Session scope") !== "community")) {
      state.starts.delete(name);
      if (unread.has(name)) state.unstarted.delete(name);
      else state.unstarted.add(name);
      continue;
    }
    const agent = named.get("Agent");
    const scope = named.get("Session scope");
    const root = named.get("Thread root");
    state.starts.set(name, {
      channelId:
        channel?.match(/\(#([^)]+)\)$/)?.[1] ?? channel ?? "@community",
      ...(agent ? { agent } : {}),
      ...(scope ? { scope } : {}),
      ...(root ? { root } : {}),
    });
    state.unstarted.delete(name);
  }
  return code === 2 ? error : undefined;
}

/** Brings `state` up to date with the project's files: the digests of files
 * changed, gone or new since its last listing are dropped, and new session
 * files are searched for where they were started. */
async function refresh(spawn: Spawn, project: string, state: Project) {
  const startedAt = Date.now();
  // After a clock set back, file ages say nothing about the last listing:
  // everything is read and searched again.
  const fresh = !state.listedAt || startedAt < state.listedAt;
  if (fresh) {
    state.digests.clear();
    state.starts.clear();
    state.unstarted.clear();
  }
  const [all, changed] = await Promise.all([
    list(spawn, project),
    fresh
      ? []
      : list(
          spawn,
          project,
          Math.ceil((startedAt - state.listedAt) / 60_000) + LIST_SLACK_MINUTES,
        ),
  ]);
  const paths = new Set(all);
  const recent = new Set(changed);
  // A digest holds while its file is listed, unchanged, both times.
  for (const path of state.digests.keys())
    if (recent.has(path) || !paths.has(path) || !state.paths.has(path))
      state.digests.delete(path);
  const subagents = new Map<string, string[]>();
  for (const path of paths) {
    const match = /^([\w-]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
    if (match?.[1])
      subagents.set(match[1], [...(subagents.get(match[1]) ?? []), path]);
  }
  const sessions = [...paths].filter((path) => /^[^/]+\.jsonl$/.test(path));
  for (const name of [...state.starts.keys(), ...state.unstarted])
    if (!paths.has(name)) {
      state.starts.delete(name);
      state.unstarted.delete(name);
    }
  // A file still being written may not have its first prompt yet, or only
  // part of it.
  const unsearched = sessions.filter(
    (name) =>
      recent.has(name) ||
      (!state.starts.has(name) && !state.unstarted.has(name)),
  );
  // In parallel: one search takes a core, and the first reads every file.
  const size = Math.max(
    1,
    Math.min(SEARCH_FILES, Math.ceil(unsearched.length / SEARCHES)),
  );
  const batches = Array.from(
    { length: Math.ceil(unsearched.length / size) },
    (_, index) => unsearched.slice(index * size, (index + 1) * size),
  );
  const failures = await Promise.all(
    batches.map((batch) =>
      searching(() => search(spawn, project, state, batch)),
    ),
  );
  state.incomplete = failures.find(Boolean);
  state.paths = paths;
  state.subagents = subagents;
  state.listedAt = startedAt;
}

/** The project directory's files as listed now. Reads made together share
 * one listing; files changed while it ran are listed next time. A session file
 * it could not search leaves `incomplete` set; each reader decides whether
 * what it did find will do. */
export async function readProject(spawn: Spawn, project: string) {
  const projects = cache.get(spawn) ?? new Map<string, Project>();
  cache.set(spawn, projects);
  let state = projects.get(project);
  if (!state) {
    state = {
      listedAt: 0,
      paths: new Set(),
      subagents: new Map(),
      starts: new Map(),
      unstarted: new Set(),
      digests: new Map(),
    };
    projects.set(project, state);
  }
  const current = state;
  current.listing ??= refresh(spawn, project, current).finally(() => {
    current.listing = undefined;
  });
  await current.listing;
  return current;
}
