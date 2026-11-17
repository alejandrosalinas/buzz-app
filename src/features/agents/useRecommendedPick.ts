// Which recommended setup a new agent on this computer would use, asked once
// as its view opens. See recommended.ts for the rest of the interface.
import { useEffect, useState } from "react";
import {
  pickRecommended,
  type RecommendedHarness,
  type RecommendedPick,
  recommendedNote,
} from "./recommended";

export type RecommendedPickState<T extends RecommendedHarness> =
  /** Not asked: off for this view, such as an edit or a requested agent. */
  | Readonly<{ status: "off" }>
  /** Still asking the harnesses, each for at most `CHECK_MS`. */
  | Readonly<{ status: "checking" }>
  /** Nothing recommended is set up on this computer. */
  | Readonly<{ status: "none" }>
  /** `note` says, in one line, when a preferred harness was skipped. */
  | Readonly<{
      status: "found";
      pick: RecommendedPick<T>;
      note: string | undefined;
    }>;

/** The first candidate one of `types` can run here now, found once. */
export function useRecommendedPick<T extends RecommendedHarness>(
  types: readonly T[],
  enabled = true,
): RecommendedPickState<T> {
  const [found, setFound] = useState<RecommendedPick<T> | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read once, as its view opens.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void pickRecommended(types).then((pick) => {
      if (current) setFound(pick ?? null);
    });
    return () => {
      current = false;
    };
  }, []);
  if (!enabled) return { status: "off" };
  if (found === undefined) return { status: "checking" };
  return found
    ? { status: "found", pick: found, note: recommendedNote(found) }
    : { status: "none" };
}
