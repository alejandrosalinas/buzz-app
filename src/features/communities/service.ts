import type { LocalAgentSource } from "../agents/local-activity";
// FOUNDATION: Client identity and membership selection outlive community query sessions.
import type { LocalAgents } from "../agents/local";
import type { IdentityNames } from "../identity-names/service";
import { createPresenceActivity } from "../presence/activity";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay, type RelayData } from "../relay/service";
import { connectBrokerTransport, type ReadTransport } from "../relay/transport";
import {
  communityDestination,
  isCommunityAlias,
  relayAddress,
} from "./destination";
import { purgeCommunityDeviceState, type PurgeFailure } from "./device-state";
import { fetchCommunityPresentation } from "./community-icon";
import {
  emptySync,
  enqueue,
  parseSync,
  type PendingOp,
  type SyncState,
} from "./known-communities";
import {
  localCommunityNameKey,
  readLocalCommunityName,
  saveLocalCommunityName,
} from "./names";

export const PROFILE_ABOUT_MAX_LENGTH = 500;
export type PersonalProfile = { name: string; picture: string; about?: string };
export type Membership = {
  id: string;
  /** Last-known default from joining; never inferred to be a personal override. */
  name: string;
  icon?: string;
  localName?: string | undefined;
  /** Optional current public metadata; not ownership or membership evidence. */
  publishedName?: string | undefined;
  publishedIcon?: string | undefined;
};
type Saved = {
  profile: PersonalProfile;
  memberships: Membership[];
  selected: string | null;
  // Written with the memberships so a change and its upload intent cannot split.
  sync: SyncState;
};
export type ClientSnapshot = Saved & {
  status: "loading" | "ready" | "unavailable";
  // A restored identity does not imply that this build has relay transport.
  relayAvailable: boolean;
  viewer?: string;
  error?: string;
};
/** Read-only membership inventory; does not acquire or select relay sessions. */
export type CommunityReader = {
  snapshot(): ClientSnapshot;
  subscribe(listener: () => void): () => void;
};
/** Known-community sync for its one upload owner: read the record and the
 * outbox, write back what the server settled and the memberships a server
 * list adds. Never joins, selects, forgets or contacts a relay. */
