import { workspaceSectionOrder } from "../../features/relay/sidebar-preferences";
import { FadingLabel } from "./FadingLabel";
import { ChannelSidebarRows } from "../../features/channel-navigation/ChannelSidebarRows";
import { createPortal } from "react-dom";
import type { ComposeWorkspaces } from "../../features/channel-navigation/WorkspaceComposition";
import type { WorkspaceSidebarComposition } from "./sidebar-environment";
import { sidebarDropRowKinds } from "./sidebar-sections";
import { prepareSoloMove } from "../../features/channel-navigation/solo-navigation";
import { useChatConversions } from "../../features/solo/conversion";
import { ConvertToChannel } from "../../features/solo/ConvertToChannel";
import { ChatSharedMark } from "./ChatSharedMark";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { SoloChatName } from "./SoloChatName";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { matchesConversation } from "../../features/channel-navigation/routes";
import {
  soloNeighbors,
  soloSuccessor,
} from "../../features/channel-navigation/solo-successor";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Collapsible } from "@base-ui/react/collapsible";
import { useDroppable } from "@dnd-kit/core";
import {
  ChannelSidebarDnd,
  DraggableChannel,
  useSidebarSectionDrag,
} from "../../features/channel-navigation/ChannelSidebarDnd";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import {
  memo,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationSectionHeading } from "../../shared/design-system/ui/NavigationSection";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import type { Navigation } from "../../features/navigation/controller";
import { SoloChatMenuItems } from "./SoloChatMenu";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import styles from "./SoloWorkspaces.module.css";
import channelStyles from "./Channels.module.css";
import {
  sidebarRow,
  type RegisteredSidebarRows,
} from "../../features/channel-navigation/sidebar-rows-service";
import { SidebarRowRenderer } from "../../features/channel-navigation/SidebarRowRenderer";

const emptyRows: readonly RegisteredSidebarRows[] = [];

/** Presentation only. The caller supplies authorized, saved chats. */
export type ChatListItem = Readonly<{
  id: string;
  title: string;
  /** Stays listed past a workspace's cap, like the open or an unread chat. */
  pinned?: boolean;
}>;

/** Each workspace lists its most recent chats; Show more adds a step. */
export const SOLO_CHAT_CAP = 7;
export const SOLO_CHAT_STEP = 10;
const workspaceSectionKey = (id: string) => (id ? `group:${id}` : "solo");

