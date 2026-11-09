// The owner tools' host side: read-only operations the app runs with its
// signed-in human's own session, for that human's agent, in the agent's own
// community. Every call resolves the binding again and checks it once more
// before returning anything, so a sign-out, account switch or reconnect during
// a call returns nothing.
import type {
  BuzzEvent,
  OwnerAccess,
  OwnerChannel,
  OwnerExecution,
  OwnerReadRequest,
  OwnerRole,
} from "../../buzz-mcp/client";
import { MESSAGES, rootOf, SEARCH, THREAD } from "../../buzz-mcp/tools";
import { memberAuthority } from "../channel-members/administration-protocol";
import { CANVAS_HISTORY_PAGE } from "../channel-templates/canvas-limits";
import { communityDestination } from "../communities/destination";
import { channelIdentity } from "../relay/channel-labels";
import type { ChannelSummary } from "../relay/contracts";
import type { ReadFilter, RelayEvent } from "../relay/events";
import {
  channelTypeTag,
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
} from "../relay/channel-lifecycle-protocol";
import { soloLabels } from "../solo/labels";
import type { RelaySession } from "../relay/session";

/** Whether this build lets agents read with their owner's access in
 * `community`: its exact canonical origin is in the build's list. */
export function ownerMcpEnabled(community: string | null | undefined) {
  if (!community) return false;
  try {
    return (import.meta.env.VITE_BUZZ_OWNER_MCP_COMMUNITIES ?? "")
      .split(" ")
      .includes(communityDestination(community).url);
  } catch {
    return false;
  }
}

export type OwnerSession = Pick<
  RelaySession,
  | "relayAuthor"
  | "channels"
  | "readRemote"
  | "names"
  | "profiles"
  | "channelLifecycle"
  | "snapshotRead"
>;
/** The owner's live session for the agent's community, as the host binds it
 * now. `signal` aborts when that binding is replaced. */
export type OwnerBinding = Readonly<{
  viewer: string;
  origin: string;
  session: OwnerSession;
  signal: AbortSignal;
}>;

/** One edit read serves a whole page; the relay reader's cap. */
const EDITS = 500;

const unavailable = () =>
  new Error(
    "Your owner's Buzz is not connected to this community as them, so owner tools are unavailable now.",
  );
const notOwners = (id: string) =>
  new Error(
    `Channel ${id} is not in your owner's channels; owner_channel_list lists them.`,
  );
const changed = () =>
  new Error(
    "Your owner's connection changed during the call, so nothing was returned. Try again.",
  );

/** `agent`'s owner reads. `bind` answers the owner's current binding for the
 * agent's community, or undefined when it may not be used now. */
