import { provideNetworkDiagnostics } from "../features/developer/network-service";
import { ArtifactStorageService } from "../features/artifact-storage/service";
import { provideArtifactStoreSync } from "../features/relay/artifact-store-sync";
import { createAdminAccess } from "../bundled/admin-access";
import { nativeRelayStaff } from "../features/relay-staff/native";
import { createLocalAgentActivity } from "../features/agents/local-activity";
// FOUNDATION: Compose the bundled distribution, plugin runtime, and services here.
import {
  createIdentity,
  nativeIdentityEnabled,
} from "../features/identity/service";
import { SettingsCardsService } from "../features/settings/service";
import { IdentityNamesService } from "../features/identity-names/service";
import { createLocalAgents } from "../features/agents/local";
import {
  askAgain,
  FederatedIdentityService,
  onSignedIn,
} from "../features/federated-identity/service";
import { HostService } from "../features/host/service";
import { bindUnreadIndicator } from "../features/notifications/indicator-unread";
import {
  createCommunityUnreads,
  type UnreadGates,
} from "../features/notifications/community-unread";
import { provideNavigation } from "../features/navigation/service";
import {
  bindDeepLinks,
  createRejectedLinks,
} from "../features/navigation/deep-links";
import { bindSearchUsage } from "../features/search/usage";
import { communityDestination } from "../features/communities/destination";
import { NotificationsService } from "../features/notifications/service";
import {
  bindMessageNotifications,
  notificationAuthorized,
} from "../features/notifications/messages";
import { AccountActionsService } from "../features/account-actions/service";
import { ShortcutsService } from "../features/shortcuts/service";
import { DecisionsService } from "../features/decisions/service";
import { AgentsService } from "../features/agents/service";
import { deviceSettings } from "./device-settings";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { ConversationService } from "../features/conversation/service";
import { createAppearance } from "../shared/theme/service";
import { createCommunities } from "../features/communities/service";
import {
  createInviteIntent,
  offeredCommunity,
} from "../features/communities/invite-intent";
import type {
  JoinRequest,
  JoinForm,
  JoinVisitState,
} from "../features/communities/invite-intent";
import {
  joinBeneath,
  withoutJoin,
  type OpenTarget,
} from "../features/navigation/targets";
import {
  connectNativeTransport,
  verifyNativeStored,
} from "../features/relay/native";
import { createUpdates } from "../features/updates/updates";
import { PanelsService } from "../features/panels/service";
import { BackdropsService } from "../features/backdrops/service";
import { SubjectLiftService } from "../features/messages/subject-lift";
import { pluginUi } from "../features/plugin-ui/service";
import { Context } from "@deepseek-ai/cordis";
import { BrowserService } from "../features/browser/service";
import { PagesService } from "../features/pages/service";
import { SeenService } from "../features/seen/service";
import { SoloNavigationService } from "../features/channel-navigation/solo-navigation";
import { SidebarRowsService } from "../features/channel-navigation/sidebar-rows-service";
import { SidebarSectionsService } from "../features/channel-navigation/sidebar-sections-service";
import { SidebarScopeService } from "../features/channel-navigation/sidebar-scope-service";
import { bundledPlugins } from "../bundled";
import { bundledFederatedIdentity } from "../bundled/builderlab/oauth/first-run";
import { nativeBuilderlab } from "../bundled/builderlab/session";
import { builderlabPhone } from "../features/identity/builderlab-account";
import { conversationFeatures } from "./conversation-features";
import { PluginDevelopmentService } from "../features/plugin-development/service";
import { createPluginManager } from "../plugins/manager";
import {
  createPluginInstallCore,
  createPluginInstallRequests,
  createPluginInstallerService,
} from "../plugins/installer";
import { withTimeout } from "../plugins/timeout";
import { createExternalApps } from "../features/agents/external-connection";

