// Goose transcript projection adapted from Salman’s #1010 (9706e746).
// Inline Mesh runs retain a volatile display trace.
import {
  promptMessage,
  promptSections,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
/** Maximum turns displayed from the volatile trace. */
export const TURN_LIMIT = 50;
const STEER = "new-message-arrived-while-you-were-working";

type Json = Record<string, unknown>;
/** A message as goose saves it. */
type Message = {
  id?: string | null;
  role: string;
  created: number;
  content: Json[];
  metadata?: { userVisible?: boolean; steer?: boolean };
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
const KINDS: Record<string, string> = {
  shell: "execute",
  edit: "edit",
  write: "edit",
  tree: "search",
  read_image: "read",
};

/** A Buzz prompt, or a steer wrapping one, as the turn's opening item. */
function prompt(id: string, at: number, raw: string, steered: boolean) {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  if (steer) sections = promptSections(steer.body);
  const { text, author } = promptMessage(sections);
  return {
    id,
    at,
    type: "prompt" as const,
    text: text || steer?.body || raw,
    ...(author ? { author } : {}),
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
      const item = prompt(id, at, raw, message.metadata?.steer === true);
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
      else if (block.type === "toolRequest") {
        const call = object(block.toolCall);
        const value = object(call?.value) ?? {};
        const name = str(value.name);
        const input = object(value.arguments) ?? {};
        const callId = str(block.id);
        if (name === "buzz__send" && str(input.text).trim()) {
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
          kind: KINDS[name.split("__").at(-1) ?? name] ?? "other",
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
  return turns;
}

export type MeshHistoryRow = GooseSessionRow & Place;
/** Read-only trace source; no process or session database. */
export interface MeshHistory {
  recent(
    agent: string,
    workspace: string,
    signal: AbortSignal,
  ): Promise<MeshHistoryRow[]>;
  transcript(
    agent: string,
    workspace: string,
    row: MeshHistoryRow,
    signal: AbortSignal,
  ): Promise<GooseTranscript>;
}