export function createOwnerAccess(
  agent: Readonly<{ pubkey: string; owner: string }>,
  bind: () => OwnerBinding | undefined,
): OwnerAccess {
  /** The binding each answer was read with. */
  const answered = new WeakMap<OwnerExecution, OwnerBinding>();
  const current = () => {
    const binding = bind();
    if (!binding || binding.signal.aborted || binding.viewer !== agent.owner)
      throw unavailable();
    return binding;
  };
  /** Runs `read` on the current binding; its answer only while the binding
   * still holds. */
  async function run<T>(
    signal: AbortSignal | undefined,
    read: (binding: OwnerBinding, signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    signal?.throwIfAborted();
    const binding = current();
    const bound = signal
      ? AbortSignal.any([signal, binding.signal])
      : binding.signal;
    let result: T;
    try {
      result = await read(binding, bound);
    } catch (error) {
      signal?.throwIfAborted();
      throw binding.signal.aborted ? changed() : error;
    }
    signal?.throwIfAborted();
    holds(binding);
    return result;
  }
  /** Throws unless `binding` is still the current one. */
  const holds = (binding: OwnerBinding) => {
    const now = bind();
    if (
      binding.signal.aborted ||
      now?.session !== binding.session ||
      now.viewer !== binding.viewer
    )
      throw changed();
    current();
  };
  const execution = (binding: OwnerBinding): OwnerExecution => {
    const execution = {
      agent: agent.pubkey,
      owner: binding.viewer,
      community: binding.origin,
    };
    answered.set(execution, binding);
    return execution;
  };
  /** The relay-signed metadata, admin list and roster, read fresh. */
  const authority = async (
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ) => {
    const { session, viewer } = binding;
    const relayAuthor = session.relayAuthor;
    if (!relayAuthor) throw unavailable();
    const events = await session.readRemote(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong" as const,
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      { signal, priority: "foreground" },
    );
    signal.throwIfAborted();
    if (!events.some((event) => event.kind === 39000))
      throw new Error(
        `Channel ${id} was not found or your owner cannot see it.`,
      );
    const rights = memberAuthority(events, id, viewer, relayAuthor);
    // Whatever the session's list says, a system channel is never read.
    if (rights.system) throw notOwners(id);
    // memberAuthority has verified all three records.
    const metadata = lifecycleRecord(
      events,
      39000,
      id,
      relayAuthor,
    ) as RelayEvent;
    return { events, rights, metadata };
  };
  /** Channel `id` as the owner's session knows it; never a system channel,
   * which `list()` never shows either. */
  const listed = (session: OwnerSession, id: string) => {
    const item =
      session.channels.list().channels.find((each) => each.id === id) ??
      session.channels.get?.(id);
    return item && item.channelType !== "system" ? item : undefined;
  };
  const known = (session: OwnerSession, id: string) => {
    const item = listed(session, id);
    if (!item) throw notOwners(id);
    return item;
  };
  /** The relay's own answer to the owner's session: nothing is merged into,
   * or projected from, its views, so no unread or read state changes. */
  const fetch = async (
    binding: OwnerBinding,
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly BuzzEvent[]> => {
    const read = binding.session.snapshotRead;
    if (!read) throw unavailable();
    const events = await read(filters, { signal });
    signal.throwIfAborted();
    return events;
  };
  /** Channel `id`, checked as one of the owner's against the relay's fresh
   * records before anything in it is read. */
  const readable = async (
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ) => {
    known(binding.session, channelId(id));
    await authority(binding, id, signal);
    return id;
  };
  /** Message `id` and its channel, which must be one of the owner's. */
  const message = async (
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ) => {
    const [event] = await fetch(
      binding,
      [{ ids: [id], kinds: [...THREAD, 45001], limit: 1 }],
      signal,
    );
    const channel = event && tag(event, "h");
    // One outside the owner's channels reads as missing, naming no channel.
    if (!event || !channel || !listed(binding.session, channel))
      throw new Error(`No message ${id} that your owner can see.`);
    return { event, channel: await readable(binding, channel, signal) };
  };
  /** The latest edits of `events`, read for their authors' names too. */
  const edits = (
    binding: OwnerBinding,
    events: readonly BuzzEvent[],
    signal: AbortSignal,
  ) =>
    events.length
      ? fetch(
          binding,
          [{ kinds: [40003], "#e": events.map(({ id }) => id), limit: EDITS }],
          signal,
        )
      : Promise.resolve([]);
  const names = async (
    session: OwnerSession,
    events: readonly BuzzEvent[],
    signal: AbortSignal,
  ) => {
    const keys = [...new Set(events.map(({ pubkey }) => pubkey))];
    if (keys.length) await session.profiles.ensure(keys, "foreground");
    signal.throwIfAborted();
    const found: Record<string, string> = {};
    for (const key of keys) {
      const name =
        session.names.resolve(key) ??
        session.profiles.snapshot().get(key)?.name;
      if (name) found[key] = name;
    }
    return found;
  };
  const channelId = (id: string) => {
    try {
      return lifecycleChannelId(id);
    } catch {
      throw new Error("channel must be a channel ID.");
    }
  };

  /** `events` with their edits and their authors' names. */
  const page = async (
    binding: OwnerBinding,
    events: readonly BuzzEvent[],
    signal: AbortSignal,
  ) => {
    const changes = await edits(binding, events, signal);
    const found = await names(binding.session, events, signal);
    const owners: Record<string, string> = {};
    for (const { pubkey } of events) {
      const owner = binding.session.profiles.owner?.(pubkey);
      if (owner) owners[pubkey] = owner;
    }
    return {
      execution: execution(binding),
      events: [...events, ...changes],
      names: found,
      ...(Object.keys(owners).length ? { owners } : {}),
      ...(changes.length >= EDITS ? { editsLimited: true as const } : {}),
    };
  };

  return Object.freeze({
    channels: (signal?: AbortSignal) =>
      run(signal, (binding) => {
        const { channels } = binding.session;
        const list = channels.list();
        // Asks the owner's session to finish its list; reads only.
        if (list.status !== "ready") channels.ensureList();
        return {
          execution: execution(binding),
          channels: list.channels.map((item) =>
            ownerChannel(item, binding.viewer),
          ),
          partial: list.status !== "ready" || list.coverage === "partial",
          ...(list.error ? { error: list.error } : {}),
        };
      }),
    channel: (id: string, signal?: AbortSignal) =>
      run(signal, async (binding, bound) => {
        const summary = known(binding.session, channelId(id));
        const { events, rights, metadata } = await authority(
          binding,
          id,
          bound,
        );
        const { viewer } = binding;
        const role = rights.roles[viewer];
        // Type, archive state and lifecycle rights from the records just read,
        // never the session's list.
        const tag = channelTypeTag(metadata);
        const type: OwnerChannel["type"] =
          tag === "stream" && soloLabels(channelIdentity(metadata).labels)
            ? "solo"
            : tag === "stream" || tag === "forum" || tag === "dm"
              ? tag
              : "unknown";
        // The session's lifecycle owner also grants a member who owns the
        // channel's owner-role agent, as the relay does. It judges the same
        // writer-backed records, never a replica that may lag them.
        const offer = role
          ? await binding.session.channelLifecycle.load(id, bound, events)
          : undefined;
        bound.throwIfAborted();
        return {
          execution: execution(binding),
          channel: {
            ...ownerChannel(summary, viewer),
            type,
            archived: exactLifecycleTag(metadata, "archived") === "true",
            role: role ?? null,
            members: Object.keys(rights.roles).length,
            ...(summary.description
              ? { description: summary.description }
              : {}),
            ...(summary.joinRole ? { joinRole: summary.joinRole } : {}),
            ...(summary.ttlSeconds ? { ttlSeconds: summary.ttlSeconds } : {}),
            ...(summary.creator ? { creator: summary.creator } : {}),
            ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
          },
          capabilities: {
            manageRoles: rights.canManage,
            removeMembers: rights.canRemove,
            archive: !!offer?.canArchive,
            unarchive: !!offer?.canUnarchive,
            delete: !!offer?.canDelete,
          },
        };
      }),
    members: (
      id: string,
      page: Readonly<{ offset: number; limit: number }>,
      signal?: AbortSignal,
    ) =>
      run(signal, async (binding, bound) => {
        known(binding.session, channelId(id));
        const { rights } = await authority(binding, id, bound);
        const roster = Object.entries(rights.roles);
        const shown = roster.slice(page.offset, page.offset + page.limit);
        const keys = shown.map(([pubkey]) => pubkey);
        const { session } = binding;
        if (keys.length) await session.profiles.ensure(keys, "foreground");
        bound.throwIfAborted();
        const members = roster.map(([pubkey]) => pubkey);
        return {
          execution: execution(binding),
          channel: id,
          total: roster.length,
          members: shown.map(([pubkey, role]) => {
            const name =
              session.names.resolve(pubkey, undefined, members) ??
              session.profiles.snapshot().get(pubkey)?.name;
            return { pubkey, role, ...(name ? { name } : {}) };
          }),
        };
      }),
    messages: (request: OwnerReadRequest, signal?: AbortSignal) =>
      run(signal, async (binding, bound) => {
        const { limit, before, beforeId, author, since, search } = request;
        let { channel } = request;
        let root: string | undefined;
        if (request.thread) {
          const found = await message(binding, request.thread, bound);
          channel = found.channel;
          root = rootOf(found.event);
        } else if (channel) await readable(binding, channel, bound);
        // The relay's cursor: at or before `until`, after `before_id` at a tie.
        const cursor = {
          ...(before !== undefined ? { until: before } : {}),
          ...(beforeId ? { before_id: beforeId } : {}),
        };
        const narrow = {
          ...(author ? { authors: [author] } : {}),
          ...(since !== undefined ? { since } : {}),
        };
        if (search !== undefined) {
          const found = await fetch(
            binding,
            [
              {
                kinds: SEARCH,
                search,
                limit,
                ...(channel ? { "#h": [channel] } : {}),
                ...cursor,
                ...narrow,
              },
            ],
            bound,
          );
          // Only the owner's own channels, never a system one.
          const shown = found.filter((event) => {
            const id = tag(event, "h");
            return !!id && !!listed(binding.session, id);
          });
          const list = binding.session.channels.list();
          const partial =
            !channel &&
            (list.status !== "ready" || list.coverage === "partial");
          const answer = await page(binding, shown, bound);
          return {
            ...answer,
            ...(channel ? { channel } : {}),
            ...(found.length >= limit ? { limited: true as const } : {}),
            ...(partial ? { partial: true as const } : {}),
          };
        }
        if (!channel) throw new Error("channel, thread or q is required.");
        // One more than the limit tells whether older messages remain.
        const found = await fetch(
          binding,
          root
            ? [
                {
                  kinds: THREAD,
                  "#h": [channel],
                  "#e": [root],
                  limit: limit + 1,
                  ...cursor,
                },
                ...(before === undefined
                  ? [{ ids: [root], kinds: [...THREAD, 45001], limit: 1 }]
                  : []),
              ]
            : [
                {
                  kinds: MESSAGES,
                  "#h": [channel],
                  limit: limit + 1,
                  ...cursor,
                  ...narrow,
                },
              ],
          bound,
        );
        const inChannel = found.filter((event) => tag(event, "h") === channel);
        const first = root
          ? inChannel.find((event) => event.id === root)
          : undefined;
        const rest = inChannel.filter((event) => event !== first);
        const shown = rest.slice(0, limit);
        const last = shown.at(-1);
        const more =
          last && rest.length > limit
            ? { before: last.created_at, beforeId: last.id }
            : undefined;
        const answer = await page(
          binding,
          first ? [first, ...shown] : shown,
          bound,
        );
        return {
          ...answer,
          channel,
          ...(root ? { root } : {}),
          ...(more ? { more } : {}),
        };
      }),
    canvas: (channel: string, revision?: string, signal?: AbortSignal) =>
      run(signal, async (binding, bound) => {
        const id = await readable(binding, channel, bound);
        const [head] = await fetch(
          binding,
          [
            {
              // From the writer, as history lists it, so an ID history just
              // gave is found.
              ...(revision
                ? { ids: [revision], consistency: "strong" as const }
                : {}),
              kinds: [40100],
              "#h": [id],
              limit: 1,
            },
          ],
          bound,
        );
        if (revision && tag(head, "h") !== id)
          throw new Error(`No revision ${revision} of channel ${id}'s canvas.`);
        return {
          execution: execution(binding),
          channel: id,
          ...(head ? { canvas: head } : {}),
        };
      }),
    canvasHistory: (
      channel: string,
      cursor: Readonly<{ before?: number; beforeId?: string }>,
      signal?: AbortSignal,
    ) =>
      run(signal, async (binding, bound) => {
        const id = await readable(binding, channel, bound);
        // As the app's history pages it. The first page is read from the
        // writer, so it includes a write just confirmed.
        const revisions = await fetch(
          binding,
          [
            {
              kinds: [40100],
              "#h": [id],
              limit: CANVAS_HISTORY_PAGE,
              ...(cursor.before === undefined
                ? { consistency: "strong" as const }
                : { until: cursor.before }),
              ...(cursor.beforeId ? { before_id: cursor.beforeId } : {}),
            },
          ],
          bound,
        );
        return {
          execution: execution(binding),
          channel: id,
          revisions: revisions.filter((event) => tag(event, "h") === id),
        };
      }),
    held: (answer: OwnerExecution) => {
      const binding = answered.get(answer);
      if (!binding) throw changed();
      holds(binding);
    },
  });
}

function ownerChannel(item: ChannelSummary, viewer: string): OwnerChannel {
  const type = item.channelType;
  // Membership alone does not say which role the owner holds.
  const role: OwnerRole | "unknown" | null | undefined =
    item.viewerRole ??
    (item.members
      ? item.members.includes(viewer)
        ? "unknown"
        : null
      : undefined);
  return {
    id: item.id,
    name: item.name,
    type:
      type === "stream" || type === "forum" || type === "dm" || type === "solo"
        ? type
        : "unknown",
    visibility: item.private
      ? "private"
      : item.visibility === "public"
        ? "open"
        : (item.visibility ?? "unknown"),
    archived: !!item.archived,
    ...(role !== undefined ? { role } : {}),
    ...(item.cached ? { cached: true as const } : {}),
    ...(item.members ? { members: item.members.length } : {}),
  };
}

const tag = (event: BuzzEvent | undefined, name: string) =>
  event?.tags.find((entry) => entry[0] === name)?.[1];
