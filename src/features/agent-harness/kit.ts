// The Buzz side of an agent turn, for a harness a plugin brings: whether a
// delivery is the harness's to act on and which conversation it goes to, the
// prompts the bundled harnesses give, the agent's Buzz tools as an MCP
// handler, and its replies. The harness owns its process, its sessions and
// what it saves; the kit grants nothing a plugin's `agents` and `host` do not
// already give it.
import { appClient } from "../../buzz-mcp/app-client";
import type { Context } from "../../buzz-mcp/client";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { respond } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  sessionHint,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  CONTEXT_LIMIT,
  systemPrompt,
  turnPrompt,
} from "../../bundled/claude-code/prompt";
import type { McpHandler } from "../host/service";
import type { AgentKey } from "../agents/membership";
import { fromOwner } from "../agents/owner-attestation";
import { ownerReads } from "../agents/reads";
import type {
  AgentHandle,
  ConversationWake,
  Delivery,
} from "../agents/service";
import { soloChat } from "../agents/solo-chat";
import type { EventData } from "../relay/events";
import type { RelayData } from "../relay/service";
import { threadReference } from "../relay/thread-reference";
import { MemoryReads, READ_TIMEOUT_MS } from "./core-memory";
import { wakeAnchor, wakeLands } from "./plugin-wake";
import { readAuthorNames } from "./author-names";
import { ownerCanvas, readProject } from "./project";

/** Whether each thread is its own conversation, or the whole channel is one. */
export type HarnessScope = "thread" | "channel";

/** Where a delivery's turn goes, frozen for the turn. */
export type HarnessConversation = Readonly<{
  /** The channel id, or `<channel>/<root>` for a thread's own conversation.
   * A Solo chat and a DM are always one conversation. */
  key: string;
  channel: string;
  /** The thread's root, when the conversation is one thread. */
  root?: string;
  /** Replies go at the channel's top level, as in a Solo chat. */
  topLevel: boolean;
  /** `#name`, `DM` or a short channel id, for titles. */
  where: string;
}>;

export type HarnessPrompt = Readonly<{
  /** The routing context, the conversation's messages the session has not
   * been shown, the event, plugins' notes and the tools' end-of-turn note. */
  text: string;
  /** What the session has been shown, once this prompt reaches it: save it
   * with the session and give it to the next turn's prompt. Opaque. */
  cursor: string;
  /** Puts back the notes the prompt took, for a turn that never started. */
  restore(): void;
}>;

export type HarnessKit = Readonly<{
  /** The conversation a mention or a wake goes to. Undefined when the
   * harness must not act on it: another trigger, a mention that is not the
   * owner's own or attested by them (a workflow's never is), no channel, or a
   * wake with no conversation to go to. */
  conversation(
    delivery: Delivery,
    scope: HarnessScope,
  ): Promise<HarnessConversation | undefined>;
  /** Buzz's system prompt for the agent: the base prompt, its session model,
   * `instructions`, its teams, its `core` memory and repositories folder.
   * `tools: false` is for a session without the Buzz tools, whose final
   * message the harness posts as its reply. */
  systemPrompt(
    delivery: Delivery,
    options: Readonly<{
      scope: HarnessScope;
      cwd: string;
      instructions: string;
      tools?: boolean;
    }>,
  ): Promise<string>;
  /** The turn's prompt, for a session at `cursor`, the one its last prompt
   * gave; none for a new session, which is shown the conversation so far.
   * Takes the notes plugins left for the turn; after `restore`, asking
   * again takes them again. */
  turnPrompt(
    delivery: Delivery,
    conversation: HarnessConversation,
    options?: Readonly<{ cursor?: string }>,
  ): Promise<HarnessPrompt>;
  /** A watch's or timer's turn `text` with its routing context. */
  standalonePrompt(agent: AgentHandle, text: string): string;
  /** Answers the agent's Buzz tools over MCP, for `Host.serveMcp`, acting in
   * `conversation`, or nowhere by default for a standalone turn. `read` gives
   * the file an upload names; without it, uploads of local files fail. */
  tools(
    agent: AgentHandle,
    conversation?: HarnessConversation,
    options?: Readonly<{ read?(path: string): Promise<Uint8Array> }>,
  ): McpHandler;
  /** Posts `text` as the agent in the conversation: in the event's thread, or
   * at the top level. `notifyOwner` tags the owner, as for a failed turn. */
  reply(
    agent: AgentHandle,
    conversation: HarnessConversation,
    text: string,
    options?: Readonly<{ notifyOwner?: boolean }>,
  ): Promise<void>;
}>;