/** The existing relay preference service owns delivery, rollback and retry. */
export function SoloWorkspaces({
  session,
  navigator: navigationController,
  scope,
  chats,
  dormantAssignments,
  renderChat,
  renderChatMenu,
  onNew,
  onConverted,
  drafts = [],
  sidebarRows = emptyRows,
  compose,
  workspaceComposition,
}: {
  compose?: ComposeWorkspaces | undefined;
  workspaceComposition?: WorkspaceSidebarComposition | undefined;
  drafts?: readonly {
    id: string;
    projectId?: string | undefined;
    content: ReactNode;
  }[];
  onConverted?: ((id: string) => void) | undefined;
  session: RelaySession;
  navigator?: Navigation | undefined;
  scope: string;
  chats: readonly ChatListItem[];
  /** Existing assignments stay stored but do not place source-managed chats. */
  dormantAssignments?: ReadonlySet<string> | undefined;
  sidebarRows?: readonly RegisteredSidebarRows[] | undefined;
  renderChatMenu?: ((channelId: string) => ReactNode) | undefined;
  /** A stable function lets a chat's row skip renders when nothing it shows changed. */
  renderChat: (
    item: ChatListItem,
    rename: (() => boolean) | undefined,
    channel: ChannelSummary | undefined,
  ) => ReactNode;
  onNew?: (projectId?: string) => void;
}) {
  useChatConversions(session);
  const handoff = useChannelNavigation();
  const pluginHiddenRows = useRef(new Map<string, object>());
  const setRowHidden = useCallback((id: string, hidden: boolean) => {
    const registration = {};
    if (hidden) pluginHiddenRows.current.set(id, registration);
    else pluginHiddenRows.current.delete(id);
    return () => {
      if (pluginHiddenRows.current.get(id) === registration)
        pluginHiddenRows.current.delete(id);
    };
  }, []);
  const preferences = session.sidebarPreferences;
  const rowHosts = useRef(new Map<string, WorkspaceRowsHost>());
  const collapsedKey = "solo:collapsed-projects";
  const expandedKey = "solo:expanded-projects";
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  useEffect(() => {
    if (channels.status === "ready") void preferences.ensure();
  }, [preferences, channels.status]);
  const [localCollapsed, setCollapsed] = useState<string[]>(() => {
    if (workspaceComposition) return [];
    const saved = readView<unknown>(scope, collapsedKey, []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const collapsed = workspaceComposition
    ? workspaceComposition.collapsed.flatMap((key) =>
        key === "solo" ? [""] : key.startsWith("group:") ? [key.slice(6)] : [],
      )
    : localCollapsed;
  // Extra chats each workspace shows past the cap, remembered like collapse.
  const [expanded, setExpanded] = useState<Record<string, number>>(() => {
    const saved = readView<unknown>(scope, expandedKey, {});
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? Object.fromEntries(
          Object.entries(saved).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && entry[1] > 0,
          ),
        )
      : {};
  });
  // Chats listed past the cap (pinned, or just moved in) stay listed until the
  // workspace folds, so a row never disappears while someone is using it.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const hold = useCallback((ids: readonly string[]) => {
    setHeld((current) =>
      ids.every((id) => current.has(id))
        ? current
        : new Set([...current, ...ids]),
    );
  }, []);
  const [sharing, setSharing] = useState<{
    id: string;
    visit: AbortSignal | undefined;
    /** The shared mark that opened it; menu launches return to the row. */
    trigger?: HTMLElement;
  }>();
  const sharingChannel = channels.channels.find(
    (channel) => channel.id === sharing?.id,
  );
  const [converting, setConverting] = useState<{
    id: string;
    visit: AbortSignal | undefined;
  }>();
  // Read when an action fires: a thread move aborts the visit without rendering here.
  const currentVisit = () => navigationController?.snapshot().attempt.signal;
  const [chatSettings, setChatSettings] = useState<{
    item: ChatListItem;
    visit: AbortSignal | undefined;
  }>();
  const [renaming, setRenaming] = useState<string>();
  if (renaming && !chats.some((chat) => chat.id === renaming))
    setRenaming(undefined);
  const [deleting, setDeleting] = useState<string>();
  const [projectError, setProjectError] = useState("");
  const [readError, setReadError] = useState<{ id: string; message: string }>();
  const [animate, setAnimate] = useState(false);
  const [rowFocus, setRowFocus] = useState<string>();
  useLayoutEffect(() => {
    if (!rowFocus) return;
    const project =
      snapshot.data?.sections.find(
        (section) => section.id === snapshot.data?.assignments[rowFocus],
      )?.id ?? "";
    // Resolve against current visibility when focus is restored, including when
    // collapse was requested after the asynchronous save began.
    const closed =
      collapsed.includes(project) && !rowHosts.current.get(project)?.unframed;
    const target = CSS.escape(closed ? `project-${project}` : rowFocus);
    document
      .querySelector<HTMLElement>(
        `[data-solo-menu-id="${target}"]:not([inert] *) ${closed ? "button[aria-expanded]:not([aria-haspopup])" : "button"}`,
      )
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus, collapsed, snapshot.data]);
  // Show more and Show fewer each unmount once spent; focus stays on the row,
  // or moves to the workspace's last chat when nothing is left to show or fold.
  const [stepFocus, setStepFocus] = useState<string>();
  useLayoutEffect(() => {
    if (stepFocus === undefined) return;
    setStepFocus(undefined);
    const row = document.querySelector<HTMLElement>(
      `[data-solo-show-more="${CSS.escape(stepFocus)}"]`,
    );
    if (row?.contains(document.activeElement)) return;
    const panel = document.querySelector(
      `[data-solo-project="${CSS.escape(stepFocus)}"]`,
    );
    const chats =
      panel?.querySelectorAll("[data-solo-menu-id]:not([inert] *)") ?? [];
    const target =
      row?.querySelector<HTMLElement>("button") ??
      [...chats].at(-1)?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  }, [stepFocus]);
  const [creatingFor, setCreatingFor] = useState<ChatListItem>();
  const [settingsFor, setSettingsFor] = useState<{
    id: string;
    name: string;
  }>();
  const order = workspaceSectionOrder(snapshot.data);
  const sections = snapshot.data?.sections ?? [];
  const groups = snapshot.data?.sectionOrder
    ? order.flatMap((key) => sections.filter(({ id }) => key === `group:${id}`))
    : sections;
  const orderWritable = preferences.sectionOrderWritable;
  const [orderFocus, setOrderFocus] = useState<string>();
  useLayoutEffect(() => {
    if (!orderFocus) return;
    document
      .querySelector<HTMLElement>(
        `[data-solo-menu-id="project-${CSS.escape(orderFocus)}"]:not([inert] *) button`,
      )
      ?.focus({ preventScroll: true });
    setOrderFocus(undefined);
  }, [orderFocus]);
  const moveProject = (id: string, to: number) => {
    if (workspaceComposition) {
      const key = workspaceSectionKey(id);
      const next = order.filter((section) => section !== key);
      next.splice(to, 0, key);
      void preferences.reorderSections(key, next).catch(() => {});
      return;
    }
    const ids = groups.map((group) => group.id).filter((key) => key !== id);
    ids.splice(to, 0, id);
    if (!snapshot.data?.sectionOrder) {
      void preferences.reorderSections(id, ids).catch(() => {});
      return;
    }
    let next = 0;
    const reordered = order.map((key) =>
      key.startsWith("group:") ? `group:${ids[next++]}` : key,
    );
    void preferences.reorderSections(`group:${id}`, reordered).catch(() => {});
  };
  const assigned = snapshot.data?.assignments ?? {};
  const assignmentFor = (item: ChatListItem) =>
    dormantAssignments?.has(item.id) ? undefined : assigned[item.id];
  const ids = new Set(groups.map((group) => group.id));
  const projects = [
    ...groups.map((group) => ({
      ...group,
      rows: chats.filter((item) => assignmentFor(item) === group.id),
    })),
    {
      id: "",
      name: "Chats",
      rows: chats.filter((item) => !ids.has(assignmentFor(item) ?? "")),
    },
  ].filter(
    (project) =>
      !workspaceComposition ||
      workspaceComposition.sections.has(workspaceSectionKey(project.id)),
  );
  // A collapse request takes effect after the editor closes. Keep its draft and
  // save owner mounted and reachable, including when a save needs recovery.
  const renamingProject = projects.find((project) =>
    project.rows.some((item) => item.id === renaming),
  )?.id;
  const move = (id: string, projectId?: string) => {
    const refusal = prepareSoloMove(session, id);
    if (refusal) {
      setProjectError(refusal);
      return;
    }
    setProjectError("");
    const saving = preferences.assign(id, projectId);
    hold([id]);
    setRowFocus(id);
    void saving.catch(() => {
      // A rollback remounts the original row. Do not steal focus if the user moved on.
      if (
        !document.querySelector(`[data-solo-menu-id="${id}"]:not([inert] *)`) ||
        document.activeElement !== document.body
      )
        return;
      setRowFocus(id);
    });
  };
  // Matches the open chat's own actions menu: leaving the open chat opens its
  // nearest sidebar neighbor (or a new draft), unless the user has moved on.
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    const neighbors = handoff?.soloNeighbors.current?.(channel.id) ?? [];
    const trigger =
      document.querySelector<HTMLElement>(
        `[data-solo-menu-id="${CSS.escape(channel.id)}"]:not([inert] *) button`,
      ) ?? undefined;
    const current = navigationController?.snapshot();
    const leavesOpenChat =
      action !== "unarchive" &&
      current?.entry.target.kind === "conversation" &&
      current.entry.target.channelId === channel.id;
    // Let the menu restore focus before opening confirmation.
    requestAnimationFrame(() =>
      handoff?.openLifecycle(channel, action, trigger, undefined, {
        close() {
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        },
        depart(visit) {
          const shown = new Set(handoff?.soloNeighbors.current?.(channel.id));
          const active =
            visit === "current"
              ? matchesConversation(
                  navigationController?.snapshot().entry.target,
                  scope,
                  channel.id,
                )
              : leavesOpenChat && !current.attempt.signal.aborted;
          if (active)
            void navigationController?.open(
              soloSuccessor(
                scope,
                session.channels.list().channels,
                neighbors.filter((id) => shown.has(id)),
                channel.id,
              ),
            );
        },
      }),
    );
  };
  const toggle = (id: string, open: boolean) => {
    if (workspaceComposition) {
      workspaceComposition.toggle(workspaceSectionKey(id), open);
      return;
    }
    const next = collapsed.filter((key) => key !== id);
    if (!open) next.push(id);
    setCollapsed(next);
    writeView(scope, collapsedKey, next);
  };
  const expand = (id: string, extra: number) => {
    const rest = Object.fromEntries(
      Object.entries(expanded).filter(([key]) => key !== id),
    );
    const next = extra > 0 ? { ...rest, [id]: extra } : rest;
    setExpanded(next);
    writeView(scope, expandedKey, next);
    if (extra === 0) {
      // Folding releases retained chats; ones still pinned stay held.
      const rows = new Set(
        projects
          .find((project) => project.id === id)
          ?.rows.filter((item) => !item.pinned)
          .map((item) => item.id),
      );
      setHeld(
        (current) => new Set([...current].filter((key) => !rows.has(key))),
      );
    }
    setStepFocus(id);
  };
  const visible = projects
    .filter(
      (project) =>
        compose ||
        project.id ||
        project.rows.length ||
        drafts.some(
          (draft) =>
            (ids.has(draft.projectId ?? "") ? draft.projectId : "") ===
            project.id,
        ),
    )
    .map((project) => {
      // A list that shrank back under the cap has nothing to fold.
      const extra =
        project.rows.length > SOLO_CHAT_CAP ? (expanded[project.id] ?? 0) : 0;
      const limit = SOLO_CHAT_CAP + extra;
      // Rows arrive newest first; chats kept past the cap keep that order.
      const listed = project.rows.filter(
        (item, index) =>
          index < limit ||
          item.pinned ||
          item.id === renaming ||
          held.has(item.id),
      );
      return {
        ...project,
        listed,
        extra,
        overflow: listed.slice(limit).map((item) => item.id),
        // Retained chats that are no longer pinned can fold even when unexpanded.
        foldable:
          extra > 0 ||
          listed
            .slice(limit)
            .some((item) => !item.pinned && item.id !== renaming),
        hidden: project.rows.length - listed.length,
      };
    });
  const soloNeighborsRef = handoff?.soloNeighbors;
  useLayoutEffect(() => {
    if (!soloNeighborsRef) return;
    const neighbors = (id: string) =>
      soloNeighbors(
        visible.map((project) => ({
          rows: project.rows,
          shown:
            collapsed.includes(project.id) &&
            !rowHosts.current.get(project.id)?.unframed
              ? []
              : project.listed.map((item) => item.id),
        })),
        id,
      ).filter((neighbor) => !pluginHiddenRows.current.has(neighbor));
    soloNeighborsRef.current = neighbors;
    return () => {
      if (soloNeighborsRef.current === neighbors)
        soloNeighborsRef.current = undefined;
    };
  });
  const overflow = visible.flatMap((project) => project.overflow).join(" ");
  useEffect(() => {
    if (overflow) hold(overflow.split(" "));
  }, [overflow, hold]);
  const canRename = (projectId: string, channel: ChannelSummary | undefined) =>
    !renaming && deleting !== projectId && canEditLifetime(session, channel);
  // Rows find their actions here when used, so their props stay stable.
  const actions: ChatEntryActions = {
    share: (id, trigger) =>
      setSharing({
        id,
        visit: currentVisit(),
        ...(trigger ? { trigger } : {}),
      }),
    convert: (id) => setConverting({ id, visit: currentVisit() }),
    move,
    newWorkspace: (id) => setCreatingFor(chats.find((item) => item.id === id)),
    settings: (id) => {
      const item = chats.find((item) => item.id === id);
      if (item) setChatSettings({ item, visit: currentVisit() });
    },
    rename: (id) => {
      const project = projects.find((project) =>
        project.rows.some((item) => item.id === id),
      );
      const channel = channels.channels.find((channel) => channel.id === id);
      if (!project || !canRename(project.id, channel)) return false;
      setRenaming(id);
      return true;
    },
    lifecycle: chooseLifecycle,
    readResult: (id, error) =>
      setReadError((current) =>
        error
          ? { id, message: error }
          : current?.id === id
            ? undefined
            : current,
      ),
  };
  const entryActions = useRef(actions);
  useLayoutEffect(() => {
    entryActions.current = actions;
  });
  const moves =
    snapshot.moves?.filter((move) =>
      chats.some((item) => item.id === move.channelId),
    ) ?? [];
  const entries = visible.map((project) => {
    const sharedFrame = !!workspaceComposition && !!project.id;
    const projectKey = sharedFrame
      ? workspaceSectionKey(project.id)
      : DROP + project.id;
    const groupIndex = workspaceComposition
      ? order.indexOf(projectKey)
      : groups.findIndex((group) => group.id === project.id);
    const lastIndex = (workspaceComposition ? order.length : groups.length) - 1;
    const reorderable = !!project.id && orderWritable;
    const open =
      !collapsed.includes(project.id) || renamingProject === project.id;
    const changeOpen = (open: boolean) =>
      toggle(
        project.id,
        renamingProject === project.id ? !collapsed.includes(project.id) : open,
      );
    const frame = (children: ReactNode) => (
      <DropProject
        projectKey={projectKey}
        shared={sharedFrame}
        registerFrame={
          project.id ? workspaceComposition?.registerFrame : undefined
        }
        groupIndex={groupIndex}
        reorderable={reorderable}
        disabled={
          !preferences.writable || (!!workspaceComposition && !sharedFrame)
        }
        key={project.id}
        className={`${styles.project} ${channelStyles.channelSection}`}
        data-project={project.id ? "" : undefined}
        open={!collapsed.includes(project.id) || renamingProject === project.id}
        onOpenChange={(open) =>
          toggle(
            project.id,
            renamingProject === project.id
              ? collapsed.includes(project.id)
              : open,
          )
        }
        data-animate={animate || undefined}
      >
        {children}
      </DropProject>
    );
    const header = (
      primary: ReactNode,
      trailing?: ReactNode,
      actions?: ReactNode,
    ) => (
      <ChatActionsMenu
        id={`project-${project.id}`}
        title={project.name}
        className={styles.workspaceHeader}
        enabled={!!project.id}
        content={
          <>
            {actions}
            <MenuItem
              disabled={!orderWritable || groupIndex <= 0}
              onClick={() => moveProject(project.id, groupIndex - 1)}
            >
              <MenuIcon>
                <ArrowUpIcon size={14} />
              </MenuIcon>
              Move up
            </MenuItem>
            <MenuItem
              disabled={!orderWritable || groupIndex >= lastIndex}
              onClick={() => moveProject(project.id, groupIndex + 1)}
            >
              <MenuIcon>
                <ArrowDownIcon size={14} />
              </MenuIcon>
              Move down
            </MenuItem>
            <MenuItem onClick={() => setSettingsFor(project)}>
              Workspace settings
            </MenuItem>
            <MenuItem
              tone="danger"
              data-delete-solo-project=""
              disabled={
                !preferences.sectionRemovalWritable ||
                !!deleting ||
                renamingProject === project.id
              }
              onClick={() => {
                setDeleting(project.id);
                setProjectError("");
                void preferences
                  .removeSection(project.id)
                  .catch((error: unknown) => {
                    setProjectError(
                      error instanceof Error
                        ? error.message
                        : "Workspace could not be deleted. Try again.",
                    );
                  })
                  .finally(() => setDeleting(undefined));
              }}
            >
              Delete workspace
            </MenuItem>
          </>
        }
      >
        {(overflow) => (
          <NavigationSectionHeading
            disclosure
            revealActions
            actions={
              <>
                {overflow}
                {project.id &&
                  workspaceComposition?.newAction(project.id, project.name)}
                {trailing ??
                  (onNew &&
                    !workspaceComposition &&
                    (!compose || !project.id) && (
                      <IconButton
                        size="compact"
                        aria-label={`New chat in ${project.name}`}
                        title="New chat"
                        icon={<PlusIcon size={15} strokeWidth={2.5} />}
                        onClick={() => onNew(project.id || undefined)}
                      />
                    ))}
              </>
            }
          >
            <WorkspaceDragHandle
              sectionKey={projectKey}
              groupIndex={groupIndex}
              reorderable={reorderable}
            >
              {primary}
            </WorkspaceDragHandle>
          </NavigationSectionHeading>
        )}
      </ChatActionsMenu>
    );
    let rowsHost = rowHosts.current.get(project.id);
    if (!rowsHost) {
      rowsHost = { element: document.createElement("div") };
      rowHosts.current.set(project.id, rowsHost);
    }
    const rows = (
      <>
        {drafts
          .filter(
            (draft) =>
              (ids.has(draft.projectId ?? "") ? draft.projectId : "") ===
              project.id,
          )
          .map((draft) => (
            <ChatActionsMenu
              key={draft.id}
              id={`new-chat-draft:${draft.id}`}
              title="New chat"
              className={styles.organizedRow}
              content={null}
              enabled={false}
            >
              <div>{draft.content}</div>
            </ChatActionsMenu>
          ))}
        <ChannelSidebarRows open={open}>
          {project.listed.map((item) => {
            const channel = channels.channels.find(
              (channel) => channel.id === item.id,
            );
            if (renaming === item.id)
              return (
                <SoloChatName
                  key={item.id}
                  session={session}
                  id={item.id}
                  title={item.title}
                  close={(focus) => {
                    setRenaming(undefined);
                    if (focus) setRowFocus(item.id);
                  }}
                />
              );
            const row = (
              <SoloChatEntry
                key={item.id}
                id={item.id}
                title={item.title}
                pinned={item.pinned}
                projectKey={projectKey}
                movable={!dormantAssignments?.has(item.id)}
                sectionKey={project.id}
                channel={channel}
                renameable={canRename(project.id, channel)}
                lifecycle={!!handoff}
                session={session}
                actions={entryActions}
                renderChat={renderChat}
                renderChatMenu={renderChatMenu}
                sidebarRows={sidebarRows}
                onHiddenChange={setRowHidden}
              />
            );
            return compose && project.id ? (
              <NavigationCard
                key={item.id}
                tone="tonal"
                className={styles.composedChat}
              >
                {row}
              </NavigationCard>
            ) : (
              row
            );
          })}
        </ChannelSidebarRows>
        {(project.hidden > 0 || project.foldable) && (
          <div className={styles.showMore} data-solo-show-more={project.id}>
            {project.hidden > 0 && (
              <NavigationItem
                variant="text"
                data-solo-show-more-expand=""
                label="Show more"
                aria-label={`Show more chats in ${project.name}`}
                icon={
                  <span className={styles.conversationIcon} aria-hidden="true">
                    <CaretDownIcon size={16} />
                  </span>
                }
                onClick={() =>
                  expand(project.id, project.extra + SOLO_CHAT_STEP)
                }
              />
            )}
            {project.foldable && (
              <NavigationItem
                variant="text"
                data-solo-show-more-fold=""
                label="Show fewer"
                aria-label={`Show fewer chats in ${project.name}`}
                onClick={() => expand(project.id, 0)}
              />
            )}
          </div>
        )}
        {!compose &&
          !project.rows.length &&
          project.id &&
          (onNew ? (
            <NavigationItem
              variant="row"
              label="New chat"
              aria-label={`New chat in ${project.name}`}
              title={`New chat in ${project.name}`}
              icon={
                <span className={styles.conversationIcon}>
                  <PlusIcon size={16} strokeWidth={2.5} />
                </span>
              }
              onClick={() => onNew(project.id)}
            />
          ) : (
            <p className={styles.listMessage}>No chats in this workspace.</p>
          ))}
      </>
    );
    const panel = (before?: ReactNode) => (
      <Collapsible.Panel
        className={styles.projectPanel}
        id={`workspace-${project.id || "unfiled"}`}
        data-solo-project={project.id}
      >
        {before}
        {compose ? <WorkspaceRows host={rowsHost} /> : rows}
      </Collapsible.Panel>
    );
    const ordinary = frame(
      <>
        {header(
          <Collapsible.Trigger
            type="button"
            className={styles.projectHeading}
            aria-expanded={
              !collapsed.includes(project.id) || renamingProject === project.id
            }
            onClick={(event) => setAnimate(event.detail > 0)}
          >
            <FadingLabel className={channelStyles.sectionTitle}>
              {project.name}
            </FadingLabel>
            <span
              className={channelStyles.sectionChevron}
              aria-hidden="true"
              data-navigation-reveal=""
            >
              <CaretDownIcon size={15} strokeWidth={2.5} />
            </span>
          </Collapsible.Trigger>,
        )}
        {panel()}
      </>,
    );
    return {
      id: project.id,
      name: project.name,
      open,
      toggle: changeOpen,
      frame,
      header,
      panel,
      ordinary,
      chatList: (
        <WorkspaceRows key={project.id} host={rowsHost} unframed={project.id} />
      ),
      rows: compose ? createPortal(rows, rowsHost.element, project.id) : null,
    };
  });
  useLayoutEffect(() => {
    const live = new Set(visible.map(({ id }) => id));
    for (const id of rowHosts.current.keys())
      if (!live.has(id)) rowHosts.current.delete(id);
  });
  const composed = (
    <>
      {entries.map((entry) => entry.rows)}
      {compose
        ? compose({
            chats: entries.find((entry) => !entry.id)?.ordinary,
            chatList: entries.map((entry) => entry.chatList),
            workspaces: entries,
            ordinary: entries.map((entry) => entry.ordinary),
          })
        : entries.map((entry) => entry.ordinary)}
    </>
  );
  return (
    <>
      {(snapshot.status === "idle" || snapshot.status === "loading") && (
        <p role="status" className={styles.listMessage}>
          Loading workspaces…
        </p>
      )}
      {snapshot.status === "error" && (
        <div role="alert" className={styles.listMessage}>
          <p>{snapshot.error ?? "Workspaces couldn’t load."}</p>
          <Button onClick={() => void preferences.refresh()}>
            Retry workspaces
          </Button>
        </div>
      )}
      {projectError && (
        <p role="alert" className={styles.listMessage}>
          {projectError}
        </p>
      )}
      {readError && (
        <p role="alert" className={styles.listMessage}>
          {readError.message}
        </p>
      )}
      {workspaceComposition ? (
        composed
      ) : (
        <ChannelSidebarDnd
          writable={preferences.writable}
          onMove={(id, key) => move(id, key.slice(DROP.length) || undefined)}
          onReorder={(key, over) => {
            const id = key.slice(DROP.length);
            const to = groups.findIndex((group) => DROP + group.id === over);
            if (groups.some((group) => group.id === id) && to >= 0)
              moveProject(id, to);
          }}
          overlay={(id, group) => {
            if (group) {
              const project = groups.find(
                (project) => DROP + project.id === id,
              );
              return (
                project && (
                  <div className={channelStyles.channelDragOverlay}>
                    {project.name}
                  </div>
                )
              );
            }
            const item = chats.find((item) => item.id === id);
            return (
              item && (
                <div className={channelStyles.channelDragOverlay}>
                  <span>{item.title}</span>
                </div>
              )
            );
          }}
        >
          {composed}
        </ChannelSidebarDnd>
      )}
      {snapshot.orderError && (
        <div role="alert" className={styles.listMessage}>
          <p>
            Couldn’t save the move for{" "}
            {groups.find(({ id }) => id === snapshot.orderError?.sectionId)
              ?.name ?? "this workspace"}
            . {snapshot.orderError.error}
          </p>
          <p>
            The previous order is shown. A partial save may already exist on the
            relay.
          </p>
          {!orderWritable && (
            <p>
              Refresh saved workspace preferences before retrying this move.
            </p>
          )}
          <Button
            disabled={!orderWritable}
            onClick={() => {
              const failed = preferences.snapshot().orderError;
              if (failed) {
                void preferences
                  .reorderSections(failed.sectionId, failed.sectionIds)
                  .catch(() => {});
                setOrderFocus(failed.sectionId);
              }
            }}
          >
            Retry move
          </Button>
          <Button
            onClick={() => {
              setOrderFocus(snapshot.orderError?.sectionId);
              preferences.dismissOrderError();
            }}
          >
            Dismiss
          </Button>
        </div>
      )}
      {converting && (
        <ConvertToChannel
          key={converting.id}
          session={session}
          id={converting.id}
          signal={converting.visit}
          onConverted={() => onConverted?.(converting.id)}
          close={() => setConverting(undefined)}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-solo-menu-id="${converting.id}"]:not([inert] *) button`,
            ) ?? false
          }
        />
      )}
      {sharing && sharingChannel && (
        <ChannelMembersDialog
          key={sharing.id}
          session={session}
          channelId={sharing.id}
          navigator={navigationController}
          signal={sharing.visit}
          trigger={{
            // Read on close: the mark is gone once the chat stops being shared.
            get current() {
              return sharing.trigger?.isConnected &&
                !sharing.trigger.closest("[inert]")
                ? sharing.trigger
                : document.querySelector<HTMLElement>(
                    `[data-solo-menu-id="${sharing.id}"]:not([inert] *) button`,
                  );
            },
          }}
          close={() => setSharing(undefined)}
        />
      )}
      {chatSettings && (
        <WorkspaceSettings
          key={chatSettings.item.id}
          signal={chatSettings.visit}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-solo-menu-id="${chatSettings.item.id}"]:not([inert] *) button`,
            ) ?? false
          }
          session={session}
          scope={scope}
          target={{
            kind: "chat",
            id: chatSettings.item.id,
            name: chatSettings.item.title,
          }}
          close={() => setChatSettings(undefined)}
        />
      )}
      {moves.some((move) => move.pending) && (
        <p role="status" className={styles.listMessage}>
          Saving workspace…
        </p>
      )}
      {moves
        .filter((move) => move.error)
        .map((move) => (
          <div role="alert" key={move.id} className={styles.listMessage}>
            <p>{move.error}</p>
            <Button
              disabled={!preferences.writable}
              onClick={() =>
                !prepareSoloMove(session, move.channelId) &&
                void preferences.retryMove(move.channelId).catch(() => {})
              }
            >
              Retry move
            </Button>
            <Button
              onClick={() => preferences.dismissMoveError(move.channelId)}
            >
              Dismiss
            </Button>
          </div>
        ))}
      {settingsFor && (
        <WorkspaceSettings
          key={settingsFor.id}
          session={session}
          scope={scope}
          target={{ kind: "project", ...settingsFor }}
          close={() => setSettingsFor(undefined)}
        />
      )}
      {creatingFor && (
        <NewWorkspace
          key={creatingFor.id}
          session={session}
          moveConversation
          close={() => setCreatingFor(undefined)}
          create={(section) => {
            if (
              !preferences.writable ||
              prepareSoloMove(session, creatingFor.id)
            )
              throw new Error("Workspaces are unavailable. Try again.");
            return preferences.createAndAssign(creatingFor.id, section);
          }}
        />
      )}
    </>
  );
}

