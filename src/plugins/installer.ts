import { Service, type Context } from "@deepseek-ai/cordis";
import type { PluginManager } from "./manager";
import { providePluginReviewHold } from "./review-access";
import {
  createPluginUpdateCapabilityBridge,
  type PluginUpdateCapability,
} from "./updates";
import type { PluginInfo } from "./types";

export type GitPluginInstallSource = Readonly<{
  repository: string;
  reference: string;
  path?: string;
  /** Install exactly this commit; the import is refused if the fetched head differs. */
  commit?: string;
}>;
/**
 * One plugin artifact (`buzzodz plugin pack`) over HTTPS, for people without access
 * to the Git host. Buzz installs it only if it hashes to `sha256` and its manifest ID is `id`.
 */
export type UrlPluginInstallSource = Readonly<{
  id: string;
  url: string;
  sha256: string;
}>;
export type PluginInstallSource =
  | GitPluginInstallSource
  | UrlPluginInstallSource;
export type PluginInstallOutcome =
  | "installed"
  | "updated"
  | "cancelled"
  | "unavailable";
type PluginInstallationStatus = "installed" | "absent" | "unavailable";
type PluginInstallationSourceKind =
  | "git"
  | "url"
  | "folder"
  | "bundled"
  | "absent"
  | "unavailable";
