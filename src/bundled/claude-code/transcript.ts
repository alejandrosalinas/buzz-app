// A conversation's Claude Code session, read from the transcript Claude Code
// keeps on this computer and shown in the host's turn-transcript model. Claude
// Code owns the file; nothing here writes or keeps it.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import { readFile } from "../../buzz-mcp/app-client";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { Spawn } from "./claude";
import { readProject, type Start } from "./history";

/** The latest turns shown; the file keeps the rest. */
export const TURN_LIMIT = 50;
/** A conversation's transcript, and why some of its sessions may be missing
 * when the history could not all be searched. */
export type ClaudeTranscript = Transcript & {
  more: boolean;
  incomplete?: string;
};

type Json = Record<string, unknown>;
/** A person's display name, if known. */
type Names = (pubkey: string) => string | undefined;
/** One session file's conversation. */
type Session = Readonly<{
  sessionId: string;
  channelId: string;
  root?: string;
}>;
/** A conversation to read: the agent's sessions for its thread or channel,
 * including the one this build of the app saved, if any. */
export type Conversation = Readonly<{
  /** The agent's membership key, as its turn prompts name it. */
  agent: string;
  sessionId?: string;
  channelId: string;
  root?: string;
}>;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const blocks = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((block) => {
    const entry = object(block);
    return entry ? [entry] : [];
  });
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : blocks(value)
        .map((block) => str(block.text))
        .filter(Boolean)
        .join("\n");
