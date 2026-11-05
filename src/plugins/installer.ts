import { Service, type Context } from "@deepseek-ai/cordis";
import type { PluginManager } from "./manager";
import { providePluginReviewHold } from "./review-access";

export type PluginInstallSource = Readonly<{
  repository: string;
  reference: string;
  path?: string;
  /** Install exactly this commit; the import is refused if the fetched head differs. */
  commit?: string;
}>;
export type PluginInstallOutcome =
  | "installed"
  | "updated"
  | "cancelled"
  | "unavailable";
export type PluginInstaller = Readonly<{
  /** Opens Settings → Plugins for the user to review; it never installs silently. */
  requestInstall(source: PluginInstallSource): Promise<PluginInstallOutcome>;
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

/** The normalized request, or null when any field is outside the accepted grammar. */
export function parsePluginInstallSource(
  input: unknown,
): PluginInstallSource | null {
  if (!input || typeof input !== "object") return null;
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
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const settle = (id: number, outcome: PluginInstallOutcome) => {
    if (current?.request.id !== id) return;
    const { resolve, timer } = current;
    clearTimeout(timer);
    current = undefined;
    resolve(outcome);
    emit();
  };
  return {
    snapshot: () => current?.request,
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
    holdReview() {
      reviews++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        reviews--;
      };
    },
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
  plugins: Pick<PluginManager, "snapshot" | "imports">;
  requests: PluginInstallRequests;
  openPlugins(): Promise<{ status: string }>;
}>;

const invalidSource =
  "A plugin install request needs an HTTPS, SSH or scp-style Git repository, a branch or tag, and optionally a relative folder and a commit";

export function createPluginInstallCore({
  plugins,
  requests,
  openPlugins,
}: InstallHost) {
  return {
    holdReview: requests.holdReview,
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
  class PluginInstallerService extends Service implements PluginInstaller {
    constructor() {
      super(ctx, "pluginInstaller");
    }

    // A method, not an arrow property: Cordis gives it the calling plugin's
    // context, which is how a request is attributed and tied to its lifetime.
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
  }

  providePluginReviewHold(ctx, host.core.holdReview);
  return new PluginInstallerService();
}
