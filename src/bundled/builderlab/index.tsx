import { BuilderlabIdentityRow } from "./login/IdentityRow";
import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { OverviewObserver, OverviewSnapshot } from "./overview";
import type { PluginModule } from "../../plugins/api";
import type { PageNavigation } from "../../features/navigation/service";
import { handoffFederatedBackupSession } from "../../features/identity/backup";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { Login } from "./login/Login";
import { browserLoginAvailable, oauthTarget } from "./oauth/browser";
import { brokerBuilderlab, createDevSession } from "./dev-session";
import {
  createNativeSession,
  followCommunity,
  nativeBuilderlab,
} from "./session";
import { createAgentClient } from "./agents/client";
import { startTurnStatusRecovery } from "./agents/turn-status";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import { createKnownCommunitiesClient } from "./known-communities/client";
import { startKnownCommunitiesSync } from "./known-communities/sync";
import { offerBuilderlabDecisions } from "./decisions";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { useAgentsSnapshot } from "../../features/agents/react";
import { agentTarget } from "../agents/routes";
import { BuilderlabSettings, ManagementHeader } from "./BuilderlabSettings";
import { BuilderlabLogoIcon } from "../../shared/design-system/icons";
import { HostedCommunities } from "./communities/HostedCommunities";
import { brokerApi, createApi } from "./communities/api";
import { createNativeBackend } from "./communities/native";
import { hostedAgentSettings } from "./service";
import { applyApps } from "./apps";

const CREATE_DISMISSED = "builderlab:create-dismissed";

