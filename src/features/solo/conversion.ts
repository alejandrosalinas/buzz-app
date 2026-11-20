import { useCallback, useSyncExternalStore } from "react";
import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";
import type { RelaySession } from "../relay/session";

/** In-process orchestration. Channel details own the signed write and its recovery. */
export type ChatConversion = {
  draft: ChannelDetailsDraft;
  converted?: true;
  running?: true;
};
const conversions = new WeakMap<
  RelaySession,
  ReadonlyMap<string, ChatConversion>
>();
const listeners = new WeakMap<RelaySession, Set<() => void>>();
const empty: ReadonlyMap<string, ChatConversion> = new Map();
export function chatConversion(session: RelaySession, id: string) {
  return conversions.get(session)?.get(id);
}
export function updateChatConversion(
  session: RelaySession,
  id: string,
  value: ChatConversion | undefined,
) {
  const next = new Map(conversions.get(session));
  if (value) next.set(id, value);
  else next.delete(id);
  conversions.set(session, next);
  for (const notify of listeners.get(session) ?? []) notify();
}
export function useChatConversions(session: RelaySession) {
  return useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        let callbacks = listeners.get(session);
        if (!callbacks) {
          callbacks = new Set();
          listeners.set(session, callbacks);
        }
        callbacks.add(notify);
        return () => {
          callbacks.delete(notify);
        };
      },
      [session],
    ),
    () => conversions.get(session) ?? empty,
  );
}
export function conversionLabel(session: RelaySession, id: string) {
  return chatConversion(session, id)
    ? "Finish conversion"
    : "Convert to channel";
}
