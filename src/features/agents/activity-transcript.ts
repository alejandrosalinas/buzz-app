/** Owner-only display projection of observer telemetry into turns and items.
 * Raw session retention is unchanged; this reads allowlisted ACP fields only. */
import { isMessageTool } from "../../buzz-mcp/message-tools";
import { readEventBody } from "../agent-harness/turn-records";
import { terminalOutcome } from "./observer";

type Source = Readonly<{
  id: string;
  agent: string;
  receivedAt: number;
  plaintext: string;
}>;
export type TranscriptScope = Readonly<{
  agent: string;
  channelId?: string | undefined;
}>;
export type PromptSection = Readonly<{ tag: string; body: string }>;
type Base = { id: string; at: number };
/** ACP `diff` tool content; a missing old text is a new file. */
export type ToolDiff = { path: string; oldText?: string; newText: string };
/** Tool names and inputs are adapter-specific, so they are shown as sent;
 * only ACP's standard `kind`, `status`, `locations` and content are read.
 * The exception is a Buzz message tool, recognized by a title of
 * `buzz__<tool>` or `mcp__buzz__<tool>`: when it completes with a
 * `rawInput.text` and no `rawOutput.isError`, it is shown as the agent's
 * posted message instead of as a tool. Renaming those titles or fields in an
 * adapter turns its sends back into tool rows. */
export type ToolItem = Base & {
  type: "tool";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  input: string;
  output: string;
  diffs: ToolDiff[];
  paths: string[];
  completedAt?: number;
  truncated: boolean;
  permission?: { options: string[]; outcome?: string };
  /** Calls recorded while this script was executing, in recorded order. */
  children?: TranscriptItem[];
};
export type TranscriptItem =
  | (Base & { type: "system"; sections: PromptSection[] })
  | (Base & {
      type: "prompt";
      text: string;
      author?: string;
      authorPubkey?: string;
      sections: PromptSection[];
      steer: boolean;
    })
  | (Base & {
      type: "message" | "thought";
      text: string;
      messageId?: string;
      /** Posted to Buzz, rather than said only in the session. */
      posted?: boolean;
    })
  | ToolItem
  | (Base & { type: "plan"; entries: { content: string; status: string }[] })
  | (Base & { type: "status"; text: string });
export type TranscriptTurn = {
  turnId: string;
  channelId: string | null;
  /** Null is the channel conversation; undefined means not recoverable. */
  threadRootId: string | null | undefined;
  source?: string;
  triggeringEventIds: string[];
  sessionId?: string;
  newSession: boolean;
  /** The first shown turn of a session that began before the shown ones. */
  continued?: boolean;
  /** Selected ACP session config values, e.g. model and thinking level. */
  config: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: ReturnType<typeof terminalOutcome>;
  error?: string;
  stopReason?: string;
  context?: { used: number; size: number };
  /** No turn_started frame is loaded, so earlier items may be missing. */
  partial: boolean;
  items: TranscriptItem[];
};
export type Transcript = Readonly<{
  turns: readonly TranscriptTurn[];
}>;

type Json = { [key: string]: unknown };
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
/** Whether a tool title names a Buzz message tool, as goose (and so kgoose)
 * names it, `buzz__send`, or as Claude Code does, `mcp__buzz__send`. */
const postsMessage = (title: string) => {
  const name = /^(?:mcp__)?buzz__(\w+)$/.exec(title.trim())?.[1];
  return !!name && isMessageTool(name);
};
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const eventId = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
const ELIDED = "…[elided ";
const PROMPT_METHODS = new Set([
  "session/prompt",
  "_session/steering",
  "_goose/unstable/session/steer",
]);

