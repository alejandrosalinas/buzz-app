import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Outcome = "loaded" | "failed";

// WebKit re-requests cached custom-scheme images on lazy remounts. Remember a
// bounded set of source outcomes: successful sources mount eagerly, and failed
// ones show their fallback at once instead of blank until the error returns.
// These are hints; the real image still decides whether it is ready. Avatars
// and emoji share the bound, so an emoji-heavy screen must not evict avatars;
// an entry is only a URL and a flag.
const outcomes = new Map<string, Outcome>();
function remember(src: string, outcome: Outcome) {
  outcomes.delete(src);
  outcomes.set(src, outcome);
  if (outcomes.size > 1024) {
    const oldest = outcomes.keys().next().value;
    if (oldest !== undefined) outcomes.delete(oldest);
  }
  if (outcome === "loaded") for (const retry of failed.get(src) ?? []) retry();
}
// A failed request may be transient (relay, network or native proxy), and a
// mounted image gets no new source to reset it. Retry the same source a
// bounded number of times, and whenever another mount loads it.
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const failed = new Map<string, Set<() => void>>();

export type ReadyImage = ReturnType<typeof useReadyImage>;

/** Paint lifecycle for a small, frequently remounted image (avatars, emoji).
 * Key the caller by `src`; spread `image` onto the `<img>` and render the
 * caller's fallback in its place while `status` is "failed". */
export function useReadyImage(src: string, loading?: "eager" | "lazy") {
  const [status, setStatus] = useState<"loading" | Outcome>("loading");
  const [outcome] = useState(() => outcomes.get(src));
  const [attempt, setAttempt] = useState(0);
  // WebKit paints a ready async-decoded image (even with `auto`) as empty
  // until a later frame. Decode an image that is ready at mount in the paint
  // that reveals it; network loads keep decoding off the main thread.
  const [readyAtMount, setReadyAtMount] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    // A cached image is ready at mount; settle it before the first paint
    // instead of waiting for another asynchronous load event. A complete image
    // without a width may be a dimensionless SVG, not a broken one, so its load
    // or error event decides.
    if (ref.current?.complete && ref.current.naturalWidth > 0) {
      remember(src, "loaded");
      setReadyAtMount(true);
      setStatus("loaded");
    }
  }, [src]);
  useEffect(() => {
    if (status !== "failed") return;
    const retry = () => {
      setAttempt(attempt + 1);
      setStatus("loading");
    };
    const waiting = failed.get(src) ?? new Set();
    failed.set(src, waiting.add(retry));
    const delay = RETRY_DELAYS_MS[attempt];
    const timer = delay === undefined ? 0 : window.setTimeout(retry, delay);
    return () => {
      window.clearTimeout(timer);
      waiting.delete(retry);
      if (!waiting.size) failed.delete(src);
    };
  }, [src, status, attempt]);
  return {
    status,
    /** The source's last request failed, here or in an earlier mount; a
     * fallback stays up while it is retried instead of blanking. */
    failing: status === "failed" || attempt > 0 || outcome === "failed",
    image: {
      ref,
      src,
      loading: loading ?? (outcome === "loaded" ? "eager" : "lazy"),
      decoding: readyAtMount ? "sync" : "async",
      onLoad: () => {
        remember(src, "loaded");
        setStatus("loaded");
      },
      onError: () => {
        remember(src, "failed");
        setStatus("failed");
      },
    },
  } as const;
}
