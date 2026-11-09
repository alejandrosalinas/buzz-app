import type { Conversation } from "../../features/conversation/service";
import { prepareSoloMove } from "../../features/channel-navigation/solo-navigation";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import identityStyles from "./ChannelHeaderIdentity.module.css";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowSquareOutIcon,
  DotsThreeIcon,
} from "../../shared/design-system/icons";
import {
  ChannelMembersButton,
  ChannelMembersDialog,
} from "./ChannelMembersDialog";
import { NewWorkspaceDialog, SoloChatMenuItems } from "./SoloChatMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useSoloOwner } from "./ChatSharedMark";

const noSubscription = () => () => {};

type SoloToolbarProps = {
  session: RelaySession;
  chatMenus?: Conversation["chatMenus"] | undefined;
  scope: string;
  channel: ChannelSummary;
  navigator?: Navigation | undefined;
  signal?: AbortSignal | undefined;
  /** Panel launchers, owned by the conversation page. */
  children?: ReactNode;
  /** The tab pane toggle, owned by the conversation page; it ends the header. */
  paneToggle?: ReactNode;
  /** Shows the chat in the main view, from a host that shows it elsewhere. */
  onOpen?: (() => void) | undefined;
  /** Absent where no host can finish a conversion. */
  onConvert?: ((trigger: HTMLElement | null) => void) | undefined;
  onLifecycle(action: ChannelLifecycleAction, trigger?: HTMLElement): void;
  /** Reports a move started here; see `useSoloMoveRecovery`. */
  onMove(move: Promise<unknown>): void;
};

/** The header of a conversation shown with the Solo treatment. */
export function SoloHeading(props: SoloToolbarProps) {
  const owner = useSoloOwner(props.session, props.channel);
  return props.channel.archived ? (
    <SoloTitle channel={props.channel}>
      <SoloToolbar {...props} />
    </SoloTitle>
  ) : (
    <div className={identityStyles.soloHeader}>
      <PanelHeader
        title={
          <ChannelMembersButton
            session={props.session}
            channelId={props.channel.id}
            conversationName={props.channel.name}
            owner={owner}
            navigator={props.navigator}
            signal={props.signal}
          />
        }
        actions={<SoloToolbar {...props} membershipInHeader />}
      />
    </div>
  );
}

