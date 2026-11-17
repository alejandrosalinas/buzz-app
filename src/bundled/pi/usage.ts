// The token use of an agent's Pi conversations, as pi-ai records it on each
// of their answers and Pi durable totals it, read from the agent's storage
// through the host. Pi owns the entries; nothing here writes or keeps them.
import {
  promptMessage,
  promptSections,
} from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import type { Pi } from "./pi";
import type { PiEntry } from "./transcript";

type Json = Record<string, unknown>;
/** A Buzz conversation's Pi conversation, as `places` lists it. */
type Place = Readonly<{
  conversation: number;
  /** Absent for a standalone turn's conversation. */
  channelId?: string;
  root?: string;
  /** When it was last active; absent for a standalone turn's conversation,
   * which is read whatever its age. */
  at?: number;
}>;

/** pi-ai's counts, named as Buzz names them. */
const TOKENS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
] as const;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((part) => str(object(part)?.text))
        .join("\n");

/** What was asked, from the conversation's first prompt. */
function title(entries: readonly PiEntry[]) {
  const first = entries.find((entry) => entry.kind === "pi.user")?.model?.[0];
  return promptMessage(promptSections(text(first?.content)))
    .text.split("\n", 1)[0]
    ?.trim();
}

/** A conversation's model requests, its entries oldest first, and Pi's
 * totals of them by `<provider>/<model>`. pi-ai counts a request's input
 * without its cached part, and prices the models it knows. A request with no
 * answer, such as a compaction's, is only in the totals: what they have beyond
 * the answers is one more request of each model, at the newest compaction. */
export function conversationUsage(
  entries: readonly PiEntry[],
  place: Omit<Place, "at">,
  recorded: Readonly<Record<string, unknown>> = {},
): Omit<SessionUsage, "revision"> | undefined {
  const observations: UsageObservation[] = [];
  const times: number[] = [];
  /** The answers' counts and cost, by the totals' key. */
  const answered = new Map<string, Record<string, number>>();
  let compacted: number | undefined;
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      if (typeof message.timestamp === "number") times.push(message.timestamp);
      if (entry.kind === "pi.compaction")
        compacted = message.timestamp ?? compacted;
      const usage = object(message.usage);
      if (message.role !== "assistant" || !usage) continue;
      const cost = count(object(usage.cost)?.total);
      const key = `${message.provider ?? ""}/${message.model ?? ""}`;
      const sum = answered.get(key) ?? {};
      for (const name of [...TOKENS, "cost"] as const)
        sum[name] =
          (sum[name] ?? 0) +
          ((name === "cost" ? cost : count(usage[name])) ?? 0);
      answered.set(key, sum);
      observations.push({
        ...(message.responseId ? { requestId: message.responseId } : {}),
        at: message.timestamp ?? 0,
        model: message.model || "pi",
        tokens: Object.fromEntries(
          TOKENS.flatMap((key) => {
            const value = count(usage[key]);
            return value === undefined ? [] : [[key, value]];
          }),
        ),
        // pi-ai prices a model it has no rates for at 0: that is unknown.
        ...(cost ? { cost: { usd: cost, source: "pi" } } : {}),
      });
    }
  if (!times.length) return undefined;
  const lastAt = Math.max(...times);
  for (const [key, value] of Object.entries(recorded)) {
    const total = object(value);
    if (!total) continue;
    const sum = answered.get(key) ?? {};
    const rest = (name: string, recorded: unknown) =>
      Math.max(0, (count(recorded) ?? 0) - (sum[name] ?? 0));
    const tokens = Object.fromEntries(
      TOKENS.flatMap((name) => {
        const value = rest(name, total[name]);
        return value ? [[name, value]] : [];
      }),
    );
    // Sums of float prices: below a millionth of a cent is rounding.
    const usd = rest("cost", object(total.cost)?.total);
    if (!Object.keys(tokens).length && usd < 1e-8) continue;
    observations.push({
      requestId: `unanswered:${key}`,
      at: compacted ?? lastAt,
      model: key.slice(key.indexOf("/") + 1) || "pi",
      tokens,
      ...(usd >= 1e-8 ? { cost: { usd, source: "pi" } } : {}),
    });
  }
  const asked = title(entries);
  return {
    id: String(place.conversation),
    ...(place.channelId ? { channelId: place.channelId } : {}),
    ...(place.root ? { root: place.root } : {}),
    ...(asked ? { title: asked } : {}),
    startedAt: Math.min(...times),
    lastAt,
    gaps: [],
    observations,
  };
}

/** All of a conversation's entries, oldest first. */
async function entries(
  pi: Pick<Pi, "request">,
  agent: string,
  conversation: number,
  signal: AbortSignal,
) {
  const found: PiEntry[] = [];
  let cursor: unknown;
  do {
    const page = await pi.request<{ entries: PiEntry[]; next?: unknown }>(
      "entries",
      { agent, conversation, ...(cursor ? { cursor } : {}) },
    );
    signal.throwIfAborted();
    found.push(...page.entries);
    cursor = page.next;
  } while (cursor);
  return found.reverse();
}

/** The agent's Buzz conversations, and conversations of its standalone turns,
 * used since `since`. A conversation's
 * requests follow the newest message it was shown. */
export async function readUsage(
  pi: Pick<Pi, "request">,
  agent: string,
  places: readonly Place[],
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const found: SessionUsage[] = [];
  for (const place of places) {
    if (place.at !== undefined && place.at < since) continue;
    // Totals first: an answer recorded between the reads is then in the
    // entries, not counted as a request without one.
    const { models } = await pi.request<{ models: Record<string, unknown> }>(
      "recorded",
      { agent, conversation: place.conversation },
    );
    signal.throwIfAborted();
    const read = await entries(pi, agent, place.conversation, signal);
    const session = conversationUsage(read, place, models);
    if (session && session.lastAt >= since)
      found.push(await withRevision(session));
  }
  return found.sort((a, b) => b.lastAt - a.lastAt);
}