/** Keep ordinary row editors mounted when a source changes their presentation. */
type WorkspaceRowsHost = {
  element: HTMLDivElement;
  focus?: HTMLElement | undefined;
  unframed?: boolean | undefined;
};
function WorkspaceRows({
  host,
  unframed,
}: {
  host: WorkspaceRowsHost;
  unframed?: string;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = slot.current;
    host.unframed = unframed !== undefined;
    parent?.appendChild(host.element);
    if (host.focus?.isConnected && document.activeElement === document.body)
      host.focus.focus({ preventScroll: true });
    host.focus = undefined;
    return () => {
      host.unframed = false;
      if (host.element.contains(document.activeElement))
        host.focus = document.activeElement as HTMLElement;
      if (host.element.parentElement === parent) host.element.remove();
    };
  }, [host, unframed]);
  return <div ref={slot} data-solo-project={unframed} />;
}

const DROP = "project:";

/** A listed chat's actions, read when used so a row's props stay stable. */
type ChatEntryActions = {
  share(id: string, trigger?: HTMLElement): void;
  convert(id: string): void;
  move(id: string, projectId?: string): void;
  newWorkspace(id: string): void;
  settings(id: string): void;
  rename(id: string): boolean;
  lifecycle(channel: ChannelSummary, action: ChannelLifecycleAction): void;
  readResult(id: string, error?: string): void;
};