/** A Solo chat's header actions, wherever the chat is shown. */
export function SoloToolbar({
  session,
  chatMenus,
  scope,
  channel,
  navigator,
  signal,
  children,
  paneToggle,
  onOpen,
  onConvert,
  onLifecycle,
  onMove,
  membershipInHeader = false,
}: SoloToolbarProps & { membershipInHeader?: boolean }) {
  const menus = useSyncExternalStore(
    chatMenus?.subscribe ?? noSubscription,
    () => chatMenus?.snapshot(),
  );
  const regions = useSoloNavigation(session);
  const region = regions.regions.find((region) =>
    region.channels.some((item) => item.id === channel.id),
  );
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Each dialog returns focus to the control that opened it.
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
    trigger: RefObject<HTMLButtonElement | null>;
  }>();
  const [sharing, setSharing] = useState<{ visit: AbortSignal | undefined }>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const owner = useSoloOwner(session, channel);
  const [readError, setReadError] = useState<string>();
  const preferences = session.soloPreferences;
  const canOpenActions =
    !channel.cached && (!channel.readOnly || channel.viewerRole === "guest");
  return (
    <>
      {region && (
        <Button
          size="sm"
          variant="ghost"
          shape="capsule"
          onClick={() => soloNavigationFor(session)?.reveal(channel.id)}
        >
          In {region.title}
        </Button>
      )}
      {channel.archived ? (
        <span>Archived</span>
      ) : (
        <>
          {!membershipInHeader && (
            <ChannelMembersButton
              session={session}
              channelId={channel.id}
              label="Share access"
              owner={owner}
              navigator={navigator}
              signal={signal}
            />
          )}
          {children}
        </>
      )}
      {/* Archived chats keep their lifecycle actions, including Unarchive. */}
      {canOpenActions && (
        <MenuRoot key={regions.binding?.incarnation ?? "recovery"}>
          <MenuTrigger
            render={
              <IconButton
                hint="familiar"
                ref={actionsTrigger}
                size="toolbar"
                aria-label="Chat actions"
                title="Chat actions"
                icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
              />
            }
          />
          <MenuPopup aria-label="Chat actions" align="end">
            {onOpen && (
              <>
                <MenuItem onClick={onOpen}>
                  <MenuIcon>
                    <ArrowSquareOutIcon size={14} />
                  </MenuIcon>
                  Open in main view
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <SoloChatMenuItems
              session={session}
              channel={channel}
              onShare={() => setSharing({ visit: signal })}
              onConvert={onConvert && (() => onConvert(actionsTrigger.current))}
              onMove={(projectId) => {
                if (!prepareSoloMove(session, channel.id))
                  onMove(preferences.assign(channel.id, projectId));
              }}
              onNewWorkspace={() => setCreatingWorkspace(true)}
              onSettings={() =>
                setSettingsOpen({
                  visit: signal,
                  trigger: actionsTrigger,
                })
              }
              onLifecycle={(action) =>
                onLifecycle(action, actionsTrigger.current ?? undefined)
              }
              onReadResult={setReadError}
            >
              {menus
                ?.slice()
                .sort(
                  (a, b) =>
                    Number(a.pluginId === "buzz.huddles") -
                    Number(b.pluginId === "buzz.huddles"),
                )
                .map(({ key, component: Item }) => (
                  <Item key={key} session={session} channelId={channel.id} />
                ))}
            </SoloChatMenuItems>
          </MenuPopup>
        </MenuRoot>
      )}
      {!channel.archived && paneToggle}
      {sharing && (
        <ChannelMembersDialog
          key={channel.id}
          session={session}
          channelId={channel.id}
          navigator={navigator}
          signal={sharing.visit}
          trigger={actionsTrigger}
          close={() => setSharing(undefined)}
        />
      )}
      {creatingWorkspace && (
        <NewWorkspaceDialog
          name={channel.name}
          finalFocus={actionsTrigger}
          close={() => setCreatingWorkspace(false)}
          create={(name) => {
            if (!preferences.writable || prepareSoloMove(session, channel.id))
              return false;
            onMove(
              preferences.createAndAssign(channel.id, {
                id: crypto.randomUUID(),
                name,
              }),
            );
            setCreatingWorkspace(false);
            return true;
          }}
        />
      )}
      {readError && (
        <ToastNotice
          title="Read state couldn’t be saved"
          description={readError}
          onDismiss={() => setReadError(undefined)}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          signal={settingsOpen.visit}
          finalFocus={settingsOpen.trigger}
          key={channel.id}
          session={session}
          scope={scope}
          target={{ kind: "chat", id: channel.id, name: channel.name }}
          close={() => setSettingsOpen(undefined)}
        />
      )}
    </>
  );
}

/** Reports failed moves started from Solo headers. The sidebar may be hidden,
 * so a header move reports its own failure. The page owns this, so recovery
 * outlives header remounts and side tab switches. A chat stays tracked while
 * the store keeps a move record for it, pending or failed, and until its
 * failure is dismissed. */
export function useSoloMoveRecovery(session: RelaySession) {
  const preferences = session.soloPreferences;
  const placement = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const [tracked, setTracked] = useState<ReadonlySet<string>>(() => new Set());
  const untrack = useCallback(
    (channelId: string) =>
      setTracked((current) => {
        if (!current.has(channelId)) return current;
        const next = new Set(current);
        next.delete(channelId);
        return next;
      }),
    [],
  );
  const track = useCallback((channelId: string, move: Promise<unknown>) => {
    setTracked((current) =>
      current.has(channelId) ? current : new Set(current).add(channelId),
    );
    // The store reports the failure; one move succeeding says nothing about
    // a newer one still queued for the same chat.
    void move.catch(() => {});
  }, []);
  // Success, or a move settled elsewhere such as the sidebar's own Retry or
  // Dismiss, leaves no record and is no longer the header's to report.
  useEffect(() => {
    for (const channelId of tracked)
      if (!placement.moves?.some((move) => move.channelId === channelId))
        untrack(channelId);
  }, [placement, tracked, untrack]);
  const notices = placement.moves?.map(
    ({ id, channelId, error }) =>
      error &&
      tracked.has(channelId) && (
        <ToastNotice
          key={`${id}:${error}`}
          title="Chat wasn’t moved"
          description={error}
          onDismiss={() => {
            preferences.dismissMoveError(channelId);
            untrack(channelId);
          }}
        >
          <Button
            size="sm"
            disabled={!preferences.writable}
            onClick={() =>
              !prepareSoloMove(session, channelId) &&
              track(channelId, preferences.retryMove(channelId))
            }
          >
            Retry move
          </Button>
        </ToastNotice>
      ),
  );
  return [track, notices] as const;
}
