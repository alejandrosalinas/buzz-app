import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

export type Listing<T> = Readonly<{ rows: readonly T[]; error?: string }>;
type Held = {
  key: string;
  controller: AbortController;
  listing: Promise<Listing<unknown>>;
  holders: number;
};
let last: Held | undefined;

function retire(held: Held) {
  held.controller.abort();
  if (last === held) last = undefined;
}

function hold(
  key: string,
  load: (signal: AbortSignal) => Promise<readonly unknown[]>,
) {
  if (last?.key !== key) {
    // A new query retires the previous one's listing.
    if (last) retire(last);
    const controller = new AbortController();
    const listing = load(controller.signal).then(
      (rows) => ({ rows }),
      (reason: unknown) => ({
        rows: [],
        error: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    last = { key, controller, listing, holders: 0 };
  }
  last.holders += 1;
  return last;
}

function release(held: Held) {
  held.holders -= 1;
  // A keystroke remounts the provider in the same commit, so its next mount
  // holds the listing before this runs. A closed query has no holder by then.
  queueMicrotask(() => {
    if (!held.holders) retire(held);
  });
}

/** What `load` lists for one open query, `key`, listed once however often the
 * host remounts its completion. A new key or `retry` lists again. Desktop
 * only. */
export function useHeldListing<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<readonly T[]>,
) {
  const [attempt, setAttempt] = useState(0);
  const [listed, setListed] = useState<{
    key: string;
    attempt: number;
    listing: Listing<T>;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` lists; a new closure for it is the same listing.
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const held = hold(key, load);
    void held.listing.then((listing) => {
      if (live) setListed({ key, attempt, listing: listing as Listing<T> });
    });
    return () => {
      live = false;
      release(held);
    };
  }, [key, attempt]);
  const retry = useCallback(() => {
    if (last?.key === key) retire(last);
    setAttempt((value) => value + 1);
  }, [key]);
  const listing =
    listed?.key === key && listed.attempt === attempt
      ? listed.listing
      : undefined;
  return useMemo(() => listing && { ...listing, retry }, [listing, retry]);
}
