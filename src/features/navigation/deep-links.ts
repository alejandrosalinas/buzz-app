// OS-delivered deep links. The native shell holds raw strings; this module is the
// only place that turns them into typed targets, and the ordinary navigation
// admission path alone decides whether a target opens. Browsers have no OS scheme
// handler, so everything here is a no-op outside Tauri.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { parseInviteLink, type InviteLink } from "../communities/invite-link";
import { communityDestination } from "../communities/destination";
import type { ClientSnapshot } from "../communities/service";
import { agentCardTarget, parseBuzzLink, settingsTarget } from "./buzz-links";
import { entityTarget } from "../repos/routes";
import type { Navigation, OpenFailure, OpenResult } from "./controller";
import { parseOpenTarget, type OpenTarget } from "./targets";
import {
  parseExternalAuthorization,
  type ExternalAuthorization,
} from "../agents/external-connection";
import { isSignInLink, requestSignIn } from "../identity/sign-in-requests";

export type DeepLinkStep =
  | Readonly<{ open: OpenTarget }>
  | Readonly<{ fail: OpenFailure }>;
/** What the shell exposes: drain held URLs, and learn when more are held. */
export type DeepLinkShell = Readonly<{
  take(): Promise<readonly string[]>;
  watch(listener: () => void): () => void;
}>;
export type DeepLinkHost = Readonly<{
  navigation: Pick<Navigation, "open" | "snapshot" | "subscribe">;
  /** Host-only: record an ingress that produced no destination. */
  fail(reason: OpenFailure, retry?: () => Promise<OpenResult>): void;
  /** Explain a link that names no Buzz destination. */
  rejected(): void;
  /** A newer link names a destination, so an earlier rejection's notice is stale. */
  accepted(): void;
  /** Whether Inbox can open, as the router will decide once startup settles. */
  inbox: Readonly<{
    status(): "loading" | "on" | "off";
    subscribe(listener: () => void): () => void;
  }>;
  /** Invite presentation belongs to the community switcher, not navigation. */
  invite?: (invite: InviteLink, viewer: string) => void;
  authorize?: (request: ExternalAuthorization, viewer: string) => void;
}>;
type Client = Pick<ClientSnapshot, "status" | "viewer" | "selected">;

// Require the canonical scheme here. The native URL parser may already have
// normalized its case before this bridge receives it. Every address outside the
// Buzz link grammar, unknown hosts included, parses to null. Beyond the Buzz
// forms, the app answers only bare `buzz://` and `buzz://sign-in`, and only at
// OS ingress (`bindDeepLinks`); they parse to null too, so content keeps them as
// plain text.
const buzzLink = (url: unknown) =>
  typeof url === "string" && url.startsWith("buzz:")
    ? parseBuzzLink(url)
    : null;

/** Decide what one OS URL means for the signed-in client. The OS ingress accepts
 * the Buzz link forms, `buzz://message?channel=&id=[&thread=]` and
 * `buzz://channel/<id>`, which carry no community and so bind to the selected one.
 * A bound target still passes the usual viewer, membership and channel checks;
 * nothing here grants access. */
export function deepLinkStep(
  url: string,
  client: Pick<Client, "viewer" | "selected">,
): DeepLinkStep {
  const link = buzzLink(url);
  if (!link) return { fail: "invalid-target" };
  try {
    if (link.format === "plugin-install")
      return {
        open: parseOpenTarget({
          version: 1,
          kind: "settings",
          section: "plugins",
          pluginImport: link.source,
        }),
      };
    if (link.format === "settings") return { open: settingsTarget(link) };
    if (!client.viewer || !client.selected) return { fail: "unavailable" };
    if (link.format === "removed")
      return {
        open: {
          version: 1,
          kind: "page",
          pluginId: "buzz.repos",
          pageId: "repos",
          scope: {
            viewer: client.viewer,
            communityOrigin: communityDestination(client.selected).url,
          },
        },
      };
    if (link.format === "agent-card")
      return {
        open: agentCardTarget(link.card, {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        }),
      };
    if (link.format === "entity")
      return {
        open: entityTarget(link.route, {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        }),
      };
    const { format: _format, ...destination } = link;
    return {
      open: parseOpenTarget({
        version: 1,
        kind: link.format === "plugin" ? "plugin" : "conversation",
        scope: {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        },
        ...destination,
      }),
    };
  } catch {
    return { fail: "invalid-target" };
  }
}

