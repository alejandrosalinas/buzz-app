// A conversation's goose sessions, read back through a short-lived `goose-acp`
// and shown in the host's turn-transcript model. goose keeps the sessions in
// its own database; nothing here writes or keeps them.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import { type GooseHost, type GooseProcess, REQUEST_TIMEOUT_MS } from "./goose";
import { absolute, abortable } from "./sessions";
import { briefly } from "./setup";

/** The latest turns shown; goose keeps the rest. */
export const TURN_LIMIT = 50;
/** Sessions read for one conversation, newest first. */
const SESSION_LIMIT = 10;
/** The agent's recent sessions listed. */
export const RECENT_LIMIT = 30;

type Json = Record<string, unknown>;
/** A message as goose saves it. */
export type Message = {
  id?: string | null;
  role: string;
  created: number;
  content: Json[];
  metadata?: {
    userVisible?: boolean;
    steer?: boolean;
    usage?: unknown;
    inference?: unknown;
  };
};
/** A place the agent talks in: a channel, or a thread in one. */
export type Place = Readonly<{ channelId: string; root?: string }>;
/** A goose session the agent ran, as goose lists it. */
export type GooseSessionRow = Readonly<{
  sessionId: string;
  title: string;
  at: number;
}>;
export type GooseTranscript = Transcript & { more: boolean };

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const texts = (content: readonly Json[]) =>
  content
    .filter((block) => block.type === "text")
    .map((block) => str(block.text))
    .filter(Boolean)
    .join("\n");
/** The `systemNotification` blocks that say something lasting. */
const NOTICES = new Set(["inlineMessage", "creditsExhausted"]);
const KINDS: Record<string, string> = {
  shell: "execute",
  edit: "edit",
  write: "edit",
  tree: "search",
  read_image: "read",
};

/** A person's display name, if known. */
type Names = (pubkey: string) => string | undefined;
/** A Buzz prompt, or a steer, as the turn's opening item. */
function prompt(
  id: string,
  at: number,
  raw: string,
  steered: boolean,
  name?: Names,
) {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  // An older steer wraps a whole turn.
  if (steer && !readEventBody(steer.body))
    sections = promptSections(steer.body);
  const { text, author, authorPubkey } = promptMessage(sections, name);
  return {
    id,
    at,
    type: "prompt" as const,
    text: text || raw,
    ...(author ? { author } : {}),
    ...(authorPubkey ? { authorPubkey } : {}),
    sections,
    steer: steered || !!steer,
  };
}

/** A tool result's text, or why the call failed. */
function result(value: unknown) {
  const outcome = object(value);
  if (outcome?.status === "error")
    return { failed: true, text: str(outcome.error) };
  const call = object(outcome?.value);
  const content = Array.isArray(call?.content) ? (call.content as Json[]) : [];
  return { failed: call?.isError === true, text: texts(content) };
}

/** A session's messages as turns, each opened by a Buzz prompt. Messages goose
 * hides from its own UI (the turn context it adds) are left out. */
export function gooseTurns(
  messages: readonly Message[],
  conversation: Place & { sessionId: string },
  working: boolean,
  name?: Names,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, ToolItem>();
  /** Messages sent with send, until their result says whether they posted. */
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
  messages.forEach((message, position) => {
    if (message.metadata?.userVisible === false) return;
    const id = message.id || `${conversation.sessionId}:${position}`;
    const at = message.created * 1000 || last;
    const content = Array.isArray(message.content) ? message.content : [];
    const responses = content.filter((block) => block.type === "toolResponse");
    if (message.role === "user" && !responses.length) {
      const raw = texts(content);
      if (!raw.trim()) return;
      const item = prompt(id, at, raw, message.metadata?.steer === true, name);
      const current = item.steer ? turns.at(-1) : undefined;
      (current ?? turn(id, at, false)).items.push(item);
      last = at;
      return;
    }
    const current = turns.at(-1) ?? turn(id, at, true);
    last = at;
    for (const response of responses) {
      const callId = str(response.id);
      const { failed, text } = result(response.toolResult);
      const sent = sends.get(callId);
      if (sent && !failed) sent.message.posted = true;
      else if (sent)
        sent.turn.items.push({
          id: `${id}:${callId}`,
          at,
          type: "status",
          text: `The message above was not posted: ${text}`,
        });
      const tool = tools.get(callId);
      if (!tool) continue;
      tool.output = text;
      tool.status = failed ? "failed" : "completed";
      tool.completedAt = at;
    }
    content.forEach((block, index) => {
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
      // A provider or auth failure, which is often all a failed turn has.
      else if (block.type === "error" && str(block.message).trim()) {
        current.error = str(block.message);
        current.items.push({
          id: key,
          at,
          type: "status",
          text: str(block.message),
        });
      }
      // What goose showed in its own UI; progress and thinking notes pass.
      else if (
        block.type === "systemNotification" &&
        NOTICES.has(str(block.notificationType)) &&
        str(block.msg).trim()
      )
        current.items.push({
          id: key,
          at,
          type: "status",
          text: str(block.msg),
        });
      else if (block.type === "toolRequest") {
        const call = object(block.toolCall);
        const value = object(call?.value) ?? {};
        const name = str(value.name);
        const input = object(value.arguments) ?? {};
        const callId = str(block.id);
        if (
          name.startsWith("buzz__") &&
          isMessageTool(name.slice("buzz__".length)) &&
          str(input.text).trim()
        ) {
          const message: TranscriptItem & { posted?: boolean } = {
            id: key,
            at,
            type: "message",
            text: str(input.text),
          };
          current.items.push(message);
          sends.set(callId, { turn: current, message });
          return;
        }
        const path = str(input.path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: callId,
          // Extension tools as Codex names them: buzz.read, not buzz__read.
          title: str(input.command) || name.replace("__", ".") || "Tool",
          kind: KINDS[name] ?? "other",
          status: call?.status === "error" ? "failed" : "in_progress",
          input: JSON.stringify(input, null, 2),
          output: call?.status === "error" ? str(call.error) : "",
          diffs: [],
          paths: path ? [path] : [],
          truncated: false,
        };
        tools.set(callId, tool);
        current.items.push(tool);
      }
    });
  });
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  // goose returns a session's every message, from its start.
  if (turns[0] && !turns[0].partial) turns[0].newSession = true;
  return turns;
}