const KINDS: Record<string, string> = {
  Bash: "execute",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

/** A Buzz prompt, or a steer, as the turn's opening item. */
function prompt(
  id: string,
  at: number,
  raw: string,
  name?: Names,
): TranscriptItem {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  // An older steer wraps a whole turn.
  if (steer && !readEventBody(steer.body))
    sections = promptSections(steer.body);
  const { text, author, authorPubkey } = promptMessage(sections, name);
  return {
    id,
    at,
    type: "prompt",
    text: text || raw,
    ...(author ? { author } : {}),
    ...(authorPubkey ? { authorPubkey } : {}),
    sections,
    steer: !!steer,
  };
}

/** Transcript lines as turns, each opened by a prompt. Claude Code's own
 * entries (metadata, subagents, attachments) are left out. */
export function claudeTurns(
  file: string,
  conversation: Session,
  working: boolean,
  name?: Names,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, ToolItem>();
  /** Messages sent with send, until their result says whether they were posted. */
  const sends = new Map<
    string,
    { turn: TranscriptTurn; message: { posted?: boolean } }
  >();
  let last = 0;
  const turn = (id: string, at: number, partial: boolean) => {
    const current = turns.at(-1);
    if (current) current.endedAt = Math.max(last, current.startedAt);
    const next: TranscriptTurn = {
      turnId: id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      sessionId: conversation.sessionId,
      newSession: false,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    turns.push(next);
    return next;
  };
  for (const line of file.split("\n")) {
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const message = object(entry.message);
    const id = str(entry.uuid);
    const at = Date.parse(str(entry.timestamp)) || last;
    if (
      !message ||
      !id ||
      (entry.type !== "user" && entry.type !== "assistant")
    )
      continue;
    const results = blocks(message.content).filter(
      (block) => block.type === "tool_result",
    );
    if (entry.type === "user" && !results.length) {
      const item = prompt(id, at, text(message.content), name);
      const current =
        item.type === "prompt" && item.steer ? turns.at(-1) : undefined;
      (current ?? turn(id, at, false)).items.push(item);
      last = at;
      continue;
    }
    const current = turns.at(-1) ?? turn(id, at, true);
    last = at;
    for (const result of results) {
      const sent = sends.get(str(result.tool_use_id));
      if (sent && !result.is_error) sent.message.posted = true;
      else if (sent) {
        sent.turn.items.push({
          id: `${id}:${str(result.tool_use_id)}`,
          at,
          type: "status",
          text: `The message above was not posted: ${text(result.content)}`,
        });
      }
      const tool = tools.get(str(result.tool_use_id));
      if (!tool) continue;
      tool.output = text(result.content);
      tool.status = result.is_error ? "failed" : "completed";
      tool.completedAt = at;
    }
    blocks(message.content).forEach((block, index) => {
      const key = `${id}:${index}`;
      if (block.type === "text" && str(block.text).trim())
        current.items.push({
          id: key,
          at,
          type: "message",
          text: str(block.text),
        });
      else if (block.type === "thinking" && str(block.thinking).trim())
        current.items.push({
          id: key,
          at,
          type: "thought",
          text: str(block.thinking),
        });
      else if (block.type === "tool_use") {
        const name = str(block.name);
        const input = object(block.input) ?? {};
        if (
          name.startsWith("mcp__buzz__") &&
          isMessageTool(name.slice("mcp__buzz__".length)) &&
          str(input.text).trim()
        ) {
          const message: TranscriptItem & { posted?: boolean } = {
            id: key,
            at,
            type: "message",
            text: str(input.text),
          };
          current.items.push(message);
          sends.set(str(block.id), { turn: current, message });
          return;
        }
        const path = str(input.file_path) || str(input.path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: str(block.id),
          // MCP tools as Codex names them: buzz.read, not mcp__buzz__read.
          title: str(input.command) || name.replace(/^mcp__(.+?)__/, "$1."),
          kind: KINDS[name] ?? "other",
          status: "in_progress",
          input: JSON.stringify(input, null, 2),
          output: "",
          diffs: [],
          paths: path ? [path] : [],
          truncated: false,
        };
        tools.set(tool.toolCallId, tool);
        current.items.push(tool);
      }
    });
  }
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  // A session file holds the whole session, from its start.
  if (turns[0] && !turns[0].partial) turns[0].newSession = true;
  return turns;
}

/** Claude Code's project folder name for a working directory. Longer paths
 * get a hash suffix this does not reproduce, so they are not found. */
export const projectName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const PROJECT_NAME_LIMIT = 200;

/** Whether a session file was started for `conversation`: its first prompt
 * names the same agent, channel and, for a thread session, thread root.
 * Prompts from before agents were named match any agent. */
export function startedFor(file: string, conversation: Conversation) {
  for (const line of file.split("\n")) {
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const context = promptSections(text(object(entry.message)?.content)).find(
      (section) => section.tag === "context",
    )?.body;
    if (!context) return false;
    const field = (name: string) =>
      context.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
    const agent = field("Agent");
    return (
      (agent === undefined || agent === conversation.agent) &&
      !!field("Channel")?.endsWith(`(#${conversation.channelId})`) &&
      (conversation.root
        ? field("Session scope") === "thread" &&
          field("Thread root") === conversation.root
        : field("Session scope") !== "thread")
    );
  }
  return false;
}

/** Whether the index says a session was started for `conversation`. Its
 * fields come from the first line naming any, which `startedFor` checks is
 * the first prompt once the file is read. */
const indexedFor = (start: Start, conversation: Conversation) =>
  (start.agent === undefined || start.agent === conversation.agent) &&
  start.channelId === conversation.channelId &&
  (conversation.root
    ? start.scope === "thread" && start.root === conversation.root
    : start.scope !== "thread");

/** How long finding the agent's workspace may take. */
const WORKSPACE_TIMEOUT_MS = 10_000;

/** The Claude Code project directory name for the agent's workspace, or
 * undefined when it is too long to be one. */
export async function workspaceProject(
  spawn: Spawn,
  workspace: string,
  signal: AbortSignal,
) {
  let directory = "";
  const process = await spawn("workspace", {
    cwd: workspace,
    onStdout: (data) => {
      directory += data;
    },
  });
  const stop = () => void process.kill();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, WORKSPACE_TIMEOUT_MS);
  const code = await process.exited.finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  });
  signal.throwIfAborted();
  if (code !== 0) throw new Error("Could not find the agent's workspace");
  const project = projectName(directory.trim());
  return project.length > PROJECT_NAME_LIMIT ? undefined : project;
}

/** MiB per page of a session too large to read whole, under its 50 MB. */
const PAGE_MIB = 32;
/** Pages read of one session at most, so a few huge turns or a record with
 * no end cannot hold more than this in memory; older lines are left. */