export const inject = [
  "host",
  "settingsCards",
  "agents",
  "relay",
  "panels",
  "browser",
  "knownCommunities",
  "communityJoin",
  "decisions",
  "navigation",
  ...(nativeBuilderlab() ? ["federatedIdentity"] : []),
];
export const apply: PluginModule["apply"] = (ctx) => {
  // Builderlab signs in with the native NIP-FI session, or in live
  // development with the broker's. A build with neither has no Builderlab.
  const dev = brokerBuilderlab() ? createDevSession() : undefined;
  if (!dev && !nativeBuilderlab()) return;
  let unavailable = "";
  try {
    oauthTarget();
  } catch (error) {
    unavailable =
      error instanceof Error
        ? error.message
        : "Builderlab sign-in is unavailable.";
  }
  const session = dev?.session ?? createNativeSession(ctx.federatedIdentity);
  ctx.effect(() => () => session.dispose());
  // Remote agents use the sign-in server of the community in view; the rest
  // of Builderlab stays with the build's.
  const agentSession = dev
    ? session
    : followCommunity(session, ctx.federatedIdentity, ctx.relay);
  if (agentSession !== session) ctx.effect(() => () => agentSession.dispose());
  const loginAvailable = (!!dev || browserLoginAvailable()) && !unavailable;
  const openSettings = (section: string) =>
    void ctx.navigation.open({ version: 1, kind: "settings", section });
  // An FI build signs out where its shared organization sign-in is managed.
  const openIdentity = !nativeBuilderlab()
    ? undefined
    : () =>
        void ctx.navigation.open({
          version: 1,
          kind: "settings",
          section: "identity",
          part: "organization-sign-in",
        });
  // An app that refuses the sign-in sends you where it is renewed: Identity in
  // an FI build, this card in live development.
  applyApps(
    ctx,
    session,
    loginAvailable,
    dev?.apps,
    openIdentity ?? (() => openSettings("block.builderlab/login")),
  );
  const handoff = (signedIn: boolean) =>
    handoffFederatedBackupSession(
      signedIn ? ctx.federatedIdentity.snapshot().revision : null,
    );
  const backupSession = () => {
    if (!nativeIdentityEnabled()) return;
    handoff(session.snapshot().status === "signed-in");
  };
  ctx.effect(() => {
    const stop = session.subscribe(backupSession);
    return () => {
      stop();
      if (nativeIdentityEnabled()) handoff(false);
    };
  });
  // The account's community list follows this sign-in; see docs/communities.md.
  // Where no sign-in is possible, no owner runs, so the rail has no sync to
  // report on.
  if (loginAvailable)
    ctx.effect(() =>
      startKnownCommunitiesSync({
        client: createKnownCommunitiesClient(session),
        session,
        knownCommunities: ctx.knownCommunities,
      }),
    );
  const agents = createAgentClient(agentSession);
  if (loginAvailable)
    ctx.effect(() =>
      startTurnStatusRecovery({
        relay: ctx.relay,
        session: agentSession,
        client: agents,
      }),
    );
  if (!unavailable) {
    let providerState: AgentProviderSnapshot = {
      readiness: "attention",
      attentionLabel: "Log in to Builderlab",
    };
    const providerListeners = new Set<() => void>();
    const updateProvider = () => {
      const state = agentSession.snapshot();
      providerState = Object.freeze(
        state.status === "signed-in"
          ? state.account?.canUseRemoteAgents
            ? { readiness: "ready" }
            : {
                readiness: "attention",
                attentionLabel: null,
                attentionDescription: "Unavailable for this account",
              }
          : state.status === "pending"
            ? { readiness: "checking", blocking: true }
            : {
                readiness: "attention",
                attentionLabel: "Log in to Builderlab",
              },
      );
      for (const listener of providerListeners) listener();
    };
    const stopProvider = agentSession.subscribe(updateProvider);
    const ProviderDialogBody = () => {
      const state = useSyncExternalStore(
        agentSession.subscribe,
        agentSession.snapshot,
      );
      return (
        <div className="grid gap-3">
          <InlineHeader level={3} title="Connection" />
          <Login
            session={agentSession}
            available={loginAvailable}
            active={() => true}
            showHeading={false}
            openIdentity={openIdentity}
          />
          {state.status === "signed-in" &&
            !state.account?.canUseRemoteAgents && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab remote agents are unavailable for this account.
              </p>
            )}
        </div>
      );
    };
    ctx.agents.register({
      ...builderlabType(
        agents,
        agentSession,
        ctx.relay,
        openIdentity,
        openSettings,
      ),
      provider: {
        snapshot: () => providerState,
        subscribe: (listener) => {
          providerListeners.add(listener);
          return () => providerListeners.delete(listener);
        },
        check: updateProvider,
        DialogBody: ProviderDialogBody,
      },
    });
    ctx.effect(() => () => stopProvider());
    // Native validation stays in place; the dev transport uses a public revision.
    offerBuilderlabDecisions(
      ctx,
      session,
      loginAvailable,
      dev?.decide,
      openIdentity,
    );
    ctx.provide("builderlab", hostedAgentSettings(agentSession, agents));
  }
  // Link the Buzz key at sign-in. Best effort: activation links again and
  // reports why when it cannot.
  let linked: unknown;
  let linking = Promise.resolve();
  const accountAgents =
    agentSession === session ? agents : createAgentClient(session);
  ctx.effect(() =>
    session.subscribe(() => {
      if (session.snapshot().status !== "signed-in") return;
      const credential = session.credential();
      if (linked === credential) return;
      linked = credential;
      linking = accountAgents
        .link(new AbortController().signal)
        .catch(() => {});
    }),
  );
  // Desktop communities use this sign-in. Live development with a pinned
  // viewer keeps the broker, which signs in and signs bindings on its own.
  const communities =
    dev?.communities ??
    (!nativeIdentityEnabled()
      ? brokerApi
      : loginAvailable
        ? createApi(createNativeBackend(session, () => linking))
        : null);
  const Communities = ({
    active,
    onOverview,
    navigation,
    initialCreate,
    onCreateClose,
  }: {
    active(): boolean;
    onOverview: OverviewObserver;
    navigation: ReactNode;
    initialCreate: boolean;
    onCreateClose(): void;
  }) => {
    const state = useSyncExternalStore(session.subscribe, session.snapshot);
    useLayoutEffect(() => {
      if (
        active() &&
        (!communities ||
          (communities !== brokerApi && state.status !== "signed-in"))
      )
        onOverview({ kind: "empty" });
    }, [active, onOverview, state.status]);
    const heading = (
      <ManagementHeader navigation={navigation} title="Communities" />
    );
    if (!communities) return heading;
    if (communities === brokerApi)
      return (
        <HostedCommunities
          initialCreate={initialCreate}
          onCreateClose={onCreateClose}
          navigation={navigation}
          api={communities}
          active={active}
          onOverview={onOverview}
          join={ctx.communityJoin?.open}
        />
      );
    const viewer =
      state.status === "signed-in" && dev ? session.viewerSession() : undefined;
    return state.status === "signed-in" ? (
      <HostedCommunities
        initialCreate={initialCreate}
        onCreateClose={onCreateClose}
        navigation={navigation}
        key={
          viewer && "broker" in viewer
            ? viewer.broker.revision
            : state.account?.subject
        }
        api={communities}
        active={active}
        onOverview={onOverview}
        join={ctx.communityJoin?.open}
        sharedSignIn
      />
    ) : (
      heading
    );
  };
  const Settings = ({
    active,
    navigation,
  }: {
    active(): boolean;
    navigation?: PageNavigation | undefined;
  }) => {
    const state = useSyncExternalStore(session.subscribe, session.snapshot);
    useSyncExternalStore(agentSession.subscribe, agentSession.snapshot);
    const agentServer =
      agentSession.providerName !== session.providerName
        ? agentSession.providerName
        : undefined;
    const route =
      navigation?.target.kind === "settings"
        ? navigation.target.route
        : undefined;
    const createRequested =
      route?.version === 1 && route.params === "create-community";
    const saved = useAgentsSnapshot(ctx.agents);
    const [communityOverview, setCommunityOverview] =
      useState<OverviewSnapshot>({ kind: "pending" });
    const [agentOverview, setAgentOverview] = useState<OverviewSnapshot>({
      kind: "pending",
    });
    return (
      <BuilderlabSettings
        key={navigation?.entryId}
        active={active}
        initialSection={createRequested ? "communities" : undefined}
        keepAccountVisible={state.status !== "signed-in"}
        summaries={{ communities: communityOverview, agents: agentOverview }}
        agentServer={agentServer}
        account={
          <Login
            notice
            showHeading={false}
            session={session}
            available={loginAvailable}
            unavailableReason={
              dev || browserLoginAvailable()
                ? unavailable
                : "Open the Buzz desktop app to sign in with Builderlab."
            }
            active={active}
            openIdentity={openIdentity}
          />
        }
        communities={(back) => (
          <Communities
            initialCreate={
              createRequested && navigation?.position(CREATE_DISMISSED) !== true
            }
            onCreateClose={() => {
              if (createRequested)
                navigation?.savePosition(CREATE_DISMISSED, true);
            }}
            navigation={back}
            active={active}
            onOverview={setCommunityOverview}
          />
        )}
        agents={
          <RemoteAgents
            client={agents}
            session={agentSession}
            signIn={
              agentSession.target ? (
                <Login
                  session={agentSession}
                  available={loginAvailable}
                  active={active}
                  showHeading={false}
                  openIdentity={openIdentity}
                />
              ) : undefined
            }
            active={active}
            onOverview={setAgentOverview}
            savedAgents={saved?.agents ?? []}
            openAgent={(pubkey) => {
              if (active() && ctx.agents.find(pubkey))
                void ctx.navigation.open(agentTarget(pubkey));
            }}
            showHeading={false}
            openAgents={() => {
              if (active())
                void ctx.navigation.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.agents",
                  pageId: "agents",
                });
            }}
          />
        }
      />
    );
  };
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    icon: BuilderlabLogoIcon,
    group: "Plugins",
    ...(nativeBuilderlab() && !unavailable
      ? {
          identityRow: ({ active }: { active(): boolean }) => (
            <BuilderlabIdentityRow
              session={session}
              active={active}
              openSettings={() => openSettings("block.builderlab/login")}
            />
          ),
        }
      : {}),
    component: Settings,
  });
};