const TITLES = new Map(
  Object.entries({
    identity: "Identity",
    base: "Base",
    workspace: "Workspace",
    "community-repositories": "Repositories folder",
    "agent-instructions": "Agent instructions",
    team: "Team",
    "core-memory": "Core memory",
    "recent-notes": "Recent notes",
    context: "Context",
    mention: "Mention",
    "buzz-event": "Buzz event",
    "buzz-events": "Buzz events",
    "thread-context": "Thread context",
    "conversation-context": "Conversation context",
    "turn-context": "Turn context",
    interest: "Interest",
    text: "Text",
  }),
);
/** A prompt section's readable title; an unknown tag shows as it is. */
export const sectionTitle = (tag: string) => TITLES.get(tag) ?? tag;

/** A steer's section holds its event, or before exact records, a whole turn. */
export const STEER = "new-message-arrived-while-you-were-working";
const EVENT_TAGS = new Set(["buzz-event", STEER]);

/** Split top-level `<tag attrs>` … `</tag>` prompt framing; other text is kept. */
export function promptSections(text: string): PromptSection[] {
  const sections: PromptSection[] = [];
  const loose: string[] = [];
  let open: { tag: string; lines: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (open) {
      if (line === `</${open.tag}>`) {
        sections.push({ tag: open.tag, body: open.lines.join("\n") });
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const start = /^<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>$/.exec(line);
    if (start?.[1]) open = { tag: start[1], lines: [] };
    else loose.push(line);
  }
  // An unterminated section is ordinary text, not a silently dropped body.
  if (open) loose.push(`<${open.tag}>`, ...open.lines);
  const rest = loose.join("\n").trim();
  if (rest) sections.push({ tag: "text", body: rest });
  return sections;
}

/** The triggering Buzz event(s): author label and content, without tags.
 * An event sent as an exact record names its author by `name`, if known. */
export function promptMessage(
  sections: PromptSection[],
  name: (pubkey: string) => string | undefined = () => undefined,
) {
  const authors: string[] = [];
  const authorKeys: string[] = [];
  const contents: string[] = [];
  for (const { tag, body } of sections) {
    const record = EVENT_TAGS.has(tag) ? readEventBody(body) : undefined;
    if (record) {
      contents.push(record.request);
      authorKeys.push(record.pubkey);
      const author = name(record.pubkey);
      if (author) authors.push(author);
      continue;
    }
    if (tag !== "buzz-event" && tag !== "buzz-events") continue;
    // Turns from before exact records serialized the event as escaped JSON.
    // Never parse its decoded content again as framing; older saved
    // transcripts use the lines below.
    let event: Json | undefined;
    try {
      event = object(JSON.parse(body));
    } catch {
      // Legacy human-readable event block.
    }
    if (event && typeof event.content === "string") {
      contents.push(event.content);
      const key = str(event.pubkey);
      if (/^[0-9a-f]{64}$/.test(key)) authorKeys.push(key);
      const author = str(event.author) || str(event.npub) || str(event.pubkey);
      if (author) authors.push(author);
      continue;
    }
    for (const block of body.split(/\n(?=--- Event \d+ )/)) {
      const from = /^From: (.*)$/m.exec(block)?.[1];
      const start = block.indexOf("\nContent: ");
      if (start < 0) continue;
      const end = block.lastIndexOf("\nTags: ");
      contents.push(
        block.slice(start + 10, end > start ? end : undefined).trim(),
      );
      if (from) authors.push(from.replace(/ \((?:npub|hex)[^)]*\)$/, ""));
    }
  }
  return {
    text: contents.join("\n\n"),
    author: [...new Set(authors)].join(", ") || undefined,
    authorPubkey:
      contents.length === authorKeys.length && new Set(authorKeys).size === 1
        ? authorKeys[0]
        : undefined,
  };
}

/** Thread evidence from the prompt's `<context>`: root, channel, or unknown. */
function promptThread(sections: PromptSection[]) {
  const context = sections.find((section) => section.tag === "context")?.body;
  if (!context) return undefined;
  const root = eventId(/^Thread root: (\S+)$/m.exec(context)?.[1]);
  if (root) return root;
  return /^Scope: (?:channel|dm)$/m.test(context) ? null : undefined;
}

/** Older harnesses supplied thread scope only in the captured ACP prompt. */
export function activityPromptThread(payload: unknown) {
  const request = object(payload);
  if (!PROMPT_METHODS.has(str(request?.method))) return undefined;
  const prompt = object(request?.params)?.prompt;
  if (!Array.isArray(prompt)) return undefined;
  return promptThread(
    promptSections(
      prompt
        .map((block) => str(object(block)?.text))
        .filter(Boolean)
        .join("\n"),
    ),
  );
}

const display = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
/** Text content is Markdown; a block that is one fenced code block shows its body. */
const unfence = (text: string) =>
  /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)?.[1] ?? text;
