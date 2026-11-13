import type { HourCycle } from "../../shared/clock-preference";

// Zone names repeat across a roster; each check constructs a formatter.
const zones = new Map<string, string | undefined>();

/** A profile's self-declared `tz` when this runtime accepts it as a time
 * zone, else undefined. Kept as written: engines canonicalize aliases such as
 * Asia/Kolkata differently. */
export function profileTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 64) return;
  if (zones.has(value)) return zones.get(value);
  let zone: string | undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    zone = value;
  } catch {}
  zones.set(value, zone);
  return zone;
}

/** Minutes the zone is ahead of UTC at `at`, including daylight saving;
 * undefined when the engine's offset name is not recognized. */
function utcOffset(timeZone: string, at: Date): number | undefined {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? "");
  if (!match) return;
  const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Days since the epoch of the calendar date in `timeZone` at `at`. */
function calendarDay(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/** "3:42 PM local time · 8h ahead": the clock in `timeZone` at `now`, and how
 * far it is from the viewer's zone when the two differ at that moment, unless
 * `difference` is false. A
 * different calendar date reads "tomorrow" or "yesterday", or the weekday when
 * the dates are two apart (UTC+14 against UTC-11). Undefined when `timeZone` is
 * not a usable zone. */
export function localTimeLabel(
  timeZone: string | undefined,
  now: Date,
  viewerZone: string,
  options: {
    locale?: string;
    hourCycle?: HourCycle | undefined;
    difference?: boolean;
  } = {},
): string | undefined {
  const zone = profileTimeZone(timeZone);
  if (!zone) return;
  const time = new Intl.DateTimeFormat(options.locale, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
  }).format(now);
  const viewer = profileTimeZone(viewerZone);
  if (!viewer) return `${time} local time`;
  const days = calendarDay(zone, now) - calendarDay(viewer, now);
  const day =
    days === 1
      ? " tomorrow"
      : days === -1
        ? " yesterday"
        : days
          ? // English, like "tomorrow" and the rest of the label.
            ` ${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now)}`
          : "";
  const zoneOffset = utcOffset(zone, now);
  const viewerOffset = utcOffset(viewer, now);
  const difference =
    zoneOffset === undefined || viewerOffset === undefined
      ? 0
      : zoneOffset - viewerOffset;
  if (!difference || options.difference === false)
    return `${time}${day} local time`;
  const hours = Math.floor(Math.abs(difference) / 60);
  const minutes = Math.abs(difference) % 60;
  const amount = [hours && `${hours}h`, minutes && `${minutes}m`]
    .filter(Boolean)
    .join(" ");
  return `${time}${day} local time · ${amount} ${difference > 0 ? "ahead" : "behind"}`;
}