export function createServices() {
  const appearance = createAppearance();
  const shortcutBindings = createShortcutBindings();
  const updates = createUpdates();
  const ctx = new Context();
  const externalApps = createExternalApps();
  ctx.provide("externalApps", externalApps);
  provideNetworkDiagnostics(ctx);
  new HostService(ctx);
  const federatedIdentity = new FederatedIdentityService(ctx);
  // An FI build's Welcome calls the session as the Builderlab plugin's
  // bundled installation, which works whether or not the plugin has started.
  const firstRunFederatedIdentity = nativeBuilderlab()
    ? bundledFederatedIdentity(ctx)
    : undefined;
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
    builtIn: conversationFeatures,
  });
  new PluginDevelopmentService(ctx, () => plugins);
  const localAgents = createLocalAgents();
  const localActivity = createLocalAgentActivity();
  const navigationHost = provideNavigation(ctx);
  const navigation = navigationHost.navigation;
  const browser = new BrowserService(ctx);
  const shortcuts = new ShortcutsService(ctx, undefined, shortcutBindings);
  const decisions = new DecisionsService(ctx);
  const pages = new PagesService(ctx);
  const sidebarSections = new SidebarSectionsService(ctx);
  const pluginInstallRequests = createPluginInstallRequests();
  const pluginInstallCore = createPluginInstallCore({
    plugins,
    requests: pluginInstallRequests,
    openPlugins: () =>
      navigation.open({ version: 1, kind: "settings", section: "plugins" }),
  });
  createPluginInstallerService(ctx, { core: pluginInstallCore });
  const sidebarScope = new SidebarScopeService(ctx);
  const sidebarRows = new SidebarRowsService(ctx);
  const panels = new PanelsService(ctx);
  const backdrops = new BackdropsService(ctx);
  new SubjectLiftService(ctx);
  ctx.provide("ui", pluginUi);
  const accountActions = new AccountActionsService(ctx);
  const conversation = new ConversationService(ctx);
  const settingsCards = new SettingsCardsService(ctx);
  const identityNames = new IdentityNamesService(ctx, localAgents.agents);
  const identity = nativeIdentityEnabled() ? createIdentity() : undefined;
  const communities = createCommunities(
    ctx,
    import.meta.env.VITE_BUZZ_LIVE === "1",
    identityNames,
    import.meta.env.VITE_BUZZ_OPEN_RELAY ?? "",
    localAgents.agents,
    identity?.ready,
    identity ? connectNativeTransport : undefined,
    localActivity.reader,
    identity ? verifyNativeStored : undefined,
    identity ? askAgain : undefined,
  );
  const seen = new SeenService(ctx, communities);
  ctx.provide("communityReader", {
    snapshot: communities.snapshot,
    subscribe: communities.subscribe,
    retained: communities.retained,
  });
  ctx.provide("knownCommunities", {
    snapshot: communities.snapshot,
    subscribe: communities.subscribe,
    pending: communities.pendingSync,
    apply: communities.applySync,
  });
  // The mobile card's one question of the Builderlab account, asked through
  // app-owned code so the pairing plugin never calls as the Builderlab plugin.
  ctx.provide(
    "builderlabPhone",
    builderlabPhone(firstRunFederatedIdentity, identity),
  );
  const relay = communities.relay;
  const artifactStorage = new ArtifactStorageService(ctx);
  provideArtifactStoreSync(ctx, artifactStorage);
  // Expose v2 only with the complete label/projection/frame/Destination/guard slice.
  new SoloNavigationService(ctx, relay, plugins);
  // The one recovery point for federated sign-in; see onSignedIn.
  ctx.effect(() =>
    onSignedIn(federatedIdentity, () => communities.reauthorize()),
  );
  const adminAccess = createAdminAccess(relay, communities, nativeRelayStaff());
  ctx.provide("adminAccess", adminAccess);
  ctx.effect(() => () => adminAccess.dispose());
  const agents = new AgentsService(
    ctx,
    communities,
    undefined,
    undefined,
    undefined,
    localActivity,
    decisions,
    undefined,
    deviceSettings(appearance),
  );
  ctx.effect(() =>
    localAgents.bind({
      snapshot: agents.local,
      subscribe: agents.subscribe,
      refresh: () => agents.refresh(),
    }),
  );
  const notifications = new NotificationsService(
    ctx,
    navigation,
    undefined,
    undefined,
    (target) => notificationAuthorized(communities, target),
  );
  ctx.effect(() =>
    bindMessageNotifications(notifications, communities, localActivity.reader),
  );
  const inviteIntent = createInviteIntent();
  // Every visit of one opening carries its token: the opening's in-memory
  // state, retirement and completion follow it, not the address it started on.
  const openJoin = (viewer: string, state: JoinVisitState) => {
    const visit = crypto.randomUUID();
    inviteIntent.set(visit, state);
    const target: OpenTarget = {
      ...joinBeneath(navigation.snapshot().entry.target),
      join: {
        viewer,
        visit,
        ...(state.community ? { community: state.community } : {}),
      },
    };
    void navigation.open(target).then((result) => {
      // A refused or cancelled opening keeps no code. A superseded one may
      // still stand in history (Back landed first), so it keeps its state.
      if (result.status === "failed" || result.status === "cancelled")
        inviteIntent.delete((key) => key === visit);
    });
  };
  const invites = {
    subscribe: inviteIntent.subscribe,
    /** In-memory state of the join visit `target`, for its viewer only. */
    state(target: OpenTarget, viewer: string | undefined) {
      const state = target.join && inviteIntent.get(target.join.visit);
      return state?.viewer === viewer ? state : undefined;
    },
    consume(target: OpenTarget) {
      if (target.join) inviteIntent.consume(target.join.visit);
    },
    /** The form as edited in the shown opening's dialog, restored without
     * submitting. A late report from a dialog no longer shown is ignored. */
    edit(target: OpenTarget, form: JoinForm) {
      const join = target.join;
      if (
        !join ||
        navigation.snapshot().entry.target.join?.visit !== join.visit
      )
        return;
      inviteIntent.edit(
        join.visit,
        {
          viewer: join.viewer,
          ...(join.community ? { community: join.community } : {}),
          code: "",
          connect: false,
        },
        form,
      );
    },
    // The join dialog is a visit over the current one, so Back closes it and
    // Forward reopens it. With no code to claim, an existing membership just
    // opens its community.
    open(invite: JoinRequest, viewer: string) {
      const { memberships } = communities.snapshot();
      const id = communityDestination(invite.community).id;
      if (invite.code || !memberships.some((m) => m.id === id)) {
        openJoin(viewer, {
          viewer,
          community: communityDestination(invite.community).url,
          code: invite.code,
          connect: invite.submitted === true,
        });
        return;
      }
      // Select now, not in the navigation effect, so a link read in the
      // meantime is not discarded as a community switch.
      communities.select(id);
      void navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: { viewer, communityOrigin: invite.community },
      });
    },
    /** Join a community with no address yet, as a visit over the current one. */
    start(viewer: string) {
      openJoin(viewer, { viewer, code: "", connect: false });
    },
    /** Explicit Close: retire this opening's visits, keeping the visit beneath. */
    close(target: OpenTarget) {
      const join = target.join;
      if (!join) return;
      inviteIntent.delete((visit) => visit === join.visit);
      navigation.dismiss(
        (visit) => visit.join?.visit === join.visit,
        withoutJoin(target),
      );
    },
    /**
     * A finished join: this opening's visits retire, and so does every visit
     * that would offer this viewer the community actually joined.
     */
    complete(target: OpenTarget, joined: string | undefined) {
      const join = target.join;
      if (!join) return;
      // What each opening offers now: its edited address, else its original.
      const offers = (visit: string, community?: string) =>
        !!joined &&
        offeredCommunity(inviteIntent.get(visit), community) === joined;
      navigation.dismiss(
        (visit) =>
          !!visit.join &&
          visit.join.viewer === join.viewer &&
          (visit.join.visit === join.visit ||
            offers(visit.join.visit, visit.join.community)),
        withoutJoin(target),
      );
      // After the dismissal, which reads each opening's state.
      inviteIntent.delete(
        (visit, state) =>
          visit === join.visit ||
          (state.viewer === join.viewer && offers(visit)),
      );
    },
  };
  // An opening's state lives as long as one of its visits does: closing the
  // view beneath it, a new branch or history's capacity releases its code.
  const joinVisits = new Map<string, string>();
  ctx.effect(() =>
    navigation.subscribe(() => {
      const { entry, retainedVisits } = navigation.snapshot();
      const before = new Set(joinVisits.values());
      if (entry.target.join) joinVisits.set(entry.id, entry.target.join.visit);
      else joinVisits.delete(entry.id);
      if (retainedVisits) {
        const retained = new Set(retainedVisits);
        for (const id of joinVisits.keys())
          if (!retained.has(id)) joinVisits.delete(id);
      }
      for (const visit of joinVisits.values()) before.delete(visit);
      if (before.size) inviteIntent.delete((visit) => before.has(visit));
    }),
  );
  // Codes are the viewer's: another identity never inherits them.
  let inviteViewer = communities.snapshot().viewer;
  communities.subscribe(() => {
    const { viewer } = communities.snapshot();
    if (viewer === inviteViewer) return;
    inviteViewer = viewer;
    inviteIntent.delete((_visit, state) => state?.viewer !== viewer);
  });
  // A community the account just created is joined as an address the person
  // already chose: the join dialog opens on it and connects at once.
  ctx.provide("communityJoin", {
    open(address: string) {
      const { viewer } = communities.snapshot();
      if (!viewer) return false;
      let community: string;
      try {
        community = communityDestination(address).url;
      } catch {
        // Not a community origin (a path, credentials): hand it off instead.
        return false;
      }
      invites.open(
        {
          community,
          code: "",
          submitted: true,
        },
        viewer,
      );
      return true;
    },
  });
  // OS deep links; a no-op in the browser build. Invite admission remains in
  // the join dialog, never in navigation or the native queue.
  const rejectedLinks = createRejectedLinks();
  const deepLinks = {
    ...navigationHost,
    invite: invites.open,
    authorize: externalApps.open,
    rejected: rejectedLinks.reject,
    accepted: () => rejectedLinks.clear(),
    // As the router decides: Inbox waits on startup and its own activation.
    inbox: {
      status: () =>
        plugins.startup() === "loading" ||
        plugins.snapshot().activation["buzz.inbox"]?.status === "starting"
          ? ("loading" as const)
          : pages.snapshot().some((page) => page.key === "buzz.inbox/inbox")
            ? ("on" as const)
            : ("off" as const),
      // Both producers emit mid-update: reconciliation before every plugin is
      // starting, activation before pages publish it. Read once both finish.
      subscribe(listener: () => void) {
        let queued = false;
        let stopped = false;
        const notify = () => {
          if (queued) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!stopped) listener();
          });
        };
        const stopPlugins = plugins.subscribe(notify);
        const stopPages = pages.subscribe(notify);
        return () => {
          stopped = true;
          stopPlugins();
          stopPages();
        };
      },
    },
  };
  ctx.effect(() => bindDeepLinks(deepLinks, communities));
  // Search ranks places by how often and how recently they were opened.
  ctx.effect(() =>
    bindSearchUsage(navigation, () => {
      const { selected, viewer } = communities.snapshot();
      return selected && viewer
        ? { viewer, communityOrigin: communityDestination(selected).url }
        : undefined;
    }),
  );
  const unreadGates: UnreadGates = {
    allows: (target) => notifications.gated(target),
    subscribe: notifications.subscribeGates,
  };
  if (notifications.indicator.available)
    ctx.effect(() =>
      bindUnreadIndicator(
        communities,
        notifications.indicator.setUnread,
        unreadGates,
      ),
    );
  const communityUnreads = createCommunityUnreads(communities, unreadGates);
  ctx.effect(() => communityUnreads.dispose);
  let disposal: Promise<void> | undefined;
  return {
    identity,
    browser,
    notifications,
    agentActivity: localActivity.reader,
    navigation,
    navigationHost,
    shortcuts,
    decisions,
    agents,
    accountActions,
    shortcutBindings,
    conversation,
    artifactStorage,
    settingsCards,
    adminAccess,
    pages,
    seen,
    sidebarSections,
    pluginInstallRequests,
    sidebarScope,
    sidebarRows,
    panels,
    backdrops,
    plugins,
    federatedIdentity,
    firstRunFederatedIdentity,
    relay,
    communities,
    communityUnreads,
    invites,
    rejectedLinks,
    deepLinks,
    externalApps,
    appearance,
    updates,
    dispose() {
      identity?.dispose();
      appearance.dispose();
      updates.dispose();
      shortcutBindings.dispose();
      // Start root cancellation without waiting for plugin-owned cleanup. Cordis
      // starts sibling effects independently; the runtime still owns replacement
      // barriers. A timeout reports incomplete cleanup, never successful disposal.
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "App cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}

export type AppServices = ReturnType<typeof createServices>;
