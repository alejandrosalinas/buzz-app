import { TOP_LEVEL_PROMPT, CHANNEL_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import { MENTION_PROMPT } from "../../features/agent-harness/base-prompt";
import { coreMemorySection } from "../../features/agent-harness/core-memory";
import {
  type ConversationWake,
  unframed,
  wakeSection,
} from "../../features/agent-harness/plugin-wake";
import type { Facts } from "../../features/agent-harness/sections/index";
import type { AgentKey } from "../../features/agents/membership";
import type { AgentHandle } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import {
  type AuthorNames,
  eventBody,
  quoted,
} from "../../features/agent-harness/turn-records";
import type { Config } from "./config";

/** A conversation's routing default. Solo chats forbid replies; an addressed
 * channel wake allows the Interest to direct a thread reply. */
export type Conversation = {
  channelId: string;
  community?: true;
  name: string;
  root?: string;
  /** Physical thread retained when root is an invocation task. */
  sourceRoot?: string;
  topLevel?: true;
  /** A channel-level default, without the Solo chat reply restriction. */
  threadReplies?: true;
};
export const rootOf = (event: EventData) =>
  threadReference(event)?.rootId ?? event.id;
export function developerInstructions(
  agent: Pick<AgentHandle, "name" | "pubkey">,
  /** The base prompt, composed for the thread. */
  base: string,
) {
  return `You are ${agent.name} (pubkey ${agent.pubkey}), a coding agent in Buzz.
The buzz namespace provides the shared Buzz tools, including messages, reactions, reads, uploads, canvas, and encrypted memory. Prefer these tools for Buzz operations. You may use the buzz CLI through the agent-specific BUZZ_CREDENTIAL_PROVIDER supplied by the runtime to this thread's shell commands. The host handles access and signing as this agent without exposing private keys. If that provider is unavailable or refuses an operation, use the available Buzz tools or report the blocker. Do not look for credentials, read private keys, change the provider, or pair the CLI as your owner. Use Codex's native coding tools in the workspace.

${base}`;
}
/** What a conversation's Codex thread is. A conversation without a root is
 * a whole one, as every conversation of an agent with channel scope is. */
export const sessionPlace = (conversation: {
  root?: string | undefined;
}): NonNullable<Facts["place"]> =>
  conversation.root ? "thread" : "conversation";

/** Codex truncates the middle of any additional-context value over 1,000
 * tokens, which it estimates as 4 UTF-8 bytes each. */
const CONTEXT_VALUE_BYTES = 4_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The agent's current identity, instructions, team, and core memory, for
 * each turn: a resumed Codex thread keeps its original developer
 * instructions. */
export function contextText(
  agent: AgentHandle,
  settings: Config,
  team = "",
  /** The agent's `core` memory: `null` when it has none, undefined if unread. */
  memory?: string | null,
  repositories = "",
  /** Buzz's own block of the base sections that changed since the thread
   * started; see `sectionUpdates`. `null` leaves out what the thread was
   * last told about them. */
  updates: string | null = "",
) {
  const core = coreMemorySection(memory);
  const text = `You are ${agent.name} (pubkey ${agent.pubkey}).\nCurrent Buzz custom instructions replace all prior Buzz custom instructions. An empty section means no custom instructions apply.\n<agent-instructions>\n${settings.instructions}\n</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.${team ? `\n${team}` : ""}${core ? `\n\nCurrent core memory replaces all prior core memory.\n${core}` : ""}`;
  const community =
    settings.scope === "community"
      ? "\nThis is the agent's one shared community session. Each request's context replaces all earlier routing and delivery-mode instructions. Only a <realtime_delegation> turn is a spoken request; other requests follow their own posting instructions. Community scope grants no additional access."
      : "";
  // None of it is Buzz's event or steer section.
  // The block is Buzz's own text, so it goes in after the rest is escaped.
  // A thread keeps the blocks of its earlier turns, so each turn says that
  // only this turn's counts: a section that is as it started is in none.
  const escaped = unframed(
    `${text}${community}${repositories ? `\n\n${repositories}` : ""}`,
  );
  if (updates === null) return escaped;
  return `${escaped}\n\nCurrent base section updates replace all prior base section updates. None means your base instructions apply as written.${updates ? `\n${updates}` : ""}`;
}

/** `text` in values of at most `limit` bytes, split at line breaks where
 * possible; a line over the limit splits by code point. */
function chunks(text: string, limit: number) {
  const values = [""];
  let size = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const pieces = bytes(line) > limit ? [...line] : [line];
    for (const piece of pieces) {
      const length = bytes(piece);
      if (size + length > limit) {
        values.push("");
        size = 0;
      }
      values[values.length - 1] += piece;
      size += length;
    }
  }
  return values;
}

