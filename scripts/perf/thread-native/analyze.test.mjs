import { expect, test } from "vitest";
import { frameMetrics, summarize } from "./analyze.mjs";

// [t, scrollTop, scrollHeight, clientHeight] at 60 Hz, scrolling every frame.
const steady = Array.from({ length: 30 }, (_, i) => [
  Math.round(i * 16.67),
  i * 10,
  9000,
  700,
]);

test("counts only frames that moved, with coarsened 60 Hz timestamps", () => {
  const frames = [...steady, [steady.at(-1)[0] + 100, 290, 9000, 700]];
  frames.push([frames.at(-1)[0] + 50, 300, 9000, 700]);
  expect(frameMetrics(frames)).toMatchObject({
    movingFrames: 30,
    gapMaxMs: 50,
    framesOver33: 1,
    droppedFrames: 2,
  });
});

test("reports a steady 60 Hz run as meeting the frame target", () => {
  const metrics = frameMetrics(steady);
  expect(metrics.framesOver33).toBe(0);
  expect(
    summarize([{ arm: "head", metrics: { ...metrics, blankFrames: 0 } }]),
  ).toContain("(target met)");
});