/** One listed chat. The roster changes often; a row renders again only when
 * what it shows changes, not for every other chat's update. */
const SoloChatEntry = memo(function SoloChatEntry({
  id,
  title,
  pinned,
  projectKey,
  movable,
  sectionKey,
  channel,
  renameable,
  lifecycle,
  session,
  actions,
  renderChat,
  renderChatMenu,
  sidebarRows,
  onHiddenChange,
}: {
  id: string;
  title: string;
  pinned: boolean | undefined;
  projectKey: string;
  movable: boolean;
  sectionKey: string;
  channel: ChannelSummary | undefined;
  renameable: boolean;
  lifecycle: boolean;
  session: RelaySession;
  actions: RefObject<ChatEntryActions>;
  renderChat: ComponentProps<typeof SoloWorkspaces>["renderChat"];
  renderChatMenu: ((channelId: string) => ReactNode) | undefined;
  sidebarRows: readonly RegisteredSidebarRows[];
  onHiddenChange: (id: string, hidden: boolean) => () => void;
}) {
  const rename = renameable ? () => actions.current.rename(id) : undefined;
  const row = renderChat(
    { id, title, ...(pinned === undefined ? {} : { pinned }) },
    rename,
    channel,
  );
  const Default = (
    <ChatActionsMenu
      id={id}
      title={title}
      indicator={
        <ChatSharedMark
          session={session}
          channel={channel}
          onOpen={(trigger) => actions.current.share(id, trigger)}
        />
      }
      className={styles.organizedRow}
      content={
        channel && (
          <>
            {renderChatMenu?.(id)}
            <SoloChatMenuItems
              session={session}
              channel={channel}
              onShare={() => actions.current.share(id)}
              onConvert={() => actions.current.convert(id)}
              onMove={(projectId) => actions.current.move(id, projectId)}
              onNewWorkspace={() => actions.current.newWorkspace(id)}
              onSettings={() => actions.current.settings(id)}
              onRename={rename && (() => void rename())}
              onLifecycle={
                lifecycle
                  ? (action) => actions.current.lifecycle(channel, action)
                  : undefined
              }
              onReadResult={(error) => actions.current.readResult(id, error)}
            />
          </>
        )
      }
    >
      {movable ? (
        <DraggableChannel channelId={id} sectionKey={projectKey} rowKind="solo">
          {row}
        </DraggableChannel>
      ) : (
        row
      )}
    </ChatActionsMenu>
  );
  return channel && sidebarRows.some((entry) => entry.render) ? (
    <ContributedSoloRow
      session={session}
      channel={channel}
      sectionKey={sectionKey}
      entries={sidebarRows}
      onHiddenChange={onHiddenChange}
    >
      {Default}
    </ContributedSoloRow>
  ) : (
    Default
  );
});

