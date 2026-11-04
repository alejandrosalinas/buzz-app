import { WINDOW_KINDS, type WindowCursor, type WindowPage } from "./window";

/** Rows per seek read: the relay's window maximum. */
export const SEEK_PAGE = 200;
/** Relay reads one seek may spend before it gives up. */
export const SEEK_READS = 40;
const DAY = 86_400;

export class SeekLimitError extends Error {
  constructor() {
    super("History seek exceeded its read budget");
    this.name = "SeekLimitError";
  }
}

/** Rows strictly older than `seconds`: past every id in that second. */
export function ceilingCursor(seconds: number): WindowCursor {
  return { createdAt: seconds, eventId: "f".repeat(64) };
}

/** One window page below `cursor` (null: the head). `full` adds aux and summaries. */
export type SeekRead = (
  cursor: WindowCursor | null,
  full: boolean,
) => Promise<WindowPage>;

export type Located =
  | Readonly<{ kind: "newest" }>
  /** `page` holds every row in [from, ceiling) and older context below it.
   * A null ceiling means `page` is the head page. */
  | Readonly<{ kind: "segment"; page: WindowPage; ceiling: number | null }>;

/** A page read below a ceiling, against the rows at or after `from`:
 * none (empty), all of them (fits), or too many for one page (overflow). */
function classify(page: WindowPage, from: number) {
  const rows = page.events.filter((event) => WINDOW_KINDS.includes(event.kind));
  if (!rows.some((row) => row.created_at >= from)) return "empty";
  return rows.some((row) => row.created_at < from) || !page.hasMore
    ? "fits"
    : "overflow";
}

/**
 * Find a ceiling whose newest-first page reaches back past `from`, so that it
 * holds the first top-level row at or after `from`. Windows read only newest
 * first, so this probes ceilings: galloping a day at a time from `from`, or
 * from the head when `gallop` is false (the channel start), then bisecting
 * between the last empty and the first overflowing ceiling. Probes are bare;
 * the chosen ceiling is read once in full.
 */
export async function locate(
  read: SeekRead,
  from: number,
  now: number,
  gallop: boolean,
): Promise<Located> {
  let reads = 0;
  const get = (ceiling: number | null, full: boolean) => {
    if (++reads > SEEK_READS) throw new SeekLimitError();
    return read(ceiling === null ? null : ceilingCursor(ceiling), full);
  };
  // No row is in [from, lo). `hi` overflows; null is the head.
  let lo = from;
  let hi: number | null = null;
  let found: number | null | undefined;
  for (let span = DAY; found === undefined; span *= 2) {
    const ceiling = gallop && from + span < now ? from + span : null;
    const outcome = classify(await get(ceiling, false), from);
    if (outcome === "fits") found = ceiling;
    else if (outcome === "overflow") {
      hi = ceiling;
      break;
    } else if (ceiling === null) return { kind: "newest" };
    else lo = ceiling;
  }
  while (found === undefined) {
    const top = hi ?? now + 1;
    // More than a page of rows share one second.
    if (top - lo <= 1) throw new SeekLimitError();
    const mid = Math.floor((lo + top) / 2);
    const outcome = classify(await get(mid, false), from);
    if (outcome === "fits") found = mid;
    else if (outcome === "empty") lo = mid;
    else hi = mid;
  }
  return { kind: "segment", page: await get(found, true), ceiling: found };
}
