import { teamSidebarSlotsReady, teamSidebarSource } from "./TeamSidebarSource";
import { soloSidebarSource } from "./SoloSidebarSource";
import { SidebarSectionSlotView } from "../../features/channel-navigation/SidebarSectionSources";
import {
  MessagesSidebarEnvironment,
  type MessagesSidebarState,
} from "./sidebar-environment";
import type { SidebarContextProps } from "../../features/sidebar/contracts";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { sidebarTarget } from "../../features/channel-navigation/routes";
import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import { ChannelInventory } from "./ChannelInventory";
import { SidebarBoundary } from "../../features/channel-navigation/SidebarBoundary";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { SidebarUnread } from "./SidebarUnread";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type {
  RegisteredSidebarRestriction,
  SidebarScope,
} from "../../features/channel-navigation/sidebar-scope-service";
import styles from "./MessagesSidebar.module.css";

import { useRelayConnection } from "../../features/relay/react";
import { targetKey } from "../../features/navigation/targets";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";
import type { SidebarRows } from "../../features/channel-navigation/sidebar-rows-service";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import {
  CommunityRefusalNotice,
  CommunitySignIn,
  issuerMayAnswerAgain,
} from "../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { Membership } from "../../features/communities/service";

const noSubscription = () => () => {};

const sameConversation = (a: OpenTarget, b: OpenTarget) =>
  a.kind === "conversation" &&
  b.kind === "conversation" &&
  targetKey(a) !== targetKey(b) &&
  targetKey(sidebarTarget(a)) === targetKey(sidebarTarget(b));
/** The latest attempt that opened a destination. Moving within the open
 * conversation, as opening or closing a thread does, keeps the previous one,
 * so it renders nothing here; reopening the same target is a new one. A
 * preserved opening applies only to itself, so entering or leaving one is. */
function destinationAttempt(navigator: Navigation) {
  let previous = navigator.snapshot();
  let shown = previous.attempt;
  return () => {
    const next = navigator.snapshot();
    if (
      next.attempt.id !== previous.attempt.id &&
      (next.attempt.sidebar !== shown.sidebar ||
        !sameConversation(previous.entry.target, next.entry.target))
    )
      shown = next.attempt;
    previous = next;
    return shown;
  };
}

export type MessagesSidebarProps = Pick<
  SidebarContextProps,
  "Frame" | "renderSections"
> & {
  federatedIdentity?: FederatedIdentity;
  /** Joined communities, so a sign-in switch names the ones it affects. */
  memberships?: readonly Membership[] | undefined;
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  sidebarSections?: SidebarSections | undefined;
  /** A plugin restriction shows only Solo; the saved filter returns after. */
  sidebarScope?: SidebarScope | undefined;
  sidebarRows?: SidebarRows | undefined;
  target: OpenTarget;
  children: ReactNode;
  creationAction?: ReactNode;
};

/** Filters the navigation inventory without replacing the current conversation. */
export function MessagesSidebar(props: MessagesSidebarProps) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  return (
    <ScopedSidebar
      {...props}
      key={scope}
      scope={scope}
      connection={connection}
    />
  );
}

