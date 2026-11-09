import { FadingLabel } from "./FadingLabel";
import { prepareSoloMove } from "../../features/channel-navigation/solo-navigation";
import { useChatConversions } from "../../features/solo/conversion";
import { ConvertToChannel } from "../../features/solo/ConvertToChannel";
import { ChatSharedMark } from "./ChatSharedMark";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { SoloChatName } from "./SoloChatName";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
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
} from "../../features/channel-navigation/ChannelSidebarDnd";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
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
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { Navigation } from "../../features/navigation/controller";
import { NewWorkspaceDialog, SoloChatMenuItems } from "./SoloChatMenu";
import styles from "./SoloWorkspaces.module.css";
import channelStyles from "./Channels.module.css";

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

/** The existing relay preference service owns delivery, rollback and retry. */
export function SoloWorkspaces({
  session,
  navigator: navigationController,
  scope,
  chats,
  renderChat,
  renderChatMenu,
  onNew,
  onConverted,
  visit,
  draft,
}: {
  draft?: { projectId?: string | undefined; content: ReactNode } | undefined;
  onConverted?: ((id: string) => void) | undefined;
  visit?: AbortSignal;
  session: RelaySession;
  navigator?: Navigation | undefined;
  scope: string;
  chats: readonly ChatListItem[];
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
  const preferences = session.soloPreferences;
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
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, collapsedKey, []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
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
  const currentVisit = useRef(visit);
  currentVisit.current = visit;
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
    const target = collapsed.includes(project)
      ? `project-${project}`
      : rowFocus;
    document
      .querySelector<HTMLElement>(`[data-solo-menu-id="${target}"] button`)
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus, collapsed, snapshot.data]);
  // Show more and Show less each unmount once spent; focus stays on the row,
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
    const chats = panel?.querySelectorAll("[data-solo-menu-id]") ?? [];
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
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments ?? {};
  const ids = new Set(groups.map((group) => group.id));
  const draftProject = draft
    ? ids.has(draft.projectId ?? "")
      ? (draft.projectId ?? "")
      : ""
    : undefined;
  useEffect(() => {
    if (draftProject === undefined) return;
    setCollapsed((current) => {
      if (!current.includes(draftProject)) return current;
      const next = current.filter((id) => id !== draftProject);
      writeView(scope, collapsedKey, next);
      return next;
    });
  }, [draftProject, scope]);
  const projects = [
    ...groups.map((group) => ({
      ...group,
      rows: chats.filter((item) => assigned[item.id] === group.id),
    })),
    {
      id: "",
      name: "Chats",
      rows: chats.filter((item) => !ids.has(assigned[item.id] ?? "")),
    },
  ];
  // A collapse request takes effect after the editor closes. Keep its draft and
  // save owner mounted and reachable, including when a save needs recovery.
  const renamingProject = projects.find((project) =>
    project.rows.some((item) => item.id === renaming),
  )?.id;
  const move = (id: string, projectId?: string) => {
    if (prepareSoloMove(session, id)) return;
    const saving = preferences.assign(id, projectId);
    toggle(projectId ?? "", true);
    hold([id]);
    setRowFocus(id);
    void saving.catch(() => {
      // A rollback remounts the original row. Do not steal focus if the user moved on.
      if (
        !document.querySelector(`[data-solo-menu-id="${id}"]`) ||
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
        `[data-solo-menu-id="${CSS.escape(channel.id)}"] button`,
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
        completed() {
          if (leavesOpenChat && !current.attempt.signal.aborted)
            void navigationController?.open(
              soloSuccessor(
                scope,
                session.channels.list().channels,
                neighbors,
                channel.id,
              ),
            );
        },
      }),
    );
  };
  const toggle = (id: string, open: boolean) => {
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
        project.id || project.rows.length || draftProject === project.id,
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
    const shown = visible.map((project) => ({
      rows: project.rows,
      shown: collapsed.includes(project.id)
        ? []
        : project.listed.map((item) => item.id),
    }));
    const neighbors = (id: string) => soloNeighbors(shown, id);
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
        visit: currentVisit.current,
        ...(trigger ? { trigger } : {}),
      }),
    convert: (id) => setConverting({ id, visit: currentVisit.current }),
    move,
    newWorkspace: (id) => setCreatingFor(chats.find((item) => item.id === id)),
    settings: (id) => {
      const item = chats.find((item) => item.id === id);
      if (item) setChatSettings({ item, visit: currentVisit.current });
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
      <ChannelSidebarDnd
        writable={preferences.writable}
        onMove={(id, key) => move(id, key.slice(DROP.length) || undefined)}
        // Solo projects keep their saved order; only chats drag.
        onReorder={() => {}}
        overlay={(id) => {
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
        {visible.map((project) => (
          <DropProject
            projectKey={DROP + project.id}
            key={project.id}
            className={`${styles.project} ${channelStyles.channelSection}`}
            data-project={project.id ? "" : undefined}
            open={
              !collapsed.includes(project.id) || renamingProject === project.id
            }
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
            <ChatActionsMenu
              id={`project-${project.id}`}
              title={project.name}
              className={undefined}
              enabled={!!project.id}
              content={
                <>
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
                      {onNew && (
                        <IconButton
                          size="compact"
                          aria-label={`New chat in ${project.name}`}
                          title="New chat"
                          icon={<PlusIcon size={15} strokeWidth={2.5} />}
                          onClick={() => onNew(project.id || undefined)}
                        />
                      )}
                    </>
                  }
                >
                  <Collapsible.Trigger
                    type="button"
                    className={styles.projectHeading}
                    aria-expanded={
                      !collapsed.includes(project.id) ||
                      renamingProject === project.id
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
                  </Collapsible.Trigger>
                </NavigationSectionHeading>
              )}
            </ChatActionsMenu>
            <Collapsible.Panel
              className={styles.projectPanel}
              data-solo-project={project.id}
            >
              {draftProject === project.id && draft && (
                <ChatActionsMenu
                  id="new-chat-draft"
                  title="New chat"
                  className={styles.organizedRow}
                  content={null}
                  enabled={false}
                >
                  <div>{draft.content}</div>
                </ChatActionsMenu>
              )}
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
                return (
                  <SoloChatEntry
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    pinned={item.pinned}
                    projectKey={DROP + project.id}
                    channel={channel}
                    renameable={canRename(project.id, channel)}
                    lifecycle={!!handoff}
                    session={session}
                    actions={entryActions}
                    renderChat={renderChat}
                    renderChatMenu={renderChatMenu}
                  />
                );
              })}
              {(project.hidden > 0 || project.foldable) && (
                <div
                  className={styles.showMore}
                  data-solo-show-more={project.id}
                >
                  {project.hidden > 0 && (
                    <NavigationItem
                      variant="text"
                      data-solo-show-more-expand=""
                      label="Show more"
                      aria-label={`Show more chats in ${project.name}`}
                      icon={
                        <span
                          className={styles.conversationIcon}
                          aria-hidden="true"
                        >
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
                      label="Show less"
                      aria-label={`Show fewer chats in ${project.name}`}
                      onClick={() => expand(project.id, 0)}
                    />
                  )}
                </div>
              )}
              {!project.rows.length &&
                project.id &&
                (onNew ? (
                  // An empty project offers its way out instead of an empty state.
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
                  <p className={styles.listMessage}>
                    No chats in this workspace.
                  </p>
                ))}
            </Collapsible.Panel>
          </DropProject>
        ))}
      </ChannelSidebarDnd>
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
              `[data-solo-menu-id="${converting.id}"] button`,
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
              return sharing.trigger?.isConnected
                ? sharing.trigger
                : document.querySelector<HTMLElement>(
                    `[data-solo-menu-id="${sharing.id}"] button`,
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
              `[data-solo-menu-id="${chatSettings.item.id}"] button`,
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
        <NewWorkspaceDialog
          key={creatingFor.id}
          name={creatingFor.title}
          close={() => setCreatingFor(undefined)}
          create={(name) => {
            if (
              !preferences.writable ||
              prepareSoloMove(session, creatingFor.id)
            )
              return false;
            const id = crypto.randomUUID();
            void preferences
              .createAndAssign(creatingFor.id, { id, name })
              .catch(() => {});
            toggle(id, true);
            setCreatingFor(undefined);
            return true;
          }}
        />
      )}
    </>
  );
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
  channel,
  renameable,
  lifecycle,
  session,
  actions,
  renderChat,
  renderChatMenu,
}: {
  id: string;
  title: string;
  pinned: boolean | undefined;
  projectKey: string;
  channel: ChannelSummary | undefined;
  renameable: boolean;
  lifecycle: boolean;
  session: RelaySession;
  actions: RefObject<ChatEntryActions>;
  renderChat: ComponentProps<typeof SoloWorkspaces>["renderChat"];
  renderChatMenu: ((channelId: string) => ReactNode) | undefined;
}) {
  const rename = renameable ? () => actions.current.rename(id) : undefined;
  return (
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
      <DraggableChannel channelId={id} sectionKey={projectKey}>
        {renderChat(
          { id, title, ...(pinned === undefined ? {} : { pinned }) },
          rename,
          channel,
        )}
      </DraggableChannel>
    </ChatActionsMenu>
  );
});

/** A drop reports only its destination, so it saves exactly like Move to. */
function DropProject({
  projectKey,
  ...props
}: ComponentProps<typeof Collapsible.Root> & { projectKey: string }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: projectKey });
  return (
    <Collapsible.Root
      {...props}
      ref={setNodeRef}
      data-drop-target={
        (isOver && active?.data.current?.sectionKey !== projectKey) || undefined
      }
    />
  );
}

/** Both entry points use one action list; right-click never selects the row. */
export function ChatActionsMenu({
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
    const row = document.querySelector(`[data-solo-menu-id="${id}"]`);
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
