// NIP-AP config history (plan §7): offset pages of one artifact's revisions,
// every chain segment they form, the cause of each gap, diffs and revert.
// Display only: history never decides artifact state (§3.2).
import { notesOf } from "./plugin-notes";
import { retryRead } from "../relay/read-retry";
import type { EventData, RelayEvent } from "../relay/events";
import { type SettingsSchema, syncedSettings } from "./agent-config";
import {
  ARTIFACT_KIND,
  artifactOp,
  artifactPrev,
  artifactProblem,
  artifactTemplate,
  type Expected,
  type SnapshotRead,
} from "./agent-config-artifacts";
import type { ConfigHistory } from "./service";

/** Revisions per page: well under the relay's 1,000 so each "Load older"
 * stays a short list. The offset ceiling is the relay's (`buzz-core`
 * artifact.rs `MAX_OFFSET`), so at most `HISTORY_LIMIT` revisions load. */
export const HISTORY_PAGE = 100;
export const HISTORY_MAX_OFFSET = 10_000;
export const HISTORY_LIMIT = HISTORY_MAX_OFFSET + HISTORY_PAGE;

export type History = Readonly<{
  /** Deduplicated revisions in the relay's order, newest accepted first. */
  revisions: readonly RelayEvent[];
  next: number;
  done: boolean;
  failed: boolean;
}>;

export const emptyHistory: History = {
  revisions: [],
  next: 0,
  done: false,
  failed: false,
};

/** Preserve the open agent's two loaded tracks across presentation remounts.
 * The reader is session-scoped; changed heads or redaction versions never reuse
 * old pages. Keeping only two artifacts bounds retention to one agent's feed. */
type LoadedHistory = {
  channel: string;
  d: string;
  head: string | undefined;
  version: number | undefined;
  history: History;
};
const loadedHistories = new WeakMap<SnapshotRead, LoadedHistory[]>();
export function recalledHistory(
  read: SnapshotRead,
  expected: Expected,
  head: RelayEvent | undefined,
  version?: number,
) {
  return loadedHistories
    .get(read)
    ?.find(
      (value) =>
        value.channel === expected.channel &&
        value.d === expected.d &&
        value.head === head?.id &&
        value.version === version,
    )?.history;
}
export function rememberHistory(
  read: SnapshotRead,
  expected: Expected,
  head: RelayEvent | undefined,
  version: number | undefined,
  history: History,
) {
  if (!history.next) return;
  const others = (loadedHistories.get(read) ?? []).filter(
    (value) => value.channel !== expected.channel || value.d !== expected.d,
  );
  loadedHistories.set(
    read,
    [
      {
        channel: expected.channel,
        d: expected.d,
        head: head?.id,
        version,
        history,
      },
      ...others,
    ].slice(0, 2),
  );
}

/** Reads the next page. Revisions accepted since the last page shift offsets,
 * so repeats are dropped by event ID. A failed page keeps what was loaded.
 * Every page names the channel in `#h`: the relay leaves system channels out
 * of any read that doesn't (NIP-CL), members included. */
export async function loadOlder(
  read: SnapshotRead,
  channel: string,
  d: string,
  history: History,
  signal?: AbortSignal,
): Promise<History> {
  if (history.done || history.next > HISTORY_MAX_OFFSET)
    return { ...history, failed: false };
  try {
    const active = signal ?? new AbortController().signal;
    const page = await retryRead(
      (signal) =>
        read(
          [
            {
              kinds: [ARTIFACT_KIND],
              "#h": [channel],
              "#d": [d],
              artifact: "history",
              limit: HISTORY_PAGE,
              offset: history.next,
            },
          ],
          { signal },
        ),
      active,
    );
    const seen = new Set(history.revisions.map((event) => event.id));
    return {
      revisions: [
        ...history.revisions,
        ...page.filter((event) => !seen.has(event.id) && seen.add(event.id)),
      ],
      next: history.next + HISTORY_PAGE,
      done: page.length < HISTORY_PAGE,
      failed: false,
    };
  } catch {
    return { ...history, failed: true };
  }
}

/** Why a segment's predecessor is missing. */
export type Gap = "unloaded" | "capped" | "failed" | "unavailable";
export type Segment = Readonly<{
  /** Newest first; each revision's `prev` is the one after it. */
  revisions: readonly RelayEvent[];
  /** Set when the oldest revision names a predecessor that wasn't returned. */
  gap?: Gap;
}>;

const gapCause = (history: History): Gap =>
  history.failed
    ? "failed"
    : history.done
      ? "unavailable"
      : history.next > HISTORY_MAX_OFFSET
        ? "capped"
        : "unloaded";

/** Every chain segment in the loaded revisions, newest segment first. A
 * segment starts at a revision no loaded revision names as `prev`. */
export function segments(history: History): Segment[] {
  const byId = new Map(history.revisions.map((event) => [event.id, event]));
  const named = new Set(history.revisions.map(artifactPrev));
  const placed = new Set<string>();
  const result: Segment[] = [];
  for (const start of history.revisions) {
    if (named.has(start.id) || placed.has(start.id)) continue;
    const revisions: RelayEvent[] = [];
    let event: RelayEvent | undefined = start;
    let prev: string | undefined;
    while (event && !placed.has(event.id)) {
      placed.add(event.id);
      revisions.push(event);
      prev = artifactPrev(event);
      event = prev ? byId.get(prev) : undefined;
    }
    result.push(
      prev && !byId.has(prev)
        ? { revisions, gap: gapCause(history) }
        : { revisions },
    );
  }
  return result;
}