const PAGE_BUDGET = 2;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A session file's size in bytes. */
async function sizeOf(spawn: Spawn, path: string, signal: AbortSignal) {
  let output = "";
  const sizing = await spawn("size", {
    args: [path],
    cwd: "~/.claude/projects",
    onStdout: (data) => {
      output += data;
    },
  });
  const stop = () => void sizing.kill();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const code = await sizing.exited.finally(() =>
    signal.removeEventListener("abort", stop),
  );
  const size = Number.parseInt(output, 10);
  if (code !== 0 || !(size > 0)) throw new Error(`Could not read ${path}`);
  signal.throwIfAborted();
  return size;
}

/** MiB read from the end of a session for its latest turns. */
const LATEST_MIB = 2;

/** Each workspace's project, found once for the latest-turn reads. */
const projects = new Map<string, string | undefined>();

/** How often a session whose latest turn is larger than {@link LATEST_MIB}
 * MiB is read in full instead. */
export const OVERSIZED_READ_MS = 30_000;
/** When each such session was last left to a full read. */
const oversized = new Map<string, number>();

/** The whole turns in the last {@link LATEST_MIB} MiB of the conversation's
 * saved session, oldest first; undefined with no saved session. While a turn
 * is larger than that, none, so what is shown stays, except undefined every
 * {@link OVERSIZED_READ_MS} to read it in full. */
export async function readLatestTurns(
  spawn: Spawn,
  workspace: string,
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
  nameOf?: Names,
): Promise<TranscriptTurn[] | undefined> {
  if (!projects.has(workspace))
    projects.set(workspace, await workspaceProject(spawn, workspace, signal));
  const project = projects.get(workspace);
  const { sessionId } = conversation;
  if (!project || !sessionId) return undefined;
  const path = `./${project}/${sessionId}.jsonl`;
  const size = await sizeOf(spawn, path, signal);
  const from = Math.max(0, Math.floor((size - 1) / (1 << 20)) - LATEST_MIB + 1);
  const bytes = await readFile(
    spawn,
    "~/.claude/projects",
    path,
    signal,
    undefined,
    "read-page",
    [String(from), String(LATEST_MIB)],
  );
  const tooLarge = () => {
    const last = oversized.get(path);
    if (last !== undefined && Date.now() - last < OVERSIZED_READ_MS) return [];
    oversized.set(path, Date.now());
    return undefined;
  };
  // A chunk from partway through starts partway through a line.
  const start = from ? bytes.indexOf(10) + 1 : 0;
  if (from && !start) return tooLarge();
  const turns = claudeTurns(
    decode(bytes.subarray(start)),
    {
      sessionId,
      channelId: conversation.channelId,
      ...(conversation.root ? { root: conversation.root } : {}),
    },
    working,
    nameOf,
  ).filter((turn) => !turn.partial);
  if (from && turns[0]) turns[0].newSession = false;
  if (from && !turns.length) return tooLarge();
  oversized.delete(path);
  return turns;
}

/** A session file in `~/.claude/projects`. One too large to read whole is
 * read a page at a time from its end, until `enough` of its latest lines are
 * read, its start is or `PAGE_BUDGET` pages are; `cut` says older ones were
 * left. Its `start` is the session's first lines even then, which say whose
 * conversation it is. */
async function readSession(
  spawn: Spawn,
  path: string,
  signal: AbortSignal,
  enough: (text: string) => boolean,
) {
  const read = (process?: string, ...args: string[]) =>
    readFile(
      spawn,
      "~/.claude/projects",
      path,
      signal,
      undefined,
      process,
      args,
    );
  try {
    const text = decode(await read());
    return { text, cut: false, start: async () => text };
  } catch (error) {
    signal.throwIfAborted();
    if (!/larger than 50 MB/.test(error instanceof Error ? error.message : ""))
      throw error;
  }
  const size = await sizeOf(spawn, path, signal);
  let page = Math.floor((size - 1) / (PAGE_MIB << 20));
  let text = "";
  // A page starts partway through a line, which ends the page before it.
  let rest = new Uint8Array();
  for (let pages = 1; page >= 0; page--, pages++) {
    const chunk = await read(
      "read-page",
      String(page * PAGE_MIB),
      String(PAGE_MIB),
    );
    const bytes = new Uint8Array(chunk.length + rest.length);
    bytes.set(chunk);
    bytes.set(rest, chunk.length);
    const line = page ? bytes.indexOf(10) + 1 || bytes.length : 0;
    rest = bytes.subarray(0, line);
    text = decode(bytes.subarray(line)) + text;
    if (pages >= PAGE_BUDGET || enough(text)) break;
  }
  const cut = page > 0;
  return {
    text,
    cut,
    start: async () => (cut ? decode(await read("read-page", "0", "4")) : text),
  };
}

