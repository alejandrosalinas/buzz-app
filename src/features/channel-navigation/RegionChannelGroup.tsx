import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChannelHeaderMenu } from "../../bundled/channels/ChannelHeaderMenu";
import { canStartLinkedChat } from "../../bundled/channels/StartLinkedChat";
import { channelTabs } from "../../bundled/channels/useChannelTabState";
import { channelIcon } from "../channels/channel-icon";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { NavigationSectionHeading } from "../../shared/design-system/ui/NavigationSection";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { SoloChannelGroupProps } from "./solo-navigation-contract";
import { RegionDestinationContext } from "./SoloDestination";
import { SoloDisclosure } from "./SoloDisclosure";
import { conversationTarget, matchesConversation } from "./routes";
import styles from "./RegionChannelGroup.module.css";

const ChannelGroupsContext = createContext<ReadonlyMap<string, ChannelSummary>>(
  new Map(),
);

/** One local roster lookup shared by every group; mounting groups starts no reads. */
export function RegionChannelGroups({
  session,
  children,
}: {
  session: RelaySession;
  children: ReactNode;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = useMemo(
    () => new Map(list.channels.map((channel) => [channel.id, channel])),
    [list],
  );
  return (
    <ChannelGroupsContext value={channels}>{children}</ChannelGroupsContext>
  );
}

export function RegionChannelGroup(props: SoloChannelGroupProps) {
  const context = useContext(RegionDestinationContext);
  const channels = useContext(ChannelGroupsContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const channel = channels.get(props.channelId);
  const eligible = (item: ChannelSummary | undefined) =>
    !!(
      context?.active() &&
      context.session.viewer &&
      item &&
      (item.channelType === "stream" || item.channelType === "forum") &&
      item.members?.includes(context.session.viewer)
    );
  if (!context || !eligible(channel) || !channel) return null;
  const { session, navigator, scope, active } = context;
  const current = () =>
    session.channels
      .list()
      .channels.find((item) => item.id === props.channelId);
  const newTask =
    props.onNewTask && canStartLinkedChat(session, channel)
      ? () => {
          const latest = current();
          if (eligible(latest) && latest && canStartLinkedChat(session, latest))
            props.onNewTask?.();
        }
      : undefined;
  const Icon = channelIcon(channel);
  const openDetails = async () => {
    if (!eligible(current())) return;
    const opening = navigator.open(conversationTarget(scope, channel.id), {
      sidebar: "preserve",
    });
    const attempt = navigator.snapshot().attempt;
    const result = await opening;
    if (
      result.status !== "opened" ||
      attempt.signal.aborted ||
      !active() ||
      !eligible(current()) ||
      !matchesConversation(navigator.snapshot().entry.target, scope, channel.id)
    )
      return;
    channelTabs(session).openSettings(channel.id, attempt.id);
  };
  return (
    <div className={styles.group} data-solo-channel-group={channel.id}>
      <NavigationCard
        tone="tonal"
        body={
          <div id={props.controls} hidden={!props.expanded}>
            {props.children}
          </div>
        }
      >
        <NavigationSectionHeading
          disclosure
          revealActions
          actions={
            <>
              {newTask && (
                <IconButton
                  size="compact"
                  data-solo-channel-new-task=""
                  aria-label={`New task in ${channel.name}`}
                  title="New task"
                  icon={<PencilSimpleIcon size={15} />}
                  onClick={newTask}
                />
              )}
              <ChannelHeaderMenu
                channel={channel}
                session={session}
                trigger={trigger}
                size="compact"
                label={`Actions for ${channel.name}`}
                openDetails={() => void openDetails()}
                startChat={
                  newTask && <MenuItem onClick={newTask}>New task</MenuItem>
                }
              />
            </>
          }
        >
          <div className={styles.heading}>
            <NavigationItem
              label={channel.name}
              title={channel.name}
              icon={<Icon size={14} />}
              selected={!!props.selected}
              onClick={() => {
                if (eligible(current())) props.onSelect();
              }}
            />
            <SoloDisclosure
              label={props.disclosureLabel}
              summary=""
              expanded={props.expanded}
              controls={props.controls}
              onToggle={() => {
                if (eligible(current())) props.onToggle();
              }}
            />
          </div>
        </NavigationSectionHeading>
      </NavigationCard>
    </div>
  );
}
