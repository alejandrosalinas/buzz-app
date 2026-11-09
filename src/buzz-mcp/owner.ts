// The owner tools (`owner_*`): read with the signed-in human's access instead
// of the agent's, only where the host gives the client `ownerAccess`. The host
// decides who the owner, agent and community are; no argument names them.
import { CANVAS_HISTORY_PAGE } from "../features/channel-templates/canvas-limits";
import { parseBuzzLink } from "../features/navigation/buzz-links";
import type {
  BuzzClient,
  OwnerAccess,
  OwnerExecution,
  OwnerReadRequest,
} from "./client";
import {
  bound,
  edited,
  HEX,
  messageLine,
  pubkey,
  type Tool,
  time,
  unixTime,
} from "./tools";

const channel = {
  type: "string",
  description: "Channel ID, from owner_channel_list.",
} as const;
const limit = (max: number, fallback: number) =>
  ({
    type: "integer",
    description: `Default ${fallback}, max ${max}.`,
  }) as const;
const offset = {
  type: "integer",
  description: "Entries to skip, from a previous answer's next.",
} as const;
const before = {
  type: "integer",
  description: "Unix seconds, at or before.",
} as const;
const beforeId = {
  type: "string",
  description: "For paginating: with before, from a previous answer's next.",
} as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
});

export const OWNER_TOOLS: readonly Tool[] = [
  tool(
    "owner_channel_list",
    "Your owner's channels in this community, read with their access, including ones you are not in and archived ones. partial means some may be missing.",
    { q: { type: "string" }, limit: limit(500, 100), offset },
  ),
  tool(
    "owner_channel_get",
    "One of your owner's channels, read with their access: its details, their role and what they may manage.",
    { channel },
    ["channel"],
  ),
  tool(
    "owner_member_list",
    "A channel's members and roles, read with your owner's access.",
    { channel, limit: limit(500, 100), offset },
    ["channel"],
  ),
  tool(
    "owner_read",
    "Read a channel's latest messages, a whole thread, or search with q, with your owner's access, including channels you are not in. Marks nothing read. edits_limited means some messages show earlier text.",
    {
      channel,
      thread: {
        type: "string",
        description: "Any message ID in the thread.",
      },
      message_url: {
        type: "string",
        description: "Buzz message link; replaces channel and thread.",
      },
      q: {
        type: "string",
        description:
          "Search text. Without channel, other channels' matches can fill a page (limited) and are dropped; then narrow with channel, before or since.",
      },
      author: {
        type: "string",
        description: "With q or channel: only this hex pubkey or npub.",
      },
      since: {
        type: "integer",
        description: "With q or channel: Unix seconds, at or after.",
      },
      before,
      before_id: beforeId,
      limit: {
        type: "integer",
        description: "Search 20 (max 100), thread 100 (499), channel 30 (200).",
      },
    },
  ),
  tool(
    "owner_canvas_get",
    "A channel's canvas, or an earlier revision of it, read with your owner's access.",
    {
      channel,
      id: {
        type: "string",
        description: "A revision ID, from owner_canvas_history.",
      },
    },
    ["channel"],
  ),
  tool(
    "owner_canvas_history",
    "A channel's canvas revisions, newest first, read with your owner's access: each one's id, time, author, size and first line.",
    { channel, before, before_id: beforeId },
    ["channel"],
  ),
];

export const isOwnerTool = (name: string) =>
  OWNER_TOOLS.some((tool) => tool.name === name);

/** Runs owner tool `name`. Throws, before reading anything, when this
 * client has no owner access, as a plugin's or another host's has not. */
