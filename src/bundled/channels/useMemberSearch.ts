import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  searchMembers,
  type MemberSearchResult,
} from "../../features/channel-members/search";
import { searchDebounce, searchable } from "../../shared/search-debounce";

const noPeople: MemberSearchResult["people"] = [];

/** Dialog-owned search intent. The session owns transport, verification and profiles. */
export function useMemberSearch(
  session: RelaySession,
  query: string,
  enabled: boolean,
) {
  const text = query.trim();
  const [request, setRequest] = useState({ text, page: 1, attempt: 0 });
  const [result, setResult] = useState<
    MemberSearchResult & { text: string; loading: boolean; error?: string }
  >({ text: "", people: [], more: false, loading: false });
  const generation = useRef(0);
  if (request.text !== text) setRequest({ text, page: 1, attempt: 0 });
  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    if (!enabled || !searchable(request.text) || request.text !== text) return;
    setResult((old) => ({
      text,
      people: request.page === 1 ? [] : old.people,
      more: false,
      loading: true,
    }));
    const cancel = searchDebounce(() => {
      void searchMembers(session, text, request.page, abort.signal).then(
        (page) => {
          if (abort.signal.aborted || current !== generation.current) return;
          setResult((old) => ({
            ...page,
            text,
            loading: false,
            people: [
              ...new Map(
                [...(request.page === 1 ? [] : old.people), ...page.people].map(
                  (person) => [person.pubkey, person],
                ),
              ).values(),
            ],
          }));
        },
        (error: unknown) => {
          if (!abort.signal.aborted && current === generation.current)
            setResult((old) => ({
              ...old,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Search could not load. Try again.",
            }));
        },
      );
    });
    return () => {
      cancel();
      abort.abort();
    };
  }, [session, request, text, enabled]);
  const visible = result.text === text && enabled;
  return {
    people: visible ? result.people : noPeople,
    loading: searchable(text) && enabled && (!visible || result.loading),
    more: visible && result.more,
    /** Typed text is too short to search, so only local choices are offered. */
    tooShort: enabled && !!text && !searchable(text),
    error: visible ? result.error : undefined,
    next: () => setRequest((old) => ({ ...old, page: old.page + 1 })),
    refresh: () =>
      setRequest((old) => ({ ...old, page: 1, attempt: old.attempt + 1 })),
  };
}