function toolContent(update: Json) {
  const content = Array.isArray(update.content) ? update.content : [];
  const diffs: ToolDiff[] = [];
  const text: string[] = [];
  for (const value of content) {
    const entry = object(value);
    const block = object(entry?.content);
    if (entry?.type === "diff" && typeof entry.newText === "string")
      diffs.push({
        path: str(entry.path),
        newText: entry.newText,
        ...(typeof entry.oldText === "string"
          ? { oldText: entry.oldText }
          : {}),
      });
    else if (block?.type === "text" && str(block.text))
      text.push(unfence(block.text as string));
  }
  return {
    diffs,
    output: text.length ? text.join("\n") : display(update.rawOutput),
  };
}
/** Selected values of ACP config options, by their display names. */
function configLabels(options: unknown) {
  if (!Array.isArray(options)) return undefined;
  return options.flatMap((value) => {
    const option = object(value);
    const current = option?.currentValue;
    if (typeof current !== "string" || !current) return [];
    const choice = Array.isArray(option?.options)
      ? option.options.map(object).find((entry) => entry?.value === current)
      : undefined;
    const label = str(choice?.name) || current;
    // Name the setting unless the adapter's label already does ("Thinking: high").
    const name = str(option?.name);
    return [name && !label.startsWith(name) ? `${name}: ${label}` : label];
  });
}

// Snapshot record arrays are frozen and replaced on change, while indicators,
// stop controls and previews read the same agent/channel on every tick.
const transcripts = new WeakMap<object, Map<string, Transcript>>();

export function activityTranscript(
  records: readonly Source[],
  scope: TranscriptScope,
  /** Names an exact-record prompt's author, if known. */
  name?: (pubkey: string) => string | undefined,
): Transcript {
  // The cache is per records, agent and channel, not per `name`.
  if (name || !Object.isFrozen(records))
    return buildTranscript(records, scope, name);
  let byScope = transcripts.get(records);
  if (!byScope) {
    byScope = new Map();
    transcripts.set(records, byScope);
  }
  const key = `${scope.agent}\n${scope.channelId ?? ""}`;
  const cached = byScope.get(key);
  if (cached) return cached;
  const transcript = buildTranscript(records, scope);
  byScope.set(key, transcript);
  return transcript;
}

