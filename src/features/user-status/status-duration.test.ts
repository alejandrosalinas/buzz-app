import { expect, it } from "vitest";
import { statusDeadline, statusDuration } from "./status-duration";
it("Today ends at local midnight and This week ends next Monday", () => {
  const thursday = new Date(2026, 8, 24, 18, 37).getTime() / 1000;
  expect(statusDeadline("today", thursday)).toBe(
    new Date(2026, 8, 25).getTime() / 1000,
  );
  expect(statusDeadline("week", thursday)).toBe(
    new Date(2026, 8, 28).getTime() / 1000,
  );
  const monday = new Date(2026, 8, 28, 12).getTime() / 1000;
  expect(statusDeadline("week", monday)).toBe(
    new Date(2026, 9, 5).getTime() / 1000,
  );
  expect(statusDuration(statusDeadline("today", thursday), thursday)).toBe(
    "today",
  );
  expect(statusDuration(thursday + 5000, thursday)).toBe("custom");
});

it("chooses the closest preset when two deadlines are within tolerance", () => {
  const midnight = new Date(2026, 8, 25).getTime() / 1000;
  const before = midnight - 28800 - 60;
  const after = midnight - 28800 + 60;
  expect(statusDuration(midnight, before)).toBe("today");
  expect(statusDuration(midnight, after)).toBe("today");
  expect(statusDuration(before + 28800, before)).toBe("28800");
  expect(statusDuration(after + 28800 + 1, after)).toBe("28800");
  const lateEvening = midnight - 3600 - 30;
  expect(statusDuration(midnight, lateEvening)).toBe("today");
  expect(statusDuration(lateEvening + 3600, lateEvening)).toBe("3600");
});

it("prefers Today when another preset ends at the same midnight", () => {
  const midnight = new Date(2026, 8, 25).getTime() / 1000;
  // "8 hours" saved at 16:00 and "1 hour" saved at 23:00 both end at midnight.
  expect(statusDuration(midnight, midnight - 28800)).toBe("today");
  expect(statusDuration(midnight, midnight - 3600)).toBe("today");
  // On a Sunday "This week" ends at the same midnight as "Today".
  const monday = new Date(2026, 8, 28).getTime() / 1000;
  expect(statusDeadline("week", monday - 28800)).toBe(monday);
  expect(statusDuration(monday, monday - 28800)).toBe("today");
  expect(statusDuration(monday, monday - 43200)).toBe("today");
  // Only presets tie: Today at the edge of the tolerance is still custom.
  expect(statusDuration(midnight + 121, midnight - 6 * 3600)).toBe("custom");
});