export type KnownCommunities = CommunityReader & {
  pending(): PendingOp[];
  apply(next: SyncState, add?: string[]): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    communityReader: CommunityReader;
    knownCommunities: KnownCommunities;
  }
}
const empty = (): Saved => ({
  profile: { name: "", picture: "", about: "" },
  memberships: [],
  selected: null,
  sync: emptySync(),
});
export function createCommunities(
  ctx: Context,
  live: boolean,
  identityNames?: IdentityNames,
  openRelay = "",
  agentChoices?: LocalAgents,
  identityReady?: Promise<string>,
  nativeConnect?: (id: string, signal: AbortSignal) => Promise<ReadTransport>,
  localAgents?: LocalAgentSource,
  verifyStored?: ReadTransport["verifyStored"],
  askAgain?: (relay: string) => Promise<void>,
) {
  const connect = live
    ? (id: string, signal: AbortSignal) =>
        connectBrokerTransport("", signal, id)
    : identityReady
      ? nativeConnect
      : undefined;
  let state: ClientSnapshot = {
    ...empty(),
    status: live || identityReady ? "loading" : "unavailable",
    relayAvailable: !!connect,
  };
  // Retain temporarily unresolvable deployment aliases in storage, not active UI/sessions.
  const unresolvedMemberships: Membership[] = [];
  let unresolvedSelection: string | null = null;
  let disposed = false;
  const controller = new AbortController();
  const presenceActivity = createPresenceActivity();
  let presentationReaders = 0;
  let presentationRead: AbortController | undefined;
  const presentations = new Set<string>();
  const membershipVersions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<() => void>();
  const sessions = new Map<string, ReturnType<typeof provideRelay>>();
  // Each session owns a scope so leaving can dispose exactly that one.
  const sessionScopes = new Map<string, Context>();
  const scopes: Context[] = [];
  const disconnected = provideRelay(
    newScope(),
    undefined,
    presenceActivity,
    identityNames,
  );
  function newScope() {
    const scope = new Context();
    scopes.push(scope);
    return scope;
  }
  const current = () =>
    state.selected
      ? (sessions.get(state.selected) ?? disconnected)
      : disconnected;
  const emitRelay = () => {
    for (const fn of relayListeners) fn();
  };
  const update = (
    patch: Partial<ClientSnapshot>,
    persist = true,
    required = false,
  ) => {
    const next = { ...state, ...patch };
    // Commit a deliberate selection only after required persistence succeeds.
    const selection =
      persist && Object.hasOwn(patch, "selected") ? null : unresolvedSelection;
    try {
      if (persist && next.viewer)
        localStorage.setItem(
          `buzz-client.v1:${next.viewer}`,
          JSON.stringify({
            profile: next.profile,
            memberships: [...next.memberships, ...unresolvedMemberships].map(
              ({ id, name, icon }) => ({
                id,
                name,
                ...(icon ? { icon } : {}),
              }),
            ),
            selected: next.selected ?? selection,
            sync: next.sync,
          }),
        );
    } catch (error) {
      // The storage error rides along as the cause so a caller can name it: a
      // store that never saves should not read as the same retry every time.
      if (required)
        throw new Error(
          "Could not save this community on this device. Try again.",
          { cause: error },
        );
      // Preferences are best effort; storage failure must not strand a remote join.
    }
    unresolvedSelection = selection;
    state = next;
    for (const fn of listeners) fn();
    emitRelay();
  };
  const acquire = (id: string, viewer = state.viewer) => {
    if (!connect) return disconnected;
    let session = sessions.get(id);
    if (!session) {
      const scope = newScope();
      session = provideRelay(
        scope,
        (signal) => connect(id, signal),
        presenceActivity,
        identityNames,
        agentChoices,
        viewer ? { viewer, scope: communityDestination(id).url } : undefined,
        localAgents,
        verifyStored,
        askAgain,
      );
      sessions.set(id, session);
      sessionScopes.set(id, scope);
      session.subscribe(() => {
        if (state.selected === id) emitRelay();
      });
    }
    return session;
  };
  /** Disposes a forgotten community's retained session. Reported, never
   * thrown: the membership is already gone, so only a report can reach the
   * viewer, and it is named for what it is, a session that would not shut
   * down, not a store that would not clear. */
  const release = async (id: string): Promise<PurgeFailure[]> => {
    const scope = sessionScopes.get(id);
    sessions.delete(id);
    sessionScopes.delete(id);
    if (!scope) return [];
    // Every session scope comes from `newScope()`, so this always finds
    // it; guarding keeps a miss from splicing another community's scope.
    const index = scopes.indexOf(scope);
    if (index !== -1) scopes.splice(index, 1);
    try {
      await scope.fiber.dispose();
      return [];
    } catch (error) {
      console.warn(
        `Couldn't dispose the session for ${communityDestination(id).url} after forgetting it`,
        error,
      );
      return [{ store: "session", error }];
    }
  };
  // Compatibility reader for bundled plugins; captured commands remain bound to their concrete session.
  const relay: RelayData = {
    snapshot: () => current().snapshot(),
    subscribe(fn) {
      relayListeners.add(fn);
      return () => {
        relayListeners.delete(fn);
      };
    },
    retry: () => current().retry(),
    tryAgain: () => current().tryAgain(),
    disconnect: () => current().disconnect(),
    clearCache: () => current().clearCache(),
  };
  ctx.provide("relay", relay);
  const identity =
    identityReady ??
    (live
      ? fetch("/api/relay/identity", { signal: controller.signal }).then(
          async (response) => {
            if (!response.ok) throw new Error("Local identity unavailable");
            const { viewer } = await response.json();
            return viewer as string;
          },
        )
      : undefined);
  if (identity)
    void identity
      .then((viewer) => {
        if (typeof viewer !== "string" || !/^[a-f0-9]{64}$/.test(viewer))
          throw new Error("Invalid local identity");
        if (disposed) return;
        let saved = empty();
        let seeded = false;
        try {
          const stored = localStorage.getItem(`buzz-client.v1:${viewer}`);
          const raw = JSON.parse(stored ?? "null");
          if (raw)
            saved = {
              profile: {
                name:
                  typeof raw.profile?.name === "string" ? raw.profile.name : "",
                picture:
                  typeof raw.profile?.picture === "string"
                    ? raw.profile.picture
                    : "",
                about:
                  typeof raw.profile?.about === "string"
                    ? raw.profile.about
                    : "",
              },
              memberships: Array.isArray(raw.memberships)
                ? raw.memberships
                    .flatMap((m: unknown): Membership[] => {
                      if (
                        !m ||
                        typeof m !== "object" ||
                        !("id" in m) ||
                        typeof m.id !== "string" ||
                        !("name" in m) ||
                        typeof m.name !== "string"
                      )
                        return [];
                      const membership = {
                        id: m.id,
                        name: m.name,
                        ...("icon" in m &&
                        typeof m.icon === "string" &&
                        m.icon.startsWith("https://")
                          ? { icon: m.icon }
                          : {}),
                      };
                      try {
                        return [
                          { ...membership, id: communityDestination(m.id).id },
                        ];
                      } catch {
                        if (
                          isCommunityAlias(m.id) &&
                          !unresolvedMemberships.some(
                            (entry) => entry.id === m.id,
                          )
                        )
                          unresolvedMemberships.push(membership);
                        return [];
                      }
                    })
                    .filter(
                      (m: Membership, index: number, all: Membership[]) =>
                        all.findIndex((entry) => entry.id === m.id) === index,
                    )
                : [],
              selected: null,
              sync: parseSync(raw.sync),
            };
          else if (openRelay && stored === null) {
            // Development opt-in for a viewer with no saved record on this origin.
            // Any stored record, including Personal space or one this reader
            // cannot understand, wins over the seed.
            const { id, name } = communityDestination(openRelay);
            saved = { ...saved, memberships: [{ id, name }], selected: id };
            seeded = true;
          }
          if (typeof raw?.selected === "string") {
            try {
              saved.selected = communityDestination(raw.selected).id;
            } catch {
              if (unresolvedMemberships.some((m) => m.id === raw.selected))
                unresolvedSelection = raw.selected;
            }
          }
        } catch {
          /* Invalid local preferences do not prevent opening the client. */
        }
        if (!saved.memberships.some((m) => m.id === saved.selected))
          saved.selected = null;
        presenceActivity.setViewer(viewer);
        if (saved.selected) acquire(saved.selected, viewer);
        saved.memberships = saved.memberships.map((membership) => ({
          ...membership,
          localName: readLocalCommunityName(membership.id, viewer),
        }));
        // A seeded record is saved once so later configuration changes cannot revoke it.
        update({ ...saved, viewer, status: "ready" }, seeded);
        refreshPresentation();
      })
      .catch((error) => {
        if (!disposed)
          update({ status: "unavailable", error: String(error) }, false);
      });
  ctx.effect(() => () => {
    disposed = true;
    controller.abort();
    presentationRead?.abort();
    presenceActivity.dispose();
    listeners.clear();
    relayListeners.clear();
    return Promise.all(scopes.map((scope) => scope.fiber.dispose()));
  });
  // The picker and Settings share the old bounded icon read, now including names.
  // Retain while a current consumer is mounted; no new startup scan or polling.
  function refreshPresentation() {
    presentationRead?.abort();
    if (
      !presentationReaders ||
      state.status !== "ready" ||
      !state.relayAvailable
    )
      return;
    const controller = new AbortController();
    presentationRead = controller;
    const viewer = state.viewer;
    const memberships = state.memberships.filter(
      (membership) => !presentations.has(membership.id),
    );
    let next = 0;
    void Promise.all(
      Array.from({ length: Math.min(2, memberships.length) }, async () => {
        while (next < memberships.length && !controller.signal.aborted) {
          const membership = memberships[next++];
          if (!membership) break;
          const version = membershipVersions.get(membership.id);
          try {
            const info = await fetchCommunityPresentation(
              membership.id,
              controller.signal,
            );
            const current = state.memberships.find(
              (entry) => entry.id === membership.id,
            );
            if (
              disposed ||
              controller.signal.aborted ||
              state.viewer !== viewer ||
              !current ||
              membershipVersions.get(membership.id) !== version
            )
              continue;
            const changed = { ...current, ...info };
            presentations.add(membership.id);
            update(
              {
                memberships: state.memberships.map((entry) =>
                  entry === current ? changed : entry,
                ),
              },
              false,
            );
          } catch {
            // Optional discovery never erases the saved label or a personal choice.
          }
        }
      }),
    );
  }
  const syncLocalNames = (event: StorageEvent) => {
    const viewer = state.viewer;
    if (!viewer) return;
    try {
      if (event.storageArea !== localStorage) return;
      let changed = false;
      const memberships = state.memberships.map((membership) => {
        if (
          event.key !== null &&
          event.key !== localCommunityNameKey(membership.id, viewer)
        )
          return membership;
        const localName = readLocalCommunityName(
          membership.id,
          viewer,
          membership.localName,
        );
        if (localName === membership.localName) return membership;
        changed = true;
        const next = { ...membership, localName };
        return next;
      });
      if (changed) update({ memberships }, false);
    } catch {
      // Closing/unavailable storage is not a reset command.
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", syncLocalNames);
    ctx.effect(
      () => () => window.removeEventListener("storage", syncLocalNames),
    );
  }
  return {
    presence: presenceActivity,
    relay,
    /** Federated sign-in changed: every joined community retries what the old
     * session refused, not only the selected one. */
    reauthorize() {
      for (const session of sessions.values()) session.reauthorize();
    },
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    retainPresentation() {
      if (++presentationReaders === 1) refreshPresentation();
      return () => {
        if (--presentationReaders === 0) presentationRead?.abort();
      };
    },
    setLocalName(id: string, viewer: string, value: string) {
      id = communityDestination(id).id;
      const membership = state.memberships.find((entry) => entry.id === id);
      if (
        disposed ||
        state.status !== "ready" ||
        state.viewer !== viewer ||
        !membership
      )
        throw new Error(
          "This account or community changed. Open Local settings again.",
        );
      const localName = saveLocalCommunityName(id, viewer, value);
      const next = { ...membership, localName };
      update(
        {
          memberships: state.memberships.map((entry) =>
            entry === membership ? next : entry,
          ),
        },
        false,
      );
    },
    select(id: string | null) {
      if (id) id = communityDestination(id).id;
      if (id && !state.memberships.some((m) => m.id === id))
        throw new Error("Join this community first");
      if (id) acquire(id);
      update({ selected: id });
    },
    /** A joined community's session, connected without selecting it, for
     * background work such as agents; it lives until the community is left. */
    open(id: string): RelayData | undefined {
      id = communityDestination(id).id;
      return state.memberships.some((m) => m.id === id)
        ? acquire(id)
        : undefined;
    },
    saveProfile(profile: PersonalProfile) {
      update({ profile });
    },
    joined(membership: Membership, profile: PersonalProfile) {
      membership = {
        ...membership,
        id: communityDestination(membership.id).id,
        ...(state.viewer
          ? { localName: readLocalCommunityName(membership.id, state.viewer) }
          : {}),
      };
      presentations.delete(membership.id);
      membershipVersions.set(
        membership.id,
        (membershipVersions.get(membership.id) ?? 0) + 1,
      );
      update(
        {
          memberships: [
            ...state.memberships.filter((m) => m.id !== membership.id),
            membership,
          ],
          profile: state.profile.name ? state.profile : profile,
          selected: membership.id,
          sync: enqueue(state.sync, relayAddress(membership.id), false),
        },
        true,
        !!nativeConnect && !live,
      );
      if (sessions.has(membership.id)) sessions.get(membership.id)?.retry();
      else acquire(membership.id);
      emitRelay();
      refreshPresentation();
    },
    /** Forgets a saved community on this device once its relay has released
     * the membership (or never held one). Drops the membership, falls back to
     * Personal space when it was selected, disposes its retained session, then
     * purges the device state keyed by that origin and viewer. Persistence
     * follows `joined`: required where the device record is the only copy, and
     * that save is the only step that throws, before anything has changed.
     * Everything after it is best effort: a session that would not dispose or
     * a store that would not clear is logged and returned, never thrown, since
     * the membership is already gone and only a report can reach the viewer.
     *
     * `purge: false` keeps the device state. It is for a relay that refused
     * the leave because the viewer is banned: the relay still holds the
     * membership (bans can be timed or lifted), so the drafts and reading
     * positions keyed by this origin and viewer are kept for the day the
     * community is added again by its URL. */
    async leave(
      id: string,
      { purge = true }: { purge?: boolean } = {},
    ): Promise<PurgeFailure[]> {
      id = communityDestination(id).id;
      if (!state.memberships.some((m) => m.id === id)) return [];
      const { viewer } = state;
      const origin = communityDestination(id).url;
      update(
        {
          memberships: state.memberships.filter((m) => m.id !== id),
          ...(state.selected === id ? { selected: null } : {}),
          sync: enqueue(state.sync, relayAddress(id), true),
        },
        true,
        !!nativeConnect && !live,
      );
      // Fence metadata responses for the old membership, including remove/rejoin.
      presentations.delete(id);
      membershipVersions.set(id, (membershipVersions.get(id) ?? 0) + 1);
      refreshPresentation();
      const failures = await release(id);
      // The session is gone (or at least detached), so nothing below can
      // refill the purged stores.
      if (purge && viewer)
        failures.push(...(await purgeCommunityDeviceState(origin, viewer)));
      return failures;
    },
    pendingSync: () => state.sync.outbox,
    /** Writes the sync owner's settled state and, in the same device record,
     * the memberships a server list adds: destinations saved on another
     * device appear here under their host name, or the viewer's local name
     * for them, without a session. Sync never forgets a membership.
     * Persistence follows `joined`, and that save is the only step that
     * throws, before anything has changed. */
    async applySync(next: SyncState, add: string[] = []) {
      const memberships = [...state.memberships];
      for (const url of add) {
        const { id, name } = communityDestination(url);
        if (memberships.some((m) => m.id === id)) continue;
        memberships.push({
          id,
          name,
          ...(state.viewer
            ? { localName: readLocalCommunityName(id, state.viewer) }
            : {}),
        });
      }
      const added = memberships.length > state.memberships.length;
      update({ memberships, sync: next }, true, !!nativeConnect && !live);
      if (added) refreshPresentation();
    },
  };
}
export type Communities = ReturnType<typeof createCommunities>;