function ScopedSidebar({
  scope,
  connection,
  ...props
}: MessagesSidebarProps & {
  scope: string;
  connection: ReturnType<typeof useRelayConnection>;
}) {
  const attemptView = useMemo(
    () => destinationAttempt(props.navigator),
    [props.navigator],
  );
  const shownAttempt = useSyncExternalStore(
    props.navigator.subscribe,
    attemptView,
  );
  const preserveSidebar = shownAttempt.sidebar === "preserve";
  const refused =
    connection.status === "error" && connection.denied && !connection.retrying;
  const restriction = useSyncExternalStore(
    props.sidebarScope?.subscribe ?? noSubscription,
    () => props.sidebarScope?.snapshot()[0],
  );
  const session = connection.session;
  const [committedSlots, setCommittedSlots] = useState<{
    generation: string;
    keys: readonly string[];
    unavailable: readonly string[];
  }>();
  const slotGeneration = `${scope}:${connection.generation}`;
  const sourcesSettled = useSyncExternalStore(
    props.sidebarRows?.subscribe ?? noSubscription,
    props.sidebarRows?.settled ?? (() => true),
  );
  const slotsCommitted = useCallback(
    (ready: boolean, keys: readonly string[], unavailable: readonly string[]) =>
      setCommittedSlots(
        ready ? { generation: slotGeneration, keys, unavailable } : undefined,
      ),
    [slotGeneration],
  );
  const inventory =
    !!session && (connection.status === "ready" || !!connection.cached);
  const floatingAction = useRef<HTMLDivElement>(null);
  const footer = props.creationAction && (
    <div
      ref={floatingAction}
      className={styles.sidebarCreation}
      data-sidebar-floating-action=""
    >
      {props.creationAction}
    </div>
  );
  const header = (
    <>
      {restriction && props.sidebarScope && (
        <div className={styles.sidebarControls}>
          <div className={styles.sidebarScope}>
            <RestrictionBanner
              entry={restriction}
              registry={props.sidebarScope}
            />
          </div>
        </div>
      )}
      {props.children && !restriction && (
        <div className={styles.destinations}>{props.children}</div>
      )}
    </>
  );
  return (
    <SidebarBoundary key={`${scope}:${connection.generation}`} header={header}>
      {session && inventory ? (
        <ChannelInventory
          relay={props.relay}
          navigator={props.navigator}
          agents={props.agents}
          target={props.target}
          queries={connection.session}
          scope={scope}
          viewer={connection.viewer}
          sidebarSections={props.sidebarSections}
          sidebarRows={props.sidebarRows}
          chatIcons={props.chatIcons}
          chatMenus={props.chatMenus}
          cached={!!connection.cached}
          chatsOnly={!!restriction}
          layoutReady={committedSlots?.generation === slotGeneration}
          slotsReady={(ids) =>
            teamSidebarSlotsReady(props.sidebarSections, committedSlots, ids)
          }
          preserveSidebar={preserveSidebar}
          connectionError={connection.error}
          render={({
            sidebar,
            workspaceComposition,
            dmPreviews,
            frame,
            before,
            content,
            team,
            after,
            dialogs,
          }) => (
            <SidebarEnvironment
              session={session}
              scope={scope}
              navigator={props.navigator}
              target={props.target}
              sidebar={sidebar}
              workspaceComposition={workspaceComposition}
              chatIcons={props.chatIcons}
              chatMenus={props.chatMenus}
              sidebarRows={props.sidebarRows}
            >
              {props.renderSections({
                settled: sourcesSettled,
                onReady: slotsCommitted,
                children: (slots, sources) => {
                  const teamContent = (
                    <>
                      {slots
                        .filter(
                          (slot) =>
                            slot.scope === "team" &&
                            (!restriction ||
                              slot.source.component ===
                                teamSidebarSource.component),
                        )
                        .map((slot) => (
                          <SidebarSectionSlotView key={slot.key} slot={slot} />
                        ))}
                      {content}
                    </>
                  );
                  return (
                    <>
                      {sources(
                        "solo",
                        (source) =>
                          source.component !== soloSidebarSource.component,
                      )}
                      {team(
                        <>
                          {sources("team")}
                          {sources(
                            "solo",
                            (source) =>
                              source.component === soloSidebarSource.component,
                          )}
                        </>,
                      )}
                      <props.Frame
                        scope={scope}
                        resizable
                        label="Sidebar"
                        header={header}
                        footer={footer}
                        {...frame}
                        launchPending={
                          committedSlots?.generation === slotGeneration
                            ? frame.launchPending
                            : "required"
                        }
                      >
                        {/* Relay outages for every inventory recover through one
                    automatic owner; its one notice shows on every page. */}
                        {!connection.cached && (
                          <RecoveryNotice
                            recovery={connection.session.recovery}
                          />
                        )}
                        <LiveSignIn
                          session={connection.session}
                          identity={communityIdentity(
                            props.federatedIdentity,
                            connection.origin,
                          )}
                          relay={connection.origin}
                          memberships={props.memberships}
                          tryAgain={() => props.relay.tryAgain()}
                        />
                        {before}
                        <SidebarUnread
                          listRef={sidebar.list}
                          adjustScrollAnchor={sidebar.adjustScrollAnchor}
                          captureScrollAnchor={sidebar.captureScrollAnchor}
                          dmPreviews={dmPreviews}
                          floatingAction={footer ? floatingAction : undefined}
                        >
                          {teamContent}
                          {slots
                            .filter((slot) => slot.scope === "solo")
                            .map((slot) => (
                              <SidebarSectionSlotView
                                key={slot.key}
                                slot={slot}
                              />
                            ))}
                        </SidebarUnread>
                        {after}
                      </props.Frame>
                      {dialogs}
                    </>
                  );
                },
              })}
            </SidebarEnvironment>
          )}
        />
      ) : (
        <props.Frame
          label="Sidebar"
          header={header}
          footer={footer}
          launchPending={
            connection.status === "connecting" ? "required" : undefined
          }
        >
          <SidebarList>
            {/* A connection retrying by itself is still connecting; only a
                  settled failure asks for Try again, right beside its notice. */}
            {refused ? (
              <CommunityRefusalNotice
                // A refusal while connecting is the relay's about access.
                refusal={connection.refusal ?? "access"}
                identity={communityIdentity(
                  props.federatedIdentity,
                  connection.origin,
                )}
                retry={props.relay.tryAgain}
                relay={connection.origin}
                memberships={props.memberships}
              />
            ) : (
              <div className={styles.connectionStatus}>
                <p>
                  {connection.status === "connecting" || connection.retrying
                    ? "Connecting…"
                    : connection.status === "error"
                      ? "Couldn’t load channels."
                      : "Choose a community to see channels."}
                </p>
                {connection.status === "error" && !connection.retrying && (
                  <>
                    <CommunitySignIn
                      identity={communityIdentity(
                        props.federatedIdentity,
                        connection.origin,
                      )}
                      error={connection.error}
                      retry={props.relay.tryAgain}
                      relay={connection.origin}
                      memberships={props.memberships}
                      asksAgain
                    />
                    <Button onClick={props.relay.tryAgain}>Try again</Button>
                  </>
                )}
              </div>
            )}
          </SidebarList>
        </props.Frame>
      )}
    </SidebarBoundary>
  );
}

