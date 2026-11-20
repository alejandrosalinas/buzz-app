import type { ChannelMessage } from "./contracts";
import type { ReadFilter } from "./events";
import { threadReference } from "./thread-reference";

function descendants(
  parents: readonly { id: string; parent?: string | undefined }[],
  anchor: string,
  verifiedTarget?: string,
) {
  const children = new Map<string, string[]>();
  for (const row of parents) {
    if (!row.parent) continue;
    const siblings = children.get(row.parent) ?? [];
    siblings.push(row.id);
    children.set(row.parent, siblings);
  }
  const ids = new Set(verifiedTarget ? [anchor, verifiedTarget] : [anchor]);
  for (const id of ids)
    for (const child of children.get(id) ?? []) ids.add(child);
  return ids;
}

/** Use exact ancestor reads as evidence without changing the page or its cursor. */
export async function readSubthread<
  T extends { id: string; kind: number; tags: readonly (readonly string[])[] },
>(
  events: readonly T[],
  { channel, root, anchor }: { channel: string; root: string; anchor: string },
  kinds: readonly number[],
  read: (filters: readonly ReadFilter[]) => Promise<readonly T[]>,
  known?: ReadonlyMap<string, T>,
) {
  const parents = new Map<string, string>();
  const inThread = (event: T) =>
    kinds.includes(event.kind) &&
    event.tags.some(([name, value]) => name === "h" && value === channel);
  function record(event: T) {
    // Follow retained evidence before spending an exact lookup on a gap.
    let row: T | undefined = event;
    while (row && row.id !== anchor && !parents.has(row.id)) {
      const reference = threadReference(row);
      if (reference?.rootId !== root || !inThread(row)) return;
      parents.set(row.id, reference.parentId);
      row = known?.get(reference.parentId);
    }
  }
  events.forEach(record);
  const missing = () =>
    [...new Set(parents.values())].filter(
      (id) => id !== anchor && id !== root && !parents.has(id),
    );
  const requested = new Set<string>();
  // Bound both round trips and total IDs for wide pages and deep reply chains.
  for (let round = 0; round < 4 && requested.size < 32; round++) {
    const ids = missing()
      .filter((id) => !requested.has(id))
      .slice(0, 32 - requested.size);
    if (!ids.length) break;
    for (const id of ids) requested.add(id);
    const expected = new Set(ids);
    for (const event of await read([
      { ids, kinds: [...kinds], "#h": [channel], limit: ids.length },
    ]))
      if (expected.has(event.id)) record(event);
  }
  const members = descendants(
    Array.from(parents, ([id, parent]) => ({ id, parent })),
    anchor,
  );
  return {
    events: events.filter((event) => members.has(event.id) && inThread(event)),
    incomplete: missing().length > 0,
  };
}

/** The exact reader can prove a target through ancestors outside the loaded rows. */
export function subthreadMessages(
  rows: readonly ChannelMessage[],
  anchor: string,
  verifiedTarget?: string,
) {
  const ids = descendants(
    rows.map((row) => ({ id: row.id, parent: row.replyParentId })),
    anchor,
    rows.some((row) => row.id === verifiedTarget) ? verifiedTarget : undefined,
  );
  return rows.filter((row) => ids.has(row.id));
}
