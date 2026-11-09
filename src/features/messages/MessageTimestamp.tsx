import type { ReactNode } from "react";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  formatDayGroupLabel,
  formatFullTimestamp,
  formatCompactTime,
  formatItemTimestamp,
} from "../../shared/datetime";
import { useClockPreference } from "../../shared/clock-preference";
import { useLocalDay } from "../../shared/use-local-day";
import styles from "./Messages.module.css";

/** The divider above a day's first row: "Today", "Monday", "June 20, 2025".
 * `data-day` carries the local calendar day. */
export function DayDivider({ createdAt }: { createdAt: number }) {
  useLocalDay();
  const date = new Date(createdAt * 1000);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  return (
    <div className={styles.day}>
      <span className={styles.dayLabel}>
        {/* Decorative calendar artwork; the adjacent label owns the date.
            The numeral is HTML, not SVG <text>: Linux WebKit's SVG text cost
            doubled every thread-pane interaction in browser journeys. */}
        <span className={styles.dayCalendar} aria-hidden="true">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#fff" />
            <path
              d="M6 .5h12a5.5 5.5 0 0 1 5.5 5.5v1H.5V6A5.5 5.5 0 0 1 6 .5Z"
              fill="#f00"
            />
            <rect
              x="0.5"
              y="0.5"
              width="23"
              height="23"
              rx="5.5"
              fill="none"
              stroke="var(--border-standard)"
              strokeWidth="0.5"
            />
          </svg>
          {/* Artwork ink, like the SVG fills: the tile is white in both themes. */}
          <span
            data-calendar-date
            style={{ color: "#111", fontSize: "calc(var(--space-5) / 2)" }}
          >
            {date.getDate()}
          </span>
        </span>
        <span data-day={day}>{formatDayGroupLabel(createdAt)}</span>
      </span>
    </div>
  );
}

/** The byline includes a day outside today because its divider can scroll away.
 * When timestamps are hidden in settings, only assistive technology reads it. */
export function MessageTimestamp({
  createdAt,
  visible = true,
  compact = false,
}: {
  createdAt: number;
  visible?: boolean;
  compact?: boolean;
}) {
  useLocalDay();
  useClockPreference();
  const date = new Date(createdAt * 1000);
  const fullDate = formatFullTimestamp(createdAt);
  // Keep accessible dates out of copied conversation text.
  const accessible = <span className="sr-only select-none">{fullDate}</span>;
  if (!visible) return <time dateTime={date.toISOString()}>{accessible}</time>;
  return (
    <Tooltip content={fullDate} disableHoverablePopup>
      <time dateTime={date.toISOString()} style={{ cursor: "default" }}>
        <span aria-hidden="true">
          {compact
            ? formatCompactTime(createdAt)
            : formatItemTimestamp(createdAt, { withTime: true })}
        </span>
        {accessible}
      </time>
    </Tooltip>
  );
}

/** Grouped messages keep their date for assistive technology without an inline clock. */
export function MessageTimestampHint({
  createdAt,
  attachments = false,
  children,
}: {
  createdAt: number | undefined;
  /** Percentage-sized media needs the payload's full width. */
  attachments?: boolean;
  children: ReactNode;
}) {
  useLocalDay();
  useClockPreference();
  return (
    <div
      className={styles.messagePayload}
      data-message-payload=""
      data-attachments={attachments || undefined}
    >
      {children}
      {createdAt !== undefined && (
        <time
          dateTime={new Date(createdAt * 1000).toISOString()}
          className="sr-only select-none"
        >
          {formatFullTimestamp(createdAt)}
        </time>
      )}
    </div>
  );
}
