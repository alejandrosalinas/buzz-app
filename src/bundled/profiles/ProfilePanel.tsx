import { historyPresentation } from "../../features/agents/history-presentation";
import {
  profileHistoryActive,
  profileHistoryRoute,
  profileHistoryTarget,
} from "../../features/profiles/target";
import { useProfileMessage } from "../../features/profiles/useProfileMessage";
import {
  otherVerifiedName,
  verifiedLabel,
} from "../../features/profiles/name-preference";
import {
  AgentSaveState,
  DiscardChanges,
  useAgentSaveReports,
} from "../../features/agents/AgentSaveButton";
import { AgentDetails } from "../agents/AgentDetails";
import { AgentMessageButton } from "../agents/AgentMessageButton";
import { useAgents } from "../../features/agents/react";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { StatusDisplay } from "../../features/user-status/StatusDisplay";
import { StatusEditor } from "../../features/user-status/StatusEditor";
import { useStatusEditor } from "../../features/user-status/useStatusEditor";
import { useUserStatus } from "../../features/user-status/useUserStatus";
import { ProfilePublicMetadata } from "./ProfilePublicMetadata";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  CheckCircleIcon,
  CopyIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { PanelProps } from "../../features/panels/service";
import {
  claimProfileTranscript,
  profileActivityViewKey,
  profileTranscriptRequest,
  subscribeProfileTranscripts,
  profileAgentHint,
  profilePanelKey,
  profileTarget,
} from "../../features/profiles/target";
import { formatPublicKey } from "../../shared/identity/public-key";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAgentIdentity } from "./ProfileAgentIdentity";
import styles from "./Profiles.module.css";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import hero from "../../features/profiles/ProfileHero.module.css";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentDelete } from "../../features/agents/AgentManage";
import { useAgent, useChannelChoices } from "../../features/agents/react";
import type {
  Agents,
  AgentViewProps,
  TranscriptRequest,
} from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { agentSections } from "../../features/agents/tabs";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useAgentSettingsHost } from "../agents/AgentSettingsHost";
import { conversationOpener } from "../agents/routes";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import type { NavigationScope } from "../../features/navigation/targets";
import { avatarMedia } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";

const noSubscribe = () => () => {};
const emptyAgentTypes = Object.freeze([]);
/** This session's community, which targets opened from the panel stay in. */
function panelCommunity(scope: string | undefined, viewer: string | undefined) {
  if (!scope || !viewer || !scope.endsWith(`:${viewer}`)) return undefined;
  try {
    return {
      viewer,
      communityOrigin: relayOrigin(scope.slice(0, -(viewer.length + 1))),
    };
  } catch {
    // This session has no usable navigation scope.
    return undefined;
  }
}

/** The conversation the profile was opened from. Agents keep a Solo chat or
 * a DM as one conversation, so a message's thread there is not its own. */
function openedFrom(session: RelaySession, context: PanelProps["context"]) {
  if (!context) return undefined;
  const kind = session.channels
    .list()
    .channels.find((item) => item.id === context.channelId)?.channelType;
  const whole = kind === "solo" || kind === "dm";
  return {
    channelId: context.channelId,
    ...(context.rootId && !whole && { rootId: context.rootId }),
  };
}

/** Optional Info composition for a panel specializing canonical person profiles. */
export type PersonProfileInfoContent = {
  renderPersonInfo?: ((content: ReactNode) => ReactNode) | undefined;
};
const plainInfo = (content: ReactNode) => content;