/** A field of the context a session's first prompt carries, such as its
 * `Agent`; undefined when that prompt carries none. */
function opening(messages: readonly Message[]) {
  for (const message of messages) {
    if (message.role !== "user" || message.metadata?.userVisible === false)
      continue;
    const raw = texts(Array.isArray(message.content) ? message.content : []);
    if (!raw.trim()) continue;
    const context = promptSections(raw).find(
      (section) => section.tag === "context",
    )?.body;
    if (!context) return undefined;
    return (name: string) =>
      context.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
  }
  return undefined;
}

/** The agent a session's first prompt names, if any. */
export const ownerOf = (messages: readonly Message[]) =>
  opening(messages)?.("Agent");

/** Whether a session was started for the agent in `place`: its first prompt's
 * context names the same agent, channel and, for a thread, thread root. */
export function startedFor(
  messages: readonly Message[],
  agent: string,
  place: Place,
) {
  const field = opening(messages);
  return (
    !!field &&
    field("Agent") === agent &&
    !!field("Channel")?.endsWith(`(#${place.channelId})`) &&
    (place.root
      ? field("Session scope") === "thread" &&
        field("Thread root") === place.root
      : field("Session scope") !== "thread")
  );
}

type Listed = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
};

/** A page of the goose sessions in the workspace, newest first; `query`
 * keeps those whose messages mention it. */
async function page(
  goose: GooseProcess,
  cwd: string,
  query?: string,
  cursor?: string,
) {
  const { sessions, nextCursor } = (await goose.request(
    "session/list",
    {
      cwd,
      ...(cursor ? { cursor } : {}),
      _meta: { types: ["acp"], ...(query ? { query } : {}) },
    },
    REQUEST_TIMEOUT_MS,
  )) as { sessions: Listed[]; nextCursor?: string | null };
  return {
    rows: sessions.map(
      (session): GooseSessionRow => ({
        sessionId: session.sessionId,
        title: session.title ?? "",
        at: Date.parse(session.updatedAt ?? "") || 0,
      }),
    ),
    next: (sessions.length && nextCursor) || undefined,
  };
}

/** The first page of the agent's goose sessions in the workspace, newest
 * first; `query` keeps those whose messages mention it. */
async function list(goose: GooseProcess, cwd: string, query?: string) {
  return (await page(goose, cwd, query)).rows;
}

/** Every goose session in the workspace. Without a query a page is an index
 * lookup; with one, the SQLite goose bundles (3.51) parses each session's
 * messages again for every message in it, which takes seconds. */
async function all(goose: GooseProcess, cwd: string) {
  const rows: GooseSessionRow[] = [];
  let cursor: string | undefined;
  do {
    const read = await page(goose, cwd, undefined, cursor);
    rows.push(...read.rows);
    cursor = read.next;
  } while (cursor);
  return rows;
}

async function messages(goose: GooseProcess, sessionId: string) {
  const { data } = (await goose.request(
    "_goose/unstable/session/export",
    { sessionId, format: "json" },
    REQUEST_TIMEOUT_MS,
  )) as { data: string };
  const session = object(JSON.parse(data));
  return (
    Array.isArray(session?.conversation) ? session.conversation : []
  ) as Message[];
}

/** A listed session's messages; none for one goose deleted since it listed it. */
const listed = (goose: GooseProcess, sessionId: string) =>
  messages(goose, sessionId).catch((error): Message[] => {
    if (/not found/i.test(String(error))) return [];
    throw error;
  });