/** The title Claude Code generated for a session (its latest `ai-title`
 * record), or undefined before it has one. */
export async function readSessionTitle(
  spawn: Spawn,
  workspace: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project || !/^[\w-]+$/.test(sessionId)) return undefined;
  let file: string;
  try {
    ({ text: file } = await readSession(
      spawn,
      `./${project}/${sessionId}.jsonl`,
      signal,
      (text) => text.includes('"ai-title"'),
    ));
  } catch (error) {
    signal.throwIfAborted();
    if (/no such file/i.test(error instanceof Error ? error.message : ""))
      return undefined;
    throw error;
  }
  let title: string | undefined;
  for (const line of file.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const record = object(JSON.parse(line));
      const value = str(record?.aiTitle).trim();
      if (record?.type === "ai-title" && value) title = value;
    } catch {
      // A partial last line is still being written.
    }
  }
  return title;
}

/** The conversation's transcript across its sessions, or undefined when this
 * computer has no file for it: deleted, or started in a workspace the agent
 * no longer uses. */
export async function readTranscript(
  spawn: Spawn,
  workspace: string,
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
  nameOf?: Names,
): Promise<ClaudeTranscript | undefined> {
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project) return undefined;
  const saved = conversation.sessionId && `${conversation.sessionId}.jsonl`;
  // The agent starts a new session when it cannot resume one, e.g. in
  // another build of the app, which keeps its own saved sessions. A failed
  // listing still finds the saved one, and a partly failed search the
  // sessions it did search; the transcript says it may be missing some.
  let failure: unknown;
  const starts = await readProject(spawn, project).then(
    (state) => {
      failure = state.incomplete;
      return state.starts;
    },
    (error: unknown) => {
      failure = error;
      return new Map<string, Start>();
    },
  );
  const names = new Set([
    ...(saved ? [saved] : []),
    ...[...starts]
      .filter(([, start]) => indexedFor(start, conversation))
      .map(([name]) => name),
  ]);
  signal.throwIfAborted();
  const turns: TranscriptTurn[] = [];
  let found = false;
  let cut = false;
  // A cut session's older turns are left, so other sessions' turns before its
  // first kept one would leave a gap; the transcript starts there instead.
  let since = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    const session = {
      sessionId: name.slice(0, -".jsonl".length),
      channelId: conversation.channelId,
      ...(conversation.root ? { root: conversation.root } : {}),
    };
    let file: Awaited<ReturnType<typeof readSession>>;
    try {
      // Project names start with `-`; GNU base64 would read one as options.
      file = await readSession(
        spawn,
        `./${project}/${name}`,
        signal,
        (text) => claudeTurns(text, session, false).length > TURN_LIMIT,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (/no such file/i.test(error instanceof Error ? error.message : ""))
        continue;
      throw error;
    }
    if (name !== saved && !startedFor(await file.start(), conversation))
      continue;
    found = true;
    const own = claudeTurns(
      file.text,
      session,
      working && name === saved,
      nameOf,
    );
    cut ||= file.cut;
    if (file.cut) {
      // Its first kept turn did not start the session, and with none kept
      // (one record larger than the budget) nothing older is contiguous.
      if (own[0]) own[0].newSession = false;
      since = Math.max(since, own[0]?.startedAt ?? Number.POSITIVE_INFINITY);
    }
    turns.push(...own);
  }
  // Nothing found is no transcript only when every file was searched.
  if (!found) {
    if (failure) throw failure;
    return undefined;
  }
  const kept = turns
    .filter((turn) => turn.startedAt >= since)
    .sort((a, b) => a.startedAt - b.startedAt);
  return {
    turns: kept.slice(-TURN_LIMIT),
    more: cut || turns.length > TURN_LIMIT,
    ...(failure
      ? {
          incomplete:
            failure instanceof Error ? failure.message : String(failure),
        }
      : {}),
  };
}