export function ProfilePanel({
  relay,
  target,
  context,
  navigation,
  agents,
  communities,
  linkRenderers,
  close,
  renderPersonInfo,
}: PanelProps &
  PersonProfileInfoContent & {
    relay: RelayData;
    navigation?: Navigation;
    /** Agents show their type's tabs. */
    agents?: Agents;
    communities?: CommunityReader | undefined;
    linkRenderers?: ConversationExtensions["links"] | undefined;
  }) {
  const connection = useRelayConnection(relay);
  const activityKey = profileActivityViewKey(target);
  const opening = activityKey ? "activity" : "info";
  // Asked once per opening. This profile takes the opening as soon as it is
  // shown, even on another section, so remounting with the channel finds
  // nothing to reopen; changing sections back after it was offered does not
  // ask again either.
  const asked = useSyncExternalStore(subscribeProfileTranscripts, () =>
    activityKey ? profileTranscriptRequest(target) : undefined,
  );
  const [held, setHeld] = useState<number>();
  const [offered, setOffered] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new opening is claimed.
  useEffect(() => {
    const claimed = claimProfileTranscript(target);
    if (claimed !== undefined) setHeld(claimed);
  }, [asked, target]);
  const pending = asked ?? held;
  const request =
    pending !== undefined && pending > offered ? pending : undefined;
  const initialTranscript = useMemo(
    () =>
      request === undefined
        ? undefined
        : {
            opening: request,
            done: () => setOffered((last) => Math.max(last, request)),
          },
    [request],
  );
  const pubkey = profilePanelKey(target) ?? activityKey;
  const owned = useAgent(agents, pubkey ?? "");
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  // An agent's activity opens a turn's conversation in this community.
  const openConversation = conversationOpener(
    navigation,
    panelCommunity(connection.scope, connection.viewer),
  );
  if (
    agents &&
    owned &&
    owned.agent.owner === connection.viewer &&
    !owned.agent.unfinished &&
    owned.agent.place !== "elsewhere"
  )
    return (
      <OwnedAgentProfile
        linkRenderers={linkRenderers}
        target={target}
        key={`${connection.scope}:${connection.generation}:${pubkey}:${opening}`}
        agents={agents}
        communities={communities}
        initialActivity={!!activityKey}
        initialTranscript={initialTranscript}
        pubkey={pubkey}
        relay={relay}
        session={connection.session}
        scope={panelCommunity(connection.scope, connection.viewer)}
        navigation={navigation}
        context={context}
        openConversation={openConversation}
        close={close}
      />
    );
  return (
    <ProfileDetails
      renderPersonInfo={renderPersonInfo}
      linkRenderers={linkRenderers}
      key={`${connection.scope}:${connection.generation}:${pubkey}:${opening}`}
      initialTab={activityKey ? "activity" : "info"}
      initialTranscript={initialTranscript}
      session={connection.session}
      pubkey={pubkey}
      agentHint={profileAgentHint(target) || !!activityKey}
      context={context}
      navigation={navigation}
      agents={agents}
      communities={communities}
      scope={connection.scope}
      viewer={connection.viewer}
      openConversation={openConversation}
      close={close}
    />
  );
}
function OwnedAgentProfile({
  linkRenderers,
  target,
  agents,
  communities,
  initialActivity,
  initialTranscript,
  pubkey,
  relay,
  session,
  scope,
  navigation,
  context,
  openConversation,
  close,
}: {
  target: string;
  linkRenderers: ConversationExtensions["links"] | undefined;
  agents: Agents;
  communities: CommunityReader | undefined;
  initialActivity: boolean;
  initialTranscript: TranscriptRequest | undefined;
  pubkey: string;
  relay: RelayData;
  session: RelaySession;
  scope: NavigationScope | undefined;
  navigation: Navigation | undefined;
  context: PanelProps["context"];
  openConversation: AgentViewProps["openConversation"];
  close(): void;
}) {
  const { types } = useAgents(agents);
  const owned = useAgent(agents, pubkey);
  const channels = useChannelChoices(session.channels);
  // Unsaved edits are asked about before a link replaces this profile.
  const [unsaved, reportUnsaved] = useAgentSaveReports();
  const [leaving, setLeaving] = useState<string>();
  if (leaving && !unsaved.dirty) setLeaving(undefined);
  if (!owned) return null;
  const address = navigation?.snapshot().entry.target;
  const conversationTarget = (link: string) => {
    const target = scope && buzzLinkTarget(link, scope);
    return target?.kind === "conversation" ? target : undefined;
  };
  const go = (link: string) => {
    const target = conversationTarget(link);
    if (target && navigation) {
      void navigation.open(target);
      return true;
    }
    return (context?.push ?? context?.open)?.(link);
  };
  const openLink = (link: string) => {
    if (!context?.canOpen(link) && !(navigation && conversationTarget(link)))
      return false;
    if (!unsaved.saving && !unsaved.dirty) return !!go(link);
    if (!unsaved.saving) setLeaving(link);
    return false;
  };
  return (
    <AgentSaveState value={reportUnsaved}>
      <AgentDetails
        historyPresentation={
          navigation &&
          address?.kind === "conversation" &&
          address.detail?.target === target
            ? historyPresentation(
                navigation,
                profileHistoryRoute(target),
                (selected) => ({
                  ...address,
                  detail: {
                    ...address.detail,
                    target: profileHistoryTarget(target, selected),
                  },
                }),
                profileHistoryActive(target),
              )
            : undefined
        }
        agents={agents}
        communities={communities}
        agent={owned.agent}
        type={owned.type}
        types={types}
        channels={channels}
        memories={session.agentMemories}
        memoryLinks={{ session, registry: linkRenderers, open: openLink }}
        onRemoved={close}
        initialActivity={initialActivity}
        initialTranscript={initialTranscript}
        close={close}
        openConversation={openConversation}
        openLink={context && openLink}
        canOpenLink={context && ((link) => context.canOpen(link))}
        conversation={openedFrom(session, context)}
        messageAction={(variant) => (
          <AgentMessageButton
            variant={variant}
            pubkey={pubkey}
            relay={relay}
            navigator={navigation}
            navigation={undefined}
          />
        )}
        openSettings={
          navigation &&
          ((section) =>
            void navigation.open({ version: 1, kind: "settings", section }))
        }
      />
      {leaving && (
        <DiscardChanges
          description={`Your unsaved changes to ${owned.agent.name} will be lost.`}
          onKeep={() => setLeaving(undefined)}
          onDiscard={() => {
            setLeaving(undefined);
            go(leaving);
          }}
        />
      )}
    </AgentSaveState>
  );
}