function ContributedSoloRow({
  session,
  channel,
  sectionKey,
  entries,
  children,
  onHiddenChange,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  sectionKey: string;
  entries: readonly RegisteredSidebarRows[];
  children: ReactElement;
  onHiddenChange: (id: string, hidden: boolean) => () => void;
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
  const row = useMemo(
    () => sidebarRow(channel, sectionKey, unread),
    [channel, sectionKey, unread],
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

/** A drop reports only its destination, so it saves exactly like Move to. */
function DropProject({
  projectKey,
  shared,
  registerFrame,
  groupIndex,
  reorderable,
  disabled,
  ...props
}: ComponentProps<typeof Collapsible.Root> & {
  projectKey: string;
  shared: boolean;
  registerFrame?: WorkspaceSidebarComposition["registerFrame"] | undefined;
  groupIndex: number;
  reorderable: boolean;
  disabled: boolean;
}) {
  useLayoutEffect(
    () => registerFrame?.(projectKey),
    [projectKey, registerFrame],
  );
  const { setNodeRef, isOver, active } = useDroppable({
    id: projectKey,
    data: {
      group: reorderable,
      groupIndex,
      accepts: shared ? sidebarDropRowKinds(projectKey) : undefined,
    },
    disabled,
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  const group = !!active?.data.current?.group;
  return (
    <Collapsible.Root
      {...props}
      data-sidebar-section={shared ? projectKey : undefined}
      ref={setNodeRef}
      data-drop-target={
        (!group && isOver && active?.data.current?.sectionKey !== projectKey) ||
        undefined
      }
      data-drop-edge={
        group && isOver && active?.id !== projectKey
          ? active?.data.current?.groupIndex < groupIndex
            ? "after"
            : "before"
          : undefined
      }
      data-section-dragging={(group && active?.id === projectKey) || undefined}
    />
  );
}

function WorkspaceDragHandle({
  children,
  ...options
}: {
  children: ReactNode;
  sectionKey: string;
  groupIndex: number;
  reorderable: boolean;
}) {
  const drag = useSidebarSectionDrag(options);
  // Preserve the heading recipe's direct trigger and the composed workspace's
  // existing label/disclosure layout. Actions stay outside this handle.
  return drag.handle && isValidElement<ComponentProps<"div">>(children)
    ? cloneElement(children, { ref: drag.handle.ref, ...drag.handle.listeners })
    : children;
}

/** Both entry points use one action list; right-click never selects the row. */
function ChatActionsMenu({
  id,
  title,
  className,
  children,
  content,
  indicator,
  enabled = true,
}: {
  id: string;
  title: string;
  className: string | undefined;
  /** A function places the overflow action itself, such as in a heading's
   * actions; otherwise it follows the children. */
  children: ReactNode | ((overflow: ReactNode) => ReactNode);
  content: ReactNode;
  indicator?: ReactNode;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const restoreFocus = () => {
    const row = document.querySelector(
      `[data-solo-menu-id="${id}"]:not([inert] *)`,
    );
    return (
      row?.querySelector<HTMLElement>("[data-solo-destination-id]") ??
      row?.querySelector<HTMLElement>("button") ??
      false
    );
  };
  if (!enabled)
    return (
      <div className={className} data-solo-menu-id={id}>
        {typeof children === "function" ? children(null) : children}
      </div>
    );
  const overflow = (
    <MenuRoot>
      <MenuTrigger
        render={(props) => (
          <IconButton
            {...props}
            // A heading reveals its own actions; rows reveal theirs here.
            data-solo-row-action={
              typeof children === "function" ? undefined : ""
            }
            variant="bare"
            size="compact"
            aria-label={`Actions for ${title}`}
            icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
          />
        )}
      />
      <MenuPopup
        aria-label={`Actions for ${title}`}
        align="end"
        finalFocus={restoreFocus}
      >
        {content}
      </MenuPopup>
    </MenuRoot>
  );
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
    >
      <ContextMenuTrigger
        render={<div className={className} data-solo-menu-id={id} />}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      >
        {typeof children === "function" ? (
          children(overflow)
        ) : (
          <>
            {children}
            {indicator}
            {overflow}
          </>
        )}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${title}`}
        anchor={anchor}
        finalFocus={restoreFocus}
      >
        {content}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
