import type { ChatIcon } from "../../features/conversation/service";
import type { Navigation } from "../../features/navigation/controller";
import { UserStatusDisplay } from "../../features/user-status/StatusDisplay";
import { useIsPresent } from "motion/react";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useLiveChannelSummary } from "../../features/relay/react";
import {
  ClockIcon,
  DotsThreeIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { channelDurationLabel } from "./ChannelDurationField";
import { ChatSharedMark, soloSharedMarkId } from "./ChatSharedMark";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { DmTypingBadge } from "./DmTypingBadge";
import { usePresenceStatus } from "../../features/presence/react";
import { UnreadBadge, ordinaryUnread, useConfirmedMute } from "./UnreadBadge";
import { SoloChatTitle } from "../../features/solo/SoloChatTitle";
import { useWorkingAgents } from "./useWorkingAgents";
import { WorkingAgentsBadge } from "./WorkingAgentsBadge";
import styles from "./Channels.module.css";
import { SidebarRowRenderer } from "../../features/channel-navigation/SidebarRowRenderer";
import { TeamRowChannelGroup } from "../../features/channel-navigation/RegionChannelGroup";
import { ContributionBoundary } from "../../features/conversation/ContributionBoundary";
import {
  sidebarRow,
  type RegisteredSidebarRows,
} from "../../features/channel-navigation/sidebar-rows-service";
import { avatarMedia } from "../../shared/avatar-source";
import { sidebarRowKind, type SidebarRowKind } from "./sidebar-sections";

type ItemProps = {
  chatIcon?: ChatIcon["component"] | undefined;
  rowContributions?: readonly RegisteredSidebarRows[] | undefined;
  onHiddenChange?: ((id: string, hidden: boolean) => () => void) | undefined;
  channel: ChannelSummary;
  profile?: Profile | undefined;
  session: RelaySession;
  working: boolean;
  selected: string | undefined;
  onSelect: (id: string) => void;
  navigation?: Navigation | undefined;
  onRename?: ((id: string) => boolean) | undefined;
  pendingClick?:
    | RefObject<ReturnType<typeof setTimeout> | undefined>
    | undefined;
  onShareChat?:
    | ((channel: ChannelSummary, trigger: HTMLElement) => void)
    | undefined;
  onOpenThread: (channelId: string, rootId: string) => void;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenWorkingAgent?: (
    channelId: string,
    agent: string,
    messageId: string | undefined,
  ) => void;
  onOpenAgentActivity?: (
    channelId: string,
    agent: string,
    messageId: string | undefined,
  ) => void;
  onHideDm?: (id: string) => void;
  menuEnabled?: boolean;
  sectionKey?: string | undefined;
  /** Frames the select surface alone, like the context menu. */
  selectFrame?:
    | ComponentType<{
        channelId: string;
        sectionKey: string;
        rowKind: SidebarRowKind;
        children: ReactNode;
      }>
    | undefined;
  onOpenMenu?: (
    channel: ChannelSummary,
    sectionKey: string,
    anchor?: HTMLElement,
  ) => void;
  menuOpen?: boolean;
  menuAnchor?: HTMLElement | undefined;
  /** Only the open row receives content, so closed rows keep equal props. */
  menuContent?: ReactNode;
  onCloseMenu?: () => void;
  onMenuClosed?: (channelId: string) => void;
  menuFinalFocus?: (channelId: string) => HTMLElement | false;
};

// Keep the row mounted as activity starts and stops; only its subscriptions change.
export const ChannelSidebarItem = memo(function ChannelSidebarItem(
  props: ItemProps,
) {
  const { channel, session, working } = props;
  const muted = useConfirmedMute(session, channel.id);
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    channel.id,
    working,
  );
  const ordinary = useOrdinaryUnread(
    session,
    channel.id,
    channel.channelType === "dm",
    muted,
  );
  return (
    <ChannelSidebarItemCore
      {...props}
      agents={agents}
      agentProfiles={agentProfiles}
      waiting={waiting}
      ordinary={ordinary}
      muted={muted}
    />
  );
});

/** Only the boolean the row styles on; counts and thread activity stay in the badge. */
function useOrdinaryUnread(
  session: RelaySession,
  channelId: string,
  dm: boolean,
  muted: boolean,
) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => ordinaryUnread(session.unread.snapshot(target), dm, muted),
    [session, target, dm, muted],
  );
  return useSyncExternalStore(subscribe, get, get);
}