// Bare `buzz://`, with Windows' optional root path; any query or fragment is
// ignored, as unknown parameters are on Buzz links.
const OPEN_APP_LINK = /^buzz:\/\/\/?(?:[?#].*)?$/;

/** Latest intent wins, as with a user's navigation. At most one unbound URL is
 * retained. Once bound, the ordinary controller owns presentation and retry. */
export function bindDeepLinks(
  host: DeepLinkHost,
  communities: Readonly<{
    snapshot(): Client;
    subscribe(listener: () => void): () => void;
  }>,
  shell = createDeepLinkShell(),
): () => void {
  if (!shell) return () => {};
  let closed = false;
  let held:
    | {
        url: string;
        invite: InviteLink | null;
        authorization: ExternalAuthorization | null;
        plugin: boolean;
        /** Names no destination, so no account or community binds it. */
        invalid: boolean;
        /** Read before the client was first ready: it launched the app. */
        launch: boolean;
        viewer: string | undefined;
        selected: string | null;
        reported: boolean;
      }
    | undefined;
  let attempt = host.navigation.snapshot().attempt;
  let client = communities.snapshot();
  const isReady = (client: Client) =>
    client.status === "ready" && !!client.viewer && !!client.selected;
  // Whether the client has been ready since binding: the app is running.
  let running = isReady(client);
  let clientEpoch = 0;
  // A malformed link in a running app explains itself over the page the user
  // is on. One that launched the app opens Inbox, or, with Inbox turned off,
  // explains itself over the start page. Until the client and Inbox both settle
  // it waits like any held link, and newer navigation cancels it.
  const reject = (client: Client, launch: boolean): Promise<OpenResult> => {
    const scope =
      client.status === "ready" && client.viewer && client.selected
        ? {
            viewer: client.viewer,
            communityOrigin: communityDestination(client.selected).url,
          }
        : undefined;
    const inbox = launch && scope ? host.inbox.status() : "off";
    if ((launch && !scope) || inbox === "loading")
      return Promise.resolve({ status: "failed", reason: "invalid-target" });
    held = undefined;
    host.rejected();
    if (scope && inbox === "on")
      return host.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.inbox",
        pageId: "inbox",
        scope,
      });
    // An earlier link's failure card is superseded too: reopen the page under
    // it, as its Go back does, so no Retry outlives the intent it recovers.
    const { ingress, entry } = host.navigation.snapshot();
    return ingress
      ? host.navigation.open(entry.target)
      : Promise.resolve({ status: "cancelled" });
  };
  const openHeld = (): Promise<OpenResult> => {
    if (closed || !held) return Promise.resolve({ status: "cancelled" });
    const client = communities.snapshot();
    const incoming = held;
    if (incoming.invalid) return reject(client, incoming.launch);
    if (
      !incoming.plugin &&
      ((incoming.viewer && incoming.viewer !== client.viewer) ||
        (!incoming.invite &&
          !incoming.authorization &&
          incoming.selected &&
          incoming.selected !== client.selected))
    ) {
      held = undefined;
      host.fail("denied");
      return Promise.resolve({ status: "failed", reason: "denied" });
    }
    if (client.status === "loading")
      return Promise.resolve({ status: "failed", reason: "unavailable" });
    const invite = incoming.invite;
    if (incoming.authorization) {
      if (!client.viewer || client.status !== "ready")
        return Promise.resolve({ status: "failed", reason: "unavailable" });
      held = undefined;
      host.authorize?.(incoming.authorization, client.viewer);
      return Promise.resolve({ status: "cancelled" });
    }
    if (invite && (!client.viewer || client.status !== "ready")) {
      // Retain the invite through identity setup and client restoration.
      return Promise.resolve({ status: "failed", reason: "unavailable" });
    }
    if (invite && client.viewer && host.invite) {
      held = undefined;
      host.invite(invite, client.viewer);
      return Promise.resolve({ status: "cancelled" });
    }
    const step = deepLinkStep(incoming.url, client);
    if ("open" in step) {
      held = undefined;
      return host.navigation.open(step.open);
    }
    if (step.fail === "invalid-target") return reject(client, incoming.launch);
    // Only an unbound link fails here; it stays held for Retry.
    incoming.reported = true;
    host.fail(step.fail, openHeld);
    attempt = host.navigation.snapshot().attempt;
    return Promise.resolve({ status: "failed", reason: step.fail });
  };
  const flush = () => {
    if (closed || !held) return;
    const client = communities.snapshot();
    held.viewer ??= client.viewer;
    held.selected ??= client.selected;
    if (
      !held.invalid &&
      !held.plugin &&
      ((held.viewer && held.viewer !== client.viewer) ||
        (!held.invite &&
          !held.authorization &&
          held.selected &&
          held.selected !== client.selected))
    ) {
      held = undefined;
      host.fail("denied");
    } else if (client.status !== "loading" && !held.reported && !draining) {
      void openHeld();
    }
  };
  // Pings coalesce while a read is in flight; neither URLs nor waiting drains grow.
  let draining = false;
  let requested = false;
  const drain = async () => {
    requested = true;
    if (draining || closed) return;
    draining = true;
    try {
      while (requested && !closed) {
        requested = false;
        const started = host.navigation.snapshot().attempt;
        const epoch = clientEpoch;
        const launch = !running;
        let urls: readonly string[];
        try {
          urls = await shell.take();
        } catch (error) {
          if (!closed)
            console.error("Could not read pending deep links", error);
          continue;
        }
        if (closed || started.id !== host.navigation.snapshot().attempt.id)
          continue;
        // Two ingress-only links name no destination; neither is held, bound
        // or rejected, and they follow different selection rules:
        // - Bare `buzz://` (Builderlab's "Open Buzz app") only asks for the
        //   app, which native has already brought forward. Selection skips it,
        //   so it never displaces a real link, in this batch or already held.
        // - `buzz://sign-in` (the account pages' "Open Buzz") wins selection
        //   like any other latest link, so earlier links in this batch are
        //   dropped, then asks first-run to sign in again
        //   (`identity/sign-in-requests.ts`). A link already held stays held.
        let url: string | undefined;
        for (let index = urls.length - 1; index >= 0; index--) {
          const candidate = urls[index];
          if (typeof candidate === "string" && !OPEN_APP_LINK.test(candidate)) {
            url = candidate;
            break;
          }
        }
        if (url === undefined) continue;
        if (isSignInLink(url)) {
          requestSignIn();
          continue;
        }
        const plugin = parseBuzzLink(url)?.format === "plugin-install";
        if (epoch !== clientEpoch && !plugin) continue;
        const client = communities.snapshot();
        const invite = parseInviteLink(url);
        const authorization = parseExternalAuthorization(url);
        held = {
          url,
          invite,
          authorization,
          plugin,
          invalid: !invite && !authorization && !buzzLink(url),
          launch,
          viewer: client.viewer,
          selected: client.selected,
          reported: false,
        };
        if (!held.invalid) host.accepted();
        if (client.status !== "loading") void openHeld();
        else flush();
      }
    } finally {
      draining = false;
      flush();
    }
  };
  const stopClient = communities.subscribe(() => {
    const next = communities.snapshot();
    if (
      (client.viewer && client.viewer !== next.viewer) ||
      (client.selected &&
        client.selected !== next.selected &&
        !held?.invite &&
        !held?.authorization)
    )
      clientEpoch++;
    client = next;
    running ||= isReady(next);
    flush();
  });
  const stopInbox = host.inbox.subscribe(flush);
  const stopNavigation = host.navigation.subscribe(() => {
    const next = host.navigation.snapshot();
    // fail() emits synchronously; its ingress marker distinguishes our failure
    // from a newer user visit, including Back/Forward and Go Home.
    if (next.attempt.id !== attempt.id && !next.ingress) held = undefined;
    attempt = next.attempt;
  });
  // A broken shell bridge must never keep the app from opening.
  let stopShell = () => {};
  try {
    stopShell = shell.watch(drain);
  } catch (error) {
    console.error("Deep link updates are unavailable", error);
  }
  drain();
  return () => {
    if (closed) return;
    closed = true;
    stopClient();
    stopInbox();
    stopNavigation();
    stopShell();
    held = undefined;
  };
}

