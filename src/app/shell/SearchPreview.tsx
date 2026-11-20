import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ReadFilter } from "../../features/relay/events";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import {
  type PreviewMentions,
  PreviewText,
  withMentionedIds,
} from "../../features/messages/PreviewText";
import { termMatches } from "../../features/search/snippet";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { formatItemTimestamp } from "../../shared/datetime";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { MessageRow } from "../../features/messages/MessageRow";
import type { SearchDestination, SearchTone } from "./SearchChoices";
import { SEARCH_KINDS, eventMentions, searchText } from "./useSearchMessages";

/** What the preview beside a highlighted row reads to show it. */
export type PeekTarget =
  | {
      kind: "message";
      channelId: string;
      messageId: string;
      createdAt: number;
      authorId: string;
      text: string;
      mentioned: PreviewMentions;
    }
  | { kind: "channel"; channelId: string; about?: string | undefined }
  | { kind: "person"; pubkey: string };

/** A highlight nobody has moved follows the first row, which more typing
 * (`text`) or results still arriving (`busy`) may replace. */
export type PeekFollow = { text: string; busy: boolean };

type Line = {
  id: string;
  channelId: string;
  authorId: string;
  createdAt: number;
  text: string;
  mentioned: PreviewMentions;
};

/** The pause on a row before its preview reads anything, so moving through
 * rows reads only where someone stops. A followed highlight waits as long as
 * search does after each key, and for its results. */
const DWELL = 150;
/** Windows after a message hit, in seconds, read in turn until one holds its
 * next two messages: a minute, an hour, a week. */
const SUCCESSOR_SPANS = [60, 3600, 7 * 86_400];
const SUCCESSOR_PAGE = 20;

/** Previews read while search is open, by target, so returning to a row
 * reads nothing. Search makes one each time it opens; later activity and
 * Clear cache show the next time. */
export type PreviewCache = Map<string, readonly Line[]>;

/** Conversation order: by time, then by id within a second, as threads are. */
const chronological = (
  a: { createdAt: number; id: string },
  b: { createdAt: number; id: string },
) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

const keyOf = (target: PeekTarget) =>
  target.kind === "message"
    ? `m:${target.messageId}`
    : target.kind === "channel"
      ? `c:${target.channelId}`
      : `p:${target.pubkey}`;

function linesOf(events: readonly { [key: string]: unknown }[]): Line[] {
  return events.flatMap((raw) => {
    const event = raw as {
      id: string;
      kind: number;
      pubkey: string;
      created_at: number;
      content: string;
      tags: readonly (readonly string[])[];
    };
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!channelId || !SEARCH_KINDS.includes(event.kind)) return [];
    return [
      {
        id: event.id,
        channelId,
        authorId: event.pubkey,
        createdAt: event.created_at,
        text: searchText(event) || "Attachment",
        mentioned: eventMentions(event),
      },
    ];
  });
}

