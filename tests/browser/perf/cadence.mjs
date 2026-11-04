// Two 60 Hz frames plus scheduling tolerance: a gap above this missed a frame.
const TWO_FRAMES_MS = (2 * 1000) / 60 + 1;

export function scrollCadence({ frames, gestureStartMs, gestureEndMs }) {
  if (
    !Number.isFinite(gestureStartMs) ||
    !Number.isFinite(gestureEndMs) ||
    gestureEndMs <= gestureStartMs
  )
    throw new Error("Missing or invalid scroll gesture timestamps");
  // Clip boundary gaps, but retain every callback inside the gesture, including
  // stalls while the scroll offset is unchanged. No callbacks means one gap.
  const times = [
    gestureStartMs,
    ...frames
      .map(({ t }) => t)
      .filter((t) => t > gestureStartMs && t < gestureEndMs),
    gestureEndMs,
  ];
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    rafMaxGapMs: Math.max(...gaps),
    rafP95GapMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
    rafGapsOver33: gaps.filter((gap) => gap > TWO_FRAMES_MS).length,
    rafGapsOver50: gaps.filter((gap) => gap > 50).length,
  };
}
