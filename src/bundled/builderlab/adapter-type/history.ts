// A remote agent's stored sessions as the host's turn-transcript model.
// Builderlab keeps the messages; nothing here writes or keeps them.
import { isMessageTool } from "../../../buzz-mcp/message-tools";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../../features/agents/activity-transcript";
import { terminalOutcome } from "../../../features/agents/observer";
import type { AgentClient, AgentSession } from "../agents/client";
import { managementTimestamp as millis } from "../management-date";
import type { BuilderlabSession, LoginSnapshot } from "../session";

type Json = Record<string, unknown>;
type Names = (pubkey: string) => string | undefined;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const list = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = object(entry);
    return item ? [item] : [];
  });
const str = (value: unknown) => (typeof value === "string" ? value : "");
/** Protobuf JSON names an enum, or may send its number. */
const enumName = (value: unknown, names: readonly string[]) =>
  typeof value === "number" ? (names[value] ?? "") : str(value);
const ROLES = ["ROLE_UNSPECIFIED", "ROLE_USER", "ROLE_ASSISTANT"];
const STATUSES = [
  "TASK_STATUS_UNSPECIFIED",
  "TASK_STATUS_INITIALIZED",
  "TASK_STATUS_IN_PROGRESS",
  "TASK_STATUS_CLIENT_INPUT_PENDING",
  "TASK_STATUS_COMPLETED",
  "TASK_STATUS_FAILED",
  "TASK_STATUS_CANCELLING",
  "TASK_STATUS_CANCELLED",
  "TASK_STATUS_TERMINATED",
  "TASK_STATUS_WAITING_FOR_PERMISSION_LEASE",
];
const SUMMARY = 5;
const REMOVAL_STATES = [
  "SESSION_REMOVAL_STATE_UNSPECIFIED",
  "SESSION_REMOVAL_STATE_REMOVED",
];
/** The prompt composer escapes these in every value it writes. */
const decodeEntities = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The composer writes a sender as its label, then its keys, then whether
 * they are the owner: `Name (username: …, npub: …, hex: …). This sender …`. */
const SENDER =
  /^From: (.+?)(?: \((?:username: [^,()]*, )?(?:npub: [^,()]*, )?hex: ([0-9a-f]{64})\))?\. This sender .*$/gm;
const EVENT_ID = /^Event ID: (\S+)$/gm;
/** Tool results are text, or other content shown as JSON. */
const resultText = (results: unknown) =>
  list(results)
    .map((result) => {
      const text = object(result.text);
      return text ? str(text.text) : JSON.stringify(result, null, 2);
    })
    .filter(Boolean)
    .join("\n");

function prompt(id: string, at: number, raw: string, name?: Names) {
  const sections = promptSections(raw);
  // Each sender is read as its name alone, so a batch lists every author.
  const senders = raw.replace(
    SENDER,
    (_, label: string, pubkey?: string) =>
      `From: ${(pubkey && name?.(pubkey)) || label}`,
  );
  const { text, author, authorPubkey } = promptMessage(
    promptSections(senders),
    name,
  );
  const item: TranscriptItem = {
    id,
    at,
    type: "prompt",
    text: text ? decodeEntities(text) : raw,
    ...(author ? { author: decodeEntities(author) } : {}),
    ...(authorPubkey ? { authorPubkey } : {}),
    sections,
    steer: sections.some((section) => section.tag === STEER),
  };
  return item;
}

/** A stored session's turns, oldest first. Messages carry no turn: a prompt
 * joins the turn its mention started, and any other message the latest turn
 * started at or before it, never one before the last prompt's. A message
 * older than every turn joins the first. */