/** The Tauri bridge. It carries raw URL strings from the main window's shell and
 * a queue-depth ping; no destination or account data crosses in either direction. */
export function createDeepLinkShell(): DeepLinkShell | undefined {
  if (!isTauri()) return undefined;
  return {
    async take() {
      const urls = await invoke<unknown>("deep_link_take");
      return Array.isArray(urls)
        ? urls.filter((url): url is string => typeof url === "string")
        : [];
    },
    watch(listener) {
      let active = true;
      const channel = new Channel<unknown>(() => {
        if (active) listener();
      });
      void invoke("deep_link_watch", { onEvent: channel }).then(
        () => {
          // A URL can arrive after the startup take but before registration.
          // Drain again once the watcher is installed so that gap cannot strand it.
          if (active) listener();
        },
        (error) => {
          if (active) console.error("Deep link updates are unavailable", error);
        },
      );
      return () => {
        active = false;
        channel.onmessage = () => {};
      };
    },
  };
}

/** The latest rejected OS link, for one notice at a time: a repeat replaces it. */
export function createRejectedLinks() {
  let current: number | undefined;
  let next = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reject() {
      current = ++next;
      emit();
    },
    /** Without an id, clears whichever notice is showing. */
    clear(id?: number) {
      if (current === undefined || (id !== undefined && current !== id)) return;
      current = undefined;
      emit();
    },
  };
}
export type RejectedLinks = ReturnType<typeof createRejectedLinks>;
