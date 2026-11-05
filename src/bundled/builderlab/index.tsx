import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import {
  handoffBackupSession,
  handoffFederatedBackupSession,
} from "../../features/identity/backup";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { brokerBuilderlab, createDevSession } from "./dev-session";
import { createOAuthSession } from "./oauth/session";
import { createNativeSession, nativeBuilderlab } from "./session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import { createKnownCommunitiesClient } from "./known-communities/client";
import { startKnownCommunitiesSync } from "./known-communities/sync";
import { offerBuilderlabDecisions } from "./decisions";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { BuilderlabLogoIcon } from "../../shared/design-system/icons";
import { HostedCommunities } from "./communities/HostedCommunities";
import { brokerApi, createApi } from "./communities/api";
import { createNativeBackend } from "./communities/native";
import { hostedAgentSettings } from "./service";
import { applyApps } from "./apps";

export const inject = [
  "host",
  "settingsCards",
  "agents",
  "relay",
  "panels",
  "browser",
  "knownCommunities",
  "decisions",
  "navigation",
  ...(nativeBuilderlab() ? ["federatedIdentity"] : []),
];
export const apply: PluginModule["apply"] = (ctx) => {
  let unavailable = "";
  try {
    oauthTarget();
  } catch (error) {
    unavailable =
      error instanceof Error
        ? error.message
        : "Builderlab sign-in is unavailable.";
  }
  // The dev broker and FI host own their sessions; only the legacy build
  // uses renderer-held OAuth.
  const dev = brokerBuilderlab() ? createDevSession() : undefined;
  const legacy =
    nativeBuilderlab() || dev
      ? undefined
      : createOAuthSession(
          (signal) => {
            if (!browserLoginAvailable())
              throw new Error(
                "Open the Buzz desktop app to sign in with Builderlab.",
              );
            return browserCredential(ctx.host, signal);
          },
          (credential) => {
            // Local guest teardown is immediate; the parent logout also revokes every server-side viewer child.
            void ctx.host
              .request({
                url: `${oauthTarget()}/v1/auth/logout`,
                method: "POST",
                headers: { "X-BB-Session-Credential": credential.value },
              })
              .catch(() => {});
          },
          ctx.host,
        );
  const session =
    dev?.session ?? legacy ?? createNativeSession(ctx.federatedIdentity);
  ctx.effect(() => () => session.dispose());
  const loginAvailable = (!!dev || browserLoginAvailable()) && !unavailable;
  const openSettings = (section: string) =>
    void ctx.navigation.open({ version: 1, kind: "settings", section });
  // An FI build signs out where its shared organization sign-in is managed.
  const openIdentity = !nativeBuilderlab()
    ? undefined
    : () => openSettings("identity");
  applyApps(ctx, session, loginAvailable, legacy, dev?.apps);
  const handoff = (signedIn: boolean) =>
    legacy
      ? handoffBackupSession(
          "builderlab",
          signedIn ? legacy.credential().value : null,
        )
      : handoffFederatedBackupSession(
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
  const agents = createAgentClient(session);
  if (!unavailable) {
    let providerState: AgentProviderSnapshot = {
      readiness: "attention",
      attentionLabel: "Log in to Builderlab",
    };
    const providerListeners = new Set<() => void>();
    const updateProvider = () => {
      const state = session.snapshot();
      providerState = Object.freeze(
        state.status === "signed-in"
          ? state.account?.canUseRemoteAgents
            ? { readiness: "ready" }
            : { readiness: "attention", attentionLabel: "Coming soon" }
          : state.status === "pending"
            ? { readiness: "checking", blocking: true }
            : {
                readiness: "attention",
                attentionLabel: "Log in to Builderlab",
              },
      );
      for (const listener of providerListeners) listener();
    };
    const stopProvider = session.subscribe(updateProvider);
    const ProviderDialogBody = () => {
      const state = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <div className="grid gap-3">
          <InlineHeader level={3} title="Connection" />
          <Login
            session={session}
            available={loginAvailable}
            active={() => true}
            showHeading={false}
            openIdentity={openIdentity}
          />
          {state.status === "signed-in" &&
            !state.account?.canUseRemoteAgents && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab remote agents are coming soon for your account.
              </p>
            )}
        </div>
      );
    };
    ctx.agents.register({
      ...builderlabType(agents, session, ctx.relay, openSettings),
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
    ctx.provide("builderlab", hostedAgentSettings(session, agents));
  }
  // Link the Buzz key at sign-in. Best effort: activation links again and
  // reports why when it cannot.
  let linked: unknown;
  let linking = Promise.resolve();
  ctx.effect(() =>
    session.subscribe(() => {
      if (session.snapshot().status !== "signed-in") return;
      const credential = session.credential();
      if (linked === credential) return;
      linked = credential;
      linking = agents.link(new AbortController().signal).catch(() => {});
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
  const Communities = ({ active }: { active(): boolean }) => {
    const state = useSyncExternalStore(session.subscribe, session.snapshot);
    if (!communities) return null;
    if (communities === brokerApi)
      return <HostedCommunities api={communities} active={active} />;
    const viewer =
      state.status === "signed-in" && dev ? session.viewerSession() : undefined;
    return state.status === "signed-in" ? (
      <HostedCommunities
        key={
          viewer && "broker" in viewer
            ? viewer.broker.revision
            : state.account?.subject
        }
        api={communities}
        active={active}
        sharedSignIn
      />
    ) : null;
  };
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    icon: BuilderlabLogoIcon,
    group: "Plugins",
    component: ({ active }) => (
      <section aria-labelledby="builderlab-title">
        <Header
          id="builderlab-title"
          title="Builderlab"
          subtitle="One Builderlab account for hosted communities, remote agents and apps."
        />
        <InlineHeader title="Account" />
        <SettingsGroup layout="form">
          <Login
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
        </SettingsGroup>
        <Communities active={active} />
        <RemoteAgents client={agents} session={session} active={active} />
      </section>
    ),
  });
};