function ChannelSidebarItemCore({
  rowContributions,
  chatIcon: ChatIconComponent,
  onHiddenChange,
  channel,
  profile,
  session,
  selected,
  onSelect,
  navigation,
  onRename,
  pendingClick,
  onShareChat,
  onOpenThread,
  onOpenMessage,
  onOpenWorkingAgent,
  onOpenAgentActivity,
  onHideDm,
  menuEnabled,
  sectionKey,
  selectFrame: SelectFrame,
  onOpenMenu,
  menuOpen = false,
  menuAnchor,
  menuContent,
  onCloseMenu,
  onMenuClosed,
  menuFinalFocus,
  agents,
  agentProfiles,
  waiting,
  ordinary,
  muted,
}: ItemProps & {
  waiting: boolean;
  agents: readonly string[];
  agentProfiles: ReadonlyMap<string, Profile>;
  ordinary: boolean;
  muted: boolean;
}) {
  const present = useIsPresent();
  const peer =
    channel.channelType === "dm" && channel.participants?.length === 1
      ? channel.participants[0]
      : undefined;
  const presence = usePresenceStatus(peer ? session.presence : undefined, peer);
  const actions = useRef<HTMLButtonElement>(null);
  const actionsOpen = !!menuAnchor && menuAnchor === actions.current;
  const menuLabel = `Actions for ${channel.name}`;
  // Keep the closing row's items through the popup's exit transition.
  const lastMenuContent = useRef<ReactNode>(undefined);
  useLayoutEffect(() => {
    if (menuContent !== undefined) lastMenuContent.current = menuContent;
  }, [menuContent]);
  const Icon = channelIcon(channel);
  const plainRow = (
    <ChannelSidebarRow
      channel={channel}
      title={
        channel.channelType === "solo" ? (
          // Incoming renames animate; a rename saved here shows at once.
          <SoloChatTitle
            key={channel.id}
            channelId={channel.id}
            title={channel.name}
            details={session.channelDetails}
          />
        ) : undefined
      }
      menuAction={
        menuEnabled &&
        channel.channelType === "solo" && (
          <MenuRoot
            open={menuOpen && present && actionsOpen}
            onOpenChange={(open) => {
              if (open && sectionKey && actions.current)
                onOpenMenu?.(channel, sectionKey, actions.current);
              else if (!open && actionsOpen) onCloseMenu?.();
            }}
            onOpenChangeComplete={(open) => {
              if (!open) onMenuClosed?.(channel.id);
            }}
          >
            <MenuTrigger
              ref={actions}
              render={(props) => (
                <IconButton
                  {...props}
                  variant="bare"
                  size="compact"
                  aria-label={menuLabel}
                  data-solo-row-action=""
                  icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
                />
              )}
            />
            <MenuPopup
              align="end"
              aria-label={menuLabel}
              finalFocus={() => menuFinalFocus?.(channel.id) ?? false}
            >
              {menuContent ?? lastMenuContent.current}
            </MenuPopup>
          </MenuRoot>
        )
      }
      sharedDescription={
        onShareChat && channel.channelType === "solo"
          ? soloSharedMarkId(channel.id)
          : undefined
      }
      sharedAction={
        onShareChat &&
        channel.channelType === "solo" && (
          <ChatSharedMark
            session={session}
            channel={channel}
            onOpen={(trigger) => onShareChat(channel, trigger)}
          />
        )
      }
      working={agents.length > 0}
      ordinary={ordinary}
      muted={muted}
      dmVisualSpacing={channel.channelType === "dm"}
      icon={
        channel.channelType === "dm" ? (
          <DmTypingBadge
            session={session}
            channelId={channel.id}
            agents={agents}
          >
            {channel.participants?.length === 1 ? (
              <span className={styles.dmAvatar} data-dm-identity="">
                <Avatar
                  src={avatarMedia(profile?.picture, session.media)}
                  alt=""
                  fallback={channel.name}
                  size="fill"
                  shape={profile?.isAgent ? "squircle" : "circle"}
                  statusBadge={presence === "unknown" ? undefined : presence}
                />
              </span>
            ) : (channel.participants?.length ?? 0) > 1 ? (
              <span
                className={styles.dmCount}
                data-dm-identity=""
                data-dm-participant-count=""
                title={`${channel.participants?.length} other participants`}
                aria-hidden="true"
              >
                {channel.participants?.length}
              </span>
            ) : (
              <Icon size={16} />
            )}
          </DmTypingBadge>
        ) : ChatIconComponent ? (
          <ContributionBoundary fallback={<Icon size={16} />}>
            <ChatIconComponent
              session={session}
              channelId={channel.id}
              fallback={<Icon size={16} />}
            />
          </ContributionBoundary>
        ) : (
          <Icon size={16} />
        )
      }
      nameAccessory={
        channel.channelType === "dm" &&
        channel.participants?.length === 1 && (
          <UserStatusDisplay
            session={session}
            userId={channel.participants[0] ?? ""}
            compact
            focusable={false}
          />
        )
      }
      badge={
        <>
          <span className={styles.indicatorStack} data-channel-indicators="">
            <span className={styles.indicatorLayer}>
              <UnreadBadge
                session={session}
                channelId={channel.id}
                dm={channel.channelType === "dm"}
              />
            </span>
            <WorkingAgentsBadge
              agents={agents}
              profiles={agentProfiles}
              channelName={channel.name}
              waiting={waiting}
            />
          </span>
          {channel.ttlSeconds !== undefined && agents.length === 0 && (
            <TemporaryMarker ttlSeconds={channel.ttlSeconds} />
          )}
        </>
      }
      wrapSelect={(trigger) => {
        const activity = (
          <ChannelActivityPopover
            session={session}
            channelId={channel.id}
            channelName={channel.name}
            agents={agents}
            agentProfiles={agentProfiles}
            {...(onOpenWorkingAgent ? { onOpenWorkingAgent } : {})}
            {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
            onOpenThread={(item) => onOpenThread(item.channelId, item.rootId)}
            onOpenMention={(item) =>
              onOpenMessage(item.channelId, item.messageId)
            }
            trigger={trigger}
          />
        );
        // Keep popup semantics on separate DOM nodes: activity owns the button,
        // the context menu wraps only its select surface.
        const select = menuEnabled ? (
          <ContextMenuTrigger
            render={<div />}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                if (sectionKey)
                  onOpenMenu?.(channel, sectionKey, event.currentTarget);
              }
            }}
          >
            {activity}
          </ContextMenuTrigger>
        ) : (
          activity
        );
        return SelectFrame && sectionKey ? (
          <SelectFrame
            channelId={channel.id}
            sectionKey={sectionKey}
            rowKind={sidebarRowKind(channel)}
          >
            {select}
          </SelectFrame>
        ) : (
          select
        );
      }}
      selected={selected}
      presenceDescription={
        presence === "unknown" ? undefined : `Presence: ${presence}`
      }
      onPrepare={(id) => session.channels.prepare?.(id)}
      onSelect={onSelect}
      navigation={navigation}
      onRename={onRename}
      {...(pendingClick ? { pendingClick } : {})}
      {...(onHideDm ? { onHideDm } : {})}
    />
  );
  // Part of the host row: contributions wrap or hide the group with it.
  const row =
    sectionKey &&
    (channel.channelType === "stream" || channel.channelType === "forum") ? (
      <TeamRowChannelGroup session={session} channelId={channel.id}>
        {plainRow}
      </TeamRowChannelGroup>
    ) : (
      plainRow
    );
  const rendered =
    sectionKey && rowContributions ? (
      <ContributionBoundary fallback={row} resetIdentity={rowContributions}>
        <ContributedChannelRow
          channel={channel}
          sectionKey={sectionKey}
          session={session}
          entries={rowContributions}
          onHiddenChange={onHiddenChange}
        >
          {row}
        </ContributedChannelRow>
      </ContributionBoundary>
    ) : (
      row
    );
  if (!menuEnabled) return rendered;
  return (
    <ContextMenuRoot
      open={menuOpen && present && !actionsOpen}
      onOpenChange={(open) => {
        if (open) {
          if (sectionKey) onOpenMenu?.(channel, sectionKey);
        } else if (menuOpen) onCloseMenu?.();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          lastMenuContent.current = undefined;
          onMenuClosed?.(channel.id);
        }
      }}
    >
      {rendered}
      <MenuPopup
        aria-label={menuLabel}
        anchor={menuOpen ? menuAnchor : undefined}
        finalFocus={() => menuFinalFocus?.(channel.id) ?? false}
      >
        {menuContent ?? lastMenuContent.current}
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function ContributedChannelRow({
  channel,
  sectionKey,
  session,
  entries,
  children,
  onHiddenChange,
}: {
  channel: ChannelSummary;
  sectionKey: string;
  session: RelaySession;
  entries: readonly RegisteredSidebarRows[];
  children: ReactElement;
  onHiddenChange?: ((id: string, hidden: boolean) => () => void) | undefined;
}) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId: channel.id }),
    [channel.id],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const snapshot = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const unread = useSyncExternalStore(subscribe, snapshot, snapshot);
  const live = useLiveChannelSummary(session.channels, channel);
  const pluginSection =
    channel.channelType === "solo"
      ? sectionKey.startsWith("group:")
        ? sectionKey.slice(6)
        : ""
      : sectionKey;
  const row = useMemo(
    () => sidebarRow(live, pluginSection, unread),
    [live, pluginSection, unread],
  );
  return (
    <SidebarRowRenderer
      row={row}
      entries={entries}
      onHiddenChange={onHiddenChange}
    >
      {children}
    </SidebarRowRenderer>
  );
}

/** Quiet lifetime metadata; the working badge takes the trailing slot while agents work. */
function TemporaryMarker({ ttlSeconds }: { ttlSeconds: number }) {
  const label = `Temporary channel. Cleans up after ${channelDurationLabel(ttlSeconds)} without activity.`;
  return (
    <span
      className={styles.temporaryMarker}
      data-channel-temporary=""
      role="img"
      aria-label={label}
      title={label}
    >
      <ClockIcon size={16} />
    </span>
  );
}