export type PluginInstaller = Readonly<{
  /** The source kinds `requestInstall` accepts. Missing on hosts that accept only Git. */
  sources?: readonly ("git" | "url")[];
  /** Opens Settings → Plugins for the user to review; it never installs silently. */
  requestInstall(source: PluginInstallSource): Promise<PluginInstallOutcome>;
  /**
   * Checks stable manifest-ID membership in the ready catalog, regardless of
   * enabled state or install source. Returns unavailable until the catalog is ready.
   */
  getInstallationStatus(id: string): PluginInstallationStatus;
  /**
   * Returns only the saved source kind. Returns unavailable before catalog
   * readiness, for duplicate IDs, or for unknown source metadata; absent means
   * the ready catalog does not contain the manifest ID.
   */
  getInstallationSource?(id: string): PluginInstallationSourceKind;
  /** Listen for status changes; call getInstallationStatus after subscribing for the current status. */
  subscribeInstallationStatus(
    id: string,
    listener: (status: PluginInstallationStatus) => void,
  ): () => void;
  /** Optional on older hosts; the current host always exposes an unavailable-capable bridge. */
  updates?: PluginUpdateCapability;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("pluginInstaller")` for old-host compatibility. */
    pluginInstaller?: PluginInstaller;
  }
}

const reference = /^[A-Za-z0-9._/-]{1,200}$/;
const pathSegment = /^[A-Za-z0-9._@+-]{1,100}$/;
const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Enterprise SSH aliases use account users such as `org-123@github.com`.
const sshUser = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const scpRepository =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([A-Za-z0-9.-]+):([A-Za-z0-9._~/+-]+)$/;

function githubTree(host: string, path: string) {
  const name = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  return name === "github.com" && path.split("/").filter(Boolean).length !== 2;
}

function gitRepository(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/[\s\p{Cc}\p{Cf}\P{ASCII}]/u.test(value)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*%/.test(value)) return null;
  const scp = scpRepository.exec(value);
  if (scp)
    return scp[2]?.startsWith("-") || githubTree(scp[2] ?? "", scp[3] ?? "")
      ? null
      : value;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      !url.hostname ||
      url.hostname.startsWith("-") ||
      url.password ||
      (url.protocol === "https:" && url.username) ||
      (url.protocol === "ssh:" &&
        url.username &&
        !sshUser.test(url.username)) ||
      url.search ||
      url.hash ||
      url.pathname.replaceAll("/", "") === "" ||
      githubTree(url.hostname, url.pathname)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function gitReference(value: unknown) {
  if (
    typeof value !== "string" ||
    !reference.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..")
  )
    return null;
  return value;
}

function relativePath(value: unknown) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length > 512) return null;
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment !== "." && segment !== ".." && pathSegment.test(segment),
  )
    ? value
    : null;
}

function relativeFolderPath(value: unknown, root: string) {
  if (value === ".") return value;
  if (typeof value !== "string" || !value || value.includes("\0")) return null;

  const windowsRoot =
    /^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(root);
  if (windowsRoot ? /^[\\/]|^[A-Za-z]:/.test(value) : value.startsWith("/"))
    return null;

  const segments = value.split(windowsRoot ? /[\\/]+/ : /\/+/);
  return segments.some((segment) => segment === "..") ||
    !segments.some((segment) => segment !== "" && segment !== ".")
    ? null
    : value;
}

function isAbsoluteFolderRoot(value: string) {
  return (
    !value.includes("\0") &&
    (value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value))
  );
}

const pluginId = /^[a-z][a-z0-9.-]{0,127}$/;
const sha256 = /^[0-9a-f]{64}$/;

export function pluginArtifactUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/[\s\p{Cc}\p{Cf}\P{ASCII}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.hostname.startsWith("-") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.replaceAll("/", "") !== ""
      ? value
      : null;
  } catch {
    return null;
  }
}

function urlInstallSource(
  input: Record<string, unknown>,
): UrlPluginInstallSource | null {
  const { id, url, sha256: digest, ...rest } = input;
  if (Object.keys(rest).length) return null;
  const normalizedUrl = pluginArtifactUrl(url);
  if (
    !normalizedUrl ||
    typeof id !== "string" ||
    !pluginId.test(id) ||
    typeof digest !== "string" ||
    !sha256.test(digest.toLowerCase())
  )
    return null;
  return { id, url: normalizedUrl, sha256: digest.toLowerCase() };
}

export function isUrlInstallSource(
  source: PluginInstallSource,
): source is UrlPluginInstallSource {
  return "url" in source;
}

/** The normalized request, or null when any field is outside the accepted grammar. */
export function parsePluginInstallSource(
  input: unknown,
): PluginInstallSource | null {
  if (!input || typeof input !== "object") return null;
  if ("url" in input) return urlInstallSource(input as Record<string, unknown>);
  const {
    repository,
    reference: ref,
    path,
    commit: pin,
  } = input as Record<string, unknown>;
  const normalizedRepository = gitRepository(repository);
  const normalizedReference = gitReference(ref);
  if (!normalizedRepository || !normalizedReference) return null;
  const normalizedPath = path === undefined ? undefined : relativePath(path);
  if (normalizedPath === null) return null;
  let normalizedCommit: string | undefined;
  if (pin !== undefined) {
    if (typeof pin !== "string" || !commit.test(pin.toLowerCase())) return null;
    normalizedCommit = pin.toLowerCase();
  }
  return {
    repository: normalizedRepository,
    reference: normalizedReference,
    ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
    ...(normalizedCommit === undefined ? {} : { commit: normalizedCommit }),
  };
}

/** The calling plugin as its own context reports it: a hint for the review, not proof. */
export type PluginInstallOrigin = Readonly<{ id: string; name: string }>;
export type PluginInstallRequest = Readonly<{
  id: number;
  source: PluginInstallSource;
  origin: PluginInstallOrigin;
}>;
export type GitPluginInstallRequest = PluginInstallRequest &
  Readonly<{ source: GitPluginInstallSource }>;
export type UrlPluginInstallRequest = PluginInstallRequest &
  Readonly<{ source: UrlPluginInstallSource }>;

export function createPluginInstallRequests({
  ttlMs = 60_000,
}: {
  ttlMs?: number;
} = {}) {
  let current:
    | {
        request: PluginInstallRequest;
        resolve(outcome: PluginInstallOutcome): void;
        timer: ReturnType<typeof setTimeout> | undefined;
        confirmed: boolean;
        ended: boolean;
      }
    | undefined;
  let nextId = 0;
  let reviews = 0;
  let reviewRevision = 0;
  const updateBridge = createPluginUpdateCapabilityBridge();
  const listeners = new Set<() => void>();
  const reviewListeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const emitReview = () => {
    reviewRevision++;
    for (const listener of reviewListeners) listener();
  };
  const holdReview = () => {
    reviews++;
    emitReview();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      reviews--;
      emitReview();
    };
  };
  const settle = (id: number, outcome: PluginInstallOutcome) => {
    if (current?.request.id !== id) return;
    const { resolve, timer } = current;
    clearTimeout(timer);
    current = undefined;
    resolve(outcome);
    emit();
    emitReview();
  };
  return {
    updates: updateBridge.capability,
    updatesFor: updateBridge.forCaller,
    registerUpdates: updateBridge.register,
    snapshot: () => current?.request,
    reviewRevision: () => reviewRevision,
    subscribeReview(listener: () => void) {
      reviewListeners.add(listener);
      return () => reviewListeners.delete(listener);
    },
    /** Acquires the shared review slot only when no request or review is active. */
    tryHoldReview() {
      return current !== undefined || reviews > 0 ? undefined : holdReview();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Resolves "unavailable" at once while another request or any review is open. */
    request(
      source: PluginInstallSource,
      origin: PluginInstallOrigin,
    ): Promise<PluginInstallOutcome> {
      if (current || reviews > 0) return Promise.resolve("unavailable");
      return new Promise((resolve) => {
        const id = ++nextId;
        current = {
          request: { id, source, origin },
          resolve,
          timer: setTimeout(() => settle(id, "cancelled"), ttlMs),
          confirmed: false,
          ended: false,
        };
        emit();
      });
    },
    /**
     * A review dialog took the request; it now lives as long as that dialog.
     * Refused, and settled unavailable, while another review dialog is open.
     */
    claim(id: number) {
      if (current?.request.id !== id || current.confirmed) return false;
      if (reviews > 0) {
        settle(id, "unavailable");
        return false;
      }
      clearTimeout(current.timer);
      current.timer = undefined;
      return true;
    },
    /**
     * The user confirmed the install. Until the returned function runs, the
     * requester going away (as it does when it updates itself) does not cancel
     * the request, so the install can still report its outcome.
     */
    confirm(id: number) {
      if (current?.request.id !== id) return () => {};
      current.confirmed = true;
      return () => {
        if (current?.request.id !== id) return;
        current.confirmed = false;
        if (current.ended) settle(id, "cancelled");
      };
    },
    /**
     * The requester or the review went away: cancels the request unless a
     * confirmed install is still running, which then reports its own outcome.
     */
    end(id: number) {
      if (current?.request.id !== id) return;
      if (current.confirmed) current.ended = true;
      else settle(id, "cancelled");
    },
    /** Marks a plugin review dialog as open until the returned function runs. */
    holdReview,
    settle,
  };
}
export type PluginInstallRequests = ReturnType<
  typeof createPluginInstallRequests
>;

function displayName(name: string, fallback: string) {
  return name.replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
}

type InstallHost = Readonly<{
  plugins: Pick<PluginManager, "snapshot" | "subscribe" | "imports">;
  requests: PluginInstallRequests;
  openPlugins(): Promise<{ status: string }>;
}>;

const invalidSource =
  "A plugin install request needs either an HTTPS, SSH or scp-style Git repository, a branch or tag, and optionally a relative folder and a commit; or a plugin id, an HTTPS artifact url and its sha256";

function savedGitRepository(value: string) {
  // Native imports save normalized URLs with broader SSH usernames than requests allow.
  // Keep legacy scp metadata readable without changing request admission.
  if (!value.includes("://")) return gitRepository(value) !== null;
  if (/[\s\p{Cc}]/u.test(value) || value.includes("?") || value.includes("#"))
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      !!url.hostname &&
      !url.hostname.startsWith("-") &&
      !url.username.startsWith("-") &&
      !url.password &&
      (url.protocol !== "https:" || !url.username) &&
      url.pathname.replaceAll("/", "") !== "" &&
      !githubTree(url.hostname, url.pathname)
    );
  } catch {
    return false;
  }
}

function savedInstallationSourceKind(
  plugin: PluginInfo,
): PluginInstallationSourceKind {
  if (plugin.source === "bundled") return "bundled";
  if (plugin.source !== "external") return "unavailable";

  const savedSource: unknown = plugin.updateSource;
  if (
    !savedSource ||
    typeof savedSource !== "object" ||
    Array.isArray(savedSource)
  )
    return "unavailable";
  const source = savedSource as Record<string, unknown>;
  const keys = Object.keys(source);
  const hasOnlyKeys = (...allowed: string[]) =>
    keys.every((key) => allowed.includes(key));
  if (
    hasOnlyKeys("repository", "reference", "path", "commit") &&
    typeof source.repository === "string" &&
    savedGitRepository(source.repository) &&
    typeof source.reference === "string" &&
    (source.reference === "" || gitReference(source.reference) !== null) &&
    typeof source.path === "string" &&
    // Native Git discovery records UTF-8 folders with POSIX separators.
    relativeFolderPath(source.path, "/") !== null &&
    (source.commit === undefined ||
      (typeof source.commit === "string" &&
        commit.test(source.commit.toLowerCase())))
  )
    return "git";
  if (
    hasOnlyKeys("url", "sha256") &&
    typeof source.url === "string" &&
    pluginArtifactUrl(source.url) !== null &&
    typeof source.sha256 === "string" &&
    sha256.test(source.sha256.toLowerCase())
  )
    return "url";
  if (
    hasOnlyKeys("root", "path") &&
    typeof source.root === "string" &&
    isAbsoluteFolderRoot(source.root) &&
    typeof source.path === "string" &&
    relativeFolderPath(source.path, source.root) !== null
  )
    return "folder";
  return "unavailable";
}

export function createPluginInstallCore({
  plugins,
  requests,
  openPlugins,
}: InstallHost) {
  const getInstallationStatus = (id: string): PluginInstallationStatus => {
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return "unavailable";
    return configuration.catalog.plugins.some(
      (plugin) => plugin.manifest.id === id,
    )
      ? "installed"
      : "absent";
  };
  const getInstallationSource = (id: string): PluginInstallationSourceKind => {
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return "unavailable";
    let plugin: PluginInfo | undefined;
    for (const candidate of configuration.catalog.plugins) {
      if (candidate.manifest.id !== id) continue;
      if (plugin) return "unavailable";
      plugin = candidate;
    }
    if (!plugin) return "absent";
    return savedInstallationSourceKind(plugin);
  };

  return {
    holdReview: requests.holdReview,
    updates: requests.updates,
    updatesFor: requests.updatesFor,
    registerUpdates: requests.registerUpdates,
    getInstallationStatus,
    getInstallationSource,
    subscribeInstallationStatus(
      id: string,
      listener: (status: PluginInstallationStatus) => void,
    ) {
      let current = getInstallationStatus(id);
      return plugins.subscribe(() => {
        const next = getInstallationStatus(id);
        if (next === current) return;
        current = next;
        listener(next);
      });
    },
    async submit(
      source: PluginInstallSource,
      caller: Readonly<{
        id: string;
        /** Runs `end` when the caller goes away and returns a function that stops
         * watching; throws when the caller is already gone. */
        lifetime(end: () => void): () => void;
      }>,
    ): Promise<PluginInstallOutcome> {
      const checked = parsePluginInstallSource(source);
      if (!checked) throw new Error(invalidSource);
      const { configuration } = plugins.snapshot();
      if (!plugins.imports || configuration.status !== "ready")
        return "unavailable";
      let admitted: number | undefined;
      let stopWatching: () => void;
      try {
        stopWatching = caller.lifetime(() => {
          if (admitted !== undefined) requests.end(admitted);
        });
      } catch {
        return "unavailable";
      }
      try {
        const own = configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === caller.id,
        );
        const origin = {
          id: caller.id,
          name: displayName(own?.manifest.name ?? "", caller.id),
        };
        const outcome = requests.request(checked, origin);
        const request = requests.snapshot();
        if (!request || request.source !== checked) return await outcome;
        admitted = request.id;
        void openPlugins().then(
          ({ status }) => {
            if (status !== "opened")
              requests.settle(
                request.id,
                status === "failed" ? "unavailable" : "cancelled",
              );
          },
          () => requests.settle(request.id, "unavailable"),
        );
        return await outcome;
      } finally {
        stopWatching();
      }
    },
  };
}
export type PluginInstallCore = ReturnType<typeof createPluginInstallCore>;

/** The handle plugins read from `ctx.reflect`. */
export function createPluginInstallerService(
  ctx: Context,
  host: Readonly<{ core: PluginInstallCore }>,
): PluginInstaller {
  const callerUpdates = new WeakMap<Context, PluginUpdateCapability>();
  class PluginInstallerService extends Service implements PluginInstaller {
    readonly sources = Object.freeze(["git", "url"] as const);

    get updates() {
      const caller = this.ctx;
      let capability = callerUpdates.get(caller);
      if (capability) return capability;
      const updates = caller.pluginOwner
        ? host.core.updatesFor(caller.pluginOwner.id)
        : host.core.updates;
      capability = {
        get ownerId() {
          return updates.ownerId;
        },
        getSnapshot: updates.getSnapshot,
        refresh: updates.refresh,
        queueUpdates: updates.queueUpdates,
        getQueueRequest: updates.getQueueRequest,
        getQueue: updates.getQueue,
        cancelQueue: updates.cancelQueue,
        getOwnerStatus: (ownerId) =>
          updates.getOwnerStatus?.(ownerId) ?? "unknown",
        subscribe(listener) {
          const stop = caller.effect(() => updates.subscribe(listener));
          return () => void stop();
        },
        subscribeQueue(id, listener) {
          const stop = caller.effect(() =>
            updates.subscribeQueue(id, listener),
          );
          return () => void stop();
        },
      };
      callerUpdates.set(caller, capability);
      return capability;
    }

    constructor() {
      super(ctx, "pluginInstaller");
    }

    // Keep these as methods so Cordis supplies the caller's context for origin and lifetime.
    requestInstall(source: PluginInstallSource): Promise<PluginInstallOutcome> {
      const owner = this.ctx.pluginOwner;
      if (!owner)
        return Promise.reject(
          new Error("Plugin installs must be requested by an installed plugin"),
        );
      const caller = this.ctx;
      return host.core.submit(source, {
        id: owner.id,
        lifetime: (end) => {
          const stop = caller.effect(() => end);
          return () => void stop();
        },
      });
    }

    getInstallationStatus(id: string): PluginInstallationStatus {
      return host.core.getInstallationStatus(id);
    }

    getInstallationSource(id: string): PluginInstallationSourceKind {
      return host.core.getInstallationSource(id);
    }

    subscribeInstallationStatus(
      id: string,
      listener: (status: PluginInstallationStatus) => void,
    ): () => void {
      const caller = this.ctx;
      const stop = caller.effect(() =>
        host.core.subscribeInstallationStatus(id, (status) => {
          try {
            listener(status);
          } catch (error) {
            caller
              .logger("pluginInstaller")
              .warn("Installed-plugin status listener failed", error);
          }
        }),
      );
      return () => void stop();
    }
  }

  providePluginReviewHold(ctx, host.core.holdReview);
  return new PluginInstallerService();
}
