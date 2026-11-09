// React's development build adds a User Timing measure for each component
// render whose props changed (its "Components ⚛" performance track), with the
// prop diff as its detail. The page keeps every measure until something clears
// it, so a long `just desktop` session grew by about 1,000 measures a second
// until WebKit ended the web process. This clears the page's measure buffer;
// an active Chromium Performance trace keeps events it already recorded.
export const REACT_DEV_MEASURE_CLEAR_MS = 10_000;

export function clearReactDevMeasures(
  perf: Pick<Performance, "clearMeasures"> | undefined = globalThis.performance,
): () => void {
  if (typeof perf?.clearMeasures !== "function") return () => {};
  const timer = setInterval(
    () => perf.clearMeasures(),
    REACT_DEV_MEASURE_CLEAR_MS,
  );
  return () => clearInterval(timer);
}