async function readLines(
  session: RelaySession,
  target: PeekTarget,
  signal: AbortSignal,
): Promise<readonly Line[]> {
  const read = async (filter: ReadFilter) =>
    linesOf(
      (
        await session.readPage([filter], {
          signal,
          priority: "foreground",
        })
      ).events as never,
    );
  if (target.kind === "message") {
    const where = { kinds: SEARCH_KINDS, "#h": [target.channelId] };
    // Both reads include the hit's second; each keeps its own side of the
    // hit, so a message sent in that second shows once.
    const hit = { createdAt: target.createdAt, id: target.messageId };
    const side = (lines: readonly Line[], after: boolean) =>
      lines.filter((line) => chronological(line, hit) * (after ? 1 : -1) > 0);
    // Relay reads return the newest first, so a full page of a window may
    // skip the replies just after the hit. Widen from a short window, and
    // keep the last one that came back whole.
    const successors = async () => {
      let whole: Line[] = [];
      for (const span of SUCCESSOR_SPANS) {
        const page = await read({
          ...where,
          since: target.createdAt,
          until: target.createdAt + span,
          limit: SUCCESSOR_PAGE,
        });
        if (page.length >= SUCCESSOR_PAGE) break;
        whole = side(page, true);
        if (whole.length >= 2) break;
      }
      return whole;
    };
    const [before, after] = await Promise.all([
      read({ ...where, until: target.createdAt, limit: 3 }),
      successors(),
    ]);
    const earlier = side(before, false).sort(chronological).slice(-2);
    const later = after.sort(chronological).slice(0, 2);
    return [
      ...earlier,
      {
        id: target.messageId,
        channelId: target.channelId,
        authorId: target.authorId,
        createdAt: target.createdAt,
        text: target.text,
        mentioned: target.mentioned,
      },
      ...later,
    ];
  }
  const latest = await read(
    target.kind === "channel"
      ? { kinds: SEARCH_KINDS, "#h": [target.channelId], limit: 3 }
      : { kinds: SEARCH_KINDS, authors: [target.pubkey], limit: 6 },
  );
  return latest
    .filter(({ channelId }) => !!session.channels.get?.(channelId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);
}

function useLines(
  session: RelaySession,
  cache: PreviewCache,
  target: PeekTarget | undefined,
  follow: PeekFollow | undefined,
) {
  const key = target ? keyOf(target) : "";
  const known = cache.get(key);
  const [state, setState] = useState<{
    key: string;
    lines?: readonly Line[];
    failed?: boolean;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: The key names the target; a followed highlight's text restarts its pause.
  useEffect(() => {
    if (!target || known || follow?.busy) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        readLines(session, target, controller.signal)
          .then((lines) => {
            if (controller.signal.aborted) return;
            cache.set(key, lines);
            setState({ key, lines });
            void session.profiles
              .ensure(
                withMentionedIds(
                  lines.map((line) => line.authorId),
                  lines.map((line) => line.mentioned),
                ),
                "background",
              )
              .catch(() => {});
          })
          .catch(() => {
            if (!controller.signal.aborted) setState({ key, failed: true });
          });
      },
      follow ? SEARCH_DEBOUNCE_MS : DWELL,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, cache, key, follow?.busy, follow?.text]);
  const failed = !known && state?.key === key && !!state.failed;
  return {
    lines: known ?? (state?.key === key ? state.lines : undefined),
    failed,
  };
}

const when = (createdAt: number) =>
  formatItemTimestamp(createdAt, { withTime: true });

/** A short look at the highlighted row: enough to tell it is the right one
 * without opening it. */
export function SearchPreview({
  session,
  cache,
  row,
  tone,
  terms,
  nameOf,
  whereOf,
  follow,
}: {
  session: RelaySession;
  cache: PreviewCache;
  row: (SearchDestination & { peek?: PeekTarget | undefined }) | undefined;
  tone: SearchTone | undefined;
  terms: readonly string[];
  nameOf: (pubkey: string, channelId?: string) => string;
  whereOf: (channelId: string) => string;
  follow?: PeekFollow | undefined;
}) {
  // Names and pictures resolve as their profiles arrive.
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  // Losing access to a channel republishes the list; held lines from a
  // channel the viewer can no longer read drop out, cached or shown.
  useSyncExternalStore(session.channels.subscribeList, session.channels.list);
  const readable = (line: { channelId: string }) =>
    !!session.channels.get?.(line.channelId);
  const target = row?.peek;
  const read = useLines(session, cache, target, follow);
  const lines = read.lines?.filter(readable);
  const { failed } = read;
  const card = useRef<HTMLDivElement>(null);
  // Each row's preview opens at its top, then scrolls only as far as the hit
  // needs: a hit taller than the view starts at its own top, the last line of
  // the one before it above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-anchor when the row or its lines change.
  useLayoutEffect(() => {
    const view = card.current?.parentElement;
    if (!view) return;
    view.scrollTop = 0;
    const hit = view.querySelector<HTMLElement>("[data-hit]");
    // A hit first in its lines already sits just below the heading.
    if (!hit?.previousElementSibling) return;
    const box = view.getBoundingClientRect();
    const rect = hit.getBoundingClientRect();
    const pad = Number.parseFloat(getComputedStyle(view).paddingBottom) || 0;
    const sliver =
      Number.parseFloat(getComputedStyle(hit).scrollMarginTop) || 0;
    const edge = view.clientTop;
    const past = rect.bottom + pad + edge - box.bottom;
    if (past > 0)
      view.scrollTop = Math.min(past, rect.top - box.top - edge - sliver);
  }, [target && keyOf(target), read.lines, failed]);
  if (!row) return <p className="search-peek-empty">Nothing highlighted</p>;
  const message = target?.kind === "message" ? target : undefined;
  const Icon = (message ? row.detailIcon : undefined) ?? row.icon;
  // The hit stands in while its neighbours load, below room held for the two
  // before it, so it doesn't move when they arrive.
  const loading = !!message && !lines && !failed;
  const shown: readonly Line[] =
    lines ??
    (message
      ? [
          {
            id: message.messageId,
            channelId: message.channelId,
            authorId: message.authorId,
            createdAt: message.createdAt,
            text: message.text,
            mentioned: message.mentioned,
          },
        ].filter(readable)
      : []);
  const lineRow = (line: Line, hit: boolean) => {
    const text = line.text.slice(0, 1600);
    return (
      <MessageRow
        row={{
          id: line.id,
          channelId: line.channelId,
          authorId: line.authorId,
          createdAt: line.createdAt,
          content: text,
          mentions: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          participants: [],
        }}
        bodyContent={
          <div className="search-peek-text text-message">
            <PreviewText
              text={text}
              full={line.text}
              mentions={line.mentioned}
              matches={hit || !message ? termMatches(text, terms) : undefined}
              session={session}
              channelId={line.channelId}
            />
          </div>
        }
        profile={{
          ...profiles.get(line.authorId),
          name: nameOf(line.authorId, line.channelId),
        }}
        references={session}
        viewer={session.viewer}
        media={session.media}
        onOpenLink={() => false}
        canOpenLink={() => false}
        day={false}
        retry={undefined}
        layout="thread"
        fullWidth
      />
    );
  };
  return (
    <div ref={card} className="search-peek-card">
      <div className="search-peek-summary">
        <div className="search-peek-head">
          {row.avatar && !message ? (
            <Avatar
              alt=""
              fallback={row.avatar.name ?? row.label}
              src={row.avatar.src}
              size="default"
              shape={row.avatar.shape}
            />
          ) : (
            <span
              className="search-peek-tile"
              data-size="large"
              data-tone={message ? "channel" : tone}
              aria-hidden="true"
            >
              {Icon && <Icon size={18} />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="search-peek-title truncate text-label">
              {message ? (
                whereOf(message.channelId)
              ) : (
                <MatchedLabel label={row.label} positions={row.matches} />
              )}
            </div>
            <div className="truncate text-caption text-subtle">
              {message ? when(message.createdAt) : row.detail}
            </div>
          </div>
        </div>
        {target?.kind === "channel" && target.about && (
          <p className="search-peek-about text-body-sm">{target.about}</p>
        )}
      </div>
      {!target && row.action && (
        <p className="search-peek-start m-0 text-body-sm text-subtle">
          <span aria-hidden="true">
            <kbd>↵</kbd>
          </span>{" "}
          {row.action}
        </p>
      )}
      {shown.length > 0 && (
        <ol className="search-peek-lines">
          {/* Hidden lines of a neighbour's shape; each no-break space holds
            its line's height. */}
          {loading &&
            ["before-2", "before-1"].map((slot) => (
              <li
                key={slot}
                className="search-peek-line"
                data-context=""
                data-slot=""
                aria-hidden="true"
              >
                {lineRow({ ...message, id: slot, text: "\u00a0" }, false)}
              </li>
            ))}
          {shown.map((line) => {
            const hit = !!message && line.id === message.messageId;
            return (
              <li
                key={line.id}
                className="search-peek-line"
                data-hit={hit || undefined}
                data-context={(!!message && !hit) || undefined}
              >
                {target?.kind === "person" && (
                  <div className="text-caption text-subtle">
                    {whereOf(line.channelId)}
                  </div>
                )}
                {lineRow(line, hit)}
              </li>
            );
          })}
        </ol>
      )}
      {failed && <p className="search-peek-empty">Couldn’t load a preview.</p>}
      {target && !message && lines?.length === 0 && (
        <p className="search-peek-empty">No recent messages.</p>
      )}
    </div>
  );
}
