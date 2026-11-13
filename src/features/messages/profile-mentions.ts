import type { AgentLibrary } from "../agents/library";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { profileTarget } from "../profiles/target";

/** The names a person's signed prose mention binds by: their shown name and,
 * when verified, both verified names, so prose written under either name
 * preference stays a mention. Renderers key their caches on the same list. */
export function profileMentionNames(profile: Profile | undefined) {
  return [
    profile?.name,
    profile?.verified?.displayName,
    profile?.verified?.fullName,
  ];
}

type Part = { text: string; target?: string | undefined };
/** Display only: signed recipients bound by an unedited body's exact known names.
 * This does not infer notification intent or resolve a name against a directory. */
export function profileMentionParts(
  row: Pick<
    ChannelMessage,
    "content" | "edited" | "attachmentSeams" | "mentions" | "mentionReferences"
  >,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: AgentLibrary["identities"] = [],
): Part[] {
  const text = row.content;
  const identities = [...row.mentions, ...(row.mentionReferences ?? [])];
  if (row.edited || !identities.length) return [{ text }];
  // Attachment removal must not join text into a name the author never wrote.
  const seams = row.attachmentSeams ?? [];
  const spansSeam = (start: number, end: number) =>
    seams.some((seam) => start < seam && seam < end);
  const names = new Map<string, Set<string>>();
  for (const id of new Set(identities)) {
    const target = profileTarget(id);
    if (!target) continue;
    const labels = [
      ...profileMentionNames(profiles?.get(id)),
      ...agents
        .filter((agent) => agent.pubkey === id)
        .map((agent) => agent.name),
    ];
    for (const name of new Set(labels)) {
      if (!name || /[\r\n]/.test(name)) continue;
      const keys = names.get(name) ?? new Set<string>();
      keys.add(target);
      names.set(name, keys);
    }
  }
  // Ambiguous long names must still consume their span, never fall back to a prefix.
  const candidates = [...names].sort(([a], [b]) => b.length - a.length);
  const parts: Part[] = [];
  let plain = 0;
  for (let i = 0; i < text.length; ) {
    const protectedEnd = protectedTextEnd(text, i);
    if (protectedEnd > i) {
      i = protectedEnd;
      continue;
    }
    if (
      text[i] !== "@" ||
      (i > 0 && /[\p{L}\p{N}_@/\\]/u.test(text[i - 1] ?? ""))
    ) {
      i++;
      continue;
    }
    // A qualified span names its signed key, so its name may differ in case:
    // mobile keeps the spelling the author typed.
    let bound: { end: number; target: string } | undefined;
    for (const [name, keys] of candidates) {
      if (
        text.slice(i + 1, i + 1 + name.length).toLowerCase() !==
        name.toLowerCase()
      )
        continue;
      const qualifier = QUALIFIER.exec(text.slice(i + 1 + name.length));
      const target = profileTarget(qualifier?.[1] ?? "");
      if (qualifier && target && keys.has(target)) {
        bound = { end: i + 1 + name.length + qualifier[0].length, target };
        break;
      }
    }
    if (bound && !spansSeam(i, bound.end)) {
      if (i > plain) parts.push({ text: text.slice(plain, i) });
      parts.push({ text: text.slice(i, bound.end), target: bound.target });
      plain = i = bound.end;
      continue;
    }
    const candidate = candidates.find(
      ([name]) =>
        text.startsWith(name, i + 1) &&
        !/[\p{L}\p{N}_]/u.test(text[i + 1 + name.length] ?? "") &&
        !spansSeam(i, i + 1 + name.length),
    );
    if (!candidate) {
      i++;
      continue;
    }
    const [name, keys] = candidate;
    const end = i + 1 + name.length;
    // A qualifier no signed key with this name carries stays literal, and a
    // known shorter name cannot claim its prefix.
    const qualifier = QUALIFIER.exec(text.slice(end));
    if (qualifier) {
      i = end + qualifier[0].length;
      continue;
    }
    if (keys.size === 1) {
      if (i > plain) parts.push({ text: text.slice(plain, i) });
      parts.push({ text: text.slice(i, end), target: [...keys][0] });
      plain = end;
    }
    i = end;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain) });
  return parts.length ? parts : [{ text }];
}

const QUALIFIER = /^ \(([a-f0-9]{64})\)/i;

// Evaluate exclusions on the full body BEFORE splitting link/emoji rendering.
// Deliberately conservative for incomplete code/link syntax; not a Markdown parser.
function protectedTextEnd(text: string, start: number): number {
  const char = text[start];
  const rest = text.slice(start);
  if (start === 0 || text[start - 1] === "\n") {
    const lineEnd = text.indexOf("\n", start);
    // A tab reaches the fourth column too. Mask the whole line even when the
    // surrounding syntax would make its indentation ambiguous in Markdown.
    if (/^(?: {4}| {0,3}\t)/.test(rest))
      return lineEnd < 0 ? text.length : lineEnd + 1;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(rest)?.[1];
    if (fence) {
      if (lineEnd < 0) return text.length;
      // Fences close only on a delimiter-only line, with the same character
      // and at least the opening length. Inline delimiter strings are code.
      const closing = new RegExp(
        `^ {0,3}${fence[0]}{${fence.length},}[\\t ]*\\r?$`,
        "gm",
      );
      closing.lastIndex = lineEnd + 1;
      const match = closing.exec(text);
      return match ? match.index + match[0].length : text.length;
    }
  }
  const boundary = start === 0 || /[\s<([]/.test(text[start - 1] ?? "");
  if (char !== "`" && char !== "~" && char !== "[" && char !== "!" && !boundary)
    return start;
  const span = /^(?:`+|~{3,})/.exec(rest)?.[0];
  if (span) {
    const end = text.indexOf(span, start + span.length);
    return end < 0 ? text.length : end + span.length;
  }
  if (rest.startsWith("[") || rest.startsWith("![")) {
    const link = /^!?\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])/.exec(rest)?.[0];
    if (link) return start + link.length;
  }
  const url = /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:|nostr:)[^\s<>`]+/i.exec(
    rest,
  )?.[0];
  return url ? start + url.length : start;
}
