// A conversation's goose sessions, read back through a short-lived `goose-acp`
// and shown in the host's turn-transcript model. goose keeps the sessions in
// its own database; nothing here writes or keeps them.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import {
  postedAs,
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
  withNotices,
} from "../../features/agents/activity-transcript";
import { STEER_NOTE } from "../claude-code/prompt";
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
export type Place = Readonly<{
  channelId: string;
  root?: string;
  community?: true;
}>;
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

/** The suffix Buzz ends a fallback wake's prompt with, naming the turn only so
 * its notice shows beside it: never a wake's or the gateway's id. */
const MARK =
  /\n\n<buzz-turn id="([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\/>$/;
export const marked = (text: string, id: string) =>
  `${text}\n\n<buzz-turn id="${id}"/>`;
/** `text`, which Buzz didn't mark, with every mark-like tag in it escaped, as
 * `unframed` escapes a section's: whatever a steer later adds or trims, no
 * mark is read from it. */
export const unforged = (text: string) =>
  text.replace(/<(?=buzz-turn)/g, "<\\");
/** What a steer adds after a marked wake: its note, and, for a wake it wraps
 * whole, the end of its section. */
const STEERED = [`\n</${STEER}>${STEER_NOTE}`, STEER_NOTE];
/** `raw` without Buzz's suffix, and the turn it names. Only the very end, or
 * what a steer adds after it, counts, so the same text quoted within the
 * prompt stays as it is. */
export function unmarked(raw: string): { text: string; turn?: string } {
  const tail = STEERED.find((end) => raw.endsWith(end)) ?? "";
  const match = MARK.exec(raw.slice(0, raw.length - tail.length));
  const turn = match?.[1];
  return match && turn
    ? { text: raw.slice(0, match.index) + tail, turn }
    : { text: raw };
}

/** A Buzz prompt, or a steer, as the turn's opening item, and the turn Buzz
 * marked it as, if any. */
