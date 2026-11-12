import { readView, subscribeView, viewRevision } from "../../shared/view-state";
import { useSoloRowActivation } from "./useSoloRowActivation";
import type { ComposeWorkspaces } from "./WorkspaceComposition";
import { useSoloNavigation } from "./solo-navigation-react";
import { regionDraftKey, soloNavigationFor } from "./solo-navigation";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import { useChannelNavigation } from "./ChannelNavigationState";
import { eligibleSolo } from "../solo/labels";
import { conversationTarget, soloDraft, soloDraftTarget } from "./routes";
import { ChannelActivityPopover } from "../../bundled/channels/ChannelActivityPopover";
import { useWorkingAgents } from "../../bundled/channels/useWorkingAgents";
import { WorkingAgentsBadge } from "../../bundled/channels/WorkingAgentsBadge";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import { useUnreadChannelIds } from "../../bundled/channels/useSidebarFilters";
import {
  SoloWorkspaces,
  type ChatListItem,
} from "../../bundled/channels/SoloWorkspaces";
import {
  soloSharedMarkId,
  useSharedWithPeople,
  useSoloOwner,
} from "../../bundled/channels/ChatSharedMark";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import { useRecoveryOwns } from "../relay/RecoveryNotice";
import { rosterRecovering } from "../relay/live-recovery";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { resetNewChatProject } from "../solo/SoloDraft";
import { NewWorkspace } from "../solo/NewWorkspace";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import creationStyles from "./SoloInventory.module.css";
import {
  DotsThreeIcon,
  ChatCircleIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { ContributionReader } from "../conversation/contracts";
import type { ChatIcon, ChatMenu } from "../conversation/service";
import type {
  RegisteredSidebarRows,
  SidebarRows,
} from "./sidebar-rows-service";
import channelStyles from "../../bundled/channels/Channels.module.css";
import styles from "../../bundled/channels/SoloWorkspaces.module.css";

const noSubscription = () => () => {};
const emptyRows: readonly RegisteredSidebarRows[] = [];
const noSidebarRows = () => emptyRows;
const chatIcon = (
  <span className={styles.conversationIcon} aria-hidden="true">
    <ChatCircleIcon size={16} />
  </span>
);

/** Solo projects and conversations: the owner's private filing of ordinary channels. */
export function SoloInventory({
  session,
  scope,
  navigator,
  target,
  chatIcons,
  chatMenus,
  sidebarRows,
  renderContents,
}: {
  session: RelaySession;
  scope: string;
  navigator: Navigation;
  target: OpenTarget;
  /** Plugin icons that can stand in for a chat's own. */
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  sidebarRows?: SidebarRows | undefined;
  /** Places the conversations in a host that titles them; creation then
   * belongs to the host's own New menu, so only the standalone header has it. */
  renderContents?: (
    content: ReactNode,
    header: ReactNode,
    pendingClick: RefObject<ReturnType<typeof setTimeout> | undefined>,
    compose: (composition: ComposeWorkspaces) => ReactNode,
  ) => ReactNode;
}) {
  const list = useChannelList(session.channels);
  const regions = useSoloNavigation(session);
  const pendingClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const preferences = useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const rosterRecovers = useRecoveryOwns(session, (live) =>
    rosterRecovering(live.roster),
  );
  const selected =
    target.kind === "conversation" ? target.channelId : undefined;
  const draft =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    target.pageId === "channels"
      ? soloDraft(target.route?.params)
      : undefined;
  // A lead draft leads only while it still targets the workspace it opened in.
  const leadKey =
    draft?.lead && draft.region && draft.project
      ? `${regionDraftKey(draft.region, draft.project)}:new-project`
      : undefined;
  const subscribeDraft = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  useSyncExternalStore(subscribeDraft, () =>
    leadKey ? viewRevision(scope, leadKey) : null,
  );
  const leadDraft =
    leadKey && readView(scope, leadKey, draft?.project) === draft?.project
      ? draft?.project
      : undefined;
  const handoff = useChannelNavigation();
  const workingIds = useSyncExternalStore(
    session.agentActivity.subscribeWorking,
    session.agentActivity.workingSnapshot,
    session.agentActivity.workingSnapshot,
  );
  const ChatIcon = useSyncExternalStore(
    chatIcons?.subscribe ?? noSubscription,
    () => chatIcons?.snapshot()[0]?.component,
  );
  const menus = useSyncExternalStore(
    chatMenus?.subscribe ?? noSubscription,
    () => chatMenus?.snapshot(),
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const rowEntries = useSyncExternalStore(
    sidebarRows?.subscribe ?? noSubscription,
    sidebarRows?.snapshot ?? noSidebarRows,
    sidebarRows?.snapshot ?? noSidebarRows,
  );
  const open = useCallback(
    (channelId: string) => navigator.open(conversationTarget(scope, channelId)),
    [navigator, scope],
  );
  const openMessage = useCallback(
    (channelId: string, messageId?: string) => {
      if (handoff && handoff.session !== session) return;
      const destination =
        messageId && session.viewer
          ? buzzLinkTarget(
              `buzz://message?channel=${channelId}&id=${messageId}`,
              {
                viewer: session.viewer,
                communityOrigin: scope.slice(0, -(session.viewer.length + 1)),
              },
            )
          : conversationTarget(scope, channelId);
      if (destination) void navigator.open(destination);
    },
    [handoff, session, navigator, scope],
  );
  const openAgentActivity = useCallback(
    (channelId: string, agent: string) => {
      if (!handoff || handoff.session !== session) return;
      const intent = {
        channelId,
        agent,
        trigger: document.querySelector<HTMLElement>(
          `[data-solo-channel-id="${CSS.escape(channelId)}"]`,
        ),
        // A Solo chat is one conversation, so its transcript is known.
        transcript: {},
      };
      handoff.activityAgent.current = intent;
      void open(channelId).then(() => {
        if (handoff.activityAgent.current === intent)
          handoff.activityAgent.current = undefined;
      });
    },
    [handoff, session, open],
  );
  const renderChat = useCallback(
    (
      item: ChatListItem,
      rename: (() => boolean) | undefined,
      channel: ChannelSummary | undefined,
    ) => (
      <SoloConversationRow
        key={item.id}
        session={session}
        navigation={navigator}
        pendingClick={pendingClick}
        id={item.id}
        channel={channel}
        title={item.title}
        selected={selected === item.id}
        working={workingChannels.has(item.id)}
        Icon={ChatIcon}
        onSelect={() => void open(item.id)}
        onRename={rename}
        onOpenThread={(thread) => openMessage(thread.channelId, thread.rootId)}
        onOpenMention={(mention) =>
          openMessage(mention.channelId, mention.messageId)
        }
        onOpenWorkingAgent={(id, _agent, messageId) => {
          if (messageId) openMessage(id, messageId);
          else void open(id);
        }}
        onOpenAgentActivity={openAgentActivity}
      />
    ),
    [
      session,
      navigator,
      selected,
      workingChannels,
      ChatIcon,
      open,
      openMessage,
      openAgentActivity,
    ],
  );
  const renderChatMenu = useCallback(
    (channelId: string) =>
      menus?.map(({ key, component: Menu }) => (
        <Menu key={key} session={session} channelId={channelId} />
      )),
    [menus, session],
  );
  const conversations = list.channels
    // Solo chats the viewer belongs to: their own and those shared with them.
    // Opening one from a link without membership adds nothing here.
    .filter(
      (item) =>
        eligibleSolo(item, session.viewer) && !regions.excluded.has(item.id),
    )
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
          (a.lastActivityAt ?? a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  // Capped workspaces never hide the open chat or one that needs the viewer.
  const unreadChats = useUnreadChannelIds(
    session.unread,
    JSON.stringify(conversations.map((item) => item.id)),
  );
  const composing = !!regions.regions.find((region) => region.source)?.source
    ?.composeWorkspaces;
  const empty =
    list.status === "ready" &&
    preferences.status === "ready" &&
    !conversations.length &&
    !preferences.data?.sections.length;
  const current = () => !handoff || handoff.session === session;
  const newChat = (project?: string) => {
    if (!current()) return;
    if (project) resetNewChatProject(scope, project);
    void navigator.open(soloDraftTarget(scope, project ? { project } : {}));
  };
  const creationItems = (
    <>
      {!composing && <MenuItem onClick={() => newChat()}>New chat</MenuItem>}
      <MenuItem
        disabled={!session.soloPreferences.sectionCreationWritable}
        onClick={() => {
          if (current()) setCreatingProject(true);
        }}
      >
        New workspace
      </MenuItem>
    </>
  );
  const actions = (
    <div className={creationStyles.actions}>
      <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <IconButton
              ref={trigger}
              size="compact"
              aria-label={
                composing ? "Workspace actions" : "New chat or workspace"
              }
              title={composing ? "Workspace actions" : "New chat or workspace"}
              icon={
                composing ? (
                  <DotsThreeIcon size={15} strokeWidth={2.5} />
                ) : (
                  <PlusIcon size={15} strokeWidth={2.5} />
                )
              }
            />
          }
        />
        <MenuPopup align="end">{creationItems}</MenuPopup>
      </MenuRoot>
    </div>
  );
  const header = (
    <div
      className={creationStyles.header}
      data-actions-visible={menuOpen || undefined}
    >
      <InlineHeader
        title={
          <span className="text-standard" data-solo-heading="" tabIndex={-1}>
            Solo
          </span>
        }
        actions={actions}
      />
    </div>
  );
  const content = (compose?: ComposeWorkspaces) => (
    <>
      {!compose && empty && (
        <NavigationItem
          variant="row"
          label="New chat"
          icon={<PlusIcon size={16} />}
          onClick={() => newChat()}
        />
      )}
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
          onCreated={async (id) => {
            if (!current() || !trigger.current?.isConnected) return;
            if (await soloNavigationFor(session)?.openCreatedWorkspace(id))
              return;
            if (trigger.current?.isConnected) newChat(id);
          }}
        />
      )}
      <SoloWorkspaces
        sidebarRows={rowEntries}
        compose={
          compose &&
          ((parts) =>
            compose({
              ...parts,
              ...(leadDraft ? { leadDraft } : {}),
            }))
        }
        renderChatMenu={renderChatMenu}
        navigator={navigator}
        draft={
          draft && !draft.region
            ? {
                projectId: draft.project,
                content: (
                  <NavigationItem
                    label="New chat"
                    selected
                    icon={
                      <span
                        className={styles.conversationIcon}
                        aria-hidden="true"
                      >
                        <ChatCircleIcon size={16} />
                      </span>
                    }
                    onClick={() => void navigator.open(target)}
                  />
                ),
              }
            : undefined
        }
        visit={navigator.snapshot().attempt.signal}
        session={session}
        scope={scope}
        onConverted={(channelId) => {
          if (handoff && handoff.session !== session) return;
          void open(channelId).then((result) => {
            if (result.status !== "opened") return;
            document
              .querySelector<HTMLElement>(
                `[data-channel-workspace="${CSS.escape(channelId)}"] form [role="textbox"]`,
              )
              ?.focus({ preventScroll: true });
          });
        }}
        chats={conversations.map((item) => ({
          id: item.id,
          title: item.name,
          pinned:
            selected === item.id ||
            workingChannels.has(item.id) ||
            unreadChats.has(item.id),
        }))}
        onNew={newChat}
        renderChat={renderChat}
      />
      {list.status === "loading" && <p role="status">Loading conversations…</p>}
      {list.status === "error" && !rosterRecovers && (
        <p role="alert">{list.error}</p>
      )}
    </>
  );
  return (
    <nav
      className={styles.sidebarContents}
      aria-label={`${regions.regions.find((region) => region.source)?.title ?? "Solo"} conversations`}
    >
      {renderContents ? (
        renderContents(content(), header, pendingClick, content)
      ) : (
        <>
          {header}
          {content()}
        </>
      )}
    </nav>
  );
}

