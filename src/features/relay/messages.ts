import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "./events";
import type { ProfileQueries } from "./profile-directory";
import { attachmentMessage, type UploadedAttachment } from "./attachments";
import { validReactionContent, type CustomEmoji } from "./emoji";
import type { EventTemplate } from "nostr-tools";
import { MEDIA_TARGET_TAG, type ChannelMessage } from "./contracts";
import { messageAuthor } from "./fold";
import { threadReference } from "./thread-reference";
import { reactionTarget as reactionTargetId } from "./reaction-target";
import { safeMessageUrl } from "./message-content";
import type { EventData } from "./events";
import type { Outbox, OutboxRecovery } from "./outbox";

/** Owner authorization is supplied only after the agent's signed profile is verified. */
export type AgentOwnerAuthorization = Readonly<{
  agentId: string;
  ownerId: string;
}>;

/** NIP-56 types accepted by the Buzz relay for message reports. */
export const REPORT_TYPES = [
  "spam",
  "profanity",
  "nudity",
  "impersonation",
  "malware",
  "illegal",
  "other",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
/** `["effort", agentPubkey, level]` and `["model", agentPubkey, model]`: what
 * an addressed agent's owner asks of its next run. Only the owner is honoured. */
export const EFFORT_TAG = "effort";
export const MODEL_TAG = "model";
export type RunPick = Readonly<{ model?: string; effort?: string }>;
/** The model and effort picked for each addressed agent, by pubkey. */
export type MentionPicks = Readonly<Record<string, RunPick>>;

/** Domain convenience only. Delivery and read reconciliation remain session-owned. */
export function createMessages(
  outbox: Outbox | undefined,
  viewer: string | undefined,
  find: (id: string) => EventData | undefined,
  emojiTags: (content: string) => string[][],
  validateMentions: (channelId: string, pubkeys: readonly string[]) => void,
  canWrite: (
    channelId: string,
    owner?: AgentOwnerAuthorization,
  ) => boolean = () => true,
  relayOrigin?: string,
  /** Resolves on relay OK. Reports are never echoed, so they bypass the outbox. */
  publishReport?: (template: EventTemplate) => Promise<void>,
  /** Explicit relay NIP-11 self; never inferred from contacts or a displayed row. */
  signingAuthority?: string,
  profiles?: ProfileQueries,
  /** Who a message in the channel addresses without a mention: a one-to-one
   * DM's other member. A pick may name them as well as a mention. */
  unmentionedRecipients: (channelId: string) => readonly string[] = () => [],
  /** Events whose `buzz:copy-of` tag names this message id (sent-to-channel copies). */
  copiesOf: (id: string) => readonly EventData[] = () => [],
) {
  const writer = (
    kind: number,
    channelId: string,
    owner?: AgentOwnerAuthorization,
  ) => {
    if (!canWrite(channelId, owner))
      throw new Error("You don’t have write access to this conversation.");
    if (!outbox?.supports(kind))
      throw new Error("This connection cannot publish that operation");
    return outbox;
  };
  const ownedMessage = (event: EventData) =>
    !!viewer && messageAuthor(event, signingAuthority) === viewer;
  const text = (content: string) => {
    const value = content.trim();
    if (!value) throw new Error("Message is empty");
    return value;
  };
  const mentionTags = (channelId: string, pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention recipients");
    const unique = [...new Set(pubkeys)];
    validateMentions(channelId, unique);
    return unique.map((key) => ["p", key]);
  };
  /** A one-to-one DM's agent partner must be `p`-tagged: a hosted agent is
   * woken only by a `p` tag naming it, and local agents already treat any
   * 1:1 DM message as addressed. Never a human partner: a `p` tag is a
   * mention and would bypass their mute. "Agent" is the profile's `isAgent`
   * (a NIP-OA `auth` tag or a declared agent flag), the app's shared agent
   * signal. Only new messages and replies call this; edits and reactions
   * are not new turns. */
  const withDmAgents = (channelId: string, mentions: readonly string[]) => {
    const profileMap = profiles?.snapshot();
    return [
      ...mentions,
      ...unmentionedRecipients(channelId).filter(
        (key) => profileMap?.get(key)?.isAgent,
      ),
    ];
  };
  const referenceTags = (pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention references");
    return [...new Set(pubkeys)].map((key) => ["mention", key]);
  };
  const pickTags = (
    channelId: string,
    mentions: readonly string[],
    picks: MentionPicks,
  ) => {
    const entries = Object.entries(picks);
    const addressed = entries.length
      ? [...mentions, ...unmentionedRecipients(channelId)]
      : mentions;
    return entries.flatMap(([key, { model, effort }]) => {
      if (
        !addressed.includes(key) ||
        (model !== undefined && !/^[\w.:/[\]-]{1,64}$/.test(model)) ||
        (effort !== undefined && !/^[a-z0-9-]{1,32}$/.test(effort))
      )
        throw new Error("A model or effort applies only to an addressed agent");
      return [
        ...(model === undefined ? [] : [[MODEL_TAG, key, model]]),
        ...(effort === undefined ? [] : [[EFFORT_TAG, key, effort]]),
      ];
    });
  };
  /** The author's other copies of a message: its source reply and every
   * sent-to-channel copy of it, deduplicated, never the message itself. */
  const linkedCopies = (message: EventData, channelId: string) => {
    if (!ownedMessage(message) || message.kind !== 9) return [];
    const sourceId = message.tags.find(
      ([name, value]) => name === "buzz:copy-of" && value,
    )?.[1];
    const root = sourceId ? find(sourceId) : message;
    const candidates = [
      ...(root ? [root] : []),
      ...copiesOf(sourceId ?? message.id),
    ];
    return [
      ...new Map(candidates.map((event) => [event.id, event])).values(),
    ].filter(
      (other) =>
        other.id !== message.id &&
        other.kind === 9 &&
        ownedMessage(other) &&
        other.tags.some(([name, value]) => name === "h" && value === channelId),
    );
  };
  const edit = (
    messageId: string,
    content: string,
    attachmentSourceId: string,
    authorization?: AgentOwnerAuthorization,
  ) => {
    const original = find(messageId);
    if (!original || ![9, 40002].includes(original.kind))
      throw new Error("Load the message before editing it");
    const ownerEdit =
      !!viewer &&
      authorization?.ownerId === viewer &&
      authorization.agentId === messageAuthor(original, signingAuthority);
    if (!ownedMessage(original) && !ownerEdit)
      throw new Error("Only your own messages can be edited");
    const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channelId) throw new Error("Message has no channel");
    // The displayed fold owns edit/deletion precedence. Resolve its provenance,
    // never silently resurrect the original attachments if evidence was evicted.
    const attachmentSource = find(attachmentSourceId);
    if (
      !attachmentSource ||
      (attachmentSource.id !== original.id &&
        (attachmentSource.kind !== 40003 ||
          (!ownedMessage(attachmentSource) &&
            attachmentSource.pubkey !==
              profiles?.owner?.(messageAuthor(original, signingAuthority)) &&
            (!ownerEdit ||
              messageAuthor(attachmentSource, signingAuthority) !==
                messageAuthor(original, signingAuthority))) ||
          !attachmentSource.tags.some(
            ([name, id]) => name === "e" && id === messageId,
          ) ||
          attachmentSource.tags.some(
            ([name, id]) => name === "h" && id !== channelId,
          ) ||
          !attachmentSource.tags.some(([name]) => name === "imeta")))
    )
      throw new Error("Reload the message before editing its attachments.");
    const sendEdit = (targetId: string) =>
      writer(40003, channelId, ownerEdit ? authorization : undefined).send({
        kind: 40003,
        content: text(content),
        tags: [
          ["h", channelId],
          ["e", targetId],
          ...attachmentSource.tags.filter((tag) => tag[0] === "imeta"),
          ...emojiTags(content),
        ],
      });
    const id = sendEdit(messageId);
    // A sent-to-channel copy and its thread reply are one message to the author:
    // mirror the edit onto the counterpart. Best effort; the primary edit stands.
    for (const other of linkedCopies(original, channelId)) {
      try {
        sendEdit(other.id);
      } catch {
        // Counterpart unavailable; leave it as-is.
      }
    }
    return id;
  };
  const remove = (
    eventIds: readonly string[],
    authorization?: AgentOwnerAuthorization,
  ) => {
    const ids = [...new Set(eventIds)];
    if (!ids.length || ids.length > 100)
      throw new Error("Choose between 1 and 100 events to remove");
    const originals = ids.map((id) => {
      const event = find(id);
      if (!event || ![7, 9, 40002].includes(event.kind))
        throw new Error("Load the message or reaction before removing it");
      const agentOwnerRemoval =
        !!viewer &&
        event.kind !== 7 &&
        messageAuthor(event, signingAuthority) === authorization?.agentId &&
        authorization.ownerId === viewer;
      if (
        event.kind === 7
          ? event.pubkey !== viewer
          : !ownedMessage(event) && !agentOwnerRemoval
      )
        throw new Error("Only your own messages and reactions can be removed");
      return event;
    });
    const channel = (event: EventData) =>
      event.tags.find(([name]) => name === "h")?.[1] ??
      (event.kind === 7
        ? find(reactionTargetId(event) ?? "")?.tags.find(
            ([name]) => name === "h",
          )?.[1]
        : undefined);
    const first = originals[0];
    const channelId = first ? channel(first) : undefined;
    if (!channelId || originals.some((event) => channel(event) !== channelId))
      throw new Error("Removal must belong to one loaded conversation");
    // Deleting a thread reply or its sent-to-channel copy removes the author's
    // other linked copies too, so none lingers as an orphan.
    const linked = originals
      .flatMap((event) => linkedCopies(event, channelId))
      .filter((event) => !ids.includes(event.id));
    const all = [...ids, ...new Set(linked.map((event) => event.id))];
    const targets = [
      ...new Map(
        [...originals, ...(all.length <= 100 ? linked : [])].map((event) => [
          event.id,
          event,
        ]),
      ).values(),
    ];
    // The relay accepts exactly one target per deletion, so each copy gets its
    // own event. One that cannot be queued does not stop the rest; any failure
    // is reported once every other target has been attempted.
    const queue = writer(5, channelId, authorization);
    const failures: unknown[] = [];
    const operations = targets.flatMap((event) => {
      try {
        return [
          queue.send({
            kind: 5,
            content: "",
            tags: [
              ["h", channelId],
              ["e", event.id],
              ["k", String(event.kind)],
            ],
          }),
        ];
      } catch (cause) {
        failures.push(cause);
        return [];
      }
    });
    if (failures.length)
      throw new Error(
        `Could not delete ${failures.length} of ${targets.length} linked messages`,
        { cause: failures[0] },
      );
    return operations[0] as string;
  };
  return Object.freeze({
    send(
      channelId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
      recovery?: OutboxRecovery,
      references: readonly string[] = [],
      picks: MentionPicks = {},
    ) {
      if (!channelId) throw new Error("A channel is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send(
        {
          kind: 9,
          content: text(message.content),
          tags: [
            ["h", channelId],
            ...mentionTags(channelId, withDmAgents(channelId, mentions)),
            ...referenceTags(references),
            ...pickTags(channelId, mentions, picks),
            ...emojiTags(content),
            ...message.tags,
          ],
        },
        ...(recovery ? [recovery] : []),
      );
    },
    /** Copy an authored reply as a fresh top-level event, preserving its displayed semantics. */
    sendToChannel(row: ChannelMessage, root?: ChannelMessage) {
      const original = find(row.id);
      const thread = original && threadReference(original);
      if (original?.kind !== 9 || !thread)
        throw new Error("Load a thread reply before sending it to the channel");
      if (!ownedMessage(original) || row.authorId !== viewer)
        throw new Error("Only your own messages can be sent to the channel");
      const channelId = original.tags.find(([name]) => name === "h")?.[1];
      if (
        !channelId ||
        channelId !== row.channelId ||
        row.threadRootId !== thread.rootId ||
        (row.delivery && !["accepted", "seen"].includes(row.delivery))
      )
        throw new Error(
          "Reload the thread reply before sending it to the channel",
        );
      const attachmentSource = find(row.attachmentSourceId ?? row.id);
      if (
        !attachmentSource ||
        (!ownedMessage(attachmentSource) &&
          attachmentSource.pubkey !==
            profiles?.owner?.(messageAuthor(original, signingAuthority))) ||
        (attachmentSource.id !== original.id &&
          (attachmentSource.kind !== 40003 ||
            !attachmentSource.tags.some(
              ([name, id]) => name === "e" && id === row.id,
            ) ||
            attachmentSource.tags.some(
              ([name, id]) => name === "h" && id !== channelId,
            )))
      )
        throw new Error("Reload the message attachments before sending");
      // The mounted thread supplies its reconciled root, including edits/deletions.
      // Never fall back to the raw retained event, which may contain superseded text.
      const excerpt =
        root?.id === thread.rootId && root.channelId === channelId
          ? Array.from(
              root.content
                .replace(/\|\|[\s\S]*?(?:\|\||$)/g, " ")
                .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
                .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
                .replace(/(?:https?:\/\/|buzz:\/\/)\S+/g, " ")
                .replace(/[`*_~>#|]/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
            )
          : [];
      const label =
        excerpt.length > 64
          ? `${excerpt.slice(0, 63).join("")}…`
          : excerpt.join("");
      const content = row.sourceContent ?? row.content;
      return writer(9, channelId).send({
        kind: 9,
        content: text(
          content.trim()
            ? content
            : row.attachments.map((attachment) => attachment.url).join("\n"),
        ),
        tags: [
          ["h", channelId],
          ["buzz:sent-from-thread", thread.rootId, ...(label ? [label] : [])],
          // Links the copy to its reply so later edits reach both.
          ["buzz:copy-of", original.id],
          // Sharing does not notify the original recipients again. Preserve display binding only.
          ...referenceTags(
            row.edited
              ? []
              : [...row.mentions, ...(row.mentionReferences ?? [])],
          ),
          ...(row.emoji ?? []).map((emoji) => [
            "emoji",
            emoji.shortcode,
            emoji.url,
          ]),
          ...attachmentSource.tags.filter(
            ([name]) => name === "imeta" || name === "link-preview",
          ),
        ],
      });
    },
    reply(
      channelId: string,
      rootId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
      parentId: string = rootId,
      references: readonly string[] = [],
      picks: MentionPicks = {},
      mediaTargetUrl?: string,
    ) {
      if (!channelId) throw new Error("A channel is required");
      if (!/^[0-9a-f]{64}$/.test(rootId))
        throw new Error("A valid thread root is required");
      if (!/^[0-9a-f]{64}$/.test(parentId))
        throw new Error("A valid reply parent is required");
      const mediaTarget = mediaTargetUrl
        ? safeMessageUrl(mediaTargetUrl)
        : undefined;
      if (mediaTargetUrl && !mediaTarget)
        throw new Error("A valid media target is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send({
        kind: 9,
        content: text(message.content),
        tags: [
          ["h", channelId],
          ...(parentId === rootId ? [] : [["e", rootId, "", "root"]]),
          ["e", parentId, "", "reply"],
          ...mentionTags(channelId, withDmAgents(channelId, mentions)),
          ...referenceTags(references),
          ...pickTags(channelId, mentions, picks),
          ...(mediaTarget ? [[MEDIA_TARGET_TAG, mediaTarget]] : []),
          ...emojiTags(content),
          ...message.tags,
        ],
      });
    },
    /** Supply the current folded attachmentSourceId, or the row ID for original media. */
    edit: (messageId: string, content: string, attachmentSourceId: string) =>
      edit(messageId, content, attachmentSourceId),
    /** Verified owner edit. Empty text removes the message, as in the composer.
     * As a guest it signs only once `profiles.owner` names the viewer; an
     * earlier call fails delivery as read-only, and `retry(id)` resends it. */
    async editOwnedAgent(
      messageId: string,
      content: string,
      attachmentSourceId: string,
    ) {
      const original = find(messageId);
      if (!original || !viewer || !profiles)
        throw new Error("Load the owned agent's message before editing it");
      const author = messageAuthor(original, signingAuthority);
      await profiles.ensure([author]);
      const profile = profiles.event?.(author);
      if (
        !profile ||
        profile.pubkey !== author ||
        profile.kind !== 0 ||
        !hasEventProof(profile) ||
        (await attestedOwner(profile)) !== viewer ||
        profiles.event?.(author)?.id !== profile.id
      )
        throw new Error("Only an agent's verified owner can edit its messages");
      const authorization = { agentId: author, ownerId: viewer };
      return content.trim()
        ? edit(messageId, content, attachmentSourceId, authorization)
        : remove([messageId], authorization);
    },
    react(messageId: string, content: string, emoji?: CustomEmoji) {
      const original = find(messageId);
      if (!original || ![9, 40002, 40008].includes(original.kind))
        throw new Error("Load the message before reacting to it");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      const value = text(content);
      if (!validReactionContent(value)) throw new Error("Reaction is too long");
      return writer(7, channelId).send({
        kind: 7,
        content: value,
        tags: [
          ["h", channelId],
          ["e", messageId],
          ["p", messageAuthor(original, signingAuthority)],
          ...(emoji && value.toLowerCase() === `:${emoji.shortcode}:`
            ? [["emoji", emoji.shortcode, emoji.url]]
            : emojiTags(value)),
        ],
      });
    },
    remove,
    /** Undefined when this connection cannot publish reports. */
    report: publishReport
      ? (messageId: string, type: ReportType, note = "") => {
          const original = find(messageId);
          if (!original || ![9, 40002, 40008].includes(original.kind))
            return Promise.reject(
              new Error("Load the message before reporting it"),
            );
          if (!REPORT_TYPES.includes(type))
            return Promise.reject(new Error("Choose a report reason"));
          return publishReport({
            kind: 1984,
            content: note.trim(),
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", original.pubkey],
              ["e", messageId, type],
            ],
          });
        }
      : undefined,
    reactionTarget(event: Pick<EventData, "kind" | "tags">) {
      if (event.kind === 7) return reactionTargetId(event);
      const target = event.tags.find(([name]) => name === "e")?.[1];
      if (event.kind !== 5 || !target) return undefined;
      const original = find(target);
      return original?.kind === 7 ? reactionTargetId(original) : undefined;
    },
    retry(id: string) {
      outbox?.retry(id);
    },
  });
}
