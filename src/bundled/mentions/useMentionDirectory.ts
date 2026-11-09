import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { allowsOutsideMentions } from "../../features/messages/mention-admission";
import { matchPerson } from "../../features/search/person-match";
import { verifiedName } from "../../features/profiles/useVerifiedNames";
import { searchDebounce, searchable } from "../../shared/search-debounce";
import { typedPublicKey } from "../../shared/identity/public-key";

type Person = Awaited<
  ReturnType<ComposerSession["directMessages"]["people"]>
>["people"][number];
export type MentionDirectoryPage = { people: readonly Person[]; more: boolean };
type Page = MentionDirectoryPage;
const empty: readonly Person[] = [];
const CACHE_LIMIT = 100;
// An exact key is an author lookup, which name-prefix evidence cannot refute.
const exactKey = (query: string) => typedPublicKey(query) !== undefined;

// Successful non-empty first pages, per session (community/viewer) and query.
// Session lifetime bounds staleness; errors are not cached, so Retry reads
// again. Empty results are not cached: `exhausted` owns that evidence, and a
// fresh search for the same query reads again.
const pages = new WeakMap<ComposerSession, Map<string, Page>>();
function cached(session: ComposerSession, query: string) {
  return pages.get(session)?.get(query);
}
function remember(session: ComposerSession, query: string, page: Page) {
  let queries = pages.get(session);
  if (!queries) {
    queries = new Map();
    pages.set(session, queries);
  }
  queries.delete(query);
  queries.set(query, page);
  if (queries.size > CACHE_LIMIT)
    queries.delete(queries.keys().next().value ?? "");
}
/**
 * The longest cached complete page for a proper prefix of `query`. The relay
 * matches names by prefix, so a page for `mira` that reported no more pages
 * already holds every match for `mira e`, `mira exam` and `mira example`;
 * `derive` filters it to the longer query. A truncated page may have left a
 * match out, and an exact key is an author lookup that no name prefix
 * answers, so neither derives. Nor does the listing read for an empty query:
 * it is a plain profile read, not a name search, and once complete (a
 * community with fewer than 15 profiles) it is a prefix of every query, so it
 * would answer each name search for the session and hide a member who joins
 * or renames after it.
 */
function prefixPage(session: ComposerSession, query: string) {
  const queries = pages.get(session);
  if (!queries || exactKey(query)) return undefined;
  let best: [string, Page] | undefined;
  for (const [key, page] of queries)
    if (
      key.trim().length > 0 &&
      !page.more &&
      key.length < query.length &&
      query.startsWith(key) &&
      (!best || key.length > best[0].length)
    )
      best = [key, page];
  return best?.[1];
}
/** The page for `query` read out of a complete page for its prefix. A person
 * the community verified also matches by their verified names, so refining
 * `fake` to `fake n` keeps Fake Name. */
const derive = (session: ComposerSession, page: Page, query: string): Page => ({
  people: page.people.filter((person) => {
    const verified = verifiedName(session.profiles, person.pubkey);
    return [person.name, verified?.displayName, verified?.fullName].some(
      (name) => name !== undefined && matchPerson(name, query),
    );
  }),
  more: false,
});
// The last settled page per chooser lifetime. Inline completion remounts its
// provider on every keystroke, so a component-local copy would be lost.
const settled = new WeakMap<ComposerSession, Map<string, Page>>();
const LIFETIME_LIMIT = 20;
function settle(session: ComposerSession, lifetime: string, page: Page) {
  let lifetimes = settled.get(session);
  if (!lifetimes) {
    lifetimes = new Map();
    settled.set(session, lifetimes);
  }
  if (lifetimes.get(lifetime) === page) return;
  lifetimes.delete(lifetime);
  lifetimes.set(lifetime, page);
  if (lifetimes.size > LIFETIME_LIMIT)
    lifetimes.delete(lifetimes.keys().next().value ?? "");
}
// Last complete, empty word-prefix search; queries strictly extending it
// cannot match anyone. Re-entering the same query searches afresh.
const exhausted = new WeakMap<ComposerSession, string>();
const refutedPage: Page = { people: empty, more: false };

/**
 * The first page for `query`: the shared cache, a complete cached page for a
 * prefix of it, or one relay read that fills the cache. The chooser and the
 * pending-mention resolver both read through here, so a page either has found
 * is the other's cache hit. `fresh` skips the prefix page: a retry asked for
 * a read, and a derived page is not cached, so the chooser could not show it.
 */