function SoloConversationRow({
  session,
  navigation,
  pendingClick,
  id,
  channel,
  title,
  selected,
  working,
  Icon,
  onSelect,
  onRename,
  onOpenThread,
  onOpenMention,
  onOpenWorkingAgent,
  onOpenAgentActivity,
}: {
  session: RelaySession;
  navigation: Navigation;
  pendingClick: RefObject<ReturnType<typeof setTimeout> | undefined>;
  id: string;
  channel: ChannelSummary | undefined;
  title: string;
  selected: boolean;
  working: boolean;
  Icon?: ChatIcon["component"] | undefined;
  onSelect: () => void;
  onRename: (() => boolean) | undefined;
} & Pick<
  ComponentProps<typeof ChannelActivityPopover>,
  | "onOpenThread"
  | "onOpenMention"
  | "onOpenWorkingAgent"
  | "onOpenAgentActivity"
>) {
  const selectRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = selectRef.current;
    if (!button) return;
    const document = button.ownerDocument;
    const sidebar = button.closest("nav");
    const panel = button.closest<HTMLElement>("[data-solo-project]");
    return () => {
      if (document.activeElement !== button) return;
      const rows = [
        ...(panel?.querySelectorAll<HTMLElement>(
          "button[data-solo-channel-id]",
        ) ?? []),
      ];
      const index = rows.indexOf(button);
      const neighbors = [
        ...rows.slice(index + 1),
        ...rows.slice(0, index).reverse(),
      ].map((row) => row.dataset.soloChannelId ?? "");
      // Decorations can remount every row. Resolve surviving buttons after the
      // commit, but never take focus back from another control or a new editor.
      queueMicrotask(() => {
        if (
          (document.activeElement !== document.body &&
            document.activeElement !== button) ||
          (button.isConnected && !button.closest("[hidden], [inert]")) ||
          !sidebar?.isConnected
        )
          return;
        const find = (id: string) =>
          sidebar.querySelector<HTMLElement>(
            `button[data-solo-channel-id="${CSS.escape(id)}"]`,
          );
        const candidates = [
          find(id),
          ...neighbors.map(find),
          sidebar.querySelector<HTMLElement>(
            `[data-solo-menu-id="project-${CSS.escape(panel?.dataset.soloProject ?? "")}"] button`,
          ),
        ];
        for (const candidate of candidates) {
          if (!candidate?.isConnected || candidate.closest("[hidden], [inert]"))
            continue;
          candidate.focus({ preventScroll: true });
          if (document.activeElement === candidate) break;
        }
      });
    };
  }, [id]);
  const activation = useSoloRowActivation(
    navigation,
    pendingClick,
    onSelect,
    onRename,
  );
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    id,
    working,
  );
  // Describe only by a mark that renders, using the same Shared evidence.
  const owner = useSoloOwner(session, channel);
  const shared = useSharedWithPeople(session, channel) || !!owner;
  return (
    <ChannelActivityPopover
      session={session}
      channelId={id}
      channelName={title}
      agents={agents}
      agentProfiles={agentProfiles}
      onOpenThread={onOpenThread}
      onOpenMention={onOpenMention}
      {...(onOpenWorkingAgent ? { onOpenWorkingAgent } : {})}
      {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
      trigger={
        <NavigationItem
          ref={selectRef}
          type="button"
          selected={selected}
          data-solo-channel-id={id}
          aria-current={selected ? "page" : undefined}
          aria-describedby={shared ? soloSharedMarkId(id) : undefined}
          {...activation}
          icon={
            Icon ? (
              <Icon session={session} channelId={id} fallback={chatIcon} />
            ) : (
              chatIcon
            )
          }
          label={
            <span className={styles.chatRow}>
              <UnreadBadge
                session={session}
                channelId={id}
                label={title}
                labelUnread="all"
              />
            </span>
          }
          trailing={
            <span
              className={channelStyles.indicatorStack}
              data-solo-working-indicator=""
            >
              <WorkingAgentsBadge
                agents={agents}
                profiles={agentProfiles}
                channelName={title}
                waiting={waiting}
              />
            </span>
          }
        />
      }
    />
  );
}