export function sessionTurns(
  session: AgentSession,
  response: Json,
  name?: Names,
): TranscriptTurn[] {
  const turns = list(response.turns)
    .flatMap((row): TranscriptTurn[] => {
      const turnId = str(row.turn_id);
      const startedAt = millis(row.created_at);
      if (!turnId || startedAt === undefined) return [];
      const status = enumName(row.status, STATUSES).replace("TASK_STATUS_", "");
      const outcome = terminalOutcome("turn_completed", status.toLowerCase());
      const ended = outcome && outcome !== "unknown";
      const updatedAt = millis(row.updated_at);
      const mention = str(row.mention_event_id);
      return [
        {
          turnId,
          channelId: session.channelId,
          threadRootId: session.threadRootId ?? null,
          triggeringEventIds: mention ? [mention] : [],
          sessionId: session.sessionId,
          newSession: false,
          config: [],
          startedAt,
          ...(ended
            ? { outcome, endedAt: Math.max(updatedAt ?? startedAt, startedAt) }
            : {}),
          partial: false,
          items: [],
        },
      ];
    })
    .sort((a, b) => a.startedAt - b.startedAt);
  if (turns[0]) turns[0].newSession = true;
  const tools = new Map<string, ToolItem>();
  const sends = new Map<string, { posted?: boolean }>();
  const mentioned = new Map(
    turns.flatMap((turn) =>
      turn.triggeringEventIds.map((event) => [event, turn] as const),
    ),
  );
  // In time order, so a tool's result never arrives before its request.
  const messages = list(response.messages)
    .map((message) => ({ message, at: millis(message.created) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let floor = 0;
  for (const { message, at } of messages) {
    const id = str(message.id);
    if (message.deleted === true || at === undefined || !id) continue;
    const role = enumName(message.role, ROLES);
    // A prompt is stamped apart from its turn, so the mention it carries
    // places it before its time does.
    const prompted =
      role === "ROLE_USER"
        ? list(message.content)
            .flatMap((content) => [
              ...str(object(content.text)?.text).matchAll(EVENT_ID),
            ])
            .map((match) => mentioned.get(match[1] ?? ""))
            .find((turn) => turn !== undefined)
        : undefined;
    const index = prompted
      ? turns.indexOf(prompted)
      : Math.max(
          turns.reduce(
            (last, turn, position) => (turn.startedAt <= at ? position : last),
            -1,
          ),
          floor,
        );
    if (prompted) floor = index;
    const turn = turns[index];
    if (!turn) break;
    const error = object(message.llm_call_error_info);
    if (error?.is_error === true)
      turn.error = str(error.cause) || "The model call failed.";
    list(message.content).forEach((content, index) => {
      const key = `${id}:${index}`;
      const text = str(object(content.text)?.text);
      const request = object(content.tool_request);
      const response = object(content.tool_response);
      if (response) {
        const callId = str(response.id);
        if (!callId) return;
        const failed = str(response.status) === "error";
        const sent = sends.get(callId);
        if (sent && !failed) sent.posted = true;
        const tool = tools.get(callId);
        if (!tool) return;
        tool.output = str(response.error) || resultText(response.results);
        tool.status = failed ? "failed" : "completed";
        tool.completedAt = at;
      } else if (request) {
        const call = object(request.value);
        const title = str(call?.name);
        const input = str(call?.arguments);
        // A call without an id has no result to pair with, so it keeps its own key.
        const callId = str(request.id) || key;
        let args: Json | undefined;
        try {
          args = object(JSON.parse(input));
        } catch {}
        const posted = /^(?:mcp__)?buzz__(\w+)$/.exec(title)?.[1];
        if (posted && isMessageTool(posted) && str(args?.text).trim()) {
          const message: TranscriptItem & { posted?: boolean } = {
            id: key,
            at,
            type: "message",
            text: str(args?.text),
          };
          turn.items.push(message);
          sends.set(callId, message);
          return;
        }
        const path = str(args?.path) || str(args?.file_path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: callId,
          title: title || "Tool",
          kind: "other",
          status: str(request.error) ? "failed" : "in_progress",
          input: args ? JSON.stringify(args, null, 2) : input,
          output: str(request.error),
          diffs: [],
          paths: path ? [path] : [],
          truncated: false,
        };
        tools.set(callId, tool);
        turn.items.push(tool);
      } else if (
        content.type === "MESSAGE_TYPE_SUMMARY" ||
        content.type === SUMMARY
      ) {
        turn.items.push({
          id: key,
          at,
          type: "status",
          text: "Earlier messages were summarized.",
        });
      } else if (object(content.thinking)) {
        const thought = str(object(content.thinking)?.thinking);
        if (thought.trim())
          turn.items.push({ id: key, at, type: "thought", text: thought });
      } else if (text.trim()) {
        if (role === "ROLE_USER") turn.items.push(prompt(key, at, text, name));
        else turn.items.push({ id: key, at, type: "message", text });
      }
    });
  }
  return turns;
}

export type SessionList =
  | Readonly<{
      status: "loaded";
      sessions: readonly AgentSession[];
      more: boolean;
      /** Builderlab's id for the agent, absent when it has none. */
      agentId?: string;
    }>
  | Readonly<{ status: "signed-out" | "unsupported" }>;

const notFound = (error: unknown) =>
  error instanceof Error && "status" in error && error.status === 404;

/** Whether the owner is signed in to Builderlab with remote agents, so its
 * stored sessions can be read. */
export const canReadSessions = (login: LoginSnapshot) =>
  login.status === "signed-in" && !!login.account?.canUseRemoteAgents;

/** The signed-in owner's stored sessions of an agent, most recently active
 * first. */
export async function listSessions(
  client: AgentClient,
  session: BuilderlabSession,
  pubkey: string,
  signal: AbortSignal,
): Promise<SessionList> {
  if (!canReadSessions(session.snapshot())) return { status: "signed-out" };
  const agent = (await client.list(signal)).find(
    (row) => row.pubkey === pubkey,
  );
  if (!agent) return { status: "loaded", sessions: [], more: false };
  try {
    return {
      status: "loaded",
      agentId: agent.id,
      ...(await client.sessions(agent.id, signal)),
    };
  } catch (error) {
    // A Builderlab without stored sessions has no such route.
    if (notFound(error)) return { status: "unsupported" };
    throw error;
  }
}

/** Turns a stored transcript shows at most, as local transcripts do. */
export const TURN_LIMIT = 50;
export type StoredTranscript = Transcript & Readonly<{ more: boolean }>;

/** A stored session's latest turns, at most {@link TURN_LIMIT}; undefined once
 * Builderlab no longer has it, or it was removed. */
export async function readSession(
  client: AgentClient,
  session: AgentSession,
  signal: AbortSignal,
  name?: Names,
): Promise<StoredTranscript | undefined> {
  let response: Json | undefined;
  try {
    response = object(await client.sessionMessages(session.sessionId, signal));
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  if (
    !response ||
    enumName(response.removal_state, REMOVAL_STATES) ===
      "SESSION_REMOVAL_STATE_REMOVED"
  )
    return undefined;
  const turns = sessionTurns(session, response, name);
  return {
    turns: turns.slice(-TURN_LIMIT),
    more: response.has_earlier_turns === true || turns.length > TURN_LIMIT,
  };
}