type Sources = Readonly<{
  relay(key: AgentKey): RelayData | undefined;
  core(key: AgentKey): Promise<string | null | undefined>;
  /** The tools plugins add to every session now. */
  added(): readonly AddedTool[];
  /** The repositories folder section for a relay's partition. */
  repositories(partition: string | undefined): string;
}>;

/** What the kit keeps of a conversation it admitted. */
type Admitted = Readonly<{
  event: EventData;
  solo: boolean;
  dm: boolean;
  name?: string;
  wake?: ConversationWake;
  resumed: boolean;
}>;

const CHAT = [9, 40002];
/** Threads a channel conversation's cursor keeps a mark for; forgetting one
 * only shows that thread's context again. */
const THREADS_LIMIT = 200;

type Cursor = Readonly<{
  seen: number;
  threads?: Readonly<Record<string, number>>;
}>;

function parseCursor(cursor: string | undefined): Cursor {
  try {
    const value = cursor ? JSON.parse(cursor) : undefined;
    if (typeof value?.seen !== "number") return { seen: 0 };
    const threads =
      value.threads && typeof value.threads === "object"
        ? Object.fromEntries(
            Object.entries(value.threads).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number",
            ),
          )
        : undefined;
    return { seen: value.seen, ...(threads ? { threads } : {}) };
  } catch {
    return { seen: 0 };
  }
}

function advance(cursor: Cursor, newest: number, contextRoot?: string) {
  let threads = cursor.threads;
  if (contextRoot) {
    const { [contextRoot]: previous = 0, ...rest } = threads ?? {};
    threads = Object.fromEntries(
      Object.entries({
        ...rest,
        [contextRoot]: Math.max(newest, previous),
      }).slice(-THREADS_LIMIT),
    );
  }
  return JSON.stringify({
    seen: Math.max(newest, cursor.seen),
    ...(threads ? { threads } : {}),
  });
}

const NO_TOOLS = `<buzz-tools-unavailable>
This session has no Buzz tools: the tools named above, such as send and read, do not exist here. Your final message is posted as your reply in the conversation, so write it as that reply, and say there what you need from anyone.
</buzz-tools-unavailable>`;
const CONVERSATION_READ_TIMEOUT_MS = 4_000;

