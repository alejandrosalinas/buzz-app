import { avatarSource } from "../../shared/avatar-source.ts";
import { newer, type ReadFilter, type RelayEvent } from "../relay/events.ts";
import type { RelayReader } from "../relay/reader.ts";
import { type AgentLibrary, inheritDefinitionAvatars } from "./library.ts";

/** Owner-authored agent definitions (30175) and identities (30177). */
export const INVENTORY_KINDS: readonly number[] = [30175, 30177];
const INVENTORY_FILTER_KEYS = [
  "authors",
  "kinds",
  "limit",
  "until",
  "before_id",
];

/** True only for the owner-scoped inventory read that `readRelayLibrary` issues. */
export function isOwnerInventoryFilter(
  filter: ReadFilter,
  owner: string | undefined,
): boolean {
  return (
    !!owner &&
    filter.authors?.length === 1 &&
    filter.authors[0] === owner &&
    !!filter.kinds?.length &&
    filter.kinds.every((kind) => INVENTORY_KINDS.includes(kind)) &&
    Object.keys(filter).every((key) => INVENTORY_FILTER_KEYS.includes(key))
  );
}

const PAGE = 200;
const MAX_EVENTS = 10_000;

/** Legacy persona_id uses the source ID; kind 30175 publishes its NIP-AP slug. */
export function definitionSlug(id: string): string {
  const slug = [...id]
    .map((c) =>
      /^[A-Z]$/.test(c) ? c.toLowerCase() : /^[a-z0-9_-]$/.test(c) ? c : "-",
    )
    .join("");
  return (/^[a-z0-9]/.test(slug) ? slug : `a${slug}`).slice(0, 64);
}

/** Owner-authored inventory is discovery evidence, not agent custody or admission. */
export async function readRelayLibrary(
  reader: RelayReader,
  owner: string,
  signal: AbortSignal,
): Promise<AgentLibrary> {
  const heads = new Map<string, RelayEvent>();
  let cursor: { until: number; before_id: string } | undefined;
  let count = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await reader.read(
      [
        {
          kinds: [...INVENTORY_KINDS],
          authors: [owner],
          limit: PAGE,
          ...cursor,
        },
      ],
      // Solo needs complete inventory to address a message; do not queue it
      // behind a background snapshot that can outlast this read's deadline.
      { signal, priority: "foreground" },
    );
    signal.throwIfAborted();
    // Reject mismatched pages rather than presenting another account's records.
    if (
      page.some((e) => e.pubkey !== owner || !INVENTORY_KINDS.includes(e.kind))
    )
      throw new Error("Agent inventory response is outside its owner scope");
    count += page.length;
    if (count > MAX_EVENTS)
      throw new Error("Agent inventory exceeds read budget");
    for (const event of page) {
      const d = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (!d) continue;
      const coordinate = `${event.kind}:${d}`;
      heads.set(coordinate, newer(heads.get(coordinate), event));
    }
    if (page.length < PAGE) break;
    // Relay query order is time descending, then ID ascending (also at ties).
    const last = [...page]
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .at(-1);
    if (!last) throw new Error("Missing inventory cursor");
    if (
      cursor &&
      (last.created_at > cursor.until ||
        (last.created_at === cursor.until && last.id <= cursor.before_id))
    )
      throw new Error("Agent inventory pagination did not advance");
    cursor = { until: last.created_at, before_id: last.id };
  }
  const definitions: AgentLibrary["definitions"][number][] = [];
  const identities: AgentLibrary["identities"][number][] = [];
  for (const event of heads.values()) {
    const id = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    let raw: unknown;
    try {
      raw = JSON.parse(event.content);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const body = raw as Record<string, unknown>;
    const rawName = event.kind === 30175 ? body.display_name : body.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) continue;
    if (event.kind === 30175) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
      // Catalog shares are addressed by agent pubkey; the identity row is the agent.
      if (/^[0-9a-f]{64}$/.test(id)) continue;
      const avatar = avatarSource(body.avatar_url);
      definitions.push({ id, name, ...(avatar ? { avatar } : {}) });
    } else {
      if (!/^[0-9a-f]{64}$/.test(id)) continue;
      const reference = body.persona_id;
      identities.push({
        pubkey: id,
        name,
        ...(typeof reference === "string" && reference
          ? { definitionId: definitionSlug(reference) }
          : {}),
      });
    }
  }
  return inheritDefinitionAvatars({ definitions, identities });
}