function ProfileDetails({
  linkRenderers,
  initialTab,
  initialTranscript,
  agentHint,
  session,
  pubkey,
  context,
  navigation,
  agents,
  communities,
  scope,
  viewer,
  openConversation,
  close,
  renderPersonInfo = plainInfo,
}: PersonProfileInfoContent & {
  agents: Agents | undefined;
  linkRenderers: ConversationExtensions["links"] | undefined;
  communities: CommunityReader | undefined;
  initialTab: "info" | "activity";
  initialTranscript: TranscriptRequest | undefined;
  agentHint: boolean;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  scope: string | undefined;
  viewer: string | undefined;
  openConversation: AgentViewProps["openConversation"];
  close(): void;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(pubkey);
  const verificationDate = profile?.verified
    ? new Date(profile.verified.verifiedAt * 1000)
    : undefined;
  const verificationIso =
    verificationDate && Number.isFinite(verificationDate.getTime())
      ? verificationDate.toISOString()
      : undefined;
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  // Retry stays mounted and focusable while its own read is pending.
  const [retrying, setRetrying] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [tab, setTab] = useState<
    "info" | "activity" | "channels" | `agent:${string}`
  >(initialTab);
  // A new transcript request shows Activity, as choosing its tab would.
  const opening = initialTranscript?.opening;
  const [asked, setAsked] = useState(opening);
  if (opening !== asked) {
    setAsked(opening);
    if (opening !== undefined) setTab("activity");
  }
  // An agent's sections come from its type and the app, not the harness.
  const plugin = useAgent(agents, pubkey);
  const agentTypes = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    agents?.types ?? (() => emptyAgentTypes),
    () => emptyAgentTypes,
  );
  const settings = useAgentSettingsHost({
    agents,
    agent: plugin?.agent,
    type: plugin?.type,
    types: agentTypes,
  });
  const sections =
    settings.agent && agents
      ? agentSections({
          agents,
          agent: settings.agent,
          type: settings.type,
          memories: session.agentMemories,
          memoryLinks: {
            session,
            registry: linkRenderers,
            open: (url) => !!context?.open(url),
          },
          communities,
          conversation: openedFrom(session, context),
          initialTranscript,
          close,
          ...(openConversation && { openConversation }),
          ...(settings.settingsHost
            ? { settingsHost: settings.settingsHost }
            : {}),
        })
      : [];
  // Opened for activity, an agent shows its type's Activity tab (its
  // sessions), or its first tab when its type has none.
  const typeActivity = sections.find((item) => item.value === "agent:activity");
  const requestedTab =
    tab === "activity" ? ((typeActivity ?? sections[0])?.value ?? "info") : tab;
  const section = sections.find((item) => item.value === requestedTab);
  const tabHost = usePanelTabHost();
  const tabbed = !!tabHost;
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!tabbed) region.current?.focus();
  }, [tabbed]);
  const profileGeneration = useProfileGeneration(session.profiles);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery; a purge generation rereads.
  useEffect(() => {
    let active = true;
    // A purge reread must not unmount a focused Retry: keep it pending, and
    // let success hand its focus to the stable region as an explicit retry does.
    if (document.activeElement === retryButton.current) setRetrying(true);
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (!active) return;
        // Retry unmounts on success; hand its focus to the stable region.
        if (document.activeElement === retryButton.current)
          region.current?.focus();
        setStatus("ready");
        setRetrying(false);
      },
      () => {
        if (!active) return;
        setStatus("error");
        setRetrying(false);
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt, profileGeneration]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  const knownAgent = agentPubkeys.has(pubkey);
  // Navigation can conservatively identify an agent; it grants no private control.
  const displayAgent = knownAgent || agentHint;
  const ownership = useAgentOwnerEvidence(
    session,
    knownAgent ? pubkey : undefined,
    attempt,
  );
  const verifiedOwner = ownership.owner;
  const selectedTab =
    requestedTab.startsWith("agent:") && !section ? "info" : requestedTab;
  const community = panelCommunity(scope, viewer);
  const communityOrigin = community?.communityOrigin;
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(
    pubkey,
    profile?.name ??
      (displayAgent ? "Unknown agent" : (formatPublicKey(pubkey) ?? pubkey)),
  );
  // The verification line carries the check, so it keeps the handle when the
  // name already is it.
  const otherName =
    profile?.verified &&
    (otherVerifiedName(verifiedLabel(profile.verified), profile.verified) ??
      `@${profile.verified.username}`);
  // The portrait is 5rem (at most 240 device px), so the relay's 320 px
  // thumbnail already covers it and reuses the URL message rows have loaded.
  const picture = avatarMedia(profile?.picture, session.media) ?? null;
  const tabAvatar = useMemo(
    () => (
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="fill"
        shape={knownAgent ? "squircle" : "circle"}
      />
    ),
    [picture, name, knownAgent],
  );
  usePanelTabTitle(name, tabAvatar);
  // Targets opened from this panel stay in its community.
  const scoped =
    navigation && community ? { navigation, scope: community } : undefined;
  const {
    available: canMessage,
    opening: openingMessage,
    error: messageError,
    open: openMessage,
  } = useProfileMessage({
    session,
    pubkey,
    viewer,
    agent: displayAgent,
    enabled: !!scoped,
    onOpened(channelId) {
      void scoped?.navigation.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: scoped.scope,
      });
    },
  });
  const canEdit = !!scoped && viewer === pubkey;
  // Settings edits the selected community's profile, so bind it to this one.
  const editProfile = () =>
    void scoped?.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
      scope: scoped.scope,
    });
  // This panel's session is its community's, so the status saves there.
  const statusEditor = useStatusEditor(session, viewer);
  const statusButton = useRef<HTMLButtonElement>(null);
  const userStatus = useUserStatus(session.statuses, pubkey);
  const canSetStatus =
    !!scope && viewer === pubkey && session.statuses.writable;

  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
    >
      <div className={styles.profileContents}>
        <div className={`${hero.hero} ${hero.panelHero}`}>
          <ProfileBackdrop src={picture} />
          <div className={styles.portrait}>
            <AgentAvatar
              session={session}
              agentPubkey={pubkey}
              channelId={context?.channelId}
              src={picture}
              alt={`${name} avatar`}
              fallback={name}
              size="fill"
              shape={displayAgent ? "squircle" : "circle"}
              statusBadge={presence === "unknown" ? undefined : presence}
            />
          </div>
          <div className={styles.identity}>
            <h2 className="text-body-lg">{name}</h2>
            {profile?.verified && (
              <p
                className={`${styles.verifiedName} text-body-sm text-secondary`}
              >
                <span>{otherName}</span>
                {profile.verified.status === "checked" && (
                  <CheckCircleIcon
                    aria-hidden="true"
                    className={styles.verificationIcon}
                  />
                )}
              </p>
            )}
            {profile?.verified && (
              <p className="text-body-sm text-secondary">
                {profile.verified.status === "checked"
                  ? `Name verified by ${profile.verified.issuerLabel}`
                  : `Cached verification from ${profile.verified.issuerLabel}`}{" "}
                {otherName !== `@${profile.verified.username}` &&
                  `· @${profile.verified.username}`}
              </p>
            )}
            {presence !== "unknown" && (
              <p className="text-body-sm text-primary">
                {
                  { online: "Active", away: "Away", offline: "Offline" }[
                    presence
                  ]
                }
              </p>
            )}
            <StatusDisplay session={session} status={userStatus} />
          </div>
          {(canSetStatus || canMessage || canEdit) && (
            <div className={`${hero.actions} ${styles.ownActions}`}>
              {canSetStatus && (
                <Button
                  ref={statusButton}
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  aria-haspopup="dialog"
                  onClick={() => statusEditor.open()}
                >
                  {userStatus ? "Update status" : "Set a status"}
                </Button>
              )}
              {canMessage && (
                <Button
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  loading={openingMessage}
                  onClick={() => void openMessage()}
                >
                  Message
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  onClick={editProfile}
                >
                  Edit profile
                </Button>
              )}
            </div>
          )}
          {messageError && (
            <p role="alert" className="text-body-sm text-danger">
              {messageError}
            </p>
          )}
        </div>
        <Tabs
          value={selectedTab}
          onValueChange={setTab}
          items={[
            { value: "info", label: "Info" },
            ...sections.map(({ value, label }) => ({ value, label })),
            { value: "channels", label: "Channels" },
          ]}
          label="Profile sections"
          variant="panel"
          renderPanel={(selected) => (
            <div className={styles.tabContent}>
              {selected.startsWith("agent:") ? (
                sections.find((item) => item.value === selected)?.render()
              ) : selected === "info" ? (
                (displayAgent ? plainInfo : renderPersonInfo)(
                  <>
                    {profile?.verified && (
                      <SettingsGroup>
                        <PreferenceRow
                          title={`Name verified by ${profile.verified.issuerLabel}`}
                          subtitle={
                            <>
                              Last verified{" "}
                              <time dateTime={verificationIso}>
                                {verificationIso
                                  ? verificationDate?.toLocaleString()
                                  : `Unix time ${profile.verified.verifiedAt}`}
                              </time>
                              .{" "}
                              {profile.verified.status === "cached"
                                ? "Cached evidence; reconnect to check for updates. "
                                : ""}
                              This verifies the name and public key at that
                              time, and does not confirm current account access
                              or current issuer endorsement.
                            </>
                          }
                        />
                      </SettingsGroup>
                    )}
                    {profile?.about && (
                      <SettingsGroup layout="form">
                        <p className={styles.about}>{profile.about}</p>
                      </SettingsGroup>
                    )}
                    {plugin && agents && plugin.agent.place !== "elsewhere" && (
                      <div>
                        <AgentDelete
                          agents={agents}
                          agent={plugin.agent}
                          onRemoved={close}
                        />
                      </div>
                    )}
                    <div className={styles.publicKey}>
                      <SettingsGroup>
                        <PreferenceRow
                          title="Public key"
                          subtitle={
                            <code className={styles.keyValue}>{npub}</code>
                          }
                          trailing={
                            <Button
                              size="compact"
                              variant="ghost"
                              aria-label="Copy npub"
                              onClick={() => {
                                setCopyStatus("");
                                void Promise.resolve()
                                  .then(() => writeClipboardText(npub))
                                  .then(
                                    () => setCopyStatus("Public key copied."),
                                    () =>
                                      setCopyStatus(
                                        "Could not copy. Select the public key above to copy it.",
                                      ),
                                  );
                              }}
                            >
                              <CopyIcon size={16} aria-hidden="true" />
                              Copy
                            </Button>
                          }
                        />
                      </SettingsGroup>
                      <span role="status" className={styles.feedback}>
                        {copyStatus}
                      </span>
                    </div>
                    {knownAgent && verifiedOwner && (
                      <ProfileAgentIdentity
                        session={session}
                        owner={verifiedOwner}
                        viewer={viewer}
                        context={context}
                      />
                    )}
                    <ProfilePublicMetadata nip05={profile?.nip05} />
                    {/* A verified overlay can exist while its kind-0 read failed. */}
                    {(!profile ||
                      (profile.verified && (status === "error" || retrying))) &&
                      (status === "loading" ? (
                        <p role="status">Loading profile…</p>
                      ) : (
                        <p role={status === "error" ? "alert" : undefined}>
                          {status === "error"
                            ? "Could not load this profile."
                            : "No profile metadata is available in this community."}
                        </p>
                      ))}
                    {((!profile && status !== "loading") ||
                      (profile?.verified && status === "error") ||
                      retrying ||
                      ownership.failed) && (
                      <Button
                        ref={retryButton}
                        size="compact"
                        loading={retrying}
                        onClick={() => {
                          setRetrying(true);
                          retry((value) => value + 1);
                        }}
                      >
                        Retry profile
                      </Button>
                    )}
                  </>,
                )
              ) : (
                <ProfileChannels
                  session={session}
                  pubkey={pubkey}
                  navigation={navigation}
                  communityOrigin={communityOrigin}
                  viewer={viewer}
                />
              )}
            </div>
          )}
        />
      </div>
      {statusEditor.editor && scope && (
        <StatusEditor
          session={session}
          scope={scope}
          current={statusEditor.editor.current}
          viewer={statusEditor.editor.viewer}
          close={statusEditor.close}
          finalFocus={statusButton}
        />
      )}
    </section>
  );
}
