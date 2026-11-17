import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppServices } from "./services";
import { communityDestination } from "../features/communities/destination";
import {
  joinBeneath,
  targetKey,
  type NavigationScope,
  withoutJoin,
  type OpenTarget,
} from "../features/navigation/targets";
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
  // The join dialog is presentation over a visit; routing sees the visit. A
  // join for another viewer is not shown, so it covers nothing.
  const join =
    state.entry.target.join?.viewer === client.viewer
      ? state.entry.target.join
      : undefined;
  const target = useMemo(
    () => withoutJoin(state.entry.target),
    [state.entry.target],
  );
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
  // Plugin cards are addressed by contribution key, prefixed by their plugin.
  const cardOwner =
    settings && target.section && !isBuiltInSettingsSection(target.section)
      ? target.section.split("/")[0]
      : undefined;
  if (cardOwner !== undefined && !failure && !waiting && visibility !== true) {
    if (
      retainedAttempt !== state.attempt ||
      startup === "loading" ||
      plugins.activation[cardOwner]?.status === "starting" ||
      visibility === "pending"
    )
      waiting = true;
    else failure = "unavailable";
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
  // An installed plugin that is turned off has no pages or Settings cards:
  // say so, not "removed". Paused external plugins can't start this launch,
  // so Enable wouldn't help. A card key is "<plugin>/<card>"; a bare section
  // id names no plugin, so it keeps the not-available card.
  const configuration = plugins.configuration;
  const pluginId =
    target.kind === "page" || target.kind === "plugin"
      ? target.pluginId
      : settings && target.section?.includes("/")
        ? cardOwner
        : undefined;
  const turnedOff =
    failure === "unavailable" &&
    pluginId !== undefined &&
    configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) =>
            plugin.manifest.id === pluginId &&
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
  // The page's request reaches only its subscribers, not the whole shell.
  const [presented] = useState(() => {
    let value: { owner: typeof owner; request: PageNavigation } | undefined;
    const listeners = new Set<() => void>();
    return {
      get: () => value,
      set(next: NonNullable<typeof value>) {
        value = next;
        for (const listener of listeners) listener();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  });
  const workspace = useRef<{
    owner: typeof owner;
    presentation: ReturnType<AppServices["navigationHost"]["request"]>;
  }>(undefined);
  // Settings' own visit, kept while a join dialog presents over it.
  const settingsView = useRef<{
    attempt: OpenAttempt;
    presentation: ReturnType<AppServices["navigationHost"]["request"]>;
  }>(undefined);
  useEffect(
    () => () => {
      workspace.current?.presentation.dispose();
      settingsView.current?.presentation.dispose();
    },
    [],
  );
  useLayoutEffect(() => {
    // A join dialog over Settings: Settings keeps its own visit beneath, as a
    // page does, so what it presents is not reopened by the dialog's visit.
    const beneath =
      join && settings && !owner.waiting && !owner.failure
        ? settingsBeneath(settingsView.current, owner.attempt)
        : undefined;
    if (beneath) {
      services.navigationHost.complete(owner.attempt, { status: "opened" });
      presented.set({ owner, request: beneath });
      return;
    }
    settingsView.current?.presentation.dispose();
    settingsView.current = undefined;
    if (owner.waiting || owner.failure) return;
    const previous = workspace.current;
    if (!settings && previous?.presentation.resume(owner.attempt)) {
      presented.set({ owner, request: previous.presentation.request });
      previous.owner = owner;
      return;
    }
    // A join dialog over a retained page: the page keeps its own visit beneath,
    // so the dialog's visit is acknowledged here, not by the page.
    if (
      join &&
      !settings &&
      previous &&
      !previous.presentation.request.signal.aborted &&
      previous.owner.attempt.entry.id !== owner.attempt.entry.id &&
      sameVisitBeneath(previous.owner.attempt, owner.attempt)
    ) {
      services.navigationHost.complete(owner.attempt, { status: "opened" });
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
      settings || !!owner.page,
    );
    presented.set({ owner, request: next.request });
    if (settings) {
      settingsView.current = { attempt: owner.attempt, presentation: next };
      return;
    }
    workspace.current = { owner, presentation: next };
  }, [services, owner, settings, presented, join]);
  const retained = workspace.current;
  // Join over a page retained from its own visit: present that page beneath.
  const covered =
    settings ||
    (!!join &&
      !!retained &&
      !retained.presentation.request.signal.aborted &&
      retained.owner.attempt.entry.id !== state.entry.id &&
      sameVisitBeneath(retained.owner.attempt, state.attempt));
  const sameWorkspaceVisit =
    retained &&
    retained.owner.attempt.entry.id === state.entry.id &&
    targetKey(retained.owner.attempt.entry.target) ===
      targetKey(state.entry.target);
  const retainedRequest =
    retained && !retained.presentation.request.signal.aborted
      ? retained.presentation.request
      : undefined;
  const requestFor = (presentation: ReturnType<typeof presented.get>) =>
    presentation?.owner === owner
      ? presentation.request
      : join && settings && !waiting && !failure
        ? settingsBeneath(settingsView.current, state.attempt)
        : !settings && sameWorkspaceVisit
          ? retainedRequest
          : undefined;
  const workspacePage = covered
    ? retainedRequest && retained?.owner.page
    : page;
  const workspaceTarget =
    covered && retainedRequest && retained
      ? withoutJoin(retained.owner.attempt.entry.target)
      : target;
  const workspaceRequestFor = (
    presentation: ReturnType<typeof presented.get>,
  ) => (covered ? retainedRequest : requestFor(presentation));
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
  // Stable, so the shell's page navigation renders only when pages change.
  const select = useCallback(
    (
      key: string,
      options?: Pick<NavigationOpenOptions, "focus" | "replace"> & {
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
        options?.focus || options?.replace
          ? {
              ...(options.focus ? { focus: options.focus } : {}),
              ...(options.replace ? { replace: true } : {}),
            }
          : undefined,
      );
    },
    [services, pages, navigation],
  );
  return {
    state,
    target,
    pages,
    page,
    presented,
    requestFor,
    workspaceRequestFor,
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
      /** The retained page's request under Settings; a page's own request
       * reaches only subscribers of `presented`, through `workspaceRequestFor`. */
      request: settings ? retainedRequest : undefined,
      selected:
        workspacePage?.key ?? (settings ? "home" : (pageKey ?? target.kind)),
      attempt:
        covered && retainedRequest && retained
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
      const selectedClient = services.communities.snapshot();
      const here =
        selectedClient.viewer && selectedClient.selected
          ? {
              viewer: selectedClient.viewer,
              communityOrigin: communityDestination(selectedClient.selected)
                .url,
            }
          : null;
      const dialogKey = settingsDialogKey(current, here);
      const dismiss = (fallback: OpenTarget) =>
        navigation.dismiss(
          (target) =>
            target.kind === "settings" &&
            settingsDialogKey(target, here) === dialogKey,
          fallback,
        );
      const previous = lastNonSettings.current;
      if (previous) {
        dismiss(previous.target);
        return;
      }
      if (!selectedClient.viewer) return;
      dismiss({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: here,
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

/** Which Settings dialog `target` shows: Settings for its community, or for
 * Personal space, whatever section or part within. A visit that names no
 * community, as every link to Settings does, shows the one selected, `here`. */
function settingsDialogKey(
  target: Extract<OpenTarget, { kind: "settings" }>,
  here: NavigationScope | null,
) {
  const scope = target.scope === undefined ? here : target.scope;
  return targetKey({ version: 1, kind: "settings", ...(scope && { scope }) });
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

/** Settings' request kept beneath this join dialog's visit, if it was opened
 * over that Settings visit. */
function settingsBeneath(
  shown:
    | { attempt: OpenAttempt; presentation: { request: PageNavigation } }
    | undefined,
  join: OpenAttempt,
) {
  return shown &&
    !shown.presentation.request.signal.aborted &&
    shown.attempt.entry.id !== join.entry.id &&
    sameVisitBeneath(shown.attempt, join)
    ? shown.presentation.request
    : undefined;
}

/** Whether a retained page is the visit this join dialog was opened over: a
 * multi-step traversal can land on a join whose page was never presented. */
function sameVisitBeneath(
  retained: { entry: { target: OpenTarget } },
  join: { entry: { target: OpenTarget } },
) {
  return (
    targetKey(joinBeneath(retained.entry.target)) ===
    targetKey(joinBeneath(join.entry.target))
  );
}
