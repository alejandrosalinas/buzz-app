import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import { spoilerText } from "../notifications/content";
import { profileKey } from "../profiles/target";
import { PROFILE_CACHE_BASE } from "../relay/budget";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { MatchedLabel } from "../search/MatchedLabel";
import { preparedMarkdown, recentResults } from "./markdown-preparation";
import { placeholderPattern, protectInlineContent } from "./MessageMarkdown";
import type { AgentLibrary } from "../agents/library";
import { profileMentionNames } from "./profile-mentions";
import { ProfileMention, useReferenceDirectory } from "./ReferenceText";

/** A message as its previews bind it: its body as its conversation shows
 * it, attachments already projected out, and its signed identities. */
export type PreviewMentions = Pick<
  ChannelMessage,
  "content" | "mentions" | "mentionReferences" | "edited" | "attachmentSeams"
>;

type Part = { text: string; target?: string | undefined };

/** Every identity a preview may name, for reading their profiles. */
export const mentionedIds = (mentioned: PreviewMentions) => [
  ...mentioned.mentions,
  ...(mentioned.mentionReferences ?? []),
];

/** `ids`, then the identities `mentioned` previews name, within the profile
 * directory's default budget: a request over it reads nobody. */
export const withMentionedIds = (
  ids: readonly string[],
  mentioned: readonly PreviewMentions[],
) => {
  const named = new Set(ids);
  return [...new Set([...named, ...mentioned.flatMap(mentionedIds)])].slice(
    0,
    Math.max(named.size, PROFILE_CACHE_BASE),
  );
};

/** Each signed identity and the names it binds by, as the binder lists
 * them from profiles and agents. */
type Labels = { id: string; names: string[] }[];

function mentionLabels(
  ids: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"],
): Labels {
  return [...new Set(ids)].map((id) => ({
    id,
    names: [
      ...profileMentionNames(profiles.get(id)),
      ...agents
        .filter((agent) => agent.pubkey === id)
        .map((agent) => agent.name),
    ].filter((name): name is string => !!name),
  }));
}

// Whitespace and controls as the flattener collapses them.
const flatSpaces = (value: string) =>
  value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").replace(/\s+/gu, " ");

/** A reference as it reads flattened, its interior's spaces collapsed. */
const flatChip = (text: string) => {
  const chars = [...text];
  return `${chars[0]}${flatSpaces(chars.slice(1, -1).join(""))}${chars.at(-1)}`;
};

/** Whether `text` can show a chip for `labels`: one reads as its name, or
 * with a namesake qualifier, which may differ in case. */
const mayName = (text: string, labels: Labels) =>
  / \([a-f0-9]{64}\)/i.test(text) ||
  labels.some(({ names }) =>
    names.some((name) => text.includes(flatChip(`@${name}`))),
  );

// The longest body a preview binds; longer ones show as plain text.
//
// Design decision: a preview binds and flattens its WHOLE body with the
// conversation's own pipeline, never a prefix. Every earlier attempt to bound
// the input for speed (prefix cuts, blank-line cuts, guessing how far a name
// or link can run) disagreed with the conversation somewhere: a long link,
// a late definition, a comment, nesting or seams past the cut. Bounding is
// therefore off the table; this size cap is the one perf trade-off, and past
// it a preview loses chips rather than risking wrong ones. The cost is about
// one extra parse of the body, cached per preview and shared with the
// conversation's prepared Markdown.
const LONGEST_BODY = 16_384;

/**
 * The body bound as its conversation binds it, flattened as preview text
 * is: the conversation's protected body, with each mention, emoji and
 * literal held in a placeholder, flattened once, and each placeholder read
 * back as its text. Undefined when the conversation renders the body as
 * plain text or it binds no one.
 */
function flatParts(
  content: string,
  seams: readonly number[] | undefined,
  labels: Labels,
): Part[] | undefined {
  if (content.length > LONGEST_BODY) return undefined;
  const prepared = preparedMarkdown(content);
  if (prepared.kind === "plain") return undefined;
  const protectedContent = protectInlineContent(
    {
      content,
      mentions: labels.map((label) => label.id),
      mentionLabels: labels,
      ...(seams ? { attachmentSeams: seams } : {}),
    },
    undefined,
    prepared,
    [],
    prepared.spoilerDelimiters,
  );
  if (!protectedContent.parts.some((part) => part.target)) return undefined;
  const flat = spoilerText(
    protectedContent.content,
    `<${protectedContent.prefix}spoiler\uE002>`,
    { limit: Number.POSITIVE_INFINITY },
  );
  const parts: Part[] = [];
  let [plain, at] = ["", 0];
  for (const match of flat.matchAll(placeholderPattern(protectedContent))) {
    const part = protectedContent.parts[Number(match[1])];
    plain += flat.slice(at, match.index);
    at = match.index + match[0].length;
    if (!part?.target) {
      plain += part?.text ?? match[0];
      continue;
    }
    if (plain) parts.push({ text: plain });
    parts.push({ text: flatChip(part.text), target: part.target });
    plain = "";
  }
  plain += flat.slice(at);
  if (plain) parts.push({ text: plain });
  return parts;
}

/**
 * `parts`, the body flattened, cut to `text`. `text` shows `full` from
 * `start`, after a leading "…" when `start` is past its first character, and
 * may end with "…" where it was cut; `full` is the body as the surface
 * flattened it. Past where `parts` stop reading as `full`, such as where the
 * surface cut the body, the preview is `full`'s text. A reference a cut
 * splits stays literal.
 */
