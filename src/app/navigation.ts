import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppServices } from "./services";
import { communityDestination } from "../features/communities/destination";
import { targetKey, type OpenTarget } from "../features/navigation/targets";
import type { PageNavigation } from "../features/navigation/service";
import type {
  OpenAttempt,
  OpenFailure,
  Navigation,
  NavigationOpenOptions,
  NavigationSnapshot,
} from "../features/navigation/controller";
import { isBuiltInSettingsSection } from "./settings-sections";
import { linkedPage, linkedPageTarget } from "../features/pages/plugin-link";

const channelsKey = "buzz.channels/channels";
/** Presentation-only lease for an already-confirmed Settings departure. */
export type PendingSettingsDeparture = {
  attempt: OpenAttempt;
  viewer: string;
  communityId: string;
};
/**
 * The navigation as the shell renders it. An attempt that opens changes only
 * its status, so the shell keeps the opening snapshot and skips a render per
 * visit: its status never reads "opened". Readers of that subscribe themselves.
 */
export function shellSnapshot(navigation: Navigation) {
  let shown = navigation.snapshot();
  return () => {
    const next = navigation.snapshot();
    const last = shown;
    const keys = Object.keys(next) as (keyof NavigationSnapshot)[];
    if (
      last.status !== "opening" ||
      next.status !== "opened" ||
      keys.length !== Object.keys(last).length ||
      keys.some((key) => key !== "status" && next[key] !== last[key])
    )
      shown = next;
    return shown;
  };
}
export function useAppNavigation(
  services: AppServices,
  departure?: PendingSettingsDeparture | null,
) {
  const navigation = services.navigation;
  const view = useMemo(() => shellSnapshot(navigation), [navigation]);
  const state = useSyncExternalStore(navigation.subscribe, view);
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const pages = useSyncExternalStore(
    services.pages.subscribe,
    services.pages.snapshot,
  );
  const plugins = useSyncExternalStore(
    services.plugins.subscribe,
    services.plugins.snapshot,
  );

  // This is the presenter the visit deadline measures. Behind the identity and
  // key-setup gate (IdentitySetup) none exists, so the startup visit's deadline
  // runs from this mount, not from createServices(); otherwise a new user's first
  // frame was the timeout notice.
  useLayoutEffect(() => services.navigationHost.attach(), [services]);

  const relay = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );

  const startup = plugins.configuration.status;
  const target = state.entry.target;
  const settings = target.kind === "settings";
  const provider = settings ? target.provider : undefined;
  const providerAvailable = useSyncExternalStore(
    (listener) =>
      provider && services.agents
        ? services.agents.subscribe(listener)
        : () => {},
    () =>
      !!provider &&
      !!services.agents
        ?.types()
        .some((type) => type.key === provider && type.provider),
  );
  const visibility = useSyncExternalStore(
    services.settingsCards.subscribe,
    () =>
      settings && target.section
        ? services.settingsCards.visibility(target.section)
        : true,
  );
  // Demand belongs to the route, including pending/error presentation and retry.
  const [retainedAttempt, setRetainedAttempt] =
    useState<typeof state.attempt>();
  useLayoutEffect(() => {
    if (!settings) return;
    const release = services.settingsCards.retainVisibility();
    setRetainedAttempt(state.attempt);
    return release;
  }, [services, settings, state.attempt]);
  const lastNonSettings = useRef<
    { target: OpenTarget; entryId: string } | undefined
  >(undefined);
  if (target.kind !== "settings")
    lastNonSettings.current = { target, entryId: state.entry.id };
  const scope = "scope" in target ? target.scope : undefined;
  const pageKey =
    target.kind === "page"
      ? `${target.pluginId}/${target.pageId}`
      : target.kind === "conversation"
        ? channelsKey
        : undefined;
  const page = pages.find((page) => page.key === pageKey);
  const pluginLink = target.kind === "plugin" ? target : undefined;
  const linked = pluginLink && linkedPage(pages, pluginLink);
  const membership = scope
    ? client.memberships.find(
        (item) => communityDestination(item.id).url === scope.communityOrigin,
      )
    : undefined;
  // Only this admitted action may outlive its own saved membership. This does
  // not authorize another community route or grant a revoked page request.
  const finishingDeparture =
    departure?.attempt === state.attempt &&
    target.kind === "settings" &&
    target.section === "leave-community" &&
    client.viewer === departure.viewer &&
    scope?.viewer === departure.viewer &&
    scope.communityOrigin === communityDestination(departure.communityId).url &&
    (client.selected === null || client.selected === departure.communityId);
  let failure: OpenFailure | undefined;
  const legacyHome = target.kind === "home";
  const legacyPage = useMemo(() => legacyPageTarget(target), [target]);
  const legacyMessagesSettings =
    settings && target.section === "buzz.channels/messages";
  let waiting =
    legacyHome ||
    legacyPage !== undefined ||
    legacyMessagesSettings ||
    pluginLink !== undefined;
  if (scope === null) {
    waiting ||= client.status === "loading" || client.selected !== null;
  } else if (scope) {
    if (client.status === "loading") waiting = true;
    else if (client.viewer !== scope.viewer) failure = "denied";
    else if (!membership && !finishingDeparture) failure = "denied";
    else if (membership && client.selected !== membership.id) waiting = true;
  }
  if (pageKey && !failure && !legacyPage) {
    if (startup === "loading") waiting = true;
    else if (
      plugins.activation[
        target.kind === "page" ? target.pluginId : "buzz.channels"
      ]?.status === "starting"
    )
      waiting = true;
    else if (!page) failure = "unavailable";
    else if (target.kind === "page" && target.route) {
      try {
        if (
          !page.route ||
          page.route.version !== target.route.version ||
          !page.route.validate(target.route.params)
        )
          failure = "unavailable";
      } catch {
        failure = "unavailable";
      }
    }
  }
  if (pluginLink && !failure && !linked && !legacyPage) {
    if (
      startup !== "loading" &&
      plugins.activation[pluginLink.pluginId]?.status !== "starting"
    )
      failure = "unavailable";
  }
  if (
    target.kind === "settings" &&
    !failure &&
    !waiting &&
    target.section &&
    !isBuiltInSettingsSection(target.section)
  ) {
    // Plugin cards are addressed by contribution key.
    const section = target.section;
    const owner = section.split("/")[0] ?? "";
    if (visibility !== true) {
      if (
        retainedAttempt !== state.attempt ||
        startup === "loading" ||
        plugins.activation[owner]?.status === "starting" ||
        visibility === "pending"
      )
        waiting = true;
      else failure = "unavailable";
    }
  }
  if (provider && !failure && !waiting) {
    const owner = provider.split("/")[0] ?? "";
    if (
      startup === "loading" ||
      plugins.activation[owner]?.status === "starting"
    )
      waiting = true;
    else if (!providerAvailable) failure = "unavailable";
  }
  // An installed plugin that is turned off has no pages: say so, not "removed".
  // Paused external plugins can't start this launch, so Enable wouldn't help.
  const configuration = plugins.configuration;
  const turnedOff =
    failure === "unavailable" &&
    (target.kind === "page" || target.kind === "plugin") &&
    configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) =>
            plugin.manifest.id === target.pluginId &&
            !plugin.enabled &&
            !(
              configuration.externalPluginsPaused &&
              plugin.source === "external"
            ),
        )?.manifest
      : undefined;
  // Legacy Home resolves to Messages; version-1 placeholder routes resolve to
  // their standalone plugins. Preserve scope so normalization never grants access.
  // Resolve in place before paint: links and history share one policy.
  // Keep the caller and visit rather than adding a redirect to browser history.
  useLayoutEffect(() => {
    if (legacyHome)
      services.navigationHost.resolve(state.attempt, {
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      });
    else if (legacyPage)
      services.navigationHost.resolve(state.attempt, legacyPage);
    else if (legacyMessagesSettings && target.kind === "settings")
      services.navigationHost.resolve(state.attempt, {
        ...target,
        section: "appearance",
      });
    else if (pluginLink && linked && !failure)
      services.navigationHost.resolve(
        state.attempt,
        linkedPageTarget(pluginLink, linked),
      );
  }, [
    services,
    state.attempt,
    legacyHome,
    legacyPage,
    legacyMessagesSettings,
    target,
    pluginLink,
    linked,
    failure,
  ]);
  const owner = useMemo(
    () => ({ attempt: state.attempt, page, waiting, failure }),
    [state.attempt, page, waiting, failure],
  );
  const [presentation, setPresentation] = useState<{
    owner: typeof owner;
    request: PageNavigation;
  }>();
  const workspace = useRef<{
    owner: typeof owner;
    presentation: ReturnType<AppServices["navigationHost"]["request"]>;
  }>(undefined);
  useEffect(() => () => workspace.current?.presentation.dispose(), []);
  useLayoutEffect(() => {
    if (owner.waiting || owner.failure) return;
    const previous = workspace.current;
    if (!settings && previous?.presentation.resume(owner.attempt)) {
      setPresentation({ owner, request: previous.presentation.request });
      previous.owner = owner;
      return;
    }
    if (!settings) {
      previous?.presentation.dispose();
      workspace.current = undefined;
    }
    const next = services.navigationHost.request(
      owner.attempt,
      {
        valid() {
          // Check exact registration identity at use time, before eventual React cleanup.
          if (owner.page && !services.pages.snapshot().includes(owner.page))
            return false;
          const target = owner.attempt.entry.target;
          if (!("scope" in target) || target.scope === undefined) return true;
          const client = services.communities.snapshot();
          if (client.status === "loading") return false;
          if (target.scope === null) return client.selected === null;
          const scope = target.scope;
          return (
            client.viewer === scope.viewer &&
            client.memberships.some(
              (item) =>
                item.id === client.selected &&
                communityDestination(item.id).url === scope.communityOrigin,
            )
          );
        },
        subscribe(listener) {
          const stopPages = services.pages.subscribe(listener);
          const stopClient = services.communities.subscribe(listener);
          const stopSettingsCards = services.settingsCards.subscribe(listener);
          return () => {
            stopPages();
            stopClient();
            stopSettingsCards();
          };
        },
      },
      !settings && !!owner.page,
    );
    setPresentation({ owner, request: next.request });
    if (settings) return next.dispose;
    workspace.current = { owner, presentation: next };
  }, [services, owner, settings]);
  const retained = workspace.current;
  const sameWorkspaceVisit =
    retained &&
    retained.owner.attempt.entry.id === state.entry.id &&
    targetKey(retained.owner.attempt.entry.target) === targetKey(target);
  const retainedRequest =
    retained && !retained.presentation.request.signal.aborted
      ? retained.presentation.request
      : undefined;
  const request =
    presentation?.owner === owner
      ? presentation.request
      : !settings && sameWorkspaceVisit
        ? retainedRequest
        : undefined;
  const workspacePage = settings
    ? retainedRequest && retained?.owner.page
    : page;
  const workspaceTarget =
    settings && retainedRequest && retained
      ? retained.owner.attempt.entry.target
      : target;
  const workspaceRequest = settings ? retainedRequest : request;
  useEffect(() => {
    if (state.attempt.signal.aborted) return;
    if (failure) {
      services.navigationHost.complete(state.attempt, {
        status: "failed",
        reason: failure,
      });
      return;
    }
    if (
      scope === null &&
      client.status !== "loading" &&
      client.selected !== null
    )
      services.communities.select(null);
    if (
      scope &&
      client.status !== "loading" &&
      client.viewer === scope.viewer &&
      membership &&
      client.selected !== membership.id
    ) {
      services.communities.select(membership.id);
    }
  }, [services, state.attempt, failure, scope, client, membership]);
  // A visit that failed while its connection was down, or whose connection has
  // dropped since, reopens by itself, once, when that connection is live again. A live connection alone does not prove
  // a failed read recovered. Host-decided, denied and invalid visits keep their
  // error; a page presenting its failure in place owns that Retry.
  const offline =
    relay.status === "connecting" || relay.status === "error" || !!relay.cached;
  const failedOffline = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      state.status !== "failed" ||
      state.presented ||
      state.ingress ||
      failure ||
      (state.reason !== "timeout" && state.reason !== "unavailable")
    )
      return;
    if (offline) failedOffline.current = state.attempt.id;
    else if (
      relay.status === "ready" &&
      failedOffline.current === state.attempt.id
    ) {
      failedOffline.current = undefined;
      void navigation.retry();
    }
  }, [navigation, state, failure, offline, relay.status]);
  const select = (
    key: string,
    options?: Pick<NavigationOpenOptions, "focus"> & {
      /** Settings only: open at this section. */
      section?: string;
    },
  ) => {
    const selectedClient = services.communities.snapshot();
    let destination: OpenTarget;
    if (key === "settings")
      destination = {
        version: 1,
        kind: "settings",
        ...(options?.section ? { section: options.section } : {}),
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    else {
      const selected = pages.find((page) => page.key === key);
      if (!selected) return;
      destination = {
        version: 1,
        kind: "page",
        pluginId: selected.pluginId,
        pageId: selected.id,
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    }
    void navigation.open(
      destination,
      options?.focus ? { focus: options.focus } : undefined,
    );
  };
  return {
    state,
    target,
    pages,
    page,
    request,
    select,
    waiting,
    failure,
    /** The installed, turned-off plugin whose page or link failed. */
    turnedOff,
    selected: pageKey ?? target.kind,
    /** The connection is down, including a settled refusal. */
    offline: !failure && offline,
    /** The connection is still being made or retried, and the visit reopens
     * once it is live; not a refused or misconfigured connection. */
    reconnecting:
      !failure && (relay.status === "connecting" || !!relay.retrying),
    workspace: {
      page: workspacePage || undefined,
      target: workspaceTarget,
      request: workspaceRequest,
      selected:
        workspacePage?.key ?? (settings ? "home" : (pageKey ?? target.kind)),
      attempt:
        settings && retainedRequest && retained
          ? retained.owner.attempt.id
          : state.attempt.id,
    },
    setSettingsProvider(provider?: string) {
      const current = navigation.snapshot().entry.target;
      if (current.kind !== "settings") return;
      const { provider: closing, ...settings } = current;
      if (provider)
        void navigation.open({ ...settings, section: "agents", provider });
      else if (closing) {
        const parent = targetKey(settings);
        navigation.dismiss((target) => {
          if (target.kind !== "settings" || target.provider !== closing)
            return false;
          const { provider: _provider, ...settings } = target;
          return targetKey(settings) === parent;
        }, settings);
      }
    },
    dismissPluginImport(request: PageNavigation | undefined) {
      const current = request?.target;
      if (!request || current?.kind !== "settings" || !current.pluginImport)
        return;
      const { pluginImport: _pluginImport, ...settings } = current;
      navigation.dismiss([request.entryId], settings);
    },
    dismissPluginDetails(request: PageNavigation | undefined) {
      const current = request?.target;
      if (!request || current?.kind !== "settings" || !current.pluginId) return;
      const { pluginId: _pluginId, ...settings } = current;
      const parent = targetKey(settings);
      navigation.dismiss((target) => {
        if (target.kind !== "settings" || target.pluginId !== current.pluginId)
          return false;
        const { pluginId: _pluginId, ...settings } = target;
        return targetKey(settings) === parent;
      }, settings);
    },
    leaveSettings() {
      const current = navigation.snapshot().entry.target;
      if (current.kind !== "settings") return;
      const {
        route: _route,
        section: _section,
        provider: _provider,
        pluginId: _pluginId,
        ...dialog
      } = current;
      const dialogKey = targetKey(dialog);
      const dismiss = (fallback: OpenTarget) =>
        navigation.dismiss((target) => {
          if (target.kind !== "settings") return false;
          const {
            route: _route,
            section: _section,
            provider: _provider,
            pluginId: _pluginId,
            ...dialog
          } = target;
          return targetKey(dialog) === dialogKey;
        }, fallback);
      const previous = lastNonSettings.current;
      if (previous) {
        dismiss(previous.target);
        return;
      }
      const selectedClient = services.communities.snapshot();
      if (!selectedClient.viewer) return;
      dismiss({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        ...(selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      });
    },
    retry() {
      // Retrying presentation must also repair its failed dependency. Only touch the
      // selected, authorized destination; never reconnect an unrelated community.
      if (
        (pageKey === channelsKey ||
          pageKey === "buzz.repos/repos" ||
          pageKey === "buzz.agents/agents" ||
          settings) &&
        !state.ingress &&
        (!failure ||
          (settings && failure === "unavailable" && visibility === "error")) &&
        !waiting
      ) {
        const status = services.relay.snapshot().status;
        if (status === "error" || status === "disconnected")
          services.relay.tryAgain();
      }
      void navigation.retry();
    },
  };
}

/** Retired page addresses resolve in place, retaining their account/community scope. */
function legacyPageTarget(
  target: OpenTarget,
): Extract<OpenTarget, { kind: "page" }> | undefined {
  const scope =
    "scope" in target && target.scope !== undefined
      ? { scope: target.scope }
      : {};
  if (
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    target.pageId === "channels" &&
    target.route?.version === 1 &&
    (target.route.params === "Inbox" || target.route.params === "Bestie")
  ) {
    const page = target.route.params.toLowerCase();
    return {
      version: 1,
      kind: "page",
      pluginId: `buzz.${page}`,
      pageId: page,
      ...scope,
    };
  }
  // Drafts & sent was briefly a Messages route, before that its own plugin.
  if (
    (target.kind === "page" &&
      target.pluginId === "buzz.channels" &&
      target.pageId === "channels" &&
      target.route?.version === 1 &&
      target.route.params === "drafts-sent") ||
    ((target.kind === "page" || target.kind === "plugin") &&
      target.pluginId === "buzz.drafts-sent" &&
      (target.pageId === undefined || target.pageId === "drafts-sent"))
  ) {
    return {
      version: 1,
      kind: "page",
      pluginId: "buzz.drafts-and-sent",
      pageId: "drafts-sent",
      ...scope,
    };
  }
}