function prompt(
  id: string,
  at: number,
  raw: string,
  steered: boolean,
  name?: Names,
) {
  const { text: shown, turn } = unmarked(raw);
  let sections = promptSections(shown);
  const steer = sections.find((section) => section.tag === STEER);
  // An older steer wraps a whole turn.
  if (steer && !readEventBody(steer.body))
    sections = promptSections(steer.body);
  const { text, author, authorPubkey } = promptMessage(sections, name);
  return {
    turn,
    item: {
      id,
      at,
      type: "prompt" as const,
      text: text || shown,
      ...(author ? { author } : {}),
      ...(authorPubkey ? { authorPubkey } : {}),
      sections,
      steer: steered || !!steer,
    },
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
  /** Notices by the turn Buzz marked their prompts as. */
  notices?: ReadonlyMap<string, string>,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  /** Notices by the id goose gave their prompts. */
  const noticed = new Map<string, string>();
  const tools = new Map<string, ToolItem>();
  /** Messages sent with send, until their result says whether they posted. */
  const sends = new Map<
    string,
    {
      turn: TranscriptTurn;
      message: { posted?: boolean; messageId?: string };
    }
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
      const { item, turn: marked } = prompt(
        id,
        at,
        raw,
        message.metadata?.steer === true,
        name,
      );
      const notice = marked && notices?.get(marked);
      if (notice) noticed.set(id, notice);
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
      if (sent && !failed) Object.assign(sent.message, postedAs(text));
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
  return noticed.size ? withNotices(turns, noticed) : turns;
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

/** The tags a Buzz session opens with, which goose indexes: the agent's
 * membership key, and the conversation's key (its channel, or `channel/root`
 * for a thread). A one-off turn has no conversation. */
export const sessionTags = (agent: string, conversation?: string) => ({
  "buzz.agent": agent,
  ...(conversation ? { "buzz.conversation": conversation } : {}),
});
const conversationOf = (place: Place) =>
  place.community
    ? "@community"
    : place.root
      ? `${place.channelId}/${place.root}`
      : place.channelId;

type Listed = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
};

/** A page of the goose sessions in the workspace, newest first; `tags`
 * keeps those opened with every one of them, an index lookup. */
async function page(
  goose: GooseProcess,
  cwd: string,
  cursor?: string,
  tags?: Readonly<Record<string, string>>,
) {
  const { sessions, nextCursor } = (await goose.request(
    "session/list",
    {
      cwd,
      ...(cursor ? { cursor } : {}),
      _meta: { types: ["acp"], ...(tags ? { tags } : {}) },
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

/** Every goose session in the workspace. */
async function all(goose: GooseProcess, cwd: string) {
  const rows: GooseSessionRow[] = [];
  let cursor: string | undefined;
  do {
    const read = await page(goose, cwd, cursor);
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
  /** The ids saved for `place`, read without listing goose's sessions. */
  sessions?: readonly string[];
  /** Where the sessions ran, found by their tags when no saved id is. */
  place?: Place;
  /** The session still working, whose last turn has not ended. */
  working?: string;
}>;

/** goose's history for an agent, each read in its own short-lived `goose-acp`. */
export class GooseHistory {
  constructor(private readonly host: GooseHost | undefined) {}
  /** The last transcript read's messages, by session. */
  private exported = new Map<string, Message[]>();

  /** The `folders` other than `workspace`, as written or as goose's
   * listing of it names it. */
  async elsewhere(workspace: string, folders: readonly string[]) {
    const { host } = this;
    if (!host || !folders.length) return folders;
    const named = await absolute(host.resolveDirectory, workspace);
    return folders.filter((folder) => folder !== workspace && folder !== named);
  }

  /** Every session in the `workspaces` used since `since`, newest first, and
   * the messages of those `wanted` picks, all from one `goose-acp`: every
   * agent in a workspace reads its sessions from one listing. */
  workspace(
    workspaces: readonly string[],
    since: number,
    wanted: (row: GooseSessionRow) => boolean,
    signal: AbortSignal,
  ) {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      // By id: two of them may name one folder.
      const sessions = new Map<string, GooseSessionRow>();
      for (const workspace of workspaces)
        for (const row of await all(
          goose,
          await absolute(resolveDirectory, workspace),
        ))
          sessions.set(row.sessionId, row);
      const rows = [...sessions.values()]
        .filter((row) => row.at >= since)
        .sort((a, b) => b.at - a.at);
      const messages = new Map<string, Message[]>();
      for (const row of rows) {
        if (!wanted(row)) continue;
        signal.throwIfAborted();
        messages.set(row.sessionId, await listed(goose, row.sessionId));
      }
      return { rows, messages };
    });
  }

  /** Whether goose has a session the agent opened for `conversation` in
   * `workspace`, by its tag index, which holds sessions the app no longer
   * lists. */
  started(
    workspace: string,
    agent: string,
    conversation: string,
    signal: AbortSignal,
  ) {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const cwd = await absolute(resolveDirectory, workspace);
      const tags = sessionTags(agent, conversation);
      return (await page(goose, cwd, undefined, tags)).rows.length > 0;
    });
  }

  /** The listed rows of `ids`, read from goose's sessions in `workspace`
   * newest first, page by page, until every one is found or none are left:
   * no session's messages. */
  listed(workspace: string, ids: ReadonlySet<string>, signal: AbortSignal) {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const cwd = await absolute(resolveDirectory, workspace);
      const found = new Map<string, GooseSessionRow>();
      let cursor: string | undefined;
      do {
        const read = await page(goose, cwd, cursor);
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
    notices?: ReadonlyMap<string, string>,
  ): Promise<GooseTranscript | undefined> {
    return this.with(signal, async (goose, { resolveDirectory }) => {
      const turns: TranscriptTurn[] = [];
      let found = false;
      // With `reuse`, while one session works, the others' messages are as
      // last exported.
      const exported = new Map<string, Message[]>();
      const readAll = async (ids: Iterable<string>) => {
        for (const sessionId of new Set(ids)) {
          if (exported.has(sessionId)) continue;
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
          found = true;
          turns.push(
            ...gooseTurns(
              read,
              { sessionId, ...(lookup.place ?? { channelId: "" }) },
              sessionId === lookup.working,
              name,
              notices,
            ),
          );
        }
      };
      await readAll([
        ...(lookup.sessionId ? [lookup.sessionId] : []),
        ...(lookup.sessions ?? []),
      ]);
      // When goose has none of the saved ids, its tag index finds the place's.
      if (!found && lookup.place) {
        const cwd = await absolute(resolveDirectory, lookup.workspace);
        await readAll(await tagged(goose, cwd, lookup.agent, lookup.place));
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

/** The agent's latest sessions goose tagged with the place's conversation,
 * newest first. */
async function tagged(
  goose: GooseProcess,
  cwd: string,
  agent: string,
  place: Place,
) {
  const tags = sessionTags(agent, conversationOf(place));
  return (await page(goose, cwd, undefined, tags)).rows
    .slice(0, SESSION_LIMIT)
    .map((row) => row.sessionId);
}
