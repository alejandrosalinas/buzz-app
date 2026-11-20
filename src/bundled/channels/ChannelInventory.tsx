import { workspaceMessageTarget } from "../../features/channel-navigation/new-message-route";
import { WorkspaceNewMenu } from "./WorkspaceNewMenu";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { visibleSoloRegions } from "./SoloRegions";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";
import type { ContributionReader } from "../../features/conversation/contracts";
import { SoloChatMenuItems } from "./SoloChatMenu";
import { SoloChatName } from "./SoloChatName";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { ConvertToChannel } from "../../features/solo/ConvertToChannel";
import { useChatConversions } from "../../features/solo/conversion";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { TeamSidebarSections, TeamSidebarSection } from "./TeamSidebarSource";
import type { WorkspaceSidebarComposition } from "./sidebar-environment";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import {
  newMessage,
  openEmptyChannels,
  resumeSoloDraftTarget,
  soloDraft,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ComponentProps,
  type RefObject,
} from "react";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { lifecycleNoun } from "./ChannelLifecycleDialog";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import { prepareSoloMove } from "../../features/channel-navigation/solo-navigation";
import { eligibleSolo } from "../../features/solo/labels";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import {
  resetNewChatProject,
  soloDraftInput,
} from "../../features/solo/SoloDraft";
import {
  hasSoloDraft,
  useSoloDraftProjects,
} from "../../features/solo/draft-projects";
import { SpringLoadedNavigationItem } from "../../features/channel-navigation/SpringLoadedNavigationItem";
import { workspaceSectionOrder } from "../../features/relay/sidebar-preferences";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelRoster } from "../../features/relay/react";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSections,
} from "../../features/channel-navigation/sidebar-sections-service";
import {
  sidebarRow,
  sidebarRowSortModes,
  sortSidebarRows,
  type SidebarRows,
  type RegisteredSidebarRows,
} from "../../features/channel-navigation/sidebar-rows-service";
import { useSidebarRowUnread } from "../../features/channel-navigation/useSidebarRowUnread";
import type { SidebarSortMode } from "../../features/relay/sidebar-sort";
import type { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useChannelRowMenu } from "./useChannelRowMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useRecoveryOwns } from "../../features/relay/RecoveryNotice";
import { rosterRecovering } from "../../features/relay/live-recovery";
import { clientMetrics } from "../../features/developer/client-metrics";
import {
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  FolderSimpleIcon,
  MinusIcon,
  PencilSimpleIcon,
  PlusIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { ChannelReadMenuItem } from "./ChannelReadMenuItem";
import { ChannelCopyLinkMenuItem } from "./ChannelCopyLinkMenuItem";
import { ChannelSidebarItem } from "./ChannelSidebarItem";
import { ChannelSidebarRows } from "../../features/channel-navigation/ChannelSidebarRows";
import { activeChannelRows } from "../../features/channel-navigation/active-channel-rows";
import type { UnreadDmPreview } from "./SidebarUnread";
import {
  ChannelSidebarDnd,
  DraggableChannel,
  DroppableSidebarSection,
} from "../../features/channel-navigation/ChannelSidebarDnd";
import { channelIcon } from "../../features/channels/channel-icon";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import { useSidebarStartup } from "./useSidebarStartup";
import { useChannelLabels } from "./useChannelLabels";
import { useHiddenDms } from "./useHiddenDms";
import { resurfaceHiddenDms } from "../../features/relay/dm-resurfacing";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { useSidebarView } from "./useSidebarView";
import { useSidebarFilters, useUnreadChannelIds } from "./useSidebarFilters";
import {
  capSections,
  SECTION_ROW_STEP,
  sectionOverflowCandidates,
  useHoldOverflow,
  useSectionLimits,
} from "./sidebar-section-caps";
import { SectionShowMore } from "./SectionShowMore";
import {
  sidebarSections,
  contributedSidebarSectionKey,
  isChannelSectionKey,
  sidebarHome,
  sidebarDropRowKinds,
  orderContributedSidebarSections,
  recentAt,
} from "./sidebar-sections";
import { activityTranscript } from "./working-agents";
import { SidebarContributionSection } from "../../features/channel-navigation/SidebarContributionSection";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import {
  CreateChannelDialog,
  type CreateChannelInput,
} from "./CreateChannelDialog";
import { writeView } from "../../shared/view-state";
import { useChannelReadAction } from "./useChannelReadAction";
import {
  type ChannelMenuSurface,
  useChannelNavigation,
} from "../../features/channel-navigation/ChannelNavigationState";
import { splitPartition } from "../../features/relay/partition";
import styles from "./Channels.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { useBestieConversation } from "../../app/shell/bestie-context";

/** The sidebar entry selected by a destination, excluding nested message state. */
function sidebarEntryLocation(target: OpenTarget) {
  return target.kind === "conversation"
    ? `conversation:${target.channelId}`
    : target.kind === "page"
      ? `page:${target.pluginId}/${target.pageId}:${JSON.stringify(target.route?.params ?? null)}`
      : target.kind;
}

type Inventory = {
  sidebar: ReturnType<typeof useSidebarView>;
  workspaceComposition: WorkspaceSidebarComposition;
  dmPreviews: ReadonlyMap<string, UnreadDmPreview>;
  frame: Pick<ComponentProps<typeof SidebarFrame>, "busy" | "launchPending">;
  before: ReactNode;
  team(children: ReactNode): ReactNode;
  content: ReactNode;
  after: ReactNode;
  dialogs: ReactNode;
};

const noSubscription = () => () => {};
const emptyContributions: readonly RegisteredSidebarSection[] = [];
const noSidebarSections = () => emptyContributions;
const emptyRowContributions: readonly RegisteredSidebarRows[] = [];
const noSidebarRows = () => emptyRowContributions;
const noPendingPlugins = () => true;
const emptySidebarSections: SidebarSections = {
  version: 1,
  snapshot: noSidebarSections,
  subscribe: noSubscription,
  register: () => {},
};

/** Channel data, actions and notices; the primary sidebar owns their framing. */
export function ChannelInventory({
  relay,
  navigator,
  agents,
  target,
  queries,
  cached,
  chatsOnly = false,
  layoutReady = true,
  slotsReady,
  preserveSidebar = false,
  connectionError,
  scope,
  viewer,
  sidebarSections: contributedSections,
  sidebarRows: contributedRows,
  chatIcons,
  chatMenus,
  render,
}: {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  target: OpenTarget;
  queries: RelaySession;
  cached: boolean;
  chatsOnly?: boolean;
  /** Other inventories sharing this viewport must settle before restoring it. */
  layoutReady?: boolean;
  slotsReady?: ((ids: readonly string[]) => boolean) | undefined;
  preserveSidebar?: boolean;
  connectionError?: string | undefined;
  scope: string;
  viewer?: string | undefined;
  sidebarSections?: SidebarSections | undefined;
  sidebarRows?: SidebarRows | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  render(inventory: Inventory): ReactNode;
}) {
  const registeredSections = useSyncExternalStore(
    contributedSections?.subscribe ?? noSubscription,
    contributedSections?.snapshot ?? noSidebarSections,
    contributedSections?.snapshot ?? noSidebarSections,
  );
  const contributions = chatsOnly ? noSidebarSections() : registeredSections;
  const chatIcon = useSyncExternalStore(
    chatIcons?.subscribe ?? noSubscription,
    () => chatIcons?.snapshot()[0]?.component,
  );
  const chatMenuEntries = useSyncExternalStore(
    chatMenus?.subscribe ?? noSubscription,
    () => chatMenus?.snapshot(),
  );
  useChatConversions(queries);
  const rowContributions = useSyncExternalStore(
    contributedRows?.subscribe ?? noSubscription,
    contributedRows?.snapshot ?? noSidebarRows,
    contributedRows?.snapshot ?? noSidebarRows,
  );
  const rowSortModes = useMemo(
    () => sidebarRowSortModes(rowContributions),
    [rowContributions],
  );
  const pluginsSettled = useSyncExternalStore(
    contributedRows?.subscribe ?? noSubscription,
    contributedRows?.settled ?? noPendingPlugins,
    contributedRows?.settled ?? noPendingPlugins,
  );
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const sectionSort = useCallback(
    (key: string): SidebarSortMode => {
      const saved =
        preferences.data?.sort?.[
          key.startsWith("group:") ? `section:${key.slice(6)}` : key
        ];
      return saved &&
        (saved === "alpha" ||
          saved === "recent" ||
          rowSortModes.some((mode) => mode.id === saved))
        ? saved
        : key === "solo"
          ? "recent"
          : "alpha";
    },
    [preferences.data, rowSortModes],
  );
  const appliedSorts = Object.keys(preferences.data?.sort ?? {}).map((key) =>
    sectionSort(key.startsWith("section:") ? `group:${key.slice(8)}` : key),
  );
  const pluginSorted = appliedSorts.some(
    (mode) => mode !== "alpha" && mode !== "recent",
  );
  const activeFiltered = Object.values(
    preferences.data?.filters ?? {},
  ).includes("active");
  const needsActivity =
    pluginSorted || appliedSorts.includes("recent") || activeFiltered;
  const soloActivity = useCallback(
    (channel: ChannelSummary) => eligibleSolo(channel, viewer),
    [viewer],
  );
  const soloRecent = sectionSort("solo") === "recent";
  const list = useChannelRoster(queries.channels, {
    activity: needsActivity || (soloRecent && soloActivity),
    preview: pluginSorted,
    // Recent order is the only reader of activity then; most messages land in
    // a chat that already leads, so they leave the sidebar alone.
    ...(pluginSorted || activeFiltered ? {} : { rank: recentAt }),
  });
  // The session reads activity only for saved sorts; Solo's default needs it
  // too, but only while there are Solo chats to order.
  const soloOrdered = soloRecent && list.channels.some(soloActivity);
  useEffect(() => {
    if (soloOrdered) return queries.channels.demandActivity?.();
  }, [soloOrdered, queries.channels]);
  const rosterRecovers = useRecoveryOwns(queries, (live) =>
    rosterRecovering(live.roster),
  );
  const sortModesReady =
    pluginsSettled ||
    Object.values(preferences.data?.sort ?? {}).every(
      (mode) =>
        !mode.startsWith("plugin:") ||
        rowSortModes.some((available) => available.id === mode),
    );
  const startup = useSidebarStartup(queries, list, preferences, sortModesReady);
  const [activityErrorDismissed, setActivityErrorDismissed] = useState(false);
  useEffect(() => {
    if (list.activityStatus !== "error") setActivityErrorDismissed(false);
  }, [list.activityStatus]);
  const handoff = useChannelNavigation();
  // Stable refs: the whole handoff changes with every navigation state, and
  // row callbacks that depend on it would rerender every sidebar row.
  const activityThread = handoff?.activityThread;
  const activityAgent = handoff?.activityAgent;
  const mute = handoff?.session === queries ? handoff.mute : undefined;
  const readAction = useChannelReadAction();
  const readWrite = readAction.state;
  const [rowFocus, setRowFocus] = useState<string>();
  const pluginHiddenRows = useRef(new Map<string, object>());
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const hiddenDms = useHiddenDms(scope, queries, list);
  const promotedDm = useBestieConversation(queries);
  // Promotion is presentation, not hiding. Clear an earlier local removal so
  // releasing this destination restores the ordinary DM row.
  const showDm = hiddenDms.show;
  useEffect(() => {
    if (promotedDm) showDm([promotedDm]);
  }, [promotedDm, showDm]);
  const lifecycle = queries.channelLifecycle;
  const dmVisibility = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.snapshot,
    lifecycle.snapshot,
  );
  const visibilityRequest = useRef<AbortController | undefined>(undefined);
  // Roster commits join an in-flight refresh; only unmount or a new lifecycle
  // cancels it, so live discovery cannot restart its retry budget.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new lifecycle retires the previous refresh signal.
  useEffect(() => {
    const request = new AbortController();
    visibilityRequest.current = request;
    return () => request.abort();
  }, [lifecycle]);
  // A completed roster refresh also refreshes per-viewer visibility. One new
  // chat commits the roster several times; a recent read answers the repeats.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each roster commit is a trigger.
  useEffect(() => {
    if (list.status === "ready")
      void lifecycle.refreshVisibility(visibilityRequest.current?.signal, {
        ifStale: true,
      });
  }, [lifecycle, list.asOf, list.status]);
  // A confirmed open asks the relay to unhide its DM, so a recent read is out
  // of date.
  useEffect(
    () =>
      queries.directMessages.subscribeOpened(
        () =>
          void lifecycle.refreshVisibility(visibilityRequest.current?.signal, {
            trailing: true,
          }),
      ),
    [queries, lifecycle],
  );
  useEffect(
    () =>
      resurfaceHiddenDms(queries, viewer, visibilityRequest.current?.signal),
    [queries, viewer],
  );
  const lifecycleFocus = useRef<string | undefined>(undefined);
  const lifecycleTrigger = useRef<HTMLElement | undefined>(undefined);
  const { channels, profiles: dmProfiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const unreadDmPreviews = useMemo(() => {
    const previews = new Map<string, UnreadDmPreview>();
    for (const channel of channels) {
      if (channel.channelType !== "dm" || channel.participants?.length !== 1)
        continue;
      const profile = dmProfiles.get(channel.participants[0] ?? "");
      previews.set(channel.id, {
        name: channel.name,
        src: avatarMedia(profile?.picture, queries.media),
        isAgent: profile?.isAgent,
      });
    }
    return previews;
  }, [channels, dmProfiles, queries]);
  const workingIds = useSyncExternalStore(
    queries.agentActivity.subscribeWorking,
    queries.agentActivity.workingSnapshot,
    queries.agentActivity.workingSnapshot,
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const lifecycleDialog = handoff?.lifecycleDialog;
  const composingMessage =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    newMessage(target.route?.params) !== undefined;
  const preparingDm = composingMessage ? handoff?.preparingDm : undefined;
  const regions = useSoloNavigation(queries);
  const sidebarChannels = useMemo(
    () =>
      channels.filter(
        (channel) =>
          channel.id !== promotedDm &&
          !channel.huddle &&
          !channel.metadataPending &&
          (channel.channelType !== "solo" ||
            (eligibleSolo(channel, viewer) &&
              !regions.excluded.has(channel.id))) &&
          (!preparingDm ||
            preparingDm.existing.has(channel.id) ||
            channel.channelType !== "dm" ||
            channel.members?.length !== preparingDm.members.size ||
            !channel.members.every((member) =>
              preparingDm.members.has(member),
            )),
      ),
    [channels, preparingDm, promotedDm, regions.excluded, viewer],
  );
  const currentDraft =
    target.kind === "page" && target.pluginId === "buzz.channels"
      ? soloDraft(target.route?.params)
      : undefined;
  const draftProjects = useSoloDraftProjects(
    queries,
    scope,
    preferences.data?.sections.map(({ id }) => id) ?? [],
  );
  const drafts = draftProjects.map((id) =>
    soloDraftTarget(scope, id ? { project: id } : {}),
  );
  if (currentDraft && !currentDraft.region) {
    const index = currentDraft.linked
      ? -1
      : draftProjects.indexOf(currentDraft.project ?? "");
    if (index < 0) drafts.push(target);
    else drafts[index] = target;
  }
  const draftSections = new Set(
    draftProjects.map((id) => (id ? `group:${id}` : "solo")),
  );
  if (currentDraft && !currentDraft.region)
    draftSections.add(
      currentDraft.project ? `group:${currentDraft.project}` : "solo",
    );
  const activeDraftSections = JSON.stringify([...draftSections]);
  const [workspaceFrames, setWorkspaceFrames] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const registerWorkspaceFrame = useCallback((key: string) => {
    setWorkspaceFrames((previous) => new Set([...previous, key]));
    return () =>
      setWorkspaceFrames((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
  }, []);
  const sections = useMemo(
    () =>
      startup.ready
        ? sidebarSections(
            sidebarChannels,
            preferences.data,
            new Set([...hiddenDms.hiddenIds, ...dmVisibility.hidden]),
            chatsOnly,
            new Set<string>(JSON.parse(activeDraftSections)),
            regions.managed,
          )
        : [],
    [
      startup.ready,
      sidebarChannels,
      preferences.data,
      hiddenDms.hiddenIds,
      dmVisibility.hidden,
      chatsOnly,
      activeDraftSections,
      regions.managed,
    ],
  );
  // Projection rejects duplicate ids; optimistic creates skip existing ids.
  // useSidebarFilters keeps every section, filtering only its rows.
  const slotsMounted =
    slotsReady?.([
      ...sections.flatMap(({ key }) => (workspaceFrames.has(key) ? [] : [key])),
      ...contributions.map(({ key }) => contributedSidebarSectionKey(key)),
    ]) ?? true;
  // A target for another community has no destination in this sidebar.
  const location =
    "scope" in target &&
    target.scope &&
    (target.scope.viewer !== viewer ||
      target.scope.communityOrigin !== scope.slice(0, -(viewer.length + 1)))
      ? undefined
      : sidebarEntryLocation(target);
  const sidebar = useSidebarView(
    scope,
    layoutReady &&
      slotsMounted &&
      startup.ready &&
      list.status === "ready" &&
      (preferences.status !== "loading" || !!preferences.cached),
    location,
    preserveSidebar,
  );
  const current = channels.find(
    (channel) =>
      channel.id ===
      (target.kind === "conversation" ? target.channelId : undefined),
  );
  const composesChats = !!visibleSoloRegions(
    regions.regions,
    sidebar.contributionOrder,
  ).find((region) => region.source)?.source?.composeWorkspaces;
  // A region can compose ordinary chats. Mixed workspaces and Starred retain
  // their unified sidebar placement.
  const composedChatSections = new Set<string>();
  if (composesChats) {
    composedChatSections.add("solo");
    const mixed = new Set(
      sidebarChannels.flatMap((channel) => {
        const workspace = preferences.data?.assignments[channel.id];
        return workspace && channel.channelType !== "solo" ? [workspace] : [];
      }),
    );
    for (const { key } of sections)
      if (key.startsWith("group:") && !mixed.has(key.slice(6)))
        composedChatSections.add(key);
  }
  const selectedSection =
    target.kind === "conversation"
      ? sections.find(({ rows }) =>
          rows.some(
            ({ id, channelType }) =>
              id === target.channelId && channelType !== "solo",
          ),
        )?.key
      : undefined;
  const ordinarySelection =
    selectedSection && !composedChatSections.has(selectedSection)
      ? selectedSection
      : undefined;
  const previousLocation = useRef(sidebar.savedLocation ?? location);
  const destinationLocation =
    target.kind === "conversation" || currentDraft ? location : undefined;
  const pendingExpansion = useRef(false);
  useLayoutEffect(() => {
    if (!destinationLocation) {
      pendingExpansion.current = false;
      return;
    }
    if (destinationLocation !== previousLocation.current) {
      previousLocation.current = destinationLocation;
      pendingExpansion.current =
        !preserveSidebar && !navigator.snapshot().attempt.traversal;
    }
    if (pendingExpansion.current && ordinarySelection && !preserveSidebar) {
      pendingExpansion.current = false;
      sidebar.toggle(ordinarySelection, true);
    }
  }, [
    destinationLocation,
    navigator,
    ordinarySelection,
    preserveSidebar,
    sidebar.toggle,
  ]);
  const [chatTool, setChatTool] = useState<{
    channel: ChannelSummary;
    kind: "share" | "convert" | "settings";
    visit: AbortSignal;
    trigger?: HTMLElement | undefined;
  }>();
  const [renamingChat, setRenamingChat] = useState<string>();
  const renameFocus = useRef<{ id: string; from: Element | null } | undefined>(
    undefined,
  );
  const pendingChatClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const renamingSection = sections.find(({ rows }) =>
    rows.some(
      (channel) =>
        channel.id === renamingChat && channel.channelType === "solo",
    ),
  )?.key;
  if (renamingChat && !renamingSection) setRenamingChat(undefined);
  const renameChat = useCallback((id: string) => {
    setRenamingChat(id);
    return true;
  }, []);
  const openChatTool = (
    channel: ChannelSummary,
    kind: NonNullable<typeof chatTool>["kind"],
  ) => {
    const visit = navigator.snapshot().attempt.signal;
    requestAnimationFrame(() => {
      if (mounted.current && !visit.aborted)
        setChatTool({ channel, kind, visit });
    });
  };
  const shareChat = useCallback(
    (channel: ChannelSummary, trigger: HTMLElement) => {
      const visit = navigator.snapshot().attempt.signal;
      setChatTool({ channel, kind: "share", visit, trigger });
    },
    [navigator],
  );
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const createChannelTrigger = useRef<HTMLButtonElement>(null);
  const removedRowFocus = useRef<
    { channelId: string; target: HTMLElement } | undefined
  >(undefined);
  const pendingCreate = useRef<ChannelSummary | undefined>(undefined);
  const [creatingSection, setCreatingSection] = useState(false);
  const createSectionTrigger = useRef<HTMLButtonElement>(null);
  const [creatingFor, setCreatingFor] = useState<{
    channel: ChannelSummary;
    surface?: ChannelMenuSurface;
    position?: "first";
  }>();

  const createOrigin = creatingFor?.surface?.signal;
  useLayoutEffect(() => {
    if (!createOrigin) return;
    const retire = () =>
      setCreatingFor((previous) =>
        previous?.surface?.signal === createOrigin ? undefined : previous,
      );
    if (createOrigin.aborted) retire();
    else createOrigin.addEventListener("abort", retire, { once: true });
    return () => createOrigin.removeEventListener("abort", retire);
  }, [createOrigin]);

  const [initialGroup, setInitialGroup] = useState("");
  const [initialStarred, setInitialStarred] = useState(false);
  const [workspaceSettings, setWorkspaceSettings] = useState<{
    id: string;
    name: string;
    icon?: string | undefined;
    trigger: RefObject<HTMLButtonElement | null>;
  }>();
  const newChat = (project?: string) => {
    if (relay.snapshot().session !== queries) return;
    const current = navigator.snapshot().entry.target;
    const destination = resumeSoloDraftTarget(scope, current, project);
    if (destination === current) {
      soloDraftInput()?.focus();
      return;
    }
    if (project && !hasSoloDraft(queries, scope, project))
      resetNewChatProject(scope, project);
    void navigator.open(destination);
  };
  const sectionDrafts = (key: string) =>
    drafts.flatMap((destination) => {
      if (destination.kind !== "page") return [];
      const draft = soloDraft(destination.route?.params);
      if ((draft?.project ? `group:${draft.project}` : "solo") !== key)
        return [];
      const selected =
        !!currentDraft &&
        !currentDraft.region &&
        draft?.linked === currentDraft.linked &&
        draft?.project === currentDraft.project;
      return [
        <SpringLoadedNavigationItem
          key={draft?.linked ?? draft?.project ?? "new-chat"}
          onSpring={() => void navigator.open(destination)}
          label="New chat"
          aria-description="Unsent draft"
          selected={selected}
          aria-current={selected ? "page" : undefined}
          icon={<PencilSimpleIcon size={16} />}
          onClick={() => {
            if (selected) soloDraftInput()?.focus();
            else void navigator.open(destination);
          }}
        />,
      ];
    });
  const setupNotices = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.notices,
    queries.channelCreation.notices,
  );
  useEffect(() => {
    if (list.status === "ready") {
      queries.channelKit.ensure();
      void queries.unread.ensure();
    }
  }, [queries, list.status]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    // Let the existing context menu restore focus before opening confirmation.
    requestAnimationFrame(() => {
      if (mounted.current) handoff?.openLifecycle(channel, action);
    });
  };
  useLayoutEffect(() => {
    if (!slotsMounted || !lifecycleFocus.current || lifecycleDialog) return;
    const id = lifecycleFocus.current;
    lifecycleFocus.current = undefined;
    const trigger = lifecycleTrigger.current;
    lifecycleTrigger.current = undefined;
    // The pending operation is nonmodal; keep focus where the user moved it.
    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      !document.activeElement.closest("[inert]")
    )
      return;
    if (trigger?.isConnected && !trigger.closest("[inert]")) {
      trigger.focus({ preventScroll: true });
      return;
    }
    const rows = activeChannelRows(sidebar.list.current);
    const row =
      rows.find(
        (row) => row.dataset.channelId === id && row.getClientRects().length,
      ) ?? rows.find((row) => row.getClientRects().length);
    (
      row ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
  }, [lifecycleDialog, sidebar.list, slotsMounted]);
  const select = useCallback(
    (id: string) => {
      const parts = splitPartition(scope);
      if (!viewer || !parts || relay.snapshot().session !== queries) return;
      clientMetrics.channelIntent(id, window.event);
      writeView(scope, "selected-channel", id);
      void navigator.open({
        version: 1,
        kind: "conversation",
        channelId: id,
        scope: { viewer, communityOrigin: parts.communityOrigin },
      });
    },
    [navigator, relay, queries, scope, viewer],
  );
  const openActivityMessage = useCallback(
    (
      channelId: string,
      messageId: string | undefined,
      threadRootId?: string,
    ) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      const trigger =
        activeChannelRows(sidebar.list.current).find(
          (row) => row.dataset.channelId === channelId,
        ) ?? null;
      const result = navigator.open({
        version: 1,
        kind: "conversation",
        channelId,
        ...(messageId ? { messageId } : {}),
        ...(threadRootId ? { threadRootId } : {}),
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
      const { attempt } = navigator.snapshot();
      const target = attempt.entry.target;
      if (
        activityThread &&
        messageId &&
        target.kind === "conversation" &&
        target.channelId === channelId &&
        target.messageId === messageId
      ) {
        const intent = {
          channelId,
          messageId,
          trigger,
          entryId: attempt.entry.id,
          signal: attempt.signal,
        };
        activityThread.current = intent;
        void result.then(() => {
          if (activityThread.current === intent)
            activityThread.current = undefined;
        });
      }
    },
    [viewer, relay, queries, activityThread, sidebar.list, navigator, scope],
  );
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) =>
      openActivityMessage(channelId, rootId, rootId),
    [openActivityMessage],
  );
  const openWorkingAgent = useCallback(
    (channelId: string, _agent: string, messageId: string | undefined) => {
      const root =
        messageId &&
        queries.channels
          .list()
          .channels.find((channel) => channel.id === channelId)?.channelType !==
          "solo" &&
        queries.channels
          .window(channelId)
          .rows.some((row) => row.id === messageId && !row.threadRootId);
      openActivityMessage(channelId, messageId, root ? messageId : undefined);
    },
    [queries, openActivityMessage],
  );
  const openAgentActivity = useCallback(
    (channelId: string, agent: string, messageId: string | undefined) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      const isChat = queries.channels
        .list()
        .channels.some(
          (row) => row.id === channelId && row.channelType === "solo",
        );
      const transcript = isChat
        ? {}
        : activityTranscript(queries.channels, channelId, messageId);
      const intent = {
        channelId,
        agent,
        trigger:
          activeChannelRows(sidebar.list.current).find(
            (row) => row.dataset.channelId === channelId,
          ) ?? null,
        ...(transcript && { transcript }),
      };
      if (activityAgent) activityAgent.current = intent;
      void navigator
        .open({
          version: 1,
          kind: "conversation",
          channelId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        })
        .then((result) => {
          if (result.status !== "opened" && activityAgent?.current === intent)
            activityAgent.current = undefined;
        });
    },
    [viewer, relay, queries, activityAgent, sidebar.list, navigator, scope],
  );
  const createChannel = async (input: CreateChannelInput) => {
    const id = await queries.channelCreation.create(input);
    if (mounted.current)
      revealCreatedChannel(relay, queries, navigator, input, id, (key) =>
        sidebar.toggle(key, true),
      );
  };
  const rowUnread = useSidebarRowUnread(
    queries.unread,
    JSON.stringify(
      sections.flatMap((section) =>
        rowSortModes.some((mode) => mode.id === sectionSort(section.key))
          ? section.rows.map((channel) => channel.id)
          : [],
      ),
    ),
  );
  const sortedSections = useMemo(
    () =>
      rowSortModes.length
        ? sections.map((section) => {
            const mode = rowSortModes.find(
              (mode) => mode.id === sectionSort(section.key),
            );
            if (!mode) return section;
            const candidates = section.rows.map((channel) => ({
              channel,
              data: sidebarRow(
                channel,
                section.key,
                rowUnread.get(channel.id) ??
                  queries.unread.snapshot({
                    kind: "channel",
                    channelId: channel.id,
                  }),
              ),
            }));
            const sorted = sortSidebarRows(
              candidates,
              mode,
              ({ data }) => data,
            );
            return sorted === candidates
              ? section
              : { ...section, rows: sorted.map(({ channel }) => channel) };
          })
        : sections,
    [sections, rowSortModes, sectionSort, rowUnread, queries.unread],
  );
  const unfoldedSections = useSidebarFilters(
    sortedSections
      .filter(({ key }) => !workspaceFrames.has(key))
      .map((section) =>
        composedChatSections.has(section.key)
          ? { ...section, rows: [] }
          : section,
      ),
    Object.fromEntries(
      Object.entries(preferences.data?.filters ?? {}).map(([key, mode]) => [
        key.startsWith("section:") ? `group:${key.slice(8)}` : key,
        mode,
      ]),
    ),
    current?.id,
    queries.unread,
    Object.fromEntries(
      Object.entries(preferences.data?.activeWindowSeconds ?? {}).map(
        ([key, seconds]) => [
          key.startsWith("section:") ? `group:${key.slice(8)}` : key,
          seconds,
        ],
      ),
    ),
    list.activityStatus === "ready",
  );
  // A capped section never hides the open chat, one being renamed, or one
  // that needs the viewer; filters choose the rows, the cap only shortens them.
  const sectionLimits = useSectionLimits(
    scope,
    preferences.data?.soloWorkspaces,
  );
  const unreadOverflow = useUnreadChannelIds(
    queries.unread,
    JSON.stringify(
      sectionOverflowCandidates(unfoldedSections, sectionLimits.limits),
    ),
    true,
  );
  const filteredSections = capSections(
    unfoldedSections,
    sectionLimits.limits,
    (id) =>
      id === current?.id ||
      id === renamingChat ||
      workingChannels.has(id) ||
      unreadOverflow.has(id),
    sectionLimits.held,
  );
  useHoldOverflow(
    filteredSections.flatMap(({ overflow }) => overflow),
    sectionLimits.hold,
  );
  const firstChannelSection = filteredSections.find(({ key }) =>
    isChannelSectionKey(key),
  )?.key;
  // Menu dismissal may run before a moved row mounts at its new placement.
  // Only an actual filter exclusion should return focus to a section summary.
  const hiddenRowSections = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    hiddenRowSections.current = new Map(
      filteredSections.flatMap((section) =>
        section.hiddenRows.map(({ id }) => [id, section.key] as const),
      ),
    );
  }, [filteredSections]);
  const channelSectionKey = useCallback(
    (channelId: string) => {
      const data = queries.sidebarPreferences.snapshot().data;
      const sectionId = regions.managed.has(channelId)
        ? undefined
        : data?.assignments[channelId];
      const channel = queries.channels
        .list()
        .channels.find((row) => row.id === channelId);
      return data?.starred.includes(channelId)
        ? "starred"
        : sectionId
          ? `group:${sectionId}`
          : channel
            ? sidebarHome(channel)
            : "channels";
    },
    [queries, regions.managed],
  );
  const focusChannelPlacement = (channelId: string) => {
    if (
      queries.channels.list().channels.find(({ id }) => id === channelId)
        ?.channelType !== "solo"
    )
      sidebar.toggle(channelSectionKey(channelId), true);
    setRowFocus(channelId);
  };
  // Show more and Show fewer each unmount once spent; focus stays on their
  // row, or moves to the section's last row when nothing is left to show.
  const [stepFocus, setStepFocus] = useState<string>();
  useLayoutEffect(() => {
    if (stepFocus === undefined) return;
    setStepFocus(undefined);
    const root = sidebar.list.current;
    const row = root?.querySelector<HTMLElement>(
      `[data-section-show-more="${CSS.escape(stepFocus)}"]`,
    );
    if (row?.contains(document.activeElement)) return;
    const target =
      row?.querySelector<HTMLElement>("button") ??
      activeChannelRows(
        root?.querySelector(
          `[data-sidebar-section="${CSS.escape(stepFocus)}"]`,
        ),
      ).at(-1);
    target?.focus({ preventScroll: true });
  }, [stepFocus, sidebar.list]);
  const moveChannel = (
    channelId: string,
    operation: () => Promise<unknown>,
    surface?: ChannelMenuSurface,
  ) => {
    const saving = operation(); // Publishes optimistic placement synchronously.
    // A moved row stays listed past its new section's cap until it folds.
    sectionLimits.hold([channelId]);
    if (surface) {
      surface.close();
      surface.focus();
    } else {
      closeRowMenu();
      focusChannelPlacement(channelId);
    }
    void saving.catch(() => {
      // The session exposes retry even after page/menu unmount. Restore a row
      // focus lost to rollback, but never steal focus from another control.
      if (
        !surface &&
        sidebar.list.current?.isConnected &&
        document.activeElement === document.body
      )
        focusChannelPlacement(channelId);
    });
  };
  const assignGroup = (
    channelId: string,
    sectionId?: string,
    surface?: ChannelMenuSurface,
  ) =>
    moveChannel(
      channelId,
      () => {
        const refusal = prepareSoloMove(queries, channelId);
        return refusal
          ? Promise.reject(new Error(refusal))
          : preferences.assign(channelId, sectionId);
      },
      surface,
    );
  const setChannelStar = (
    channelId: string,
    starred: boolean,
    surface?: ChannelMenuSurface,
  ) =>
    moveChannel(
      channelId,
      () => preferences.setStar(channelId, starred),
      surface,
    );
  const placementWritable =
    preferences.writable && preferences.starWritable && !!preferences.data;
  // Group drags land on the placement drop targets, so they need both writers.
  const orderWritable = placementWritable && preferences.sectionOrderWritable;
  const groupIds = workspaceSectionOrder(preferences.data);
  const visibleGroupIds = filteredSections.map(({ key }) => key);
  // Saved order uses the same section keys as collapse and drag.
  const orderedContributions = orderContributedSidebarSections(
    contributions.map((entry) => ({
      key: contributedSidebarSectionKey(entry.key),
      entry,
    })),
    sidebar.contributionOrder,
  ).map(({ entry }) => entry);
  const reorderContributions = (sectionKey: string, overKey: string) => {
    const ids = orderedContributions.map(({ key }) =>
      contributedSidebarSectionKey(key),
    );
    const from = ids.indexOf(sectionKey);
    const to = ids.indexOf(overKey);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sectionKey);
    const activeKeys = new Set(ids);
    const seenSavedKeys = new Set<string>();
    const order: string[] = [];
    let nextActive = 0;
    for (const savedKey of sidebar.contributionOrder) {
      if (!activeKeys.has(savedKey)) {
        order.push(savedKey);
        continue;
      }
      if (seenSavedKeys.has(savedKey)) continue;
      seenSavedKeys.add(savedKey);
      order.push(ids[nextActive++] ?? savedKey);
    }
    order.push(...ids.slice(nextActive));
    sidebar.setContributionOrder(order);
  };
  const moveGroup = (sectionId: string, to: number) => {
    const ids = groupIds.filter((id) => id !== sectionId);
    ids.splice(to, 0, sectionId);
    void preferences.reorderSections(sectionId, ids).catch(() => {});
  };
  const sectionMove = (key: string) => {
    if (!orderWritable) return undefined;
    const index = visibleGroupIds.indexOf(key);
    const previous = visibleGroupIds[index - 1];
    const next = visibleGroupIds[index + 1];
    return {
      up: previous
        ? () => moveGroup(key, groupIds.indexOf(previous))
        : undefined,
      down: next ? () => moveGroup(key, groupIds.indexOf(next)) : undefined,
    };
  };
  const setSectionSort = (key: string, mode: SidebarSortMode) => {
    void preferences
      .setSort(
        key.startsWith("group:") ? `section:${key.slice(6)}` : key,
        mode,
        preferences.data?.sections.map((section) => section.id) ?? [],
      )
      .catch(() => {});
  };
  const setSectionFilter = (
    key: string,
    mode: "all" | "unreads" | "active",
    activeWindowSeconds?: number | null,
  ) => {
    return preferences.setFilter(
      key.startsWith("group:") ? `section:${key.slice(6)}` : key,
      mode,
      preferences.data?.sections.map((section) => section.id) ?? [],
      undefined,
      activeWindowSeconds,
    );
  };
  // Compose actual items here; menu availability is their count, not the policy
  // of any one action. Sibling actions keep their own eligibility checks.
  const rowActions = (
    channel: ChannelSummary,
    sectionKey: string,
    surface?: ChannelMenuSurface,
  ) => {
    const actions: ReactNode[] = [];
    if (!surface && channel.channelType === "solo") {
      actions.push(
        <SoloChatMenuItems
          key="chat-tools"
          session={queries}
          channel={channel}
          includeChannelControls={false}
          onSettings={() => openChatTool(channel, "settings")}
          onShare={() => openChatTool(channel, "share")}
          onConvert={() => openChatTool(channel, "convert")}
          onRename={
            canEditLifetime(queries, channel)
              ? () => setRenamingChat(channel.id)
              : undefined
          }
        >
          {chatMenuEntries?.map(({ key, component: Menu }) => (
            <Menu key={key} session={queries} channelId={channel.id} />
          ))}
        </SoloChatMenuItems>,
      );
    }
    if (preferences.starWritable && !regions.managed.has(channel.id)) {
      const currentSectionId = sectionKey.startsWith("group:")
        ? sectionKey.slice("group:".length)
        : undefined;
      const starred = sectionKey === "starred";
      const home = sidebarHome(channel);
      actions.push(
        <MenuSubmenu key="move-channel">
          <MenuSubmenuTrigger>
            <MenuIcon>
              <FolderSimpleIcon size={14} />
            </MenuIcon>
            Move to…
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup
            aria-label={`Move ${channel.name} to workspace`}
            // The root restores by channel identity after relocation;
            // a nested popup must not refocus its retired trigger.
            finalFocus={false}
          >
            <MenuGroup>
              <MenuGroupLabel>Move to…</MenuGroupLabel>
            </MenuGroup>
            <MenuRadioGroup
              value={
                starred
                  ? "starred"
                  : currentSectionId
                    ? `group:${currentSectionId}`
                    : home
              }
              onValueChange={(destination) => {
                if (destination === "starred")
                  void setChannelStar(channel.id, !starred, surface);
                else {
                  const groupId = destination.startsWith("group:")
                    ? destination.slice("group:".length)
                    : undefined;
                  void assignGroup(
                    channel.id,
                    groupId === currentSectionId ? undefined : groupId,
                    surface,
                  );
                }
              }}
            >
              <MenuRadioItem value="starred" closeOnClick={false}>
                <MenuIcon>★</MenuIcon>
                Starred
              </MenuRadioItem>
              {preferences.data?.sections.map((group) => (
                <MenuRadioItem
                  key={group.id}
                  disabled={!placementWritable}
                  value={`group:${group.id}`}
                  closeOnClick={false}
                >
                  <MenuIcon>
                    {group.icon ? (
                      <SidebarGroupIcon icon={group.icon} session={queries} />
                    ) : (
                      <FolderSimpleIcon size={14} />
                    )}
                  </MenuIcon>
                  {group.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem
                value={home}
                closeOnClick={false}
                disabled={!placementWritable}
              >
                <MenuIcon>
                  <ChatCircleIcon size={14} />
                </MenuIcon>
                {sections.find((section) => section.key === home)?.title ??
                  "Unfiled"}
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem
              disabled={!preferences.sectionCreationWritable}
              onClick={() => {
                if (surface) {
                  surface.close(() => false);
                  requestAnimationFrame(() => {
                    if (
                      mounted.current &&
                      !surface.signal?.aborted &&
                      queries.sidebarPreferences.sectionCreationWritable &&
                      relay.snapshot().session === queries
                    )
                      setCreatingFor({ channel, surface });
                  });
                } else pendingCreate.current = channel;
              }}
            >
              <MenuIcon>
                <PlusIcon size={14} />
              </MenuIcon>
              Create new…
            </MenuItem>
            {(starred || currentSectionId) && (
              <MenuItem
                closeOnClick={false}
                disabled={!starred && !placementWritable}
                onClick={() => {
                  if (starred) void setChannelStar(channel.id, false, surface);
                  else void assignGroup(channel.id, undefined, surface);
                }}
              >
                <MenuIcon>
                  <MinusIcon size={14} />
                </MenuIcon>
                Remove from{" "}
                {sections.find((section) => section.key === sectionKey)?.title}
              </MenuItem>
            )}
          </MenuSubmenuPopup>
        </MenuSubmenu>,
      );
    }
    const muteable =
      queries.sidebarPreferences.muteWritable && !!preferences.data;
    const readable = queries.unread.sync().capability === "frontier-sync";
    if (muteable && mute) {
      const intent = mute.intents.get(channel.id);
      const muted = intent?.pending
        ? intent.muted
        : (preferences.data?.muted.includes(channel.id) ?? false);
      actions.push(
        <MenuItem
          key="mute"
          closeOnClick={false}
          disabled={surface?.pending ?? readWrite?.pending ?? false}
          onClick={() => changeMute(channel.id, channel.name, !muted, surface)}
        >
          <MenuIcon>
            {muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
          </MenuIcon>
          {muted ? "Unmute" : "Mute"}
        </MenuItem>,
      );
    }
    if (readable)
      actions.push(
        <ChannelReadMenuItem
          key="read"
          unread={queries.unread}
          channelId={channel.id}
          pending={surface?.pending ?? readWrite?.pending ?? false}
          run={(action) =>
            surface
              ? surface.runRead(action)
              : runReadAction(channel.id, action)
          }
        />,
      );
    actions.push(
      <ChannelCopyLinkMenuItem key="copy-link" channelId={channel.id} />,
    );
    if (!surface && !channel.archived) {
      actions.push(
        <ChannelLifecycleMenu
          key="lifecycle"
          separator={false}
          noun={lifecycleNoun(channel)}
          channel={channel}
          session={queries}
          disabled={!!lifecycleDialog}
          choose={(action) => chooseLifecycle(channel, action)}
        />,
      );
    }
    if (channel.channelType === "dm") {
      actions.push(
        <MenuItem
          key="remove-message"
          onClick={() => {
            if (surface) {
              hiddenDms.hide(channel.id);
              surface.close();
              surface.focus();
              return;
            }
            const trigger = activeChannelRows(sidebar.list.current).find(
              (row) => row.dataset.channelId === channel.id,
            );
            const section = trigger?.closest("[data-sidebar-section]");
            const rows = activeChannelRows(section);
            const index = rows.indexOf(trigger as HTMLButtonElement);
            const survivingSummary = [
              ...(sidebar.list.current?.querySelectorAll<HTMLElement>(
                "[data-sidebar-section] details > summary",
              ) ?? []),
            ].find((summary) => !section?.contains(summary));
            const target =
              rows[index + 1] ?? rows[index - 1] ?? survivingSummary;
            removedRowFocus.current = target
              ? { channelId: channel.id, target }
              : undefined;
            hiddenDms.hide(channel.id);
          }}
        >
          <MenuIcon>
            <XIcon size={14} />
          </MenuIcon>
          Close conversation
        </MenuItem>,
      );
    }
    return actions;
  };
  const {
    rowMenu,
    open: openMenu,
    close: closeMenu,
  } = useChannelRowMenu(filteredSections, rowActions);
  const openRowMenu = useCallback(
    (channel: ChannelSummary, sectionKey: string, anchor?: HTMLElement) => {
      readAction.reset();
      removedRowFocus.current = undefined;
      // A row whose menu is open stays listed past its section's cap.
      sectionLimits.hold([channel.id]);
      openMenu(channel, sectionKey, anchor);
    },
    [openMenu, readAction.reset, sectionLimits.hold],
  );
  const closeRowMenu = useCallback(() => {
    readAction.reset();
    closeMenu();
  }, [closeMenu, readAction.reset]);
  const currentRowMenu = useRef(rowMenu);
  // Hidden-state callbacks run in child layout effects, before parent effects.
  currentRowMenu.current = rowMenu;
  const setRowHidden = useCallback(
    (id: string, hidden: boolean) => {
      const registration = {};
      if (hidden) {
        pluginHiddenRows.current.set(id, registration);
        const menu = currentRowMenu.current;
        if (menu?.channelId === id) {
          const target = sidebar.list.current?.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(menu.sectionKey)}"] details > summary`,
          );
          removedRowFocus.current = target
            ? { channelId: id, target }
            : undefined;
          closeRowMenu();
        }
      } else pluginHiddenRows.current.delete(id);
      return () => {
        // An exiting placement must not clear the live placement's registration.
        if (pluginHiddenRows.current.get(id) === registration)
          pluginHiddenRows.current.delete(id);
      };
    },
    [closeRowMenu, sidebar.list],
  );
  const muteRecovery = handoff?.muteRecovery;
  useLayoutEffect(() => {
    if (!muteRecovery) return;
    const callbacks = { focus: setRowFocus, closeMenu: closeRowMenu };
    muteRecovery.current = callbacks;
    return () => {
      if (muteRecovery.current === callbacks) muteRecovery.current = undefined;
    };
  }, [muteRecovery, closeRowMenu]);
  const rowMenuClosed = useCallback((channelId: string) => {
    if (pendingCreate.current?.id === channelId) {
      setCreatingFor({ channel: pendingCreate.current });
      pendingCreate.current = undefined;
    }
  }, []);
  const rowFocusTarget = useCallback(
    (channelId: string) => {
      const list = sidebar.list.current;
      const row = activeChannelRows(list).find(
        (candidate) => candidate.dataset.channelId === channelId,
      );
      if (row) return row;
      const filteredSection = hiddenRowSections.current.get(channelId);
      const sectionKey = filteredSection ?? channelSectionKey(channelId);
      if (!filteredSection && !sidebar.collapsed.includes(sectionKey)) return;
      return list?.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(sectionKey)}"] :is(details > summary, button[aria-expanded]:not([aria-haspopup]))`,
      );
    },
    [channelSectionKey, sidebar.collapsed, sidebar.list],
  );
  const rowMenuFinalFocus = useCallback(
    (channelId: string) =>
      pendingCreate.current
        ? false
        : removedRowFocus.current?.channelId === channelId
          ? removedRowFocus.current.target
          : (rowFocusTarget(channelId) ?? false),
    [rowFocusTarget],
  );
  const sidebarFocusFallback = useCallback(
    () =>
      activeChannelRows(sidebar.list.current).find(
        (row) => row.getClientRects().length,
      ) ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button"),
    [sidebar.list],
  );
  useLayoutEffect(() => {
    if (!rowFocus || !slotsMounted) return;
    (rowFocusTarget(rowFocus) ?? sidebarFocusFallback())?.focus({
      preventScroll: true,
    });
    setRowFocus(undefined);
  }, [rowFocus, rowFocusTarget, sidebarFocusFallback, slotsMounted]);
  useLayoutEffect(() => {
    const intent = renameFocus.current;
    if (renamingChat || !intent || !slotsMounted) return;
    // Let the editor unmount and the disclosure finish committing before
    // restoring focus. Preserve any focus the user has moved in the meantime.
    const frame = requestAnimationFrame(() => {
      if (renameFocus.current !== intent) return;
      renameFocus.current = undefined;
      if (
        document.activeElement !== document.body &&
        document.activeElement !== intent.from
      )
        return;
      const section = channelSectionKey(intent.id);
      const summary = sidebar.collapsed.includes(section)
        ? sidebar.list.current?.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(section)}"] details > summary`,
          )
        : undefined;
      (summary ?? rowFocusTarget(intent.id) ?? sidebarFocusFallback())?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    renamingChat,
    slotsMounted,
    channelSectionKey,
    rowFocusTarget,
    sidebarFocusFallback,
    sidebar.collapsed,
    sidebar.list,
  ]);
  const [groupFocus, setGroupFocus] = useState<string>();
  // Group recovery removes its focused notice; return focus to the group header.
  useLayoutEffect(() => {
    if (!groupFocus || !slotsMounted) return;
    (
      sidebar.list.current?.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(groupFocus)}"] details > summary`,
      ) ??
      sidebar.list.current?.querySelector<HTMLElement>(
        "[data-sidebar-section] details > summary",
      )
    )?.focus({ preventScroll: true });
    setGroupFocus(undefined);
  }, [groupFocus, sidebar.list, slotsMounted]);
  const runReadAction = (channelId: string, action: () => Promise<unknown>) =>
    readAction.run(action, () => {
      setRowFocus(channelId);
      closeRowMenu();
    });
  const changeMute = (
    channelId: string,
    name: string,
    muted: boolean,
    surface?: ChannelMenuSurface,
  ) => {
    if (!mute) return;
    mute.change(channelId, name, muted);
    if (surface) {
      surface.close();
      surface.focus();
    } else {
      setRowFocus(channelId);
      closeRowMenu();
    }
  };
  // Publish presentation callbacks, not a second mutation owner. Header renders
  // these elements under its own MenuRoot; a portal here would lose that context.
  const menuActions = handoff?.menuActions;
  useLayoutEffect(() => {
    menuActions?.publish((channel, surface) => {
      if (cached || channel.cached || relay.snapshot().session !== queries)
        return [];
      // A not-joined preview has no sidebar row to place, mute or mark read.
      if (channel.readOnly && channel.viewerRole !== "guest")
        return [
          <ChannelCopyLinkMenuItem key="copy-link" channelId={channel.id} />,
        ];
      const placement = sections.find((section) =>
        section.rows.some((row) => row.id === channel.id),
      );
      return rowActions(channel, placement?.key ?? "channels", surface);
    });
  });
  useLayoutEffect(() => () => menuActions?.publish(undefined), [menuActions]);
  const lifecycleCallbacks = handoff?.lifecycleCallbacks;
  const openSuccessor = handoff?.openSuccessor;
  const soloNeighborsRef = handoff?.soloNeighbors;
  useLayoutEffect(() => {
    if (!soloNeighborsRef || composesChats) return;
    const neighbors = (id: string) => {
      const shown = filteredSections.flatMap(({ key, rows }) =>
        sidebar.collapsed.includes(key)
          ? []
          : rows.flatMap((row) =>
              row.channelType === "solo" &&
              !pluginHiddenRows.current.has(row.id)
                ? [row.id]
                : [],
            ),
      );
      const at = shown.indexOf(id);
      return at < 0
        ? shown
        : [...shown.slice(at + 1), ...shown.slice(0, at).reverse()];
    };
    soloNeighborsRef.current = neighbors;
    return () => {
      if (soloNeighborsRef.current === neighbors)
        soloNeighborsRef.current = undefined;
    };
  }, [composesChats, filteredSections, sidebar.collapsed, soloNeighborsRef]);
  // The shown rows nearest the confirmed channel and the open one: its own
  // section's, then the nearest expanded sections'. Captured while each is
  // still listed: completion, or removal while it is open, can drop it first.
  // Kept apart, so a confirmation for another channel keeps the open one's.
  const lifecycleNeighbors = useRef<
    Partial<Record<"dialog" | "open", { id: string; ids: string[] }>>
  >({});
  useLayoutEffect(() => {
    if (!lifecycleCallbacks || !openSuccessor) return;
    const capture = (key: "dialog" | "open", anchor: string | undefined) => {
      if (!anchor) {
        delete lifecycleNeighbors.current[key];
        return;
      }
      const at = filteredSections.findIndex((section) =>
        section.rows.some((row) => row.id === anchor),
      );
      const placement = filteredSections[at];
      if (!placement) return;
      const shown = (section: typeof placement) =>
        sidebar.collapsed.includes(section.key)
          ? []
          : section.rows
              .filter(
                (row) =>
                  row.id === anchor || !pluginHiddenRows.current.has(row.id),
              )
              .map((row) => row.id);
      const own = shown(placement);
      const index = Math.max(own.indexOf(anchor), 0);
      lifecycleNeighbors.current[key] = {
        id: anchor,
        ids: [
          ...own.slice(index + 1),
          ...own.slice(0, index).reverse(),
          ...filteredSections.slice(at + 1).flatMap(shown),
          ...filteredSections.slice(0, at).flatMap(shown).reverse(),
        ],
      };
    };
    capture("dialog", lifecycleDialog?.channel.id);
    capture(
      "open",
      target.kind === "conversation" ? target.channelId : undefined,
    );
    // Its neighbor takes its place, so the sidebar stays where it is.
    const successor = (id: string) => {
      const listed = filteredSections
        .flatMap((section) => section.rows)
        .filter((row) => !pluginHiddenRows.current.has(row.id));
      return (
        (
          [
            lifecycleNeighbors.current.dialog,
            lifecycleNeighbors.current.open,
          ].find((captured) => captured?.id === id)?.ids ?? []
        ).find((neighbor) => listed.some((row) => row.id === neighbor)) ??
        listed.find((channel) => channel.id !== id)?.id
      );
    };
    const land = (next: string | undefined) => {
      if (next) select(next);
      else openEmptyChannels(navigator, scope);
    };
    openSuccessor.current = (id) => land(successor(id));
    lifecycleCallbacks.current = lifecycleDialog
      ? {
          close: () => {
            lifecycleFocus.current = lifecycleDialog.channel.id;
            lifecycleTrigger.current = lifecycleDialog.trigger?.isConnected
              ? lifecycleDialog.trigger
              : lifecycleDialog.focusFallback;
          },
          depart: () => {
            const id = lifecycleDialog.channel.id;
            lifecycleFocus.current = id;
            // Archive changes visibility, not access or the current destination.
            if (
              lifecycleDialog.action === "archive" ||
              lifecycleDialog.action === "unarchive"
            ) {
              lifecycleTrigger.current = lifecycleDialog.trigger?.isConnected
                ? lifecycleDialog.trigger
                : lifecycleDialog.focusFallback;
              return;
            }
            const next = successor(id);
            if (next) lifecycleFocus.current = next;
            // Confirmed access loss can already have removed current from the roster.
            if (
              (target.kind === "conversation"
                ? target.channelId
                : undefined) === id
            )
              land(next);
          },
        }
      : undefined;
  });
  useLayoutEffect(
    () => () => {
      if (lifecycleCallbacks) lifecycleCallbacks.current = undefined;
      if (openSuccessor) openSuccessor.current = undefined;
    },
    [lifecycleCallbacks, openSuccessor],
  );
  const workspaceNewAction = (workspace: string, name: string) => (
    <WorkspaceNewMenu
      key={`${scope}:${workspace}`}
      scope={scope}
      workspace={workspace}
      name={name}
      channelAvailable={queries.channelCreation.available}
      dmAvailable={queries.directMessages.available}
      choose={(action, trigger) => {
        if (relay.snapshot().session !== queries) return;
        if (action === "chat") newChat(workspace);
        else if (action === "channel") {
          createChannelTrigger.current = trigger;
          setInitialStarred(false);
          setInitialGroup(workspace);
          setCreateChannelOpen(true);
        } else {
          const partition = splitPartition(scope);
          if (partition)
            void navigator.open(workspaceMessageTarget(partition, workspace));
        }
      }}
    />
  );
  return render({
    sidebar,
    workspaceComposition: {
      sections: composedChatSections,
      pendingChatClick,
      collapsed: sidebar.collapsed,
      toggle: sidebar.toggle,
      registerFrame: registerWorkspaceFrame,
      newAction: workspaceNewAction,
    },
    dmPreviews: unreadDmPreviews,
    frame: {
      launchPending: connectionError
        ? undefined
        : !startup.ready ||
            (!cached && (list.status === "idle" || list.status === "loading"))
          ? "required"
          : cached || startup.updating
            ? "settling"
            : undefined,
      busy: preferences.status === "loading" || startup.updating || undefined,
    },
    before: (
      <>
        {/* The sidebar mounts the one automatic relay-recovery notice.
              Other failures need the user and keep their own message and Retry. */}
        {kitState.status === "error" && !kitState.transient && (
          <p role="alert">
            {kitState.error}{" "}
            <Button onClick={() => void queries.channelKit.refresh()}>
              Retry templates
            </Button>
          </p>
        )}
        {setupNotices.map((notice) => (
          <ToastNotice
            key={notice.id}
            title={`Channel setup couldn’t finish: ${notice.name}`}
            description={notice.error}
            tone="warning"
          >
            <Button
              size="sm"
              onClick={() => queries.channelCreation.dismissNotice(notice.id)}
            >
              Dismiss
            </Button>
          </ToastNotice>
        ))}
        {!cached && dmVisibility.status === "error" && (
          <div role="alert">
            Hidden conversations could not be refreshed.{" "}
            <Button
              onClick={() =>
                void lifecycle.refreshVisibility(
                  visibilityRequest.current?.signal,
                )
              }
            >
              Retry hidden conversations
            </Button>
          </div>
        )}
      </>
    ),
    team: (children) => (
      <ChannelSidebarDnd
        writable={placementWritable}
        // A dragged row stays listed past its section's cap until it folds.
        onDragStart={(id, group) => {
          if (!group) sectionLimits.hold([id]);
        }}
        onCreateSection={(channelId) => {
          const channel = sidebarChannels.find(({ id }) => id === channelId);
          // Finish releasing the pointer before giving the modal its focus.
          requestAnimationFrame(() => {
            if (
              mounted.current &&
              channel &&
              !prepareSoloMove(queries, channelId) &&
              queries.sidebarPreferences.sectionCreationWritable
            )
              setCreatingFor({ channel, position: "first" });
          });
        }}
        onMove={(channelId, sectionKey) => {
          if (prepareSoloMove(queries, channelId)) return;
          if (sectionKey === "starred") setChannelStar(channelId, true);
          else
            assignGroup(
              channelId,
              sectionKey.startsWith("group:")
                ? sectionKey.slice("group:".length)
                : undefined,
            );
        }}
        onReorder={(sectionKey, overKey) =>
          sectionKey.startsWith("plugin:")
            ? reorderContributions(sectionKey, overKey)
            : moveGroup(sectionKey, groupIds.indexOf(overKey))
        }
        overlay={(id, group) => {
          if (group) {
            const section = sections.find(({ key }) => key === id);
            const contribution = section
              ? undefined
              : orderedContributions.find(
                  ({ key }) => contributedSidebarSectionKey(key) === id,
                );
            const title = section?.title ?? contribution?.title;
            if (!title) return null;
            return (
              <div className={styles.channelDragOverlay}>
                {section?.icon ? (
                  <SidebarGroupIcon icon={section.icon} session={queries} />
                ) : contribution?.icon ? (
                  <ContributionBoundary
                    key={contributionKey(contribution)}
                    fallback={null}
                  >
                    {contribution.icon}
                  </ContributionBoundary>
                ) : null}
                <span>{title}</span>
              </div>
            );
          }
          const channel = sidebarChannels.find((channel) => channel.id === id);
          if (!channel) return null;
          const Icon = channelIcon(channel);
          return (
            <div className={styles.channelDragOverlay}>
              <Icon size={16} />
              <span>{channel.name}</span>
            </div>
          );
        }}
      >
        <TeamSidebarSections
          value={[
            ...filteredSections.map((section, index) => ({
              id: section.key,
              title: section.title,
              defaultPosition: index,
              element: (
                <TeamSidebarSection
                  render={() => {
                    return (
                      <DroppableSidebarSection
                        key={section.key}
                        createSectionTarget={
                          section.key === firstChannelSection
                            ? preferences.sectionCreationWritable
                              ? "available"
                              : "unavailable"
                            : undefined
                        }
                        groupIndex={groupIds.indexOf(section.key)}
                        disabled={
                          !placementWritable ||
                          !sidebarDropRowKinds(section.key).length
                        }
                        accepts={sidebarDropRowKinds(section.key)}
                        reorderable={orderWritable}
                        move={sectionMove(section.key)}
                        sectionKey={section.key}
                        title={section.title}
                        icon={section.icon}
                        session={queries}
                        open={
                          !sidebar.collapsed.includes(section.key) ||
                          renamingSection === section.key
                        }
                        onToggle={(open) =>
                          sidebar.toggle(
                            section.key,
                            renamingSection === section.key
                              ? sidebar.collapsed.includes(section.key)
                              : open,
                          )
                        }
                        channelCount={section.allRows.length}
                        filter={
                          preferences.data
                            ? {
                                value:
                                  preferences.data.filters?.[
                                    section.key.startsWith("group:")
                                      ? `section:${section.key.slice(6)}`
                                      : section.key
                                  ] ?? "all",
                                disabled: !preferences.filterWritable,
                                activeWindowSeconds:
                                  preferences.data.activeWindowSeconds?.[
                                    section.key.startsWith("group:")
                                      ? `section:${section.key.slice(6)}`
                                      : section.key
                                  ],
                                change: (mode, seconds) =>
                                  setSectionFilter(section.key, mode, seconds),
                                dismissError: () =>
                                  preferences.dismissFilterError(
                                    section.key.startsWith("group:")
                                      ? `section:${section.key.slice(6)}`
                                      : section.key,
                                  ),
                              }
                            : undefined
                        }
                        channels={{
                          rows: section.hiddenRows,
                          selected: preserveSidebar ? undefined : current?.id,
                          select,
                        }}
                        onRemove={
                          preferences.removeSectionWritable &&
                          section.key.startsWith("group:")
                            ? async () => {
                                await preferences.removeSection(
                                  section.key.slice(6),
                                );
                                sidebar.toggle(section.key, true);
                              }
                            : undefined
                        }
                        menuActions={
                          section.key.startsWith("group:")
                            ? (dismiss, trigger) => (
                                <MenuItem
                                  onClick={() => {
                                    dismiss();
                                    requestAnimationFrame(() => {
                                      if (mounted.current)
                                        setWorkspaceSettings({
                                          id: section.key.slice(6),
                                          name: section.title,
                                          icon: section.icon,
                                          trigger,
                                        });
                                    });
                                  }}
                                >
                                  Workspace settings
                                </MenuItem>
                              )
                            : undefined
                        }
                        headerActions={
                          section.key.startsWith("group:") ? (
                            workspaceNewAction(
                              section.key.slice(6),
                              section.title,
                            )
                          ) : section.key === "solo" ? (
                            <IconButton
                              size="compact"
                              aria-label="New Solo chat"
                              title="New chat"
                              icon={<PlusIcon size={15} strokeWidth={2.5} />}
                              onClick={() => newChat()}
                            />
                          ) : null
                        }
                        removalFocus={() =>
                          sidebar.list.current?.querySelector<HTMLButtonElement>(
                            '[data-sidebar-section="channels"] button',
                          )
                        }
                        createChannel={
                          section.key === "starred" ||
                          section.key === "channels"
                            ? {
                                available: queries.channelCreation.available,
                                open: (trigger) => {
                                  createChannelTrigger.current = trigger;
                                  setInitialStarred(section.key === "starred");
                                  setInitialGroup("");
                                  setCreateChannelOpen(true);
                                },
                              }
                            : undefined
                        }
                        createSection={
                          section.key === "channels"
                            ? {
                                available: preferences.sectionCreationWritable,
                                open: (trigger) => {
                                  createSectionTrigger.current = trigger;
                                  requestAnimationFrame(() => {
                                    if (mounted.current)
                                      setCreatingSection(true);
                                  });
                                },
                              }
                            : undefined
                        }
                        newMessage={
                          section.key === "dms"
                            ? () => {
                                if (
                                  viewer &&
                                  relay.snapshot().session === queries
                                )
                                  void navigator.open({
                                    version: 1,
                                    kind: "page",
                                    pluginId: "buzz.channels",
                                    pageId: "channels",
                                    scope: {
                                      viewer,
                                      communityOrigin: scope.slice(
                                        0,
                                        -(viewer.length + 1),
                                      ),
                                    },
                                    route: {
                                      version: 1,
                                      params: "new-message",
                                    },
                                  });
                              }
                            : undefined
                        }
                        sort={
                          preferences.sortWritable
                            ? {
                                value: sectionSort(section.key),
                                modes: rowSortModes,
                                change: (mode) =>
                                  setSectionSort(section.key, mode),
                              }
                            : undefined
                        }
                      >
                        <ChannelSidebarRows
                          open={
                            !sidebar.collapsed.includes(section.key) ||
                            renamingSection === section.key
                          }
                        >
                          {[
                            ...(composedChatSections.has(section.key)
                              ? []
                              : sectionDrafts(section.key)),
                            ...section.rows.map((channel) => {
                              if (channel.id === renamingChat)
                                return (
                                  <SoloChatName
                                    key={channel.id}
                                    session={queries}
                                    id={channel.id}
                                    title={channel.name}
                                    className={styles.unifiedChatName}
                                    onAbandon={() => {
                                      const ids = section.rows.map(
                                        ({ id }) => id,
                                      );
                                      const index = ids.indexOf(channel.id);
                                      const neighbors = [
                                        ...ids.slice(index + 1),
                                        ...ids.slice(0, index).reverse(),
                                      ];
                                      const rows = activeChannelRows(
                                        sidebar.list.current,
                                      );
                                      const target = neighbors
                                        .map((id) =>
                                          rows.find(
                                            (row) =>
                                              row.dataset.channelId === id,
                                          ),
                                        )
                                        .find(Boolean);
                                      (
                                        target ??
                                        sidebar.list.current?.querySelector<HTMLElement>(
                                          `[data-sidebar-section="${CSS.escape(section.key)}"] summary`,
                                        )
                                      )?.focus({ preventScroll: true });
                                    }}
                                    close={(focus) => {
                                      renameFocus.current = focus
                                        ? {
                                            id: channel.id,
                                            from: document.activeElement,
                                          }
                                        : undefined;
                                      setRenamingChat(undefined);
                                    }}
                                  />
                                );
                              const selected =
                                !preserveSidebar && current?.id === channel.id
                                  ? current.id
                                  : undefined;
                              // Every row offers Copy link; build items only for the open
                              // menu. useChannelRowMenu closes a menu left with none.
                              const menuOpen =
                                rowMenu?.channelId === channel.id &&
                                rowMenu.sectionKey === section.key;
                              return (
                                <ChannelSidebarItem
                                  profile={
                                    channel.channelType === "dm" &&
                                    channel.participants?.length === 1
                                      ? dmProfiles.get(
                                          channel.participants[0] ?? "",
                                        )
                                      : undefined
                                  }
                                  key={channel.id}
                                  channel={channel}
                                  chatIcon={
                                    channel.channelType === "solo"
                                      ? chatIcon
                                      : undefined
                                  }
                                  rowContributions={rowContributions}
                                  onHiddenChange={setRowHidden}
                                  session={queries}
                                  working={workingChannels.has(channel.id)}
                                  selected={
                                    composingMessage ? undefined : selected
                                  }
                                  onSelect={select}
                                  onShareChat={shareChat}
                                  navigation={navigator}
                                  pendingClick={pendingChatClick}
                                  onRename={
                                    channel.channelType === "solo" &&
                                    !renamingChat &&
                                    canEditLifetime(queries, channel)
                                      ? renameChat
                                      : undefined
                                  }
                                  onOpenThread={openActivityThread}
                                  onOpenMessage={openActivityMessage}
                                  onOpenWorkingAgent={openWorkingAgent}
                                  onOpenAgentActivity={openAgentActivity}
                                  menuEnabled
                                  sectionKey={section.key}
                                  selectFrame={
                                    regions.managed.has(channel.id)
                                      ? undefined
                                      : DraggableChannel
                                  }
                                  onOpenMenu={openRowMenu}
                                  menuOpen={menuOpen}
                                  menuAnchor={
                                    menuOpen ? rowMenu.anchor : undefined
                                  }
                                  menuContent={
                                    menuOpen ? (
                                      <>
                                        {rowActions(channel, section.key)}
                                        {readWrite?.pending && (
                                          <p role="status">Saving…</p>
                                        )}
                                        {readWrite?.error && (
                                          <p role="alert">{readWrite.error}</p>
                                        )}
                                      </>
                                    ) : undefined
                                  }
                                  onCloseMenu={closeRowMenu}
                                  onMenuClosed={rowMenuClosed}
                                  menuFinalFocus={rowMenuFinalFocus}
                                />
                              );
                            }),
                          ]}
                        </ChannelSidebarRows>
                        <SectionShowMore
                          sectionKey={section.key}
                          title={section.title}
                          cap={section.cap}
                          more={() => {
                            sectionLimits.change(
                              section.key,
                              (section.cap.limit === "all"
                                ? 0
                                : section.cap.limit) + SECTION_ROW_STEP,
                            );
                            setStepFocus(section.key);
                          }}
                          fewer={() => {
                            sectionLimits.change(
                              section.key,
                              0,
                              section.allRows.map(({ id }) => id),
                            );
                            setStepFocus(section.key);
                          }}
                        />
                      </DroppableSidebarSection>
                    );
                  }}
                />
              ),
            })),
            ...orderedContributions.map((entry, index) => {
              const sectionKey = contributedSidebarSectionKey(entry.key);
              const previousKey = orderedContributions[index - 1]?.key;
              const nextKey = orderedContributions[index + 1]?.key;
              const reorderable = contributions.length > 1;
              return {
                id: sectionKey,
                title: entry.title,
                defaultPosition: filteredSections.length + index,
                element: (
                  <SidebarContributionSection
                    key={entry.key}
                    entry={entry}
                    registry={contributedSections ?? emptySidebarSections}
                    navigator={navigator}
                    target={target}
                    open={!sidebar.collapsed.includes(sectionKey)}
                    onToggle={(open) => sidebar.toggle(sectionKey, open)}
                    groupIndex={index}
                    reorderable={reorderable}
                    onRowsCommitted={sidebar.retryReveal}
                    move={
                      reorderable
                        ? {
                            ...(previousKey
                              ? {
                                  up: () =>
                                    reorderContributions(
                                      sectionKey,
                                      contributedSidebarSectionKey(previousKey),
                                    ),
                                }
                              : {}),
                            ...(nextKey
                              ? {
                                  down: () =>
                                    reorderContributions(
                                      sectionKey,
                                      contributedSidebarSectionKey(nextKey),
                                    ),
                                }
                              : {}),
                          }
                        : undefined
                    }
                  />
                ),
              };
            }),
          ]}
        >
          {children}
        </TeamSidebarSections>
      </ChannelSidebarDnd>
    ),
    content: (
      <>
        {!startup.ready && (
          <p className={styles.empty} role="status">
            Loading your sidebar…
          </p>
        )}
        {list.status === "error" && !rosterRecovers && (
          <p role="alert" className={styles.empty}>
            {list.error}
          </p>
        )}
        {startup.ready && list.status === "ready" && !channels.length && (
          <p className={styles.empty}>No channels yet.</p>
        )}
      </>
    ),
    after: (
      <>
        {cached && connectionError && (
          <p className={styles.preferenceNotice} role="status">
            Offline · Showing saved conversations.
            <Button onClick={relay.tryAgain}>Retry connection</Button>
          </p>
        )}
        {preferences.sortErrors?.map(({ group, mode, error }) => (
          <div key={group} className={styles.preferenceNotice} role="alert">
            <p>
              Couldn’t save the sort order for{" "}
              {sections.find(
                ({ key }) =>
                  key ===
                  (group.startsWith("section:")
                    ? `group:${group.slice(8)}`
                    : group),
              )?.title ?? "this section"}
              . {error}
            </p>
            <button type="button" onClick={() => setSectionSort(group, mode)}>
              Retry sort
            </button>
            <button
              type="button"
              onClick={() => preferences.dismissSortError(group)}
            >
              Dismiss
            </button>
          </div>
        ))}
        {preferences.filterErrors?.map(
          ({ group, mode, activeWindowSeconds, error }) => (
            <div key={group} className={styles.preferenceNotice} role="alert">
              <p>
                Couldn’t save the filter for{" "}
                {sections.find(
                  ({ key }) =>
                    key ===
                    (group.startsWith("section:")
                      ? `group:${group.slice(8)}`
                      : group),
                )?.title ?? "this section"}
                . {error}
              </p>
              <button
                type="button"
                onClick={() =>
                  void setSectionFilter(group, mode, activeWindowSeconds).catch(
                    () => {},
                  )
                }
              >
                Retry filter
              </button>
              <button
                type="button"
                onClick={() => preferences.dismissFilterError(group)}
              >
                Dismiss
              </button>
            </div>
          ),
        )}
        {preferences.orderError && (
          <div className={styles.preferenceNotice} role="alert">
            <p>
              Couldn’t save the move for{" "}
              {sections.find(
                ({ key }) => key === preferences.orderError?.sectionId,
              )?.title ?? "this section"}
              . {preferences.orderError.error}
            </p>
            <p>
              The previous placement is shown. A partial save may already exist
              on the relay.
            </p>
            {!preferences.sectionOrderWritable && (
              <p>
                Refresh saved sidebar preferences before retrying this move.
              </p>
            )}
            <button
              type="button"
              disabled={!preferences.sectionOrderWritable}
              onClick={() => {
                const failed = preferences.orderError;
                if (!failed) return;
                void preferences
                  .reorderSections(failed.sectionId, failed.sectionIds)
                  .catch(() => {});
                setGroupFocus(failed.sectionId);
              }}
            >
              Retry move
            </button>
            <button
              type="button"
              onClick={() => {
                const failed = preferences.orderError;
                preferences.dismissOrderError();
                if (failed) setGroupFocus(failed.sectionId);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {preferences.moves
          ?.filter((move) => !move.pending)
          .map((move) => (
            <div key={move.id} className={styles.preferenceNotice} role="alert">
              <p>
                Couldn’t save the move for{" "}
                {channels.find(({ id }) => id === move.channelId)?.name ??
                  "this channel"}
                . {move.error}
              </p>
              <p>
                The previous placement is shown. A partial save may already
                exist on the relay.
              </p>
              {!preferences.writable && (
                <p>
                  Refresh saved sidebar preferences before retrying this move.
                </p>
              )}
              <button
                type="button"
                disabled={
                  !preferences.writable || regions.managed.has(move.channelId)
                }
                onClick={() =>
                  !prepareSoloMove(queries, move.channelId) &&
                  moveChannel(move.channelId, () =>
                    preferences.retryMove(move.channelId),
                  )
                }
              >
                Retry move
              </button>
              <button
                type="button"
                onClick={() => {
                  preferences.dismissMoveError(move.channelId);
                  focusChannelPlacement(move.channelId);
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        {!cached &&
        startup.ready &&
        preferences.data?.workspaceMigrationPending ? (
          <ToastNotice
            title="Some workspaces couldn’t load"
            description="Retry to load your previous workspaces and edit the layout."
            tone="warning"
          >
            <Button type="button" size="sm" onClick={preferences.reload}>
              Retry
            </Button>
          </ToastNotice>
        ) : !cached &&
          startup.ready &&
          preferences.status === "error" &&
          !preferences.transient ? (
          <ToastNotice
            title="Saved sidebar preferences couldn’t refresh"
            description="Your conversations are still available."
            tone="warning"
          >
            <Button type="button" size="sm" onClick={preferences.reload}>
              Retry
            </Button>
          </ToastNotice>
        ) : !cached && startup.ready && preferences.status === "unsupported" ? (
          <p className={styles.preferenceNotice} role="status">
            Saved groups and stars aren’t supported by this host yet.
          </p>
        ) : null}
        {list.activityStatus === "error" && !activityErrorDismissed && (
          <ToastNotice
            title="Couldn’t refresh recent activity"
            description="Activity filters and Recent sorting may be out of date."
            tone="warning"
            onDismiss={() => setActivityErrorDismissed(true)}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => queries.channels.refreshList?.()}
            >
              Retry
            </Button>
          </ToastNotice>
        )}
      </>
    ),
    dialogs: (
      <>
        {chatTool?.kind === "settings" && (
          <WorkspaceSettings
            key={chatTool.channel.id}
            session={queries}
            scope={scope}
            signal={chatTool.visit}
            target={{
              kind: "chat",
              id: chatTool.channel.id,
              name: chatTool.channel.name,
            }}
            close={() => setChatTool(undefined)}
            finalFocus={() => rowMenuFinalFocus(chatTool.channel.id)}
          />
        )}
        {chatTool?.kind === "share" && (
          <ChannelMembersDialog
            key={chatTool.channel.id}
            session={queries}
            channelId={chatTool.channel.id}
            navigator={navigator}
            signal={chatTool.visit}
            trigger={{
              get current() {
                if (
                  chatTool.trigger?.isConnected &&
                  !chatTool.trigger.closest("[inert]")
                )
                  return chatTool.trigger;
                return (
                  activeChannelRows(sidebar.list.current).find(
                    (row) => row.dataset.channelId === chatTool.channel.id,
                  ) ?? null
                );
              },
            }}
            close={() => setChatTool(undefined)}
          />
        )}
        {chatTool?.kind === "convert" && (
          <ConvertToChannel
            key={chatTool.channel.id}
            session={queries}
            id={chatTool.channel.id}
            signal={chatTool.visit}
            onConverted={() => select(chatTool.channel.id)}
            close={() => setChatTool(undefined)}
            finalFocus={() => rowMenuFinalFocus(chatTool.channel.id)}
          />
        )}
        {workspaceSettings && (
          <WorkspaceSettings
            key={workspaceSettings.id}
            session={queries}
            scope={scope}
            target={{ kind: "project", ...workspaceSettings }}
            close={() => setWorkspaceSettings(undefined)}
            finalFocus={workspaceSettings.trigger}
          />
        )}
        {creatingSection && (
          <NewWorkspace
            session={queries}
            finalFocus={createSectionTrigger}
            close={() => setCreatingSection(false)}
            create={preferences.createSection}
            onCreated={(id) => sidebar.toggle(`group:${id}`, true)}
          />
        )}
        {creatingFor && !creatingFor.surface?.signal?.aborted && (
          <NewWorkspace
            session={queries}
            moveConversation
            create={(section) => {
              creatingFor.surface?.signal?.throwIfAborted();
              const refusal = prepareSoloMove(queries, creatingFor.channel.id);
              if (refusal) return Promise.reject(new Error(refusal));
              return preferences.createAndAssign(creatingFor.channel.id, {
                ...section,
                ...(creatingFor.position
                  ? { position: creatingFor.position }
                  : {}),
              });
            }}
            onCreated={(id) => {
              if (creatingFor.channel.channelType !== "solo")
                sidebar.toggle(`group:${id}`, true);
            }}
            finalFocus={() =>
              creatingFor.surface
                ? false
                : (rowFocusTarget(creatingFor.channel.id) ??
                  sidebarFocusFallback() ??
                  false)
            }
            close={() => {
              setCreatingFor(undefined);
              if (mounted.current) creatingFor.surface?.focus();
            }}
          />
        )}
        <CreateChannelDialog
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
          onCreate={createChannel}
          finalFocus={createChannelTrigger}
          session={queries}
          agents={agents}
          destinations={preferences.data?.sections ?? []}
          initialGroup={initialGroup}
          initialStarred={initialStarred}
          groupsReady={preferences.writable}
        />
      </>
    ),
  });
}
