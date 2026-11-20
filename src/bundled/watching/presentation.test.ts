import { expect, it } from "vitest";
import type { Watch } from "./model";
import { timerState } from "../../features/agents/attention";
import { describe } from "./presentation";

/** Local-time unix seconds, so labels read in the zone the formatter uses. */
const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month, day, hour, minute).getTime() / 1_000;
const NOW = at(10, 13, 12); // Fri Nov 13 2026, 12:00 PM local
const DAY = 86_400;
type Timer = Extract<Watch, { type: "timer" }>;
const timer = (
  armed_at: number,
  interval_secs: number,
  more: Partial<Timer> = {},
): Timer => ({
  type: "timer",
  interest_id: "attention-manager",
  enabled: true,
  prompt: "Check in",
  armed_at,
  interval_secs,
  max_occurrences: null,
  expires_at: null,
  ...more,
});

it("tells timers on one interval apart by when each runs next", () => {
  const morning = timer(at(10, 1, 8), DAY);
  const evening = timer(at(10, 1, 22), DAY);
  expect(describe(morning, NOW).title).toBe(
    "Every 24h · next Sat, Nov 14 at 8:00 AM",
  );
  expect(describe(evening, NOW).title).toBe("Every 24h · next 10:00 PM");
});

it("counts the next run from the runner's state", () => {
  // Weekly, first run Sun Nov 1 at 5:00 PM. Until the runner uses the Nov 8
  // run (its Interest busy, or its channel not joined), that run is overdue.
  const weekly = timer(at(10, 1, 17) - 7 * DAY, 7 * DAY);
  expect(describe(weekly, NOW).title).toBe(
    "Every 168h · next Sun, Nov 15 at 5:00 PM",
  );
  const saved = { armedAt: weekly.armed_at, nextDue: at(10, 8, 17), used: 1 };
  expect(describe(weekly, NOW, saved).title).toBe(
    "Every 168h · overdue since Sunday at 5:00 PM",
  );
  // Paused, it is not waiting to run.
  expect(describe(weekly, NOW, saved, true).title).toBe("Every 168h");
  expect(
    describe(timer(at(10, 13, 9), 3_600, { max_occurrences: 5 }), NOW).title,
  ).toBe("Every 1h · 5 runs · next 1:00 PM");
});

it("shows the runner's next run after a late run, an edit or a rearm", () => {
  const hourly = timer(at(10, 13, 8), 3_600);
  // The 9:00 run started late, at noon; the runner set the next for 1:00.
  const late = { armedAt: hourly.armed_at, nextDue: at(10, 13, 13), used: 1 };
  expect(describe(hourly, at(10, 13, 12, 5), late).title).toBe(
    "Every 1h · next 1:00 PM",
  );
  // An interval edit keeps the saved next run.
  expect(
    describe({ ...hourly, interval_secs: 7_200 }, at(10, 13, 12, 5), late)
      .title,
  ).toBe("Every 2h · next 1:00 PM");
  // Rearmed at noon with one used run kept: next is 1:00, not 2:00.
  expect(
    describe(timer(NOW, 3_600), at(10, 13, 12, 5), {
      armedAt: NOW,
      nextDue: at(10, 13, 13),
      used: 1,
    }).title,
  ).toBe("Every 1h · next 1:00 PM");
  // Rearmed at noon with its five used runs kept.
  const rearmed = timer(NOW, 3_600, { max_occurrences: 10 });
  expect(
    describe(rearmed, at(10, 13, 12, 5), {
      armedAt: NOW,
      nextDue: at(10, 13, 13),
      used: 5,
    }).title,
  ).toBe("Every 1h · 10 runs · next 1:00 PM");
});

it("keeps a missed one-shot's configured time once state is saved", () => {
  // Due yesterday at 3:00 and never run: state first saved at noon counts
  // the missed occurrences as used.
  const missed = timer(at(10, 12, 3) - 60, 60, { max_occurrences: 1 });
  expect(describe(missed, NOW, timerState(missed, undefined, NOW))).toEqual({
    title: "Once · Yesterday at 3:00 AM",
    spent: true,
  });
});

it("does not infer a one-shot's run time across an interval edit", () => {
  // It ran at 9:00; an interval edit keeps that state but moves its time.
  const ran = { armedAt: at(10, 13, 8), nextDue: at(10, 13, 10), used: 1 };
  const once = timer(at(10, 13, 8), 3_600, { max_occurrences: 1 });
  expect(describe(once, NOW, ran).title).toBe("Once · 9:00 AM");
  expect(describe({ ...once, interval_secs: 7_200 }, NOW, ran).title).toBe(
    "Once · 10:00 AM",
  );
});

