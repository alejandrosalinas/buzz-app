import { useGifDraftPreview } from "../../bundled/emoji/GifDraftPreview";
import { useMentionArchives } from "./use-mention-archives";
import { memo, useContext, type ReactNode } from "react";
import { DraftMentionRoster } from "./draft-mention-roster";
import { archivedMention } from "./mention-admission";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useNamesRevision } from "../identity-names/react";
import { useListedChannel } from "../relay/listed-channel";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import type { ConversationExtensions } from "../conversation/contracts";
import type { Profile } from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { ComposerSession } from "./composer-session";
import { profileKey } from "../profiles/target";
import { scanMarkdown } from "../relay/message-content";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "./composer-document";
import { messageLinkParts } from "./message-link-parts";
import { parseBuzzLink } from "../navigation/buzz-links";
import { messageReferences } from "./message-references";
import { EditableInput, type EditableInputProps } from "./EditableInput";

/** Token artwork with props that hold across keystrokes, so typing prose does
 * not re-render every link chip in a long draft. */
const TokenMarkdown = memo(function TokenMarkdown({
  source,
  channelId,
  emoji,
  directory,
  profiles,
  session,
  scope,
  extensions,
}: {
  source: string;
  channelId: string;
  emoji: readonly CustomEmoji[];
  directory: ReturnType<typeof useReferenceDirectory>;
  profiles: ReadonlyMap<string, Profile>;
  session: ComposerSession;
  scope: string;
  extensions: ConversationExtensions | undefined;
}) {
  return (
    <MessageMarkdown
      row={{
        id: "composer",
        authorId: "",
        createdAt: 0,
        channelId,
        content: source,
        mentions: [],
        emoji,
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      directory={directory}
      participantProfiles={profiles}
      session={session}
      scope={scope}
      extensions={extensions}
      media={session.media}
      onOpenLink={() => false}
      interactive={false}
    />
  );
});

/** Identity chip artwork from primitive props, so typing prose does not
 * re-render every mention in a long draft. */
const TokenChip = memo(function TokenChip({
  kind,
  id,
  label,
  qualifier,
  reveal,
}: {
  kind: "agent" | "person";
  id: string;
  label: string;
  qualifier: string | undefined;
  reveal: boolean;
}) {
  return (
    <InlineChip
      address={{ kind, id }}
      face={{ label, loading: false, resolved: true }}
      qualifier={
        qualifier
          ? {
              text: `· ${qualifier}`,
              reveal,
              accessibleLabel: `public key ending ${qualifier.split("").join(" ")}`,
            }
          : undefined
      }
      interactive={false}
    />
  );
});

/** Decorations never change source text or infer notification recipients from names. */
export function RichComposerInput({
  draft,
  session,
  scope,
  channelId,
  extensions,
  emoji,
  ...input
}: EditableInputProps & {
  draft: MentionDraft;
  session: ComposerSession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const gifDraftPreview = useGifDraftPreview(extensions?.tools);
  const directory = useReferenceDirectory(session);
  const members = useListedChannel(
    session.channels,
    channelId,
    (channel) => channel?.members,
  );
  const archives = useMentionArchives(session);
  const roster = useContext(DraftMentionRoster)?.recipients;
  // Recipients, not keystrokes, change chip names: typing prose must not
  // copy every profile or scan every member of a large channel.
  const recipientKey = JSON.stringify(
    draft.recipients.map(({ pubkey, name }) => [pubkey, name]),
  );
  // Chip labels and facts come from names.lookup.
  const names = useNamesRevision(session.names, recipientKey !== "[]");
  const { profiles, qualifiers, labels } = useMemo(() => {
    void archives;
    void names;
    const recipients = JSON.parse(recipientKey) as [string, string][];
    const profiles = new Map(directory.profiles);
    for (const [pubkey, name] of recipients)
      profiles.set(pubkey, { ...profiles.get(pubkey), name });
    if (!recipients.length)
      return {
        profiles,
        qualifiers: new Map<string, string | undefined>(),
        labels: new Map<string, string>(),
      };
    // Chips name selections among the people who read this destination. Draft
    // recipients stay in even when archived, so their chips keep a name.
    const candidates = [
      ...new Set([
        ...(roster?.map((p) => p.pubkey) ?? members ?? []).filter(
          (pubkey) => !archivedMention(session, pubkey),
        ),
        ...recipients.map(([pubkey]) => pubkey),
      ]),
    ];
    const displayFacts = recipients
      .filter(([pubkey]) => !session.names?.lookup(pubkey, candidates))
      .map(([pubkey, name]) => ({ pubkey, name }));
    return {
      profiles,
      qualifiers: new Map(
        recipients.map(([pubkey]) => [
          pubkey,
          session.names?.lookup(pubkey, candidates, displayFacts)?.qualifier,
        ]),
      ),
      labels: new Map(
        recipients.map(([pubkey, name]) => [
          pubkey,
          session.names?.lookup(pubkey, candidates, displayFacts)?.name ?? name,
        ]),
      ),
    };
  }, [
    session,
    directory.profiles,
    recipientKey,
    roster,
    members,
    archives,
    names,
  ]);
  const previous = useRef(labels);
  const revealed = useRef(
    new Set([...qualifiers].filter(([, suffix]) => suffix).map(([key]) => key)),
  );
  // Keep the motion decision through editor-driven rerenders of the same
  // draft and labels; a new draft or naming result starts a new decision.
  const labelState = JSON.stringify([...labels]);
  const reveal = useMemo(
    () =>
      new Set(
        (JSON.parse(labelState) as [string, string][])
          .filter(
            ([key, label]) =>
              draft.recipients.some((recipient) => recipient.pubkey === key) &&
              previous.current.has(key) &&
              previous.current.get(key) !== label &&
              !revealed.current.has(key),
          )
          .map(([key]) => key),
      ),
    [draft, labelState],
  );
  // Media URLs derive from the URL alone, so this list changes with the catalog.
  const renderableEmoji = useMemo(
    () => emoji.filter((entry) => !!session.media(entry.url)),
    [emoji, session],
  );
  const shortcodes = useMemo(
    () =>
      new Set(renderableEmoji.map((entry) => entry.shortcode.toLowerCase())),
    [renderableEmoji],
  );
  // The normalizer, the render and the token reconcile decorate the same
  // document in one keystroke; parse its Markdown once.
  const scanned = useRef<{
    text: string;
    scan: ReturnType<typeof scanMarkdown>;
  }>(undefined);
  // Channel references scan every channel name against the text; reuse them
  // until the text or the directory changes.
  const referenced = useRef<{
    text: string;
    inputs: unknown[];
    references: ReturnType<typeof messageReferences>;
  }>(undefined);
  useLayoutEffect(() => {
    previous.current = labels;
    if (!draft.text) revealed.current.clear();
    for (const [key, suffix] of qualifiers)
      if (suffix) revealed.current.add(key);
  });
  function decorationsFor(draft: MentionDraft) {
    const doc = readComposerSnapshot(draft.document);
    const context = doc
      ? composerMarkdownContext(doc)
      : { text: draft.text, protected: [] };
    if (scanned.current?.text !== context.text)
      scanned.current = {
        text: context.text,
        scan: scanMarkdown(context.text),
      };
    const { tree, links, tooDeep } = scanned.current.scan;
    const literals: { start: number; end: number }[] = [...context.protected];
    const gifPreviews = new Map<number, { end: number; content: ReactNode }>();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.type === "image" && !tooDeep) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const content = gifDraftPreview?.(node.url, node.alt, session.media);
        if (
          content &&
          start !== undefined &&
          end !== undefined &&
          !context.protected.some(
            (range) => start < range.end && end > range.start,
          )
        )
          gifPreviews.set(start, { end, content });
      }
      if (
        [
          "code",
          "inlineCode",
          "image",
          "imageReference",
          "definition",
          "html",
        ].includes(node.type)
      ) {
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          literals.push({ start, end });
      } else pending.push(...(node.children ?? []));
    }
    const ranges: {
      start: number;
      end: number;
      mention?: string;
      editAsText?: boolean;
    }[] = [];
    const add = (
      start: number,
      end: number,
      mention?: string,
      editAsText = false,
    ) => {
      if (
        // Explicit recipients disclose notification intent even inside Markdown literals.
        (mention ||
          (!tooDeep &&
            !literals.some(
              (range) => start < range.end && end > range.start,
            ))) &&
        !ranges.some((range) => start < range.end && end > range.start)
      )
        ranges.push({
          start,
          end,
          editAsText,
          ...(mention ? { mention } : {}),
        });
    };
    for (const recipient of draft.recipients)
      add(recipient.start, recipient.end, recipient.pubkey);
    // Identity links are display references, not new notification recipients.
    // Keep their exact source token so editing surrounding prose preserves it.
    const profileLinks = new Map<number, { pubkey: string; label: string }>();
    for (const link of links) {
      const pubkey = link.url && profileKey(link.url);
      const start = link.position?.start.offset;
      const end = link.position?.end.offset;
      if (!pubkey || start === undefined || end === undefined) continue;
      let label = "";
      const pending = [...(link.children ?? [])].reverse();
      while (pending.length) {
        const node = pending.pop();
        if (node?.value) label += node.value;
        else pending.push(...(node?.children ?? []).slice().reverse());
      }
      profileLinks.set(start, { pubkey, label: label.replace(/^@/, "") });
      add(start, end, undefined, true);
    }
    // A labeled channel link is one chip, like a mention: editing never
    // exposes its Markdown or separates its label from its channel.
    messageLinkParts(
      context.text,
      (start, end, _label, url) => {
        const link = parseBuzzLink(url);
        add(
          start,
          end,
          undefined,
          !(link?.format === "legacy" && !link.messageId),
        );
      },
      (start, end) => add(start, end, undefined, true),
    );
    const inputs = [profiles, directory.named, directory.agents];
    if (
      referenced.current?.text !== context.text ||
      referenced.current.inputs.some((input, i) => input !== inputs[i])
    )
      referenced.current = {
        text: context.text,
        inputs,
        references: messageReferences(
          context.text,
          [],
          profiles,
          directory.named,
          directory.agents,
        ),
      };
    for (const reference of referenced.current.references)
      add(reference.start, reference.end, undefined, true);
    for (const match of context.text.matchAll(/:([a-z0-9_-]{1,64}):/gi))
      if (shortcodes.has(match[1]?.toLowerCase() ?? ""))
        add(match.index, match.index + match[0].length);
    for (const [start, { end }] of gifPreviews)
      if (!ranges.some((range) => start < range.end && end > range.start))
        ranges.push({ start, end });
    const decorations = ranges
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, mention, editAsText }) => {
        const preview = gifPreviews.get(start);
        if (preview && preview.end === end && !mention)
          return { start, end, editAsText: false, content: preview.content };
        const profile = mention ? undefined : profileLinks.get(start);
        const identity = mention ?? profile?.pubkey;
        const label = profile?.label ?? draft.text.slice(start + 1, end);
        const resolved = mention ? (labels.get(mention) ?? label) : label;
        const qualifier = mention ? qualifiers.get(mention) : undefined;
        const faceLabel = qualifier
          ? resolved.slice(0, -(qualifier.length + 3))
          : resolved;
        return {
          start,
          end,
          editAsText: !!editAsText,
          content: identity ? (
            <TokenChip
              kind={
                directory.profiles.get(identity)?.isAgent ||
                directory.agents.some((agent) => agent.pubkey === identity)
                  ? "agent"
                  : "person"
              }
              id={identity}
              label={faceLabel}
              qualifier={qualifier}
              reveal={!!mention && reveal.has(mention)}
            />
          ) : (
            <TokenMarkdown
              source={draft.text.slice(start, end)}
              channelId={channelId}
              emoji={renderableEmoji}
              directory={directory}
              profiles={profiles}
              session={session}
              scope={scope}
              extensions={extensions}
            />
          ),
        };
      });
    return decorations;
  }
  return (
    <EditableInput {...input} draft={draft} decorationsFor={decorationsFor} />
  );
}
