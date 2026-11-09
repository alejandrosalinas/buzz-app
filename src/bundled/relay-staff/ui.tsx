import { createContext, useContext, useState, type ReactNode } from "react";
import { nip19 } from "nostr-tools";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  unsupported,
  type StaffFailure,
} from "../../features/relay-staff/contract";
import { describe, type Tracked } from "./session";

export const UNSUPPORTED_BROWSING =
  "This relay doesn't support community browsing yet.";

/** A community as a row knows it. `id` is null when its source was removed. */
export type CommunityRef = { id: string; host: string };

type Nav = {
  open(community: CommunityRef): void;
  /** Host of the community this app is connected to. */
  connectedHost: string;
};
export const NavContext = createContext<Nav>({
  open: () => {},
  connectedHost: "",
});

export function time(raw: string | null | undefined) {
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${relativeTimestamp(date.getTime() / 1000)} (${absoluteTime(raw)})`;
}

/** For future instants, where a relative label misleads. */
export function absoluteTime(raw: string) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const shortKey = (hex: string) => formatPublicKey(hex) ?? hex;

export function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2 text-caption">
      <span className="w-28 shrink-0 text-secondary">{label}</span>
      <span className={mono ? "break-all font-mono" : "break-words"}>
        {children ?? "—"}
      </span>
    </div>
  );
}

export function Loading() {
  return (
    <p className="flex items-center gap-2 text-body-sm text-secondary">
      <CircleNotchIcon className="animate-spin" /> Loading…
    </p>
  );
}

export function Failure({
  failure,
  unsupportedText,
  onRetry,
  retrying = false,
}: {
  failure: StaffFailure;
  /** Copy for a relay that lacks the route (a complete, empty 404 or 405). */
  unsupportedText?: string | undefined;
  /** Reruns the failed read; shown as Retry beside the error. */
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-body-sm text-danger" role="alert">
        {unsupportedText && unsupported(failure)
          ? unsupportedText
          : describe(failure)}
      </p>
      {onRetry && (
        <Button size="sm" loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Retry for a failed read. While the retry runs, the failure stays on screen
 * with its Retry busy, so the focused control stays mounted. The attempt is
 * over once the read settles another outcome (`settled` moves), whatever it
 * is and however fast it came back.
 */
export function useRetry(
  failure: StaffFailure | null,
  settled: number,
  run: () => void,
) {
  const [kept, setKept] = useState<{
    failure: StaffFailure;
    settled: number;
  } | null>(null);
  if (kept && settled !== kept.settled) setKept(null);
  const live = kept && settled === kept.settled ? kept : null;
  return {
    failure: failure ?? live?.failure ?? null,
    retrying: live !== null,
    retry: () => {
      if (failure) setKept({ failure, settled });
      run();
    },
  };
}

/** Loading and failure states for a read; `children` renders the value. */
export function Loaded<T>({
  read,
  onRetry,
  unsupportedText,
  children,
}: {
  read: Tracked<T>;
  /** The read's reload, offered as Retry beside a failure. */
  onRetry?: (() => void) | undefined;
  unsupportedText?: string | undefined;
  children(value: T): ReactNode;
}) {
  const retry = useRetry(
    read.state === "failed" ? read.failure : null,
    read.settled,
    () => onRetry?.(),
  );
  if (retry.failure)
    return (
      <Failure
        failure={retry.failure}
        unsupportedText={unsupportedText}
        onRetry={onRetry && retry.retry}
        retrying={retry.retrying}
      />
    );
  if (read.state !== "ok") return <Loading />;
  return <>{children(read.value)}</>;
}

/** Opens the community's page; a removed source community is not navigable. */
export function CommunityBadge({
  id,
  host,
}: {
  id: string | null;
  host: string | null;
}) {
  const { open } = useContext(NavContext);
  const base =
    "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-caption";
  if (!id || !host)
    return <span className={`${base} text-secondary`}>community removed</span>;
  return (
    <button
      type="button"
      className={base}
      title={`Open ${host}`}
      onClick={() => open({ id, host })}
    >
      <span className="truncate">{host}</span>
    </button>
  );
}

export function NotConnected({ host }: { host: string }) {
  const { connectedHost } = useContext(NavContext);
  if (!connectedHost || connectedHost === host) return null;
  return (
    <span className="text-caption text-warning">
      Not the community you're connected to.
    </span>
  );
}

type Grouped = { communityId: string | null; communityHost: string | null };
const SEVERED = "(source community removed)";

/**
 * Deployment-wide rows grouped by community, in first-seen order. Rows whose
 * source community was purged share one "removed" group.
 */
export function groupByCommunity<T extends Grouped>(items: T[]) {
  const groups = new Map<
    string,
    { host: string; id: string | null; items: T[] }
  >();
  for (const item of items) {
    const key = item.communityId ?? "";
    const group = groups.get(key) ?? {
      id: item.communityId,
      host: item.communityId ? item.communityHost || item.communityId : SEVERED,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Each group's count. A list the relay cut off at `limit` (it returns no
 * total) may hold more in any group, so counts then read as a lower bound.
 */
export function GroupedList<T extends Grouped>({
  items,
  render,
  limit,
  headings = true,
}: {
  items: T[];
  render(item: T): ReactNode;
  limit: number;
  headings?: boolean;
}) {
  const capped = items.length >= limit;
  return (
    <div className="flex flex-col gap-4">
      {groupByCommunity(items).map((group) => (
        <section key={group.id ?? ""}>
          <h4 className="mb-1.5 flex items-center gap-1.5">
            {headings && <CommunityBadge id={group.id} host={group.host} />}
            <span
              className="rounded-full bg-secondary px-2 py-0.5 text-caption font-medium"
              title={
                capped
                  ? "The relay returned its maximum; there may be more"
                  : undefined
              }
            >
              {group.items.length}
              {capped && "+"}
            </span>
          </h4>
          <ul className="flex flex-col gap-1">{group.items.map(render)}</ul>
        </section>
      ))}
    </div>
  );
}

export const listButton =
  "w-full rounded-md border px-3 py-2.5 text-left text-body-sm hover:bg-secondary";

/** A pasted private key must never leave the device. */
export const containsSecretKey = (text: string) =>
  /nsec1[02-9ac-hj-np-z]{6,}/i.test(text);

/** Shown wherever `containsSecretKey` refuses an input. */
export const SECRET_KEY_WARNING =
  "That looks like a private key. Never paste it here.";

/** Hex, `note1…` or `nevent1…` (optionally `nostr:`-prefixed) as a hex event ID. */
export function eventIdInput(text: string): string | null {
  const value = text.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "note") return decoded.data;
    if (decoded.type === "nevent") return decoded.data.id;
  } catch {
    // Not an event reference.
  }
  return null;
}
