import { useEffect, useState } from "react";

let loaded: ((content: string) => string) | undefined;

/** The reaction name lookup, or undefined until its emoji table has loaded.
 * The table is large, so it loads once, on first use, never with first paint. */
export function useReactionName(load = true) {
  const [, setLoaded] = useState(!!loaded);
  useEffect(() => {
    if (!load) return;
    let live = true;
    void import("./reaction-name").then(({ reactionName }) => {
      loaded = reactionName;
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [load]);
  return loaded;
}
