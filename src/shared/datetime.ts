/**
 * Relative date labels for messages and day groups, ported from Buzz desktop
 * (`desktop/src/shared/lib/datetime.ts`) so both apps read the same.
 *
 * The ladder follows the Block writing standard for relative dates, with one
 * deliberate deviation noted on `formatDayGroupLabel`. Formats use the default
 * locale and time zone, checked again after yielding, so a running app follows
 * OS changes without resolving the defaults for every row in one render batch.
 * Clock times follow the hour cycle and seconds chosen in Appearance settings.
 */

import { clockHourCycle, clockPreference } from "./clock-preference";

let defaultsChecked = false;
let formats:
  | {
      locale: string;
      timeZone: string;
      hourCycle: string | undefined;
      seconds: boolean;
      weekday: Intl.DateTimeFormat;
      weekdayMonthDay: Intl.DateTimeFormat;
      monthDayYear: Intl.DateTimeFormat;
      shortWeekdayMonthDay: Intl.DateTimeFormat;
      shortMonthDayYear: Intl.DateTimeFormat;
      time: Intl.DateTimeFormat;
      full: Intl.DateTimeFormat;
    }
  | undefined;
function dateFormats() {
  const hourCycle = clockHourCycle();
  const { seconds } = clockPreference();
  if (
    defaultsChecked &&
    formats &&
    formats.hourCycle === hourCycle &&
    formats.seconds === seconds
  )
    return formats;
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  if (
    formats?.locale !== locale ||
    formats.timeZone !== timeZone ||
    formats.hourCycle !== hourCycle ||
    formats.seconds !== seconds
  ) {
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, options);
    const clock = hourCycle ? { hourCycle } : {};
    formats = {
      locale,
      timeZone,
      hourCycle,
      seconds,
      weekday: format({ weekday: "long" }),
      weekdayMonthDay: format({
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
      monthDayYear: format({ month: "long", day: "numeric", year: "numeric" }),
      shortWeekdayMonthDay: format({
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      shortMonthDayYear: format({
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      time: format({
        hour: "numeric",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
        ...clock,
      }),
      full: format({ dateStyle: "full", timeStyle: "long", ...clock }),
    };
  }
  defaultsChecked = true;
  queueMicrotask(() => {
    defaultsChecked = false;
  });
  return formats;
}

/** Days in a week, past which the weekday name stops being unambiguous. */
const WEEKDAY_BAND_DAYS = 7;

/**
 * Label for a group of items that share a calendar day, such as a day divider.
 *
 * ```
 * Today            → "Today"
 * Yesterday        → "Yesterday"
 * 2–6 days ago     → "Monday"
 * older, this year → "Saturday, June 20"
 * earlier years    → "June 20, 2025"
 * ```
 *
 * Deliberate deviation from the standard: the standard collapses anything over
 * ten months old to month and year ("Aug 2022"). A group label has to identify
 * its day, so the day is kept and only the year is conditional.
 *
 * `nowSeconds` stays a parameter, not a captured constant: a label rendered
 * before midnight has to say "Yesterday" once the day rolls over.
 */
export function formatDayGroupLabel(
  unixSeconds: number,
  nowSeconds = Date.now() / 1_000,
): string {
  const date = new Date(unixSeconds * 1_000);
  const now = new Date(nowSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  const f = dateFormats();
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  // Bounded below too: a future timestamp (clock skew) must not get a weekday
  // that reads as the recent past.
  if (dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS) return f.weekday.format(date);
  return date.getFullYear() === now.getFullYear()
    ? f.weekdayMonthDay.format(date)
    : f.monthDayYear.format(date);
}

/**
 * Label for one item's timestamp, such as a message byline or a list row.
 *
 * ```
 * withTime: false (narrow rows)   withTime: true (roomy rows)
 * Today   → "2:34 PM"             Today   → "2:34 PM"
 * Yest.   → "Yesterday"           Yest.   → "Yesterday at 2:34 PM"
 * 2–6d    → "Monday"              2–6d    → "Monday at 2:34 PM"
 * year    → "Sat, Jun 20"         year    → "Sat, Jun 20 at 2:34 PM"
 * older   → "Jun 20, 2025"        older   → "Jun 20, 2025 at 2:34 PM"
 * ```
 *
 * Today needs no date word: a bare clock time already reads as today.
 * `withTime` is a surface decision: pass `true` where people read
 * conversation, and `false` in a narrow list row with the full date a hover
 * away.
 */
export function formatItemTimestamp(
  unixSeconds: number,
  {
    withTime = false,
    nowSeconds = Date.now() / 1_000,
  }: { withTime?: boolean; nowSeconds?: number } = {},
): string {
  const date = new Date(unixSeconds * 1_000);
  const now = new Date(nowSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  const f = dateFormats();
  const time = f.time.format(date);
  if (dayDiff === 0) return time;
  const dayLabel =
    dayDiff === 1
      ? "Yesterday"
      : dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS
        ? f.weekday.format(date)
        : date.getFullYear() === now.getFullYear()
          ? f.shortWeekdayMonthDay.format(date)
          : f.shortMonthDayYear.format(date);
  return withTime ? `${dayLabel} at ${time}` : dayLabel;
}

/** The complete date and time, such as a timestamp's hover text:
 * "Friday, October 2, 2026 at 3:05:09 PM EDT". */
export function formatFullTimestamp(unixSeconds: number): string {
  return dateFormats().full.format(new Date(unixSeconds * 1_000));
}

/** The clock time, such as "3:05 PM". */
export function formatTime(unixSeconds: number): string {
  return dateFormats().time.format(new Date(unixSeconds * 1_000));
}

/** A continuation clock without the day period, sharing the full date's settings. */
export function formatCompactTime(unixSeconds: number): string {
  return dateFormats()
    .time.formatToParts(unixSeconds * 1_000)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

/** Local midnight of the calendar day containing `date`. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole calendar days from `date` to `now`, in local time. Rounded, so a
 * 23- or 25-hour DST day still counts as one day. */
function calendarDaysBetween(now: Date, date: Date): number {
  return Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) /
      86_400_000,
  );
}