function buildTranscript(
  records: readonly Source[],
  scope: TranscriptScope,
  name?: (pubkey: string) => string | undefined,
): Transcript {
  const events: { id: string; at: number; order: number; event: Json }[] = [];
  for (const record of records) {
    if (record.agent !== scope.agent) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(record.plaintext);
    } catch {
      continue;
    }
    const envelope = object(raw);
    const children =
      envelope?.kind === "batch" ? object(envelope.payload)?.events : [raw];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      const event = object(child);
      // Unscoped children never inherit a channel; see activityRecords.
      if (!event || (scope.channelId && event.channelId !== scope.channelId))
        return;
      const parsed = Date.parse(str(event.timestamp));
      const at =
        Number.isFinite(parsed) && parsed <= record.receivedAt + 5000
          ? parsed
          : record.receivedAt;
      events.push({
        id: `${record.id}:${index}`,
        at,
        order: events.length,
        event,
      });
    });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  type Draft = TranscriptTurn & {
    tools: Map<string, ToolItem>;
    /** Text of each call's arguments, for calls that may post a message. */
    sent: Map<string, string>;
    /** Calls whose result reported an error, whatever their status says. */
    errored: Set<string>;
    plan?: Extract<TranscriptItem, { type: "plan" }>;
    piStartup?: string;
    payloadThread?: string;
    promptThread?: string | null;
  };
  const turns = new Map<string, Draft>();
  // JSON-RPC ids are per agent process and direction, so key them by pool slot
  // and keep our prompts apart from the agent's permission requests.
  const prompts = new Map<string, Draft>();
  const permissions = new Map<string, { tool: ToolItem; options: Json[] }>();
  const tool = (turn: Draft, id: string, at: number, eventKey: string) => {
    let item = turn.tools.get(id);
    if (!item) {
      item = {
        id: eventKey,
        at,
        type: "tool",
        toolCallId: id,
        title: "",
        kind: "",
        status: "pending",
        input: "",
        output: "",
        diffs: [],
        paths: [],
        truncated: false,
      };
      turn.tools.set(id, item);
      turn.items.push(item);
    }
    return item;
  };
  const chunk = (
    turn: Draft,
    type: "message" | "thought",
    text: string,
    messageId: string,
    id: string,
    at: number,
  ) => {
    const same = (item: TranscriptItem | undefined) =>
      (item?.type === "message" || item?.type === "thought") &&
      item.type === type
        ? item
        : undefined;
    const last = same(turn.items.at(-1));
    // Explicit message IDs join across tools; unkeyed chunks join only adjacent.
    const target = messageId
      ? turn.items.map(same).find((item) => item?.messageId === messageId)
      : last && !last.messageId
        ? last
        : undefined;
    if (target) target.text += text;
    else
      turn.items.push({
        id,
        at,
        type,
        text,
        ...(messageId ? { messageId } : {}),
      });
  };

  for (const { id, at, event } of events) {
    const turnId = str(event.turnId);
    if (!turnId) continue;
    const kind = str(event.kind);
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        channelId: str(event.channelId) || null,
        threadRootId: undefined,
        triggeringEventIds: [],
        newSession: false,
        config: [],
        startedAt: at,
        partial: true,
        items: [],
        tools: new Map(),
        sent: new Map(),
        errored: new Set(),
      };
      turns.set(turnId, turn);
    }
    if (str(event.sessionId)) turn.sessionId = str(event.sessionId);
    const payload = object(event.payload) ?? {};
    const root = eventId(payload.threadRootEventId);
    if (root) turn.payloadThread = root;
    const slot = String(event.agentIndex ?? "");
    if (kind === "turn_started") {
      turn.partial = false;
      const started = Date.parse(str(event.startedAt));
      turn.startedAt = Number.isFinite(started) ? started : at;
      if (str(payload.source)) turn.source = str(payload.source);
      turn.triggeringEventIds = Array.isArray(payload.triggeringEventIds)
        ? payload.triggeringEventIds.flatMap((value) => eventId(value) ?? [])
        : [];
    } else if (kind === "session_resolved") {
      if (str(payload.sessionId)) turn.sessionId = str(payload.sessionId);
      turn.newSession = payload.isNewSession === true;
    } else if (kind === "session_config_captured") {
      turn.config = configLabels(payload.configOptions) ?? turn.config;
    } else if (kind === "turn_completed") {
      if (turn.endedAt === undefined) {
        turn.endedAt = at;
        turn.outcome = terminalOutcome(kind, payload.outcome);
      }
    } else if (kind === "turn_error" || kind === "agent_panic") {
      turn.endedAt ??= at;
      turn.error =
        str(payload.error).slice(0, 2000) || str(payload.outcome) || kind;
    } else if (kind === "acp_write") {
      const method = str(payload.method);
      const params = object(payload.params) ?? {};
      if (method === "session/new") {
        const meta = object(params._meta)?.systemPrompt;
        const system =
          str(params.systemPrompt) ||
          str(meta) ||
          str(object(meta)?.replace) ||
          str(object(meta)?.append);
        if (system)
          turn.items.push({
            id,
            at,
            type: "system",
            sections: promptSections(system),
          });
      } else if (PROMPT_METHODS.has(method) && Array.isArray(params.prompt)) {
        const text = params.prompt
          .map((block) => str(object(block)?.text))
          .filter(Boolean)
          .join("\n");
        const sections = promptSections(text);
        const message = promptMessage(sections, name);
        const thread = promptThread(sections);
        if (thread !== undefined) turn.promptThread = thread;
        turn.items.push({
          id,
          at,
          type: "prompt",
          // Non-Buzz prompts (heartbeats, other hosts) keep their unframed text.
          text:
            message.text ||
            sections.find((section) => section.tag === "text")?.body ||
            text,
          ...(message.author ? { author: message.author } : {}),
          ...(message.authorPubkey
            ? { authorPubkey: message.authorPubkey }
            : {}),
          sections,
          steer: method !== "session/prompt",
        });
        if (payload.id !== undefined && method === "session/prompt")
          prompts.set(`${slot}:${JSON.stringify(payload.id)}`, turn);
      } else if (!method && payload.id !== undefined) {
        // Our reply to an agent request, e.g. the auto-approved permission.
        const request = permissions.get(
          `${slot}:${JSON.stringify(payload.id)}`,
        );
        const outcome = object(object(payload.result)?.outcome);
        if (request?.tool.permission && outcome) {
          const option = request.options.find(
            (entry) => entry.optionId === outcome.optionId,
          );
          request.tool.permission.outcome =
            outcome.outcome === "cancelled"
              ? "Cancelled"
              : str(option?.name) || str(option?.kind) || str(outcome.optionId);
        }
      }
    } else if (kind === "acp_read") {
      const method = str(payload.method);
      const params = object(payload.params) ?? {};
      if (!method && payload.id !== undefined) {
        const result = object(payload.result);
        const prompt = prompts.get(`${slot}:${JSON.stringify(payload.id)}`);
        const stop = str(result?.stopReason);
        if (prompt && stop) prompt.stopReason = stop;
        // Pi-specific: pi-acp returns its startup banner (version, context
        // files, skills, extensions) in the session/new result and then repeats
        // it verbatim as an agent message. It is not a reply; Raw keeps it.
        const banner = str(object(object(result?._meta)?.piAcp)?.startupInfo);
        if (banner) turn.piStartup = banner;
      } else if (method === "session/request_permission") {
        const call = object(params.toolCall) ?? {};
        const callId = str(call.toolCallId) || `permission:${id}`;
        const item = tool(turn, callId, at, id);
        item.title ||= str(call.title);
        const options = Array.isArray(params.options)
          ? params.options.flatMap((value): Json[] => {
              const option = object(value);
              return option ? [option] : [];
            })
          : [];
        item.permission = {
          options: options.map((entry) => str(entry.name) || str(entry.kind)),
        };
        if (payload.id !== undefined)
          permissions.set(`${slot}:${JSON.stringify(payload.id)}`, {
            tool: item,
            options,
          });
      } else if (method === "session/update") {
        const update = object(params.update) ?? {};
        const type = str(update.sessionUpdate);
        if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
          const content = object(update.content);
          const text = str(content?.text);
          if (type === "agent_message_chunk" && text === turn.piStartup) {
            delete turn.piStartup;
            continue;
          }
          if (text && (content?.type ?? "text") === "text")
            chunk(
              turn,
              type === "agent_message_chunk" ? "message" : "thought",
              text,
              str(update.messageId),
              id,
              at,
            );
        } else if (type === "tool_call" || type === "tool_call_update") {
          const callId = str(update.toolCallId);
          if (!callId) continue;
          const item = tool(turn, callId, at, id);
          if (str(update.title)) item.title = str(update.title);
          if (str(update.kind)) item.kind = str(update.kind);
          if (str(update.status)) item.status = str(update.status);
          if (update.rawInput !== undefined) {
            item.input = display(update.rawInput);
            const text = str(object(update.rawInput)?.text);
            if (text.trim()) turn.sent.set(callId, text);
          }
          // MCP application errors can arrive as completed calls.
          if (object(update.rawOutput)?.isError === true)
            turn.errored.add(callId);
          const { diffs, output } = toolContent(update);
          if (output) item.output = output;
          if (diffs.length) item.diffs = diffs;
          const located = Array.isArray(update.locations)
            ? update.locations.flatMap(
                (value) => str(object(value)?.path) || [],
              )
            : [];
          if (located.length) item.paths = located;
          if (
            (item.status === "completed" || item.status === "failed") &&
            item.completedAt === undefined
          )
            item.completedAt = at;
          item.truncated ||= [
            item.input,
            item.output,
            ...item.diffs.flatMap((diff) => [diff.oldText ?? "", diff.newText]),
          ].some((text) => text.includes(ELIDED));
        } else if (type === "plan" && Array.isArray(update.entries)) {
          const entries = update.entries.flatMap((value) => {
            const entry = object(value);
            return entry && str(entry.content)
              ? [{ content: str(entry.content), status: str(entry.status) }]
              : [];
          });
          if (turn.plan) turn.plan.entries = entries;
          else {
            turn.plan = { id, at, type: "plan", entries };
            turn.items.push(turn.plan);
          }
        } else if (type === "current_mode_update" && str(update.currentModeId))
          turn.items.push({
            id,
            at,
            type: "status",
            text: `Mode: ${str(update.currentModeId)}`,
          });
        else if (type === "config_option_update") {
          const labels = configLabels(update.configOptions);
          if (labels) turn.config = labels;
        } else if (type === "usage_update") {
          const used = number(update.used);
          const size = number(update.size);
          if (used !== undefined && size !== undefined)
            turn.context = { used, size };
        }
      }
    }
    if (str(payload.elided))
      turn.items.push({
        id,
        at,
        type: "status",
        text: `A ${kind} frame was too large and was elided by the agent.`,
      });
  }

  // Harnesses capture config when creating a session and reuse sessions without
  // another capture, so a later turn shows its session's last observed config.
  const drafts = [...turns.values()].sort((a, b) => a.startedAt - b.startedAt);
  const configs = new Map<string, string[]>();
  for (const draft of drafts) {
    if (!draft.sessionId) continue;
    if (draft.config.length) configs.set(draft.sessionId, draft.config);
    else draft.config = configs.get(draft.sessionId) ?? [];
  }

  return {
    turns: drafts.map((draft) => {
      const {
        tools: _tools,
        sent,
        errored,
        plan: _plan,
        piStartup: _piStartup,
        payloadThread,
        promptThread: prompt,
        ...turn
      } = draft;
      // A Buzz message a tool posted reads as the agent's reply, as the local
      // harnesses' transcripts show it. A failed, erroring or unfinished send
      // stays a tool, with its error.
      turn.items = turn.items.map((item) => {
        const text = item.type === "tool" && sent.get(item.toolCallId);
        return text &&
          item.status === "completed" &&
          !errored.has(item.toolCallId) &&
          postsMessage(item.title)
          ? { id: item.id, at: item.at, type: "message", text, posted: true }
          : item;
      });
      // Older harnesses omit threadRootEventId; the prompt context still names it.
      turn.threadRootId = payloadThread ?? prompt;
      return turn;
    }),
  };
}