export function harnessKit(sources: Sources): HarnessKit {
  const admitted = new WeakMap<HarnessConversation, Admitted>();
  const memoryReads = new MemoryReads();
  const session = (key: AgentKey) => {
    const snapshot = sources.relay(key)?.snapshot();
    return snapshot?.status === "ready" ? snapshot.session : undefined;
  };
  const summary = (key: AgentKey, channelId: string) => {
    const found = session(key);
    return (
      found?.channels.list().channels.find((item) => item.id === channelId) ??
      found?.channels.get?.(channelId)
    );
  };
  const known = (conversation: HarnessConversation) => {
    const found = admitted.get(conversation);
    if (!found)
      throw new Error("This conversation was not admitted by agents.harness");
    return found;
  };

  return Object.freeze({
    async conversation(
      { trigger, agent, channelId, signal }: Delivery,
      scope: HarnessScope,
    ) {
      if (
        trigger.type !== "mention" &&
        trigger.type !== "attention" &&
        trigger.type !== "plugin"
      )
        return undefined;
      // A wake is not a message to check: a plugin's is the owner's installed
      // code, and the agent's own handoff comes from a turn already acting
      // for the owner.
      const wake = trigger.type !== "mention" ? trigger : undefined;
      if (trigger.type === "mention") {
        // Only the owner or an attested sibling. Unlike the bundled harnesses,
        // which kept relay workflow mentions for compatibility, no workflow
        // authority is given, so no workflow mention is delegated; the
        // community still applies the build's workflow restriction.
        if (
          !(await fromOwner(trigger.event, agent.owner, {
            agent: agent.pubkey,
            authority: undefined,
            community: sources.relay(agent.key)?.snapshot().origin,
          }))
        )
          return undefined;
        signal.throwIfAborted();
      }
      const event =
        trigger.type === "mention" ? trigger.event : wakeAnchor(trigger);
      const channel =
        channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channel) return undefined;
      const solo = await soloChat(
        () => sources.relay(agent.key),
        agent.owner,
        channel,
        signal,
      );
      const topLevel = solo || wake?.topLevel === true;
      if (wake && !wakeLands(wake, topLevel)) return undefined;
      const found = summary(agent.key, channel);
      const dm = found?.channelType === "dm";
      const root = threadReference(event)?.rootId ?? event.id;
      const whole = topLevel || dm || scope === "channel";
      const conversation: HarnessConversation = Object.freeze({
        key: whole ? channel : `${channel}/${root}`,
        channel,
        ...(whole ? {} : { root }),
        topLevel,
        where: found?.name ? `#${found.name}` : dm ? "DM" : channel.slice(0, 8),
      });
      admitted.set(conversation, {
        event,
        solo,
        dm,
        ...(found?.name ? { name: found.name } : {}),
        ...(wake ? { wake } : {}),
        resumed: trigger.type === "mention" && !!trigger.resumed,
      });
      return conversation;
    },

    async systemPrompt(
      { agent, team }: Delivery,
      { scope, cwd, instructions, tools = true },
    ) {
      const memory = await sources.core(agent.key);
      const text = systemPrompt({
        scope,
        cwd,
        repositories: sources.repositories(
          sources.relay(agent.key)?.snapshot().scope,
        ),
        agent: { name: agent.name, pubkey: agent.pubkey },
        instructions,
        team: team ?? "",
        ...(memory === undefined ? {} : { memory }),
      });
      return tools ? text : `${text}\n\n${NO_TOOLS}`;
    },

    async turnPrompt(
      { agent, wakeText }: Delivery,
      conversation,
      options = {},
    ) {
      const { event, solo, dm, name, wake, resumed } = known(conversation);
      const { key, channel: channelId, topLevel } = conversation;
      const ready = session(agent.key);
      const thread = threadReference(event);
      const rootId = thread?.rootId ?? event.id;
      const shown = parseCursor(options.cursor);
      // Sharing a session does not mean it has seen every thread in the
      // channel, so a channel conversation keeps a mark for each thread.
      const contextRoot =
        key === channelId && !dm && !topLevel ? rootId : undefined;
      // A resumed turn's session never saw its thread, its own replies
      // included.
      const since = resumed
        ? 0
        : contextRoot
          ? (shown.threads?.[contextRoot] ?? 0)
          : shown.seen;
      const owner = agent.owner;
      // Only a Solo chat's Canvas is handed over.
      const reading = solo
        ? readProject(
            ready
              ? () =>
                  ownerCanvas(
                    ready.canvas,
                    owner,
                    channelId,
                    ready.channelWrites.startingCanvas(channelId),
                  )
              : undefined,
          )
        : Promise.resolve(undefined);
      const threadRead = (thread || (resumed && !dm)) && !topLevel;
      let earlier: readonly EventData[] = [];
      if (ready && (thread || dm || topLevel || resumed))
        try {
          const events = await ready.read(
            threadRead
              ? [
                  { ids: [rootId], "#h": [channelId], limit: 1 },
                  {
                    kinds: CHAT,
                    "#h": [channelId],
                    "#e": [rootId],
                    limit: 200,
                  },
                ]
              : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
            { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) },
          );
          earlier = events
            .filter(
              (item) =>
                CHAT.includes(item.kind) &&
                item.tags.some(
                  ([tag, value]) => tag === "h" && value === channelId,
                ) &&
                item.id !== event.id &&
                (resumed || item.created_at <= event.created_at),
            )
            .sort((a, b) => a.created_at - b.created_at);
        } catch (error) {
          console.warn("A harness could not read the conversation", error);
        }
      // A session already has its own replies; a new one is shown them too.
      const unseen = earlier.filter(
        (item) =>
          item.created_at > since && (!since || item.pubkey !== agent.pubkey),
      );
      const reads = ownerReads(sources.relay(agent.key), agent.pubkey);
      const signingAuthority = reads?.workflowAuthority();
      const [names, project] = await Promise.all([
        readAuthorNames(
          reads,
          [event, ...unseen.slice(-CONTEXT_LIMIT)],
          signingAuthority,
        ),
        reading.then((read) => read?.section),
      ]);
      const text = turnPrompt({
        agent: agent.key,
        event,
        scope: key === channelId ? "channel" : "thread",
        topLevel,
        channelLevel: topLevel && !solo,
        channel: { id: channelId, ...(name ? { name } : {}), dm },
        ...(thread ? { thread } : {}),
        context: unseen,
        total: earlier.length + 1,
        names,
        ...(signingAuthority ? { signingAuthority } : {}),
        ...(project ? { project } : {}),
        ...(wake
          ? { wake: { ...wake, text: (await wakeText?.()) ?? wake.text } }
          : {}),
      });
      const noteRoot = conversation.root;
      const notes = agent.notes?.(channelId, noteRoot) ?? [];
      return {
        text: [
          resumed ? `${text}\n\n${RESUMED_PROMPT}` : text,
          ...notes,
          turnNote(agent),
        ]
          .filter(Boolean)
          .join("\n\n"),
        cursor: advance(
          shown,
          Math.max(event.created_at, ...unseen.map((item) => item.created_at)),
          contextRoot,
        ),
        restore: () => agent.restoreNotes?.(channelId, notes, noteRoot),
      };
    },

    standalonePrompt: (agent: AgentHandle, text: string) =>
      `<context>\nScope: standalone\nAgent: ${agent.key}\n</context>\n\n${text}`,

    tools(agent, conversation, options = {}) {
      const solo = conversation && known(conversation).solo;
      const context: Context = !conversation
        ? {}
        : conversation.topLevel
          ? {
              channel: conversation.channel,
              ...(solo ? { topLevel: true } : {}),
            }
          : conversation.root
            ? { channel: conversation.channel, root: conversation.root }
            : { channel: conversation.channel };
      const pubkey = agent.pubkey;
      const reads = () => ownerReads(sources.relay(agent.key), pubkey);
      return async (message) => {
        const ready = session(agent.key);
        const client = appClient(agent, {
          relayAuthor: ready?.relayAuthor,
          signingAuthority: ready?.workflowAuthority,
          read: (path) =>
            options.read
              ? options.read(path)
              : Promise.reject(new Error(`This agent cannot read ${path}`)),
          memories: (slug) => {
            const found = reads();
            if (!found)
              return Promise.reject(new Error("Buzz is not connected"));
            return memoryReads.read(
              found,
              pubkey,
              AbortSignal.timeout(READ_TIMEOUT_MS),
              slug,
            );
          },
          remembered: () => {
            const found = reads();
            if (found) memoryReads.forget(found.connection, pubkey);
          },
        });
        const added = sources.added();
        return respond(client, context, message, added, {
          instructions: sessionHint(added),
        });
      };
    },

    async reply(agent, conversation, text, options = {}) {
      const { event } = known(conversation);
      await agent.publish({
        kind: 9,
        content: text,
        tags: [
          ["h", conversation.channel],
          ...(conversation.topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...(options.notifyOwner ? [["p", agent.owner]] : []),
        ],
      });
    },
  });
}