/** The sign-in session for the community's own server, when it has one. */
function communityIdentity(
  identity: FederatedIdentity | undefined,
  origin: string | undefined,
) {
  return (origin && identity?.forCommunity?.(origin)) || identity;
}

/** A protected community can refuse after its channel list is shown: native
 * discovery hands back the transport before NIP-FI admission, so the refusal
 * arrives on the live socket. Its recovery reconnects only that socket; a
 * refusal its sign-in server may change offers Try again, which asks it. */
function LiveSignIn({
  session,
  identity,
  relay,
  memberships,
  tryAgain,
}: {
  session: RelaySession;
  identity: FederatedIdentity | undefined;
  relay: string | undefined;
  memberships: readonly Membership[] | undefined;
  tryAgain: () => void;
}) {
  const live = useSyncExternalStore(
    session.live.subscribe,
    session.live.snapshot,
    session.live.snapshot,
  );
  if (live.status !== "error") return null;
  const asksAgain = !!identity && issuerMayAnswerAgain(live.error);
  return (
    <>
      <CommunitySignIn
        identity={identity}
        error={live.error}
        retry={session.live.retry}
        relay={relay}
        memberships={memberships}
        asksAgain={asksAgain}
      />
      {asksAgain && <Button onClick={tryAgain}>Try again</Button>}
    </>
  );
}

/** A plugin's banner, isolated so its failure keeps the sidebar working. */
function RestrictionBanner({
  entry,
  registry,
}: {
  entry: RegisteredSidebarRestriction;
  registry: SidebarScope;
}) {
  return (
    <OwnedContribution entry={entry} registry={registry} fallback={null}>
      {({ banner: Banner }) => <Banner />}
    </OwnedContribution>
  );
}

const alwaysActive = () => true;
/** A new environment value makes React search every memoized sidebar subtree
 * that skips rendering for its consumers, so keep it while its fields hold. */
function SidebarEnvironment({
  session,
  scope,
  navigator,
  target,
  sidebar,
  workspaceComposition,
  chatIcons,
  chatMenus,
  sidebarRows,
  children,
}: Omit<MessagesSidebarState, "active"> & { children: ReactNode }) {
  const value = useMemo(
    () => ({
      session,
      scope,
      navigator,
      target,
      sidebar,
      workspaceComposition,
      active: alwaysActive,
      chatIcons,
      chatMenus,
      sidebarRows,
    }),
    [
      session,
      scope,
      navigator,
      target,
      sidebar,
      workspaceComposition,
      chatIcons,
      chatMenus,
      sidebarRows,
    ],
  );
  return (
    <MessagesSidebarEnvironment value={value}>
      {children}
    </MessagesSidebarEnvironment>
  );
}
