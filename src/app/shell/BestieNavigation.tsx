import {
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { bestieChat } from "../../bundled/bestie/chat";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import channelStyles from "../../bundled/channels/Channels.module.css";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { RegisteredPage } from "../../features/pages/service";
import {
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { useSavedAgentState } from "../../features/solo/default-agent";
import { pagePresentation } from "./presentation";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import styles from "./BestieNavigation.module.css";
import {
  BESTIE_PAGE,
  BestieNavigationContext,
  BestieConversationContext,
  type BestieMark,
} from "./bestie-context";

/** Shell projection of the account-saved Bestie and its existing exact DM. */
export function BestieNavigationProvider({
  pages,
  relay,
  children,
}: {
  pages: readonly RegisteredPage[];
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope, session } = connection;
  const enabled =
    pages.some((page) => page.key === BESTIE_PAGE) &&
    !!viewer &&
    !!scope?.endsWith(`:${viewer}`);
  const active = enabled && connection.status === "ready";
  const savedState = useSavedAgentState(session, scope ?? "");
  const saved = savedState.agent;
  const choices = useAgentChoices(session, active, active);
  const agent = enabled
    ? choices.selectable.find((item) => item.pubkey === saved)
    : undefined;
  // A failed source contributes no stale identity row, but the account choice
  // and exact verified DM still establish promotion. Complete evidence that the
  // agent is gone, or known archive evidence, releases it.
  const promoted =
    enabled &&
    saved &&
    !choices.archives.archived.includes(saved) &&
    (agent || choices.status !== "ready" || !choices.complete)
      ? saved
      : undefined;
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = bestieChat(channels.channels, viewer, promoted);
  // The published profile wins, as in DM rows and message avatars, including a
  // profile without a picture (initials). The agent definition's art covers
  // only the wait for that profile, or an agent that never published one.
  const bestie = agent?.pubkey;
  const generation = useProfileGeneration(session.profiles);
  // Evictions also count cancelled background reads, so a cache shrink while
  // this read is pending asks again.
  const readEvictions = () => session.profiles.evictions?.() ?? 0;
  const evictions = useSyncExternalStore(
    session.profiles.subscribe,
    readEvictions,
    readEvictions,
  );
  useEffect(() => {
    void generation;
    void evictions;
    if (bestie)
      void session.profiles.ensure([bestie], "background").catch(() => {});
  }, [session, bestie, generation, evictions]);
  const profile = useSyncExternalStore(session.profiles.subscribe, () =>
    bestie ? session.profiles.snapshot().get(bestie) : undefined,
  );
  const picture = profile ? profile.picture : agent?.avatar;
  const pack = agentAvatars.find((item) => item.url === picture);
  const preview = useAvatarPreview(
    pack ? "" : (picture ?? ""),
    connection.origin,
    "small",
    session.media,
  );
  const avatar = pack?.preview ?? preview;
  const mark: BestieMark | undefined = agent
    ? {
        label: agent.managedName ?? agent.name,
        detail: "Bestie",
        avatar: { src: avatar, shape: "squircle" },
      }
    : active &&
        savedState.read &&
        !savedState.error &&
        !saved &&
        choices.complete &&
        ["ready", "unavailable"].includes(choices.archives.status) &&
        !choices.archives.error &&
        !choices.error
      ? {
          label: "Create an agent",
          detail: "Bestie",
          placeholder: true,
        }
      : undefined;
  return (
    <BestieNavigationContext value={mark}>
      <BestieConversationContext
        value={channel ? { session, channelId: channel.id } : undefined}
      >
        {children}
      </BestieConversationContext>
    </BestieNavigationContext>
  );
}

export function BestieUnreadBadge({ pageKey }: { pageKey: string }) {
  const conversation = useContext(BestieConversationContext);
  if (pageKey !== BESTIE_PAGE || !conversation) return null;
  return (
    <span className={styles.badge} data-channel-indicators="">
      <span className={channelStyles.indicatorLayer}>
        <UnreadBadge
          session={conversation.session}
          channelId={conversation.channelId}
          dm
        />
      </span>
    </span>
  );
}

/** Decorate Bestie's navigation and search destination with its exact choice. */
export function usePagePresentation() {
  const bestie = useContext(BestieNavigationContext);
  return (page: RegisteredPage) => ({
    ...pagePresentation(page),
    ...(page.key === BESTIE_PAGE ? bestie : undefined),
  });
}