/** Room for a part's header line. */
const PART_HEADER_BYTES = 96;

/** `contextText` as turn context. Codex orders values by key, so text over
 * its per-value limit continues in `buzz.instructions.001` onward. Codex
 * sends only the values that changed, so each part names the revision of
 * the whole: a change anywhere sends every part again, never a tail without
 * its beginning. */
export function turnContext(...args: Parameters<typeof contextText>) {
  const text = contextText(...args);
  const whole = chunks(text, CONTEXT_VALUE_BYTES);
  const parts =
    whole.length === 1
      ? whole
      : chunks(text, CONTEXT_VALUE_BYTES - PART_HEADER_BYTES);
  const revision = fnv1a(text);
  return Object.fromEntries(
    parts.map((value, index) => [
      index
        ? `buzz.instructions.${String(index).padStart(3, "0")}`
        : "buzz.instructions",
      {
        kind: "application",
        value:
          parts.length === 1
            ? value
            : `${partHeader(revision, index, parts.length)}${value}`,
      },
    ]),
  );
}

/** The first line of each part of a turn context that is split. */
const partHeader = (revision: string, index: number, count: number) =>
  `[Buzz turn context ${revision}, part ${index + 1} of ${count}]\n`;

export function turnInput(
  /** The membership the turn is for, which its usage is read by. */
  agent: AgentKey,
  event: EventData,
  conversation: Conversation,
  text: string,
  steering = false,
  /** The Buzz tools' note for the end of the turn, if any. */
  note?: string,
  /** A plugin's wake, whose section takes the place of `event`'s. */
  wake?: ConversationWake,
  /** The names shown beside the event author's pubkey, when known. */
  names?: AuthorNames,
) {
  const section = steering
    ? "new-message-arrived-while-you-were-working"
    : "buzz-event";
  const body = wake ? wakeSection(wake) : eventBody(event, text, names);
  const replyTo = conversation.sourceRoot ? conversation.root : rootOf(event);
  const routing = conversation.topLevel
    ? { posting: "top-level" }
    : {
        session_thread: conversation.root,
        reply_to: replyTo,
        ...(conversation.sourceRoot
          ? { source_thread: conversation.sourceRoot }
          : {}),
      };
  const replyGuidance = steering
    ? wake
      ? `When posting about this wake, pass channel "${conversation.channelId}" explicitly to send${conversation.topLevel ? " and omit reply" : ` and use reply "${replyTo}"`}. Leave out the request field for the wake. You can continue working on other requests.`
      : "When answering requests from different conversations, use Buzz send with the request ID for each reply. You can answer one request and continue working on another."
    : "";
  return `<context>\n${quoted({ agent, channel_id: conversation.channelId, channel_name: conversation.name, session_scope: conversation.community ? "community" : conversation.root ? "thread" : "channel", ...routing })}\n</context>\n${conversation.topLevel ? `${conversation.threadReplies ? CHANNEL_LEVEL_PROMPT : TOP_LEVEL_PROMPT}\n` : ""}${wake ? "" : `${MENTION_PROMPT}\n`}${wake && !steering ? body : `<${section}>\n${body}\n</${section}>`}${replyGuidance ? `\n\n${replyGuidance}` : ""}${note ? `\n\n${note}` : ""}`;
}
/** The readable part of a conversation's thread name; earlier versions used
 * it alone. */
export function sessionTitle(agentName: string, conversation: Conversation) {
  if (conversation.community) return `Buzz community · ${agentName}`;
  return `Buzz #${conversation.name.replace(/\s+/g, " ").slice(0, 100)}${conversation.root ? ` · thread ${conversation.root.slice(0, 8)}` : ""} · ${agentName}`;
}
/** Names the agent's conversation in its thread names, so its threads can be
 * found from any build of the app, each of which saves its own bindings. A
 * 64-bit FNV-1a hash: stable and synchronous, so naming a thread does not
 * reorder concurrent turn starts. */
export function sessionTag(
  agent: AgentKey,
  conversation: Pick<Conversation, "channelId" | "root" | "community">,
) {
  return `buzz:${fnv1a(
    JSON.stringify([
      agent,
      conversation.community ? "@community" : conversation.channelId,
      conversation.community ? "channel" : (conversation.root ?? "channel"),
    ]),
  )}`;
}
/** A 64-bit FNV-1a hash of `text`'s UTF-8 bytes, in hex. */
function fnv1a(text: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
export function sessionName(
  agent: Pick<AgentHandle, "key" | "name">,
  conversation: Conversation,
) {
  return `${sessionTitle(agent.name, conversation)} · ${sessionTag(agent.key, conversation)}`;
}
