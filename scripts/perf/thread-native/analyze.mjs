// Frame and pixel metrics for native thread-scroll runs (docs/performance.md).
import { execFileSync } from "node:child_process";
import { gestureGaps } from "../../../tests/browser/perf/cadence.mjs";

const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
    : Number.NaN;
};

// In-app frames: [t, scrollTop, scrollHeight, clientHeight]; wheels: [t, deltaY].
// The measured window opens at the first wheel event and closes one frame after
// the last frame that changed the scroll offset, so it includes the frame after
// Jump to latest lands. Every frame interval inside it counts, including a stall
// whose ending frame kept the same offset; idle frames after that do not. Frame timestamps are coarsened, so
// thresholds allow 1ms beyond 60 Hz frames.
const VSYNC_MS = 1000 / 60;
export function frameMetrics({ frames, wheels }, vsyncMs = VSYNC_MS) {
  const moving = frames.filter(
    (frame, i) => i && frame[1] !== frames[i - 1][1],
  );
  if (!wheels.length || !moving.length)
    throw new Error("the run recorded no scrolling input");
  const after = frames[frames.indexOf(moving.at(-1)) + 1] ?? moving.at(-1);
  const gaps = gestureGaps(
    frames.map(([t]) => t),
    wheels[0][0],
    after[0],
  );
  return {
    movingFrames: moving.length,
    gapP95Ms: quantile(gaps, 0.95),
    gapMaxMs: Math.max(...gaps),
    framesOver33: gaps.filter((gap) => gap > 2 * vsyncMs + 1).length,
    droppedFrames: gaps.reduce(
      (sum, gap) => sum + Math.max(0, Math.round(gap / vsyncMs) - 1),
      0,
    ),
  };
}

// Captured pixels: a frame is blank when one uniform band (near-zero variance
// across each scanline) covers at least `threshold` of the pane's height.
// Paragraph gaps and padding stay well below it; an unpainted region does not.
export function videoMetrics(path, { threshold = 0.35, width = 120 } = {}) {
  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate",
      "-of",
      "json",
      path,
    ]),
  ).streams[0];
  const height = Math.round((probe.height / probe.width) * width);
  const [num, den] = probe.avg_frame_rate.split("/").map(Number);
  const frameMs = (1000 * den) / num;
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      `scale=${width}:${height},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  const size = width * height;
  const count = Math.floor(raw.length / size);
  let blank = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i < count; i++) {
    const offset = i * size;
    let band = 0;
    let rows = 0;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let squares = 0;
      for (let x = 0; x < width; x++) {
        const value = raw[offset + y * width + x];
        sum += value;
        squares += value * value;
      }
      rows = squares / width - (sum / width) ** 2 < 4 ? rows + 1 : 0;
      band = Math.max(band, rows);
    }
    if (band / height >= threshold) {
      blank++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return {
    capturedFrames: count,
    blankFrames: blank,
    longestBlankMs: Math.round(longest * frameMs),
  };
}

export const TARGETS = {
  gapP95Ms: { target: VSYNC_MS + 1, ceiling: 2 * VSYNC_MS + 1 },
  framesOver33: { target: 0, ceiling: 5 },
  blankFrames: { target: 0, ceiling: 5 },
};

export function summarize(runs) {
  const arms = [...new Set(runs.map((run) => run.arm))];
  const keys = [
    "gapP95Ms",
    "gapMaxMs",
    "framesOver33",
    "droppedFrames",
    "blankFrames",
    "longestBlankMs",
    "movingFrames",
  ];
  const median = (values) => quantile(values, 0.5);
  const rows = keys.map((key) => {
    const cells = arms.map((arm) => {
      const values = runs
        .filter((run) => run.arm === arm)
        .map((run) => run.metrics[key]);
      const value = median(values);
      const verdict = TARGETS[key]
        ? value <= TARGETS[key].target
          ? " (target met)"
          : value <= TARGETS[key].ceiling
            ? " (within ceiling)"
            : " (over ceiling)"
        : "";
      return `${format(value)} [${format(Math.min(...values))}–${format(Math.max(...values))}]${verdict}`;
    });
    return `| ${key} | ${cells.join(" | ")} |`;
  });
  return [
    `| metric (median [min–max]) | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
    ...rows,
    "",
    `Runs per arm: ${arms.map((arm) => `${arm} ${runs.filter((run) => run.arm === arm).length}`).join(", ")}.`,
  ].join("\n");
}
const format = (value) =>
  Number.isFinite(value) ? String(Math.round(value * 10) / 10) : "–";