export async function fetchMentionDirectoryPage(
  session: ComposerSession,
  query: string,
  signal: AbortSignal,
  { fresh = false } = {},
): Promise<Page> {
  const hit = cached(session, query);
  if (hit) return hit;
  const source = fresh ? undefined : prefixPage(session, query);
  if (source) return derive(session, source, query);
  exhausted.delete(session);
  const { people, hasMore } = await session.directMessages.people(
    query,
    1,
    signal,
  );
  const page = { people, more: hasMore };
  if (signal.aborted) return page;
  if (people.length) remember(session, query, page);
  // The relay ignores non-word text, so it only refutes word prefixes.
  else if (!hasMore && !exactKey(query) && /[\p{L}\p{N}]/u.test(query))
    exhausted.set(session, query);
  return page;
}

/**
 * Directory pages belong to this menu and community, not the global profile
 * cache. While a new query waits or loads, the last settled page stays visible
 * so callers can keep its still-matching people instead of blanking the list.
 * `lifetime` names one chooser opening (one picker, or one inline `@` token)
 * and must outlive provider remounts within it.
 */
export function useMentionDirectory(
  session: ComposerSession,
  channel: ChannelSummary | undefined,
  query: string,
  enabled: boolean,
  lifetime: string,
) {
  const active =
    enabled &&
    allowsOutsideMentions(channel) &&
    !channel?.archived &&
    !channel?.readOnly;
  // A retry belongs to the query it was asked for. The picker keeps one hook
  // mounted across openings, so a count that never reset would hold every
  // later query of the session to a fresh read, off the prefix-page and
  // refuted shortcuts, after one transient failure.
  const [retried, setRetried] = useState<{ query: string; attempt: number }>();
  const attempt = retried?.query === query ? retried.attempt : 0;
  const [state, setState] = useState<{
    session: ComposerSession;
    query: string;
    attempt: number;
    /** The chooser opening this result belongs to. */
    lifetime: string;
    /** A settled page that is not cached (an empty result), for this opening only. */
    page?: Page;
    error?: string;
  }>();
  const own =
    state?.session === session &&
    state.query === query &&
    state.attempt === attempt &&
    state.lifetime === lifetime
      ? state
      : undefined;
  const prefix = exhausted.get(session);
  const refuted =
    attempt === 0 &&
    !exactKey(query) &&
    prefix !== undefined &&
    query.length > prefix.length &&
    query.startsWith(prefix);
  const exact = active ? cached(session, query) : undefined;
  // Like the refuted shortcut, a prefix page serves only until a retry asks
  // for a fresh read. Its identity keys the derived page, so the result is
  // stable across renders until another read lands in the cache.
  const source =
    active && !exact && attempt === 0 ? prefixPage(session, query) : undefined;
  const derived = useMemo(
    () => (source ? derive(session, source, query) : undefined),
    [session, source, query],
  );
  const hit = active
    ? (exact ?? own?.page ?? derived ?? (refuted ? refutedPage : undefined))
    : undefined;
  // An empty query lists the directory; shorter text shows only pages already
  // read, filtered by the chooser, and waits for enough to search.
  const tooShort = active && !hit && !!query.trim() && !searchable(query);
  const searching = active && !hit && !tooShort;
  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const current = { session, query, attempt, lifetime };
    const cancel = searchDebounce(() => {
      void fetchMentionDirectoryPage(session, query, controller.signal, {
        fresh: attempt > 0,
      }).then(
        (page) => {
          if (controller.signal.aborted) return;
          // A non-empty page is now cached; `own.page` keeps an empty one.
          setState(page.people.length ? current : { ...current, page });
        },
        () => {
          if (!controller.signal.aborted)
            setState({
              ...current,
              error: "Could not search community people. Retry to refresh.",
            });
        },
      );
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [session, query, searching, attempt, lifetime]);
  if (hit) settle(session, lifetime, hit);
  const error = active && !hit ? own?.error : undefined;
  const shown = hit ?? settled.get(session)?.get(lifetime);
  const retry = useCallback(() => {
    pages.get(session)?.delete(query);
    setRetried((prior) => ({
      query,
      attempt: (prior?.query === query ? prior.attempt : 0) + 1,
    }));
  }, [session, query]);
  return useMemo(
    () => ({
      /** The current query's page, or the last settled page while it loads. */
      // An empty page shares one array, so it changes no cached candidates.
      people: active && shown?.people.length ? shown.people : empty,
      loading: searching && !error,
      error,
      more: !!hit?.more,
      /** Text too short to search: people not yet read may still match. */
      tooShort,
      retry,
    }),
    [active, shown, hit, searching, tooShort, error, retry],
  );
}