export type LineChange = Readonly<{
  type: "same" | "added" | "removed";
  text: string;
}>;

const LCS_MAX_CELLS = 4_000_000;
const same = (text: string): LineChange => ({ type: "same", text });

/** Line diff by longest common subsequence after trimming the shared ends. */
export function lineDiff(before: string, after: string): LineChange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  // Bounds the table for very different large texts: show a replacement.
  if (x.length * y.length > LCS_MAX_CELLS)
    return [
      ...a.slice(0, start).map(same),
      ...x.map((text): LineChange => ({ type: "removed", text })),
      ...y.map((text): LineChange => ({ type: "added", text })),
      ...a.slice(a.length - end).map(same),
    ];
  // lcs[i * w + j]: common lines between x[i..] and y[j..].
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        x[i] === y[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  const middle: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    const line = x[i];
    if (line !== undefined && line === y[j]) {
      middle.push(same(line));
      i++;
      j++;
    } else if (j < y.length && (i === x.length || at(i, j + 1) >= at(i + 1, j)))
      middle.push({ type: "added", text: y[j++] ?? "" });
    else middle.push({ type: "removed", text: x[i++] ?? "" });
  }
  return [
    ...a.slice(0, start).map(same),
    ...middle,
    ...a.slice(a.length - end).map(same),
  ];
}

export type FieldChange = Readonly<{
  field: string;
  before?: unknown;
  after?: unknown;
}>;

/** Settings fields that differ between two `buzz.agent.settings` revisions. */
export function settingsDiff(before: string, after: string): FieldChange[] {
  const fields = (content: string) =>
    (parse(content)?.settings ?? {}) as Record<string, unknown>;
  const a = fields(before);
  const b = fields(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]))
    .map((field) => ({ field, before: a[field], after: b[field] }));
}

const parse = (content: string) => {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The agent type and plugin schema a settings revision must fit to start. */
export type SettingsCheck = Readonly<{
  agentType: string;
  schema: SettingsSchema;
}>;

/** Why a revision isn't config this client could start, or undefined. A
 * settings revision without a schema to check it against is never valid. */
export function revisionProblem(
  expected: Expected,
  event: EventData,
  settings?: SettingsCheck,
) {
  const problem = artifactProblem(event, expected);
  if (
    problem ||
    expected.type !== "buzz.agent.settings" ||
    artifactOp(event) === "delete"
  )
    return problem;
  if (!settings) return "No settings schema to check against";
  const checked = syncedSettings(
    event.content,
    settings.agentType,
    settings.schema,
  );
  return "problem" in checked ? checked.problem : undefined;
}

export function incompatibleSettings(history: ConfigHistory | undefined) {
  const track = history?.sides.find(({ side }) => side === "settings");
  return Boolean(
    !history?.settingsProblem &&
      history?.settings &&
      track?.head &&
      artifactOp(track.head) !== "delete" &&
      revisionProblem(track.expected, track.head, history.settings),
  );
}

const ENVELOPE = new Set(["ar", "d", "h", "type", "title", "op", "prev"]);

/** Revert: a new revision whose content is `target`'s snapshot and whose
 * `prev` is the current head: `op=update`, or `op=restore` over a deleted
 * head. A team keeps its current name. Never redacts. Only a valid snapshot
 * is republished (NIP-AP); an invalid or deleted head is what a revert
 * repairs, so its name, title and client tags are kept only when the head
 * itself is valid. */
export function revertTemplate(
  expected: Expected,
  head: RelayEvent,
  target: RelayEvent,
  settings?: SettingsCheck,
) {
  if (artifactOp(target) === "delete")
    throw new Error("A deleted revision can't be reverted to");
  const restore = artifactOp(head) === "delete";
  const base =
    restore || revisionProblem(expected, head, settings) ? target : head;
  const title = base.tags.find((t) => t[0] === "title")?.[1] ?? "";
  let content = target.content;
  if (expected.type === "buzz.team")
    content = JSON.stringify({
      ...parse(target.content),
      name: parse(base.content)?.name,
    });
  // Going back keeps the head's plugin notes: a plugin's memory of the agent
  // isn't a setting to undo.
  const reverted = parse(content);
  if (expected.type === "buzz.agent.settings" && reverted) {
    const { pluginNotes: _, ...rest } = reverted;
    // A deleted or unreadable head has none to keep: the target's stay.
    const current = restore ? undefined : parse(head.content);
    const notes = notesOf(current ?? reverted);
    content = JSON.stringify(notes ? { ...rest, pluginNotes: notes } : rest);
  }
  const template = artifactTemplate({
    ...expected,
    op: restore ? "restore" : "update",
    title,
    content,
    prev: head.id,
    extra: base.tags.filter((t) => !ENVELOPE.has(t[0] ?? "")),
  });
  // Unsigned, so no id or pubkey yet; validation reads neither.
  const problem = revisionProblem(
    expected,
    { ...template, id: "", pubkey: "" },
    settings,
  );
  if (problem) throw new Error(`That revision isn't valid: ${problem}`);
  return template;
}