function previewParts(
  parts: Part[],
  full: string,
  text: string,
  start: number,
): Part[] | undefined {
  const opened = start > 0 ? "…" : "";
  if (!text.startsWith(opened)) return undefined;
  const shown = text.slice(opened.length);
  const length = full.startsWith(shown, start)
    ? shown.length
    : shown.endsWith("…") && full.startsWith(shown.slice(0, -1), start)
      ? shown.length - 1
      : -1;
  if (length < 0) return undefined;
  const [from, to] = [start, start + length];
  const source = parts.map((part) => part.text).join("");
  let same = 0;
  while (same < to && source[same] === full[same]) same++;
  // Never between a surrogate pair.
  if (same < to && /[\uD800-\uDBFF]/.test(full[same - 1] ?? "")) same--;
  const cut: Part[] = opened ? [{ text: opened }] : [];
  let offset = 0;
  for (const part of parts) {
    const at = offset;
    offset += part.text.length;
    const [cutFrom, cutTo] = [Math.max(at, from), Math.min(offset, same)];
    if (cutFrom >= cutTo) continue;
    cut.push(
      cutFrom === at && cutTo === offset
        ? part
        : { text: part.text.slice(cutFrom - at, cutTo - at) },
    );
  }
  if (same < to) cut.push({ text: full.slice(Math.max(from, same), to) });
  if (length < shown.length) cut.push({ text: "…" });
  return cut;
}

/** Flattened preview text with its signed mentions as chips, bound and
 * labelled as its message binds them. `text` shows `full` (itself by
 * default) from `start`, as `previewParts` describes. `matches` are the code
 * points MatchedLabel marks in `text`; a chip holding one is marked whole,
 * since its label can differ from its text. */
export function PreviewText({
  text,
  full = text,
  start = 0,
  mentions,
  matches,
  session,
  channelId,
}: {
  text: string;
  full?: string | undefined;
  start?: number | undefined;
  mentions: PreviewMentions;
  matches?: readonly number[] | undefined;
  session: RelaySession | undefined;
  channelId: string | undefined;
}) {
  const directory = useReferenceDirectory(session);
  const resolveName = useChannelIdentityNames(session, channelId);
  const shown = useNearScreen();
  const { content, edited, attachmentSeams: seams } = mentions;
  // Binding reruns only when what it reads changes: the body and the names
  // its identities bind by, not every profile the directory loads.
  const labels = JSON.stringify(
    mentionLabels(mentionedIds(mentions), directory.profiles, directory.agents),
  );
  // Binding parses the body's Markdown, and only for previews on or near the
  // screen whose text can show a name.
  const parts = useMemo(() => {
    if (!shown.near || edited || labels === "[]") return [{ text }];
    const parsed: Labels = JSON.parse(labels);
    if (!mayName(text, parsed)) return [{ text }];
    const key = JSON.stringify([labels, seams, content, full, text, start]);
    return recentParts(key, () => {
      const flat = flatParts(content, seams, parsed);
      return (flat && previewParts(flat, full, text, start)) ?? [{ text }];
    });
  }, [shown.near, edited, labels, content, seams, full, text, start]);
  // Code points before each part, as `matches` count them.
  let point = 0;
  const shownParts = parts.map((part) => {
    const start = point;
    const length = [...part.text].length;
    point += length;
    const positions = matches
      ?.filter((at) => at >= start && at < start + length)
      .map((at) => at - start);
    if (!part.target || !profileKey(part.target))
      return (
        <MatchedLabel key={start} label={part.text} positions={positions} />
      );
    const chip = (
      <ProfileMention
        key={start}
        text={part.text}
        target={part.target}
        profiles={directory.profiles}
        agents={directory.agents}
        viewer={session?.viewer}
        resolveName={resolveName}
      />
    );
    return positions?.length ? (
      <mark key={start} className="search-match">
        {chip}
      </mark>
    ) : (
      chip
    );
  });
  return <span ref={shown.ref}>{shownParts}</span>;
}

// Recent previews' parts, so a row shown again does not bind again.
const recentParts = recentResults<Part[]>(1_000_000, (key) => key.length);

// One observer per scroll pane for the previews in it still waiting to come
// near its view, released with the last of them.
const waiting = new Map<Element, () => void>();
const nearObservers = new Map<
  Element | null,
  { observer: IntersectionObserver; previews: Set<Element> }
>();
// Half a pane ahead, so chips are usually bound before a row shows.
const NEAR = 0.5;

/** The nearest ancestor that scrolls `element`, or none for the window. */
function scrollPane(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement)
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY))
      return node;
  return null;
}

/** Whether this preview has been on or near its scroll pane's view. A
 * preview there on its first layout is bound before it paints; the rest bind
 * as they near. */
function useNearScreen() {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const pane = scrollPane(element);
    const view = pane?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight,
    };
    const rect = element.getBoundingClientRect();
    const margin = (view.bottom - view.top) * NEAR;
    if (rect.bottom >= view.top - margin && rect.top <= view.bottom + margin) {
      setNear(true);
      return;
    }
    let watch = nearObservers.get(pane);
    if (!watch) {
      watch = {
        observer: new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.isIntersecting) waiting.get(entry.target)?.();
          },
          { root: pane, rootMargin: `${NEAR * 100}% 0px` },
        ),
        previews: new Set(),
      };
      nearObservers.set(pane, watch);
    }
    const { observer, previews } = watch;
    const release = () => {
      if (!previews.delete(element)) return;
      waiting.delete(element);
      observer.unobserve(element);
      if (previews.size) return;
      observer.disconnect();
      nearObservers.delete(pane);
    };
    waiting.set(element, () => {
      release();
      setNear(true);
    });
    previews.add(element);
    observer.observe(element);
    return release;
  }, [near]);
  return { ref, near };
}
