import { useEffect, useState } from "react";

let loaded: ((content: string) => string) | undefined;

/** The reaction name lookup, or undefined until its emoji table has loaded.
 * The table is large, so it loads once, on first use, never with first paint. */
export function useReactionName(load = true) {
  const [, setLoaded] = useState(!!loaded);
  useEffect(() => {
    if (!load) return;
    let live = true;
    // A failed load (a navigation cancelled the chunk, or it is gone) leaves
    // the name unresolved; the warning keeps a chunk that keeps failing
    // visible. The next mount tries again, but only a new document fetches
    // the chunk again: some engines keep the failed fetch and reject at once.
    void import("./reaction-name").then(
      ({ reactionName }) => {
        loaded = reactionName;
        if (live) setLoaded(true);
      },
      (error) => console.warn("The reaction name table didn't load", error),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return loaded;
}