/** What a session's transcript is read for: one session, or every session the
 * agent ran for a place. */
export type Lookup = Readonly<{
  /** The agent's membership key, as its turn prompts name it. */
  agent: string;
  workspace: string;
  sessionId?: string;
  /** The ids saved for `place`, read without searching goose. */
  sessions?: readonly string[];
  place?: Place;
  /** Also search goose's history for the place's sessions, which takes
   * seconds; for one that saved no ids. */
  search?: boolean;
  /** The session still working, whose last turn has not ended. */
  working?: string;
}>;

/** goose's history for an agent, each read in its own short-lived `goose-acp`. */
export class GooseHistory {
  constructor(private readonly host: GooseHost | undefined) {}
  /** The last transcript read's messages, by session. */
  private exported = new Map<string, Message[]>();

  /** Every session in `workspace` used since `since`, newest first, and the
   * messages of those `wanted` picks, all from one `goose-acp`: every agent
   * in a workspace reads its sessions from one listing. */
  workspace(
    workspace: string,
    since: number,
    wanted: (row: GooseSessionRow) => boolean,
    signal: AbortSignal,
  ) {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const cwd = await absolute(resolveDirectory, workspace);
      const rows = (await all(goose, cwd)).filter((row) => row.at >= since);
      const messages = new Map<string, Message[]>();
      for (const row of rows) {
        if (!wanted(row)) continue;
        signal.throwIfAborted();
        messages.set(row.sessionId, await listed(goose, row.sessionId));
      }
      return { rows, messages };
    });
  }

  /** The listed rows of `ids`, read from goose's sessions in `workspace`
   * newest first, page by page, until every one is found or none are left:
   * no search and no session's messages. */
  listed(workspace: string, ids: ReadonlySet<string>, signal: AbortSignal) {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const cwd = await absolute(resolveDirectory, workspace);
      const found = new Map<string, GooseSessionRow>();
      let cursor: string | undefined;
      do {
        const read = await page(goose, cwd, undefined, cursor);
        for (const row of read.rows)
          if (ids.has(row.sessionId)) found.set(row.sessionId, row);
        cursor = read.next;
        signal.throwIfAborted();
      } while (cursor && found.size < ids.size);
      return found;
    });
  }

  /** The latest turns of the lookup's sessions, oldest first, or undefined
   * when goose has none of them. */
  transcript(
    lookup: Lookup,
    signal: AbortSignal,
    name?: Names,
    reuse = false,
  ): Promise<GooseTranscript | undefined> {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const saved = new Set(lookup.sessions);
      const ids = new Set([
        ...(lookup.sessionId ? [lookup.sessionId] : []),
        ...saved,
      ]);
      if (lookup.place && lookup.search) {
        const cwd = await absolute(resolveDirectory, lookup.workspace);
        for (const row of await candidates(goose, cwd, lookup.place))
          ids.add(row.sessionId);
      }
      const turns: TranscriptTurn[] = [];
      let found = false;
      // With `reuse`, while one session works, the others' messages are as
      // last exported.
      const exported = new Map<string, Message[]>();
      for (const sessionId of ids) {
        let read: Message[];
        signal.throwIfAborted();
        const kept = reuse && lookup.working && this.exported.get(sessionId);
        try {
          read =
            kept && sessionId !== lookup.working
              ? kept
              : await messages(goose, sessionId);
        } catch (error) {
          if (/not found/i.test(String(error))) continue;
          throw error;
        }
        signal.throwIfAborted();
        exported.set(sessionId, read);
        if (
          lookup.place &&
          sessionId !== lookup.sessionId &&
          !saved.has(sessionId) &&
          !startedFor(read, lookup.agent, lookup.place)
        )
          continue;
        found = true;
        turns.push(
          ...gooseTurns(
            read,
            { sessionId, ...(lookup.place ?? { channelId: "" }) },
            sessionId === lookup.working,
            name,
          ),
        );
      }
      this.exported = exported;
      if (!found) return undefined;
      turns.sort((a, b) => a.startedAt - b.startedAt);
      return {
        turns: turns.slice(-TURN_LIMIT),
        more: turns.length > TURN_LIMIT,
      };
    });
  }

  private async with<T>(
    signal: AbortSignal,
    run: (goose: GooseProcess, host: GooseHost) => Promise<T>,
  ) {
    const { host } = this;
    if (!host) throw new Error("goose runs only in the desktop app");
    // Cancelling rejects at once, and `briefly` then stops goose, or stops
    // its startup.
    return briefly(
      host,
      (goose) => {
        signal.throwIfAborted();
        return abortable(run(goose, host), signal);
      },
      {},
      signal,
    );
  }
}

/** The workspace's sessions whose messages mention the place, newest first. */
async function candidates(goose: GooseProcess, cwd: string, place: Place) {
  return (await list(goose, cwd, place.root ?? place.channelId)).slice(
    0,
    SESSION_LIMIT,
  );
}
