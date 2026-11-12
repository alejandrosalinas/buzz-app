import { createContext, useContext } from "react";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RelaySession } from "../../features/relay/session";

export const BESTIE_PAGE = "buzz.bestie/bestie";
/** Whether `target` is the Bestie page, which presents the promoted DM. */
export function isBestiePage(target: OpenTarget | null | undefined) {
  return (
    target?.kind === "page" &&
    `${target.pluginId}/${target.pageId}` === BESTIE_PAGE
  );
}
export type BestieMark = {
  label: string;
  detail: "Bestie";
  avatar?: { src: string | undefined; shape: "squircle" };
  placeholder?: true;
};
export const BestieNavigationContext = createContext<BestieMark | undefined>(
  undefined,
);
export const BestieConversationContext = createContext<
  { session: RelaySession; channelId: string } | undefined
>(undefined);

export function useBestieConversation(session: RelaySession | undefined) {
  const conversation = useContext(BestieConversationContext);
  return session && conversation?.session === session
    ? conversation.channelId
    : undefined;
}
