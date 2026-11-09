import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";

type Replacement = Readonly<{
  session: RelaySession;
  channelId: string;
  threadRootId: string | undefined;
  pubkey: string;
  requestId?: string | undefined;
  /** This mounted row is the agent's live working indicator, not only its
   * step details: the conversation must not show a second one. */
  presence?: boolean | undefined;
}>;
function createPresentation() {
  const entries = new Map<symbol, Replacement>();
  const listeners = new Set<() => void>();
  let snapshot: readonly Replacement[] = [];
  const publish = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** One publish per batch: every mounted row re-reads on each publish. */
    register(...values: Replacement[]) {
      const tokens = values.map((value) => {
        const token = Symbol();
        entries.set(token, value);
        return token;
      });
      publish();
      return () => {
        let removed = false;
        for (const token of tokens) removed = entries.delete(token) || removed;
        if (removed) publish();
      };
    },
  };
}
const Presentation = createContext<
  | {
      store: ReturnType<typeof createPresentation>;
      active: boolean;
    }
  | undefined
>(undefined);
const empty: readonly Replacement[] = [];
const noopSubscribe = () => () => {};

/** Mounted conversation presentation only; no data, timers, or plugin identity checks. */
export function TypingPresentation({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [store] = useState(createPresentation);
  const value = useMemo(() => ({ store, active }), [store, active]);
  return (
    <Presentation.Provider value={value}>{children}</Presentation.Provider>
  );
}
export function useTypingReplacement(
  value: Replacement | undefined,
  enabled: boolean,
) {
  useReplacement(useContext(Presentation), value, enabled);
}
const ActivityPresentation = createContext<
  ReturnType<typeof createPresentation> | undefined
>(undefined);
export function ActivityIndicatorPresentation({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(createPresentation);
  return (
    <ActivityPresentation.Provider value={store}>
      {children}
    </ActivityPresentation.Provider>
  );
}
export function useActivityTypingReplacement(
  value: Replacement | undefined,
  enabled: boolean,
  participants?: readonly string[],
) {
  const store = useContext(ActivityPresentation);
  useReplacement(
    store ? { store, active: true } : undefined,
    value,
    enabled,
    participants,
  );
}
function useReplacement(
  context:
    | { store: ReturnType<typeof createPresentation>; active: boolean }
    | undefined,
  value: Replacement | undefined,
  enabled: boolean,
  participants?: readonly string[],
) {
  const store = context?.store;
  const active = context?.active;
  const { session, channelId, threadRootId, pubkey, requestId, presence } =
    value ?? {};
  const participantKeys = (participants ?? (pubkey ? [pubkey] : [])).join(":");
  useLayoutEffect(() => {
    if (!active || !enabled || !session || !channelId || !participantKeys)
      return;
    return store?.register(
      ...participantKeys.split(":").map((pubkey) => ({
        session,
        channelId,
        threadRootId,
        pubkey,
        requestId,
        presence,
      })),
    );
  }, [
    store,
    active,
    enabled,
    session,
    channelId,
    threadRootId,
    participantKeys,
    requestId,
    presence,
  ]);
}
/** Agents whose step details a mounted row shows in this conversation. */
export function useReplacedTypers(
  session: object | undefined,
  channelId: string,
  threadRootId: string | undefined,
) {
  return useScopedReplacements(session, channelId, threadRootId, false);
}
/** Agents whose live working indicator a mounted row shows in this conversation. */
export function usePresentedAgents(
  session: object | undefined,
  channelId: string,
  threadRootId: string | undefined,
) {
  return useScopedReplacements(session, channelId, threadRootId, true);
}
function useScopedReplacements(
  session: object | undefined,
  channelId: string,
  threadRootId: string | undefined,
  presenceOnly: boolean,
) {
  const context = useContext(Presentation);
  const activityStore = useContext(ActivityPresentation);
  const store = context?.store;
  const active = context?.active;
  // Select this conversation's keys: unrelated registrations must not
  // re-render every mounted row.
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = [
        store?.subscribe(listener),
        activityStore?.subscribe(listener),
      ];
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    [store, activityStore],
  );
  const getKey = () =>
    keysOf(
      [
        ...(active ? (store?.snapshot() ?? empty) : empty),
        ...(activityStore?.snapshot() ?? empty),
      ],
      (entry) =>
        !entry.requestId &&
        (!presenceOnly || !!entry.presence) &&
        entry.session === session &&
        entry.channelId === channelId &&
        entry.threadRootId === threadRootId,
    );
  const key = useSyncExternalStore(subscribe, getKey, emptyKey);
  return useMemo(() => keySet(key), [key]);
}
const emptyKey = () => "";
const keysOf = (
  entries: readonly Replacement[],
  matches: (entry: Replacement) => boolean,
) =>
  [...new Set(entries.filter(matches).map((entry) => entry.pubkey))].join(":");
const keySet = (key: string): ReadonlySet<string> =>
  new Set(key ? key.split(":") : []);

/** Recorded history owns request controls only while that history is mounted. */
export function useRecordedActivityAgents(
  session: object,
  channelId: string,
  requestId: string | undefined,
) {
  const store = useContext(ActivityPresentation);
  const getKey = () =>
    keysOf(
      store?.snapshot() ?? empty,
      (entry) =>
        entry.session === session &&
        entry.channelId === channelId &&
        !!requestId &&
        entry.requestId === requestId,
    );
  const key = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    getKey,
    emptyKey,
  );
  return useMemo(() => keySet(key), [key]);
}
