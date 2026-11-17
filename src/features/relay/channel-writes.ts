import { canonicalDetailsName } from "./channel-details-protocol";
import { exactLifecycleTag } from "./channel-lifecycle-protocol";
import { channelIdentityUnsupported, channelLabelTags } from "./channel-labels";
import { SOLO_NAMED_LABEL, SOLO_LABEL } from "../solo/labels";
import type { Outbox, OutboxRecovery } from "./outbox";
import type { RelayWriter } from "./transport";
import {
  promoteSoloAdmins,
  soloAdminKey,
  soloAdminRecovery,
  soloAgentOwnership,
} from "./solo-admins";
import { isBatchAddition } from "../channel-members/members";
import { withdraw } from "./withdraw";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { RelayReader } from "./reader";
import type { EventData } from "./events";
import type { ProfileQueries } from "./profile-directory";

export const DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Solo start that made no chat: the relay refused its create, or the
 * relay has no record of it once its delivery attempts ran out. */
export class ChatNotStarted extends Error {}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Channel write commands use the same durable outbox and connection lifetime. */
export function createChannelWrites(
  outbox: Outbox | undefined,
  channels: ChannelQueries,
  reader: RelayReader,
  signal: AbortSignal,
  receipts?: Pick<Outbox, "snapshot" | "subscribe">,
  confirmCreation?: (id: string) => Promise<boolean>,
  /** Forward-looking agent choices plus the base archive rule for admissions. */
  agents?: {
    selectable: () => readonly string[];
    archived: (pubkey: string) => boolean;
    profiles?: Pick<ProfileQueries, "event">;
    viewer?: string;
  },
  relayAuthor?: string,
  /** Signed roster discovery, including channels this viewer cannot open. */
  discovery: RelayReader = reader,
  channelIdentity = false,
  adminWriter?: RelayWriter,
) {
  const available = !!outbox?.supports(9007);
  function writer(addition = false) {
    if (signal.aborted || !available || !outbox)
      throw new Error(
        addition
          ? "This community cannot add agents to channels right now. Check the connection and retry."
          : "This community does not support channel creation yet. Your draft is kept here.",
      );
    return outbox;
  }
  function identifier(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid session identifier");
  }
  async function delivered(
    id: string,
    active?: () => boolean,
    addition = false,
    retry = true,
  ) {
    const check = () => {
      if (active?.() === false)
        throw new DOMException("Channel addition cancelled", "AbortError");
    };
    check();
    // Recipe and Canvas saves share delivery, not channel-creation authority.
    if (signal.aborted || !outbox)
      throw new Error(
        "The community connection cannot confirm this operation.",
      );
    const source = addition ? writer(true) : outbox;
    const journal = receipts ?? source;
    const existing = journal.snapshot().find((item) => item.event.id === id);
    if (!existing) {
      if (await confirmCreation?.(id)) {
        check();
        return;
      }
      const events = await reader.read(
        [{ ids: [id], limit: 1, consistency: "strong" }],
        { signal },
      );
      if (events.some((event) => event.id === id)) {
        check();
        return;
      }
      throw new Error(
        "The saved operation could not be confirmed. Reconnect and retry.",
      );
    }
    if (existing.delivery === "failed" || existing.delivery === "unknown") {
      // Ordinary channel creation rejects a repeated channel UUID. An exact,
      // verified creation event can confirm an earlier lost acknowledgment.
      if (existing.event.kind === 9007) {
        if (await confirmCreation?.(id)) {
          check();
          return;
        }
        const channelId = existing.event.tags.find(
          ([name]) => name === "h",
        )?.[1];
        if (!channelId)
          throw new Error("The saved channel creation is invalid.");
        // A missed membership notification must not leave the readback hidden
        // by a stale roster. The verified reader applies signed discovery first.
        const events = await reader.read(
          [
            {
              kinds: [39000, 39002],
              "#d": [channelId],
              limit: 2,
              consistency: "strong",
            },
            { ids: [id], limit: 1, consistency: "strong" },
          ],
          { signal },
        );
        if (
          events.some(
            (event) =>
              event.id === id && event.pubkey === existing.event.pubkey,
          )
        ) {
          check();
          return;
        }
      }
      check();
      if (!retry) {
        const events = await reader.read(
          [{ ids: [id], limit: 1, consistency: "strong" }],
          { signal },
        );
        if (events.some((event) => event.id === id)) return;
        throw new Error(
          existing.error ?? "The operation could not be confirmed.",
        );
      }
      if (active) source.retry(id, active);
      else source.retry(id);
    }
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const aborted = () =>
        finish(
          new Error(
            addition
              ? "The community connection changed. Check channel membership before adding again."
              : "The community connection changed. Your draft is kept.",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              addition
                ? "Agent addition is unconfirmed. Check channel membership before retrying; the request may already have reached the relay."
                : "Still waiting for confirmation. Retry without starting another session.",
            ),
          ),
        15000,
      );
      const inspect = () => {
        const item = journal.snapshot().find((item) => item.event.id === id);
        if (item?.delivery === "accepted" || item?.delivery === "seen")
          finish();
        else if (item?.delivery === "failed" || item?.delivery === "unknown")
          finish(
            new Error(
              item.error ??
                (addition
                  ? "Agent addition could not be confirmed. Check membership before retrying."
                  : "The operation could not be confirmed."),
            ),
          );
      };
      unsubscribe = journal.subscribe(inspect);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else inspect();
    });
    check();
  }
  /** Resolves once the channel list shows `id` with the expected membership.
   * Admission never comes from the command's acknowledgment: the list must
   * carry a relay-signed roster. When discovery has already made the list
   * ready, that evidence arrives by an exact one-channel read first: the
   * store's `resolve` (metadata and roster) for a channel the list lacks, or
   * its `refreshRoster` (roster only) for a channel it already carries, such
   * as one an agent was just added to. Otherwise, or when that read leaves the
   * gate unsatisfied, the full viewer-roster discovery runs. All three apply
   * through the same discovery path.
   *
   * A system channel (NIP-CL) never joins the list, so the gate finds it
   * through `get` once the list is ready. The full pass reads system rosters
   * too, so it follows the same path. */
  async function refresh(
    id: string,
    expected: {
      member?: string;
      members?: readonly string[];
      system?: boolean | undefined;
    } = {},
    soloOnly = true,
  ) {
    writer(!soloOnly);
    let settled = false;
    // Aborted once the gate decides, so a still-running exact read releases
    // its reader slot instead of holding it until the connection closes.
    const exact = new AbortController();
    // A system channel never lists; `get` carries it once discovery is ready.
    const found = (
      matches: (channel: ChannelSummary) => boolean | undefined,
    ) => {
      if (!expected.system) return channels.list().channels.some(matches);
      const channel = channels.get?.(id);
      return (
        channel?.channelType === "system" && !channel.cached && matches(channel)
      );
    };
    const wait = new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const done = (error?: Error) => {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        exact.abort();
        error ? reject(error) : resolve();
      };
      const abort = () => done(new Error("The community connection changed."));
      const timer = setTimeout(
        () =>
          done(
            new Error(
              soloOnly
                ? "Session saved, but its membership is still loading. Retry to continue."
                : "Agent addition is unconfirmed. Check channel membership before retrying; the request may already have reached the relay.",
            ),
          ),
        15000,
      );
      const matches = (channel: ChannelSummary) =>
        channel.id === id &&
        !channel.pending &&
        (!soloOnly || channel.channelType === "solo") &&
        (!expected.member || channel.members?.includes(expected.member)) &&
        (!expected.members ||
          expected.members.every((key) => channel.members?.includes(key)));
      const inspect = (reportError = true) => {
        const list = channels.list();
        if (reportError && list.status === "error")
          done(new Error(list.error ?? "Session membership could not load."));
        else if (list.status === "ready" && found(matches)) done();
      };
      unsubscribe = channels.subscribeList(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else inspect(false); // An earlier roster error does not decide this retry.
    });
    // The gate may time out or abort while a read is in flight; its rejection
    // stays observed here and is rethrown below.
    const gate = wait.catch(() => {});
    // The exact read extends a list discovery has already made ready. Any other
    // status (idle, loading, error) needs the full pass to become ready at all,
    // and that pass carries the new channel; the store's exact reads would
    // otherwise commit a ready list holding only this channel and, after a
    // failed initial discovery, hide the error the user still needs to retry.
    if (!settled && channels.list().status === "ready") {
      // A channel the ready list carries is one the store authorizes. Its
      // `resolve` skips such ids (they carry cached-denial semantics), so a
      // member addition re-reads that one roster through `refreshRoster`; a
      // channel the list lacks (just created) is admitted by `resolve`'s exact
      // metadata-and-roster read.
      // A chat still pending is listed but unconfirmed: `resolve` admits it.
      const listed = found((channel) => channel.id === id && !channel.pending);
      await Promise.race([
        gate,
        (async () => {
          try {
            const options = {
              signal: AbortSignal.any([signal, exact.signal]),
              consistency: "strong" as const,
            };
            await (listed
              ? channels.refreshRoster?.(id, options)
              : channels.resolve?.([id], options));
          } catch {
            // A failed or stale exact read leaves the decision to discovery.
          }
        })(),
      ]);
    }
    if (!settled) channels.refreshList?.({ consistency: "strong" });
    await wait;
  }
  async function refreshMembership(id: string) {
    if (signal.aborted || (!outbox?.supports(9007) && !outbox?.supports(9000)))
      throw new Error("Channel membership is unavailable.");
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    // A chat this device is starting has no roster until its create lands.
    await starts.get(id);
    const events = await reader.read(
      [
        {
          kinds: [39002],
          authors: [relayAuthor],
          "#d": [id],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal, fresh: true, priority: "foreground" },
    );
    const channel =
      channels.list().channels.find((item) => item.id === id) ??
      channels.get?.(id);
    if (
      !events.some(
        (event) =>
          event.kind === 39002 &&
          event.pubkey === relayAuthor &&
          event.tags.some(([name, value]) => name === "d" && value === id),
      ) ||
      !channel?.members ||
      channel.archived
    )
      throw new Error(
        "Could not refresh channel membership. Retry to continue.",
      );
    return channel;
  }
  /** Unarchived channel IDs among `candidates` and those whose relay-signed
   * roster lists `pubkey`, as far as this viewer may read. The relay refuses
   * membership changes in an archived channel, where a membership is inert.
   * Throws rather than return a possibly truncated set. */
  async function memberChannels(
    pubkey: string,
    caller: AbortSignal,
    candidates: Iterable<string>,
  ) {
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    const limit = 500;
    const events = await discovery.read(
      [
        {
          kinds: [39002],
          authors: [relayAuthor],
          "#p": [pubkey],
          limit,
          consistency: "strong",
        },
      ],
      {
        signal: AbortSignal.any([signal, caller]),
        fresh: true,
        priority: "foreground",
      },
    );
    if (events.length >= limit)
      throw new Error("Too many channels to confirm. Retry later.");
    const ids = new Set(candidates);
    for (const event of events) {
      const id = event.tags.find(([name]) => name === "d")?.[1];
      if (
        id &&
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([name, value]) => name === "p" && value === pubkey)
      )
        ids.add(id);
    }
    if (!ids.size) return [];
    const metadata = await discovery.read(
      [
        {
          kinds: [39000],
          authors: [relayAuthor],
          "#d": [...ids],
          limit: ids.size,
          consistency: "strong",
        },
      ],
      {
        signal: AbortSignal.any([signal, caller]),
        fresh: true,
        priority: "foreground",
      },
    );
    for (const event of metadata) {
      const id = event.tags.find(([name]) => name === "d")?.[1];
      if (
        id &&
        event.kind === 39000 &&
        event.pubkey === relayAuthor &&
        exactLifecycleTag(event, "archived") === "true"
      )
        ids.delete(id);
    }
    return [...ids];
  }
  /** Whether this channel's current relay-signed roster lists `pubkey`. Throws
   * when no roster is readable, so missing evidence never counts as absence. */
  async function listsMember(id: string, pubkey: string, caller: AbortSignal) {
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    const events = await discovery.read(
      [
        {
          kinds: [39002],
          authors: [relayAuthor],
          "#d": [id],
          limit: 1,
          consistency: "strong",
        },
      ],
      {
        signal: AbortSignal.any([signal, caller]),
        fresh: true,
        priority: "foreground",
      },
    );
    const roster = events.find(
      (event) =>
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([name, value]) => name === "d" && value === id),
    );
    if (!roster)
      throw new Error(
        "Could not refresh channel membership. Retry to continue.",
      );
    return roster.tags.some(
      ([name, value]) => name === "p" && value === pubkey,
    );
  }
  async function addAgents(
    id: string,
    keys: readonly string[],
    active?: () => boolean,
  ) {
    if (active?.() === false)
      throw new DOMException("Channel addition cancelled", "AbortError");
    const original = await refreshMembership(id);
    if (active?.() === false)
      throw new DOMException("Channel addition cancelled", "AbortError");
    const unique = [...new Set(keys)].filter(
      (key) =>
        original.channelType !== "solo" || !original.members?.includes(key),
    );
    if (!unique.length) return;
    if (
      !original.members ||
      original.archived ||
      !["stream", "forum", "solo"].includes(original.channelType ?? "")
    )
      throw new Error("Refresh the channel before adding agents.");
    // Archive state applies to every new admission, even for current members;
    // unknown archive state fails open to the library/member rule.
    if (unique.some((key) => agents?.archived(key)))
      throw new Error("This agent is archived. Choose another agent.");
    const known = new Set(agents?.selectable() ?? []);
    if (
      unique.some((key) => !original.members?.includes(key) && !known.has(key))
    )
      throw new Error("Choose an agent from your agent library.");
    // Additions are published and acknowledged in turn; the roster is then
    // confirmed with one exact read rather than a gate after every command.
    const added: string[] = [];
    for (const key of unique) {
      if (active?.() === false)
        throw new DOMException("Channel addition cancelled", "AbortError");
      writer(!!active);
      const current = channels.list().channels.find((item) => item.id === id);
      if (!current?.members || current.archived)
        throw new Error("Channel membership is unavailable.");
      if (current.members.includes(key)) continue;
      const previous = (receipts ?? outbox)?.snapshot().find((item) => {
        const roles = item.event.tags.filter(([name]) => name === "role");
        return (
          item.event.kind === 9000 &&
          !item.acknowledged &&
          !isBatchAddition(item) &&
          !["accepted", "seen"].includes(item.delivery) &&
          item.event.tags.some(
            ([name, value]) => name === "h" && value === id,
          ) &&
          item.event.tags.some(
            ([name, value]) => name === "p" && value === key,
          ) &&
          roles.length === (original.channelType === "solo" ? 1 : 0) &&
          // Recovery finishes the saved grant even if the viewer's role changed.
          roles.every(
            (tag) =>
              tag.length === 2 && (tag[1] === "bot" || tag[1] === "admin"),
          )
        );
      });
      if (previous && Date.now() / 1000 - previous.event.created_at >= 15 * 60)
        throw new Error(
          `This agent-add request expired. Open Outbox, remove the “Add agent ${key.slice(0, 12)}” item, then add the agent again. Check channel membership first if the request was unconfirmed.`,
        );
      let owned: (() => boolean) | undefined;
      if (
        original.channelType === "solo" &&
        !previous &&
        original.viewerRole === "owner"
      ) {
        owned = await freshOwnership(key);
      }
      const roleTags =
        original.channelType === "solo"
          ? [
              [
                "role",
                original.viewerRole === "owner" && owned?.() ? "admin" : "bot",
              ],
            ]
          : [];
      const operation =
        previous?.event.id ??
        writer(!!active).send(
          {
            kind: 9000,
            content: "",
            tags: [["h", id], ["p", key], ...roleTags],
          },
          undefined,
          active,
        );
      await delivered(operation, active, true);
      if (active?.() === false)
        throw new DOMException("Channel addition cancelled", "AbortError");
      added.push(key);
    }
    if (added.length) await refresh(id, { members: added }, false);
    if (original?.channelType === "solo")
      await refresh(id, { members: unique });
  }
  /** Cached discovery is not evidence for a new automatic Admin grant. */
  async function freshOwnership(key: string) {
    const events = await discovery.read(
      [{ kinds: [0], authors: [key], limit: 1, consistency: "strong" }],
      { signal, fresh: true, priority: "foreground" },
    );
    const owned = await soloAgentOwnership(
      agents?.profiles,
      agents?.viewer,
      key,
    );
    return () =>
      owned() &&
      events.some(
        (event) =>
          event.kind === 0 &&
          event.pubkey === key &&
          event.id === agents?.profiles?.event?.(key)?.id,
      );
  }
  /** Solo chats this device is starting, until they can take events. */
  const starts = new Map<string, Promise<void>>();
  const adminSetups = new Map<string, Promise<void>>();
  /** Publication retries also call this after reload. The create's local
   * receipt retains the original recipients until every grant is recorded. */
  function prepareOpening(id: string): Promise<void> | undefined {
    const pending = (receipts ?? outbox)
      ?.snapshot()
      .find((item) => item.recovery?.key === soloAdminKey(id));
    if (!pending) return;
    const active = adminSetups.get(id);
    if (active) return active;
    const work = (async () => {
      const source = writer();
      const withRecovery = source.withRecovery;
      const finishRecovery = source.finishRecovery;
      if (!adminWriter || !relayAuthor || !withRecovery || !finishRecovery)
        throw new Error("This connection cannot set up chat admins.");
      await created(pending.event.id);
      const saved = await source.recovery(soloAdminKey(id));
      if (!saved?.recovery)
        throw new Error(
          "Chat admin setup ended in another window. Retry this message to continue.",
        );
      const recovery = saved.recovery;
      await promoteSoloAdmins(
        saved,
        {
          ...adminWriter,
          publish: (event, signal, checkOwnership) =>
            withRecovery(saved.event.id, recovery, () => {
              checkOwnership();
              return adminWriter.publish(event, signal);
            }),
        },
        discovery,
        relayAuthor,
        signal,
        freshOwnership,
      );
      signal.throwIfAborted();
      await finishRecovery(saved.event.id, recovery);
    })();
    adminSetups.set(id, work);
    void work.catch(() => {}).finally(() => adminSetups.delete(id));
    return work;
  }
  /** The Canvas of each chat this device is starting ("" for none), until
   * its save lands; see `startingCanvas`. */
  const canvases = new Map<string, string>();
  /** Settles once the relay has the create, or rejects with ChatNotStarted
   * once it is known to have none. A lost acknowledgment resends the same
   * create, which the relay confirms; when the attempts run out, the relay is
   * asked for the create until it answers. */
  async function created(create: string) {
    for (let tries = 1; tries <= 3; tries++) {
      try {
        return await delivered(create);
      } catch (error) {
        // Only the relay's refusal ends the start; a failure on this device,
        // before the create was sent, retries it.
        if (
          (receipts ?? outbox)
            ?.snapshot()
            .some((item) => item.event.id === create && item.refused)
        )
          throw new ChatNotStarted(
            String(error instanceof Error ? error.message : error),
            { cause: error },
          );
        if (signal.aborted) throw error;
      }
      // A failed check is not an answer; give the connection time to recover.
      await pause(500 * 2 ** tries, signal);
    }
    for (let wait = 1_000; ; wait = Math.min(wait * 2, 30_000)) {
      if (signal.aborted) throw new Error("The community connection changed.");
      try {
        const events = await reader.read(
          [{ ids: [create], limit: 1, consistency: "strong" }],
          { signal },
        );
        if (events.some((event) => event.id === create)) return;
      } catch {
        await pause(wait, signal);
        continue;
      }
      // An attempt still under way may yet land; ask again after it.
      if (
        outbox
          ?.snapshot()
          .some(
            (item) => item.event.id === create && item.delivery === "sending",
          )
      ) {
        await pause(wait, signal);
        continue;
      }
      // The relay has no such create; `start` withdraws it.
      throw new ChatNotStarted("The relay has no record of it.");
    }
  }
  const api = Object.freeze({
    available,
    addAgents,
    refreshMembership,
    memberChannels,
    listsMember,
    prepareOpening,
    createChannel(
      id: string,
      title: string,
      visibility: "open" | "private",
      description?: string,
      ttlSeconds?: number,
      active?: () => boolean,
      options: Readonly<{
        labels?: readonly string[] | undefined;
        /** NIP-CL system channel: left out of reads that do not name it. */
        system?: boolean | undefined;
      }> = {},
    ) {
      writer();
      identifier(id);
      const labelTags = channelLabelTags(options.labels ?? []);
      const name = canonicalDetailsName(title);
      const about = description?.trim();
      if (!name || [...name].length > 120)
        throw new Error("Use a channel name between 1 and 120 characters.");
      if (about && [...about].length > 1000)
        throw new Error("Keep the channel description under 1,000 characters.");
      if (options.labels?.includes(SOLO_LABEL))
        throw new Error("Start a Solo chat from Solo instead.");
      if (
        ttlSeconds !== undefined &&
        (!Number.isInteger(ttlSeconds) ||
          ttlSeconds <= 0 ||
          ttlSeconds > 2_147_483_647)
      )
        throw new Error("Choose a valid temporary channel duration.");
      return writer().send(
        {
          kind: 9007,
          content: "",
          tags: [
            ["h", id],
            ["name", name],
            ["visibility", visibility],
            ["channel_type", options.system ? "system" : "stream"],
            ...(about ? [["about", about]] : []),
            ...(ttlSeconds ? [["ttl", String(ttlSeconds)]] : []),
            ...labelTags,
          ],
        },
        undefined,
        active,
      );
    },
    create(
      id: string,
      title: string,
      ttlSeconds?: number,
      named = false,
      members: readonly string[] = [],
      active?: () => boolean,
      labels: readonly string[] = [],
      recovery?: OutboxRecovery,
    ) {
      writer();
      identifier(id);
      // Solo is a channel label, so a relay without NIP-CL cannot hold one.
      if (!channelIdentity) throw channelIdentityUnsupported();
      if (!title.trim() || [...title].length > 120)
        throw new Error("Use a session title between 1 and 120 characters.");
      if (
        ttlSeconds !== undefined &&
        (!Number.isInteger(ttlSeconds) ||
          ttlSeconds <= 0 ||
          ttlSeconds > 2_147_483_647)
      )
        throw new Error("Choose a valid chat duration.");
      return writer().send(
        {
          kind: 9007,
          content: "",
          tags: [
            ["h", id],
            ["name", title],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ...(ttlSeconds !== undefined ? [["ttl", String(ttlSeconds)]] : []),
            ...channelLabelTags([
              SOLO_LABEL,
              ...(named ? [SOLO_NAMED_LABEL] : []),
              ...labels,
            ]),
            ...[...new Set(members)].map((key) => ["p", key]),
          ],
        },
        recovery,
        active,
      );
    },
    /** Starts a Solo chat whose create names its `members`. It lists at once
     * as pending; `ready` settles once the relay OKs the create, which adds the
     * members (block/buzz#8421), and a background read then confirms the chat.
     * The chat's own events publish after `ready` (see `starting`). A refused
     * create (see `failed`) drops the pending chat. */
    start(
      id: string,
      title: string,
      members: readonly string[],
      ttlSeconds?: number,
      named = false,
      /** The chat's Canvas, and the work that saves it once the chat
       * exists; nothing waits for it, and a failure leaves a working chat. */
      setup?: { canvas: string; apply(): Promise<unknown> },
      options?: {
        labels?: readonly string[];
        active?: () => boolean;
        admins?: readonly string[];
      },
    ) {
      const recovery = soloAdminRecovery(id, members, options?.admins);
      if (recovery && (!adminWriter || !relayAuthor))
        throw new Error("This connection cannot set up chat admins.");
      const create = api.create(
        id,
        title,
        ttlSeconds,
        named,
        members,
        options?.active,
        options?.labels,
        recovery,
      );
      channels.start?.({
        id,
        name: title,
        members,
        labels: [
          SOLO_LABEL,
          ...(named ? [SOLO_NAMED_LABEL] : []),
          ...(options?.labels ?? []),
        ],
        ttlSeconds,
      });
      // The relay adds the members in the create, so the chat takes events
      // once the create is OK.
      const ready = created(create);
      starts.set(id, ready);
      canvases.set(id, setup?.canvas ?? "");
      const settled = setup
        ? ready.then(() =>
            setup.apply().catch((reason) => {
              console.warn("Solo chat setup did not finish", reason);
            }),
          )
        : ready;
      void ready.then(
        // Confirming the chat only ends its pending listing.
        () => refresh(id).catch(() => {}),
        (error) => {
          if (!(error instanceof ChatNotStarted)) return;
          // A chat that was never made is gone, with everything sent in it.
          channels.abandon?.(id);
          for (const item of outbox?.snapshot() ?? [])
            if (
              outbox &&
              item.event.tags.some(
                ([name, value]) => name === "h" && value === id,
              )
            )
              void withdraw(outbox, item.event.id).catch(() => {});
        },
      );
      void ready.catch(() => {}).finally(() => starts.delete(id));
      void settled.catch(() => {}).finally(() => canvases.delete(id));
      return { create, ready };
    },
    /** Settles when a chat this device is starting exists on the relay, so it
     * can be read and take events. */
    starting(id: string): Promise<void> | undefined {
      return starts.get(id);
    },
    /** The Canvas a chat this device is starting will have ("" for none),
     * until its save lands: what a local agent's first turn reads, without
     * waiting for the relay. */
    startingCanvas(id: string): string | undefined {
      return canvases.get(id);
    },
    failed(id: string) {
      return (
        (receipts ?? outbox)
          ?.snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed") ??
        false
      );
    },
    /** Outbox fences local delivery and expiry; this read bypasses cached absence. */
    async additionRecorded(event: EventData, caller: AbortSignal) {
      const active = AbortSignal.any([signal, caller]);
      active.throwIfAborted();
      const events = await reader.read(
        [
          {
            kinds: [9000],
            ids: [event.id],
            authors: [event.pubkey],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal: active, fresh: true, priority: "foreground" },
      );
      active.throwIfAborted();
      return events.some((recorded) => recorded.id === event.id);
    },
    async discardFailed(id: string) {
      const source = writer();
      if (
        !(receipts ?? source)
          .snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed")
      )
        throw new Error(
          "This operation is still unconfirmed. Retry to confirm it first.",
        );
      await source.dismiss(id);
    },
    delivered,
    refresh,
  });
  return api;
}