export async function callOwnerTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ text: string; held(): void }>> {
  const tool = OWNER_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const { ownerAccess } = client;
  if (!ownerAccess)
    throw new Error(
      "Owner tools are not available to this agent here; nothing was read.",
    );
  const extra = Object.keys(args).filter(
    (arg) => !Object.hasOwn(tool.inputSchema.properties, arg),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  if (name === "owner_channel_list") {
    const page = paging(args);
    const q = optionalText(args.q, "q")?.toLowerCase();
    const list = await ownerAccess.channels();
    const matched = q
      ? list.channels.filter((item) => item.name.toLowerCase().includes(q))
      : list.channels;
    const shown = matched.slice(page.offset, page.offset + page.limit);
    const next = page.offset + shown.length;
    return answer(ownerAccess, list.execution, {
      channels: shown,
      total: matched.length,
      ...(next < matched.length ? { next: { offset: next } } : {}),
      partial: list.partial,
      ...(list.error ? { error: list.error } : {}),
    });
  }
  if (name === "owner_read") return read(ownerAccess, args);
  const id = optionalText(args.channel, "channel");
  if (!id) throw new Error("channel is required.");
  if (name === "owner_canvas_get") {
    const revision = eventId(args.id, "id");
    const { execution, channel, canvas } = await ownerAccess.canvas(
      id,
      revision,
    );
    return answer(ownerAccess, execution, {
      channel,
      ...(canvas
        ? {
            id: canvas.id,
            author: canvas.pubkey,
            at: time(canvas.created_at),
            canvas: canvas.content,
          }
        : { canvas: null }),
    });
  }
  if (name === "owner_canvas_history") {
    const cursor = pageCursor(args);
    const { execution, channel, revisions } = await ownerAccess.canvasHistory(
      id,
      cursor,
    );
    const last = revisions.at(-1);
    return answer(ownerAccess, execution, {
      channel,
      ...(cursor.before === undefined && revisions[0]
        ? { version: revisions[0].id }
        : {}),
      revisions: revisions.map((revision) => ({
        id: revision.id,
        at: time(revision.created_at),
        author: revision.pubkey,
        bytes: new TextEncoder().encode(revision.content).length,
        line: (revision.content.trim().split("\n", 1)[0] ?? "").slice(0, 80),
      })),
      ...(last && revisions.length >= CANVAS_HISTORY_PAGE
        ? {
            next: { channel, before: last.created_at, before_id: last.id },
          }
        : {}),
    });
  }
  if (name === "owner_channel_get") {
    const { execution, ...details } = await ownerAccess.channel(id);
    return answer(ownerAccess, execution, details);
  }
  const page = paging(args);
  const { execution, ...members } = await ownerAccess.members(id, page);
  const next = page.offset + members.members.length;
  return answer(ownerAccess, execution, {
    ...members,
    ...(next < members.total ? { next: { offset: next } } : {}),
  });
}

/** owner_read: `read`'s arguments, limits and continuation, with no
 * default to the current conversation. */
async function read(
  ownerAccess: OwnerAccess,
  args: Readonly<Record<string, unknown>>,
) {
  let channel = optionalText(args.channel, "channel");
  let thread = optionalText(args.thread, "thread");
  if (args.message_url !== undefined) {
    if (channel || thread)
      throw new Error("message_url cannot be combined with channel or thread.");
    const link =
      typeof args.message_url === "string"
        ? parseBuzzLink(args.message_url)
        : null;
    if (link?.format !== "legacy" || !link.messageId)
      throw new Error("message_url must be a Buzz message link.");
    channel = link.channelId;
    thread = link.messageId;
  }
  if (thread !== undefined) thread = eventId(thread, "thread");
  const q = optionalText(args.q, "q");
  const cursor = pageCursor(args);
  const since = unixTime(args, "since");
  if (
    since !== undefined &&
    cursor.before !== undefined &&
    since > cursor.before
  )
    throw new Error("since must not be after before.");
  let author: string | undefined;
  if (args.author !== undefined)
    try {
      author = pubkey(args.author as string);
    } catch {
      throw new Error(
        "author must be a hex pubkey or npub; users finds one by name.",
      );
    }
  const given = typeof args.limit === "number" ? args.limit : undefined;
  let request: OwnerReadRequest;
  if (q) {
    if (thread)
      throw new Error(
        "q searches channels, not a thread; narrow it with channel.",
      );
    if (cursor.beforeId)
      throw new Error(
        "before_id pages thread and channel reads; narrow a search with before or since.",
      );
    request = {
      search: q,
      ...(channel ? { channel } : {}),
      ...(author ? { author } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(cursor.before !== undefined ? { before: cursor.before } : {}),
      limit: bound(given, 20, 100),
    };
  } else if (thread) {
    if (author || since !== undefined)
      throw new Error(
        "author and since filter a search (q) or a channel read, not a thread; add q or channel.",
      );
    // One under the relay read cap leaves room for the more-pages lookahead.
    request = { thread, ...cursor, limit: bound(given, 100, 499) };
  } else if (channel) {
    request = {
      channel,
      ...(author ? { author } : {}),
      ...(since !== undefined ? { since } : {}),
      ...cursor,
      limit: bound(given, 30, 200),
    };
  } else throw new Error("channel, thread, message_url or q is required.");
  const page = await ownerAccess.messages(request);
  const scope = {
    ...(page.channel ? { channel: page.channel } : {}),
    ...(page.root ? { root: page.root } : {}),
  };
  const more = page.root
    ? { thread: page.root, limit: request.limit }
    : {
        channel: page.channel,
        ...(author ? { author } : {}),
        ...(since !== undefined ? { since } : {}),
        limit: request.limit,
      };
  return answer(ownerAccess, page.execution, {
    ...(page.channel ? { channel: page.channel } : {}),
    ...(page.root ? { thread: page.root } : {}),
    messages: edited(page.events, (author) => page.owners?.[author]).map(
      (event) => messageLine(event, page.names[event.pubkey], scope),
    ),
    ...(page.more
      ? {
          next: {
            ...more,
            before: page.more.before,
            before_id: page.more.beforeId,
          },
        }
      : {}),
    ...(page.limited ? { limited: true } : {}),
    // Messages whose edits did not fit show their earlier text.
    ...(page.editsLimited ? { edits_limited: true } : {}),
    ...(page.partial ? { partial: true } : {}),
  });
}

/** The answer's text, and a check that the binding it was read with still
 * holds. */
function answer(
  ownerAccess: OwnerAccess,
  execution: OwnerExecution,
  fields: object,
) {
  return {
    text: JSON.stringify({ executedAs: execution, ...fields }),
    held: () => ownerAccess.held(execution),
  };
}

/** A `before` and `before_id` cursor. */
function pageCursor(args: Readonly<Record<string, unknown>>) {
  const before = unixTime(args, "before");
  const beforeId = args.before_id;
  if (beforeId === undefined) return before === undefined ? {} : { before };
  if (before === undefined)
    throw new Error("before_id needs before, from the same next.");
  return { before, beforeId: eventId(beforeId, "before_id") as string };
}

function eventId(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HEX.test(value))
    throw new Error(`${name} must be a 64-character event ID.`);
  return value;
}

function paging(args: Readonly<Record<string, unknown>>) {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
    throw new Error("limit must be a whole number, 1 or more.");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw new Error("offset must be a whole number, 0 or more.");
  return { limit: Math.min(limit, 500), offset };
}

function optionalText(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  return value.trim() || undefined;
}