it("shows the runner's deadline for a one-shot that has not run", () => {
  // Armed at 8:00 with one hour, then edited to two hours before it fired:
  // the edit keeps the 9:00 deadline, and the runner fires then.
  const once = timer(at(10, 13, 8), 7_200, { max_occurrences: 1 });
  const armed = { armedAt: at(10, 13, 8), nextDue: at(10, 13, 9), used: 0 };
  expect(describe(once, at(10, 13, 8, 30), armed)).toEqual({
    title: "Once · 9:00 AM",
    spent: false,
  });
  // Past its deadline and still waiting, it is overdue.
  expect(describe(once, NOW, armed)).toEqual({
    title: "Once · overdue since 9:00 AM",
    spent: false,
  });
  // Paused, it shows its deadline without calling it overdue.
  expect(describe(once, NOW, armed, true).title).toBe("Once · 9:00 AM");
});

it("shows no time for a one-shot that expires before it runs", () => {
  // Armed at 8:00 for one hour, ending at 8:30: the 9:00 run never starts.
  const once = timer(at(10, 13, 8), 3_600, {
    max_occurrences: 1,
    expires_at: at(10, 13, 8, 30),
  });
  expect(describe(once, at(10, 13, 8, 10))).toEqual({
    title: "Once · expires before it runs",
    spent: false,
  });
  // Past the deadline it is spent, and keeps its configured time.
  expect(describe(once, at(10, 13, 8, 40))).toEqual({
    title: "Once · 9:00 AM",
    spent: true,
  });
});

it("renders timers dated past what Date can hold", () => {
  const far = Number.MAX_SAFE_INTEGER - DAY;
  expect(describe(timer(far, DAY), NOW).title).toBe("Every 24h");
  expect(describe(timer(far, 60, { max_occurrences: 1 }), NOW)).toEqual({
    title: "Once · date out of range",
    spent: false,
  });
});

it("promises no run at or after the timer expires", () => {
  const hourly = (expires_at: number) => timer(NOW, 3_600, { expires_at });
  const now = at(10, 13, 12, 5);
  expect(describe(hourly(at(10, 13, 12, 30)), now)).toEqual({
    title: "Every 1h",
    spent: false,
  });
  // A next run exactly at the deadline never starts.
  expect(describe(hourly(at(10, 13, 13)), now).title).toBe("Every 1h");
  // A next run one minute before the deadline still shows.
  expect(describe(hourly(at(10, 13, 13, 1)), now).title).toBe(
    "Every 1h · next 1:00 PM",
  );
});

it("reads in the viewer's time zone", async () => {
  const zone = process.env.TZ;
  const daily = timer(Date.UTC(2026, 10, 1, 8) / 1_000, DAY);
  const now = Date.UTC(2026, 10, 13, 12) / 1_000;
  try {
    process.env.TZ = "UTC";
    expect(describe(daily, now).title).toBe(
      "Every 24h · next Sat, Nov 14 at 8:00 AM",
    );
    // The formatter checks the zone again after a microtask checkpoint.
    await Promise.resolve();
    process.env.TZ = "Asia/Tokyo";
    expect(describe(daily, now).title).toBe(
      "Every 24h · next Sat, Nov 14 at 5:00 PM",
    );
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

it("shows a one-shot timer's run time, before and after it runs", () => {
  const once = timer(at(10, 14, 3) - 60, 60, { max_occurrences: 1 });
  expect(describe(once, NOW)).toEqual({
    title: "Once · Sat, Nov 14 at 3:00 AM",
    spent: false,
  });
  expect(describe(once, at(10, 14, 9))).toEqual({
    title: "Once · 3:00 AM",
    spent: true,
  });
});

it("leaves out the next run of a spent, disabled or paused timer", () => {
  const armed = at(10, 1, 8);
  expect(describe(timer(armed, DAY, { max_occurrences: 3 }), NOW)).toEqual({
    title: "Every 24h · 3 runs",
    spent: true,
  });
  expect(describe(timer(armed, DAY, { expires_at: NOW - 1 }), NOW)).toEqual({
    title: "Every 24h",
    spent: true,
  });
  expect(describe(timer(armed, DAY, { enabled: false }), NOW)).toEqual({
    title: "Every 24h",
    spent: false,
  });
  // Its Interest is paused, so the runner skips it.
  expect(describe(timer(armed, DAY), NOW, undefined, true)).toEqual({
    title: "Every 24h",
    spent: false,
  });
});
