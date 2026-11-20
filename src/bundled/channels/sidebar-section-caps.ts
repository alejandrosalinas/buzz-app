import { useCallback, useEffect, useState } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";

/** A capped section lists its newest rows; Show more adds a step. */
export const SECTION_ROW_CAP = 7;
export const SECTION_ROW_STEP = 10;

/** Rows a section lists past the cap, or every row. */
export type SectionLimit = number | "all";

const limitsKey = "sidebar:section-limits";
/** Solo's per-workspace Show more steps from before sections were unified. */
const legacySoloKey = "solo:expanded-projects";

function legacySoloSteps(scope: string): Readonly<Record<string, unknown>> {
  const legacy = readView<unknown>(scope, legacySoloKey, {});
  return legacy && typeof legacy === "object" && !Array.isArray(legacy)
    ? (legacy as Record<string, unknown>)
    : {};
}

const legacyStep = (steps: Readonly<Record<string, unknown>>, id: string) => {
  const step = Object.hasOwn(steps, id) ? steps[id] : undefined;
  return typeof step === "number" && step > 0 ? step : 0;
};

/** Solo starts capped, as its chats were before sections were unified, and
 * keeps the steps it had shown. Every other section starts expanded. */
export function readSectionLimits(
  scope: string,
): Readonly<Record<string, SectionLimit>> {
  const saved = readView<unknown>(scope, limitsKey, undefined);
  if (saved && typeof saved === "object" && !Array.isArray(saved))
    return Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, SectionLimit] =>
          entry[1] === "all" || (typeof entry[1] === "number" && entry[1] >= 0),
      ),
    );
  return { solo: legacyStep(legacySoloSteps(scope), "") };
}

/** Workspaces from the old Solo sidebar start capped like Solo, with the
 * steps they had shown. Their limits are saved so they keep that start after
 * the legacy record is gone. Other workspaces, including new ones, start
 * expanded. */
export function seedSoloWorkspaceLimits(
  scope: string,
  limits: Readonly<Record<string, SectionLimit>>,
  soloWorkspaces: readonly string[],
): Readonly<Record<string, SectionLimit>> {
  const missing = soloWorkspaces.filter(
    (id) => !Object.hasOwn(limits, `group:${id}`),
  );
  if (!missing.length) return limits;
  const steps = legacySoloSteps(scope);
  return {
    ...limits,
    ...Object.fromEntries(
      missing.map((id) => [`group:${id}`, legacyStep(steps, id)]),
    ),
  };
}

export const sectionLimit = (
  limits: Readonly<Record<string, SectionLimit>>,
  key: string,
): SectionLimit => limits[key] ?? (key === "solo" ? 0 : "all");

type Section = Readonly<{ key: string; rows: readonly ChannelSummary[] }>;

export type SectionCap = Readonly<{
  /** Rows past the cap that Show more would add. */
  hidden: number;
  /** Show fewer would hide rows. */
  foldable: boolean;
  /** Rows listed past the cap, or every row. */
  limit: SectionLimit;
}>;

/** Ids listed past each capped section's limit only because they are kept. */
export function sectionOverflowCandidates(
  sections: readonly Section[],
  limits: Readonly<Record<string, SectionLimit>>,
) {
  return sections.flatMap(({ key, rows }) => {
    const limit = sectionLimit(limits, key);
    return limit === "all" || rows.length <= SECTION_ROW_CAP
      ? []
      : rows.slice(SECTION_ROW_CAP + limit).map(({ id }) => id);
  });
}

/** Rows arrive in display order. Kept rows (open, unread, working) and held
 * rows stay listed past the cap, in that order, so a row someone is using
 * never disappears. */
export function capSections<T extends Section>(
  sections: readonly T[],
  limits: Readonly<Record<string, SectionLimit>>,
  kept: (id: string) => boolean,
  held: ReadonlySet<string>,
): (T & { cap: SectionCap; overflow: string[] })[] {
  return sections.map((section) => {
    const limit = sectionLimit(limits, section.key);
    if (limit === "all")
      return {
        ...section,
        cap: {
          hidden: 0,
          foldable: section.rows.length > SECTION_ROW_CAP,
          limit,
        },
        overflow: [],
      };
    // A list that shrank back under the cap has nothing to fold.
    const extra = section.rows.length > SECTION_ROW_CAP ? limit : 0;
    const shown = SECTION_ROW_CAP + extra;
    const rows = section.rows.filter(
      (row, index) => index < shown || kept(row.id) || held.has(row.id),
    );
    const past = rows.slice(shown);
    return {
      ...section,
      rows,
      cap: {
        hidden: section.rows.length - rows.length,
        // Held rows that are no longer kept can fold even when unexpanded.
        foldable: extra > 0 || past.some((row) => !kept(row.id)),
        limit: extra,
      },
      overflow: past.map(({ id }) => id),
    };
  });
}

/** Each section's Show more and Show fewer, remembered per sidebar scope. */
export function useSectionLimits(
  scope: string,
  soloWorkspaces: readonly string[] = [],
) {
  const [limits, setLimits] = useState(() => readSectionLimits(scope));
  const solo = soloWorkspaces.join(" ");
  useEffect(() => {
    if (!solo) return;
    setLimits((current) => {
      const next = seedSoloWorkspaceLimits(scope, current, solo.split(" "));
      if (next !== current) writeView(scope, limitsKey, next);
      return next;
    });
  }, [scope, solo]);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const hold = useCallback((ids: readonly string[]) => {
    setHeld((current) =>
      ids.every((id) => current.has(id))
        ? current
        : new Set([...current, ...ids]),
    );
  }, []);
  const change = useCallback(
    (key: string, limit: SectionLimit, rows: readonly string[] = []) => {
      const next = { ...limits, [key]: limit };
      writeView(scope, limitsKey, next);
      setLimits(next);
      // Folding releases the section's held rows; kept rows stay listed.
      if (limit !== "all" && rows.length) {
        const released = new Set(rows);
        setHeld((current) => {
          const next = [...current].filter((id) => !released.has(id));
          return next.length === current.size ? current : new Set(next);
        });
      }
    },
    [scope, limits],
  );
  return { limits, held, hold, change };
}

/** Hold rows listed past the cap until their section folds. */
export function useHoldOverflow(
  overflow: readonly string[],
  hold: (ids: readonly string[]) => void,
) {
  const ids = overflow.join(" ");
  useEffect(() => {
    if (ids) hold(ids.split(" "));
  }, [ids, hold]);
}
