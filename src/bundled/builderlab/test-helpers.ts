import type { BuilderlabViewerSession } from "../../features/browser/api";
import type { Host } from "../../features/host/service";
import { oauthTarget } from "./oauth/browser";
import {
  accountStorage,
  type BuilderlabRequest,
  type BuilderlabSession,
  type Credential,
  type LoginSnapshot,
} from "./session";

export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * A Builderlab session for tests: `acquire` stands in for the native NIP-FI
 * sign-in, and `request` sends each call to the build's Builderlab API
 * through `host` as it is, as native's forwarder would before adding the
 * session. Each sign-in is a new credential object; the viewer session names
 * it by revision.
 */
export function createTestSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
  release?: (credential: Credential) => void,
  /** Carries `request`; without it, requests are refused. */
  host?: Pick<Host, "request">,
) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  let viewer: BuilderlabViewerSession | undefined;
  let viewerLifetime: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const reset = (revoke = false, announce = true) => {
    attempt?.abort();
    attempt = undefined;
    viewerLifetime?.abort();
    viewerLifetime = undefined;
    viewer = undefined;
    const previous = credential;
    credential = undefined;
    if (previous && revoke) release?.(previous);
    if (announce) publish({ status: "signed-out" });
  };
  const session = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    async freshCredential(signal: AbortSignal): Promise<Credential> {
      signal.throwIfAborted();
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    async request(_owner: Credential, input: BuilderlabRequest) {
      if (!host) throw new Error("Builderlab requests are unavailable.");
      return host.request({
        url: `${oauthTarget()}${input.path}`,
        ...(input.method ? { method: input.method } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
    },
    viewerSession() {
      if (!viewer) throw new Error("Sign in to Builderlab first.");
      return viewer;
    },
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (state.status === "pending") return;
          cleanup();
          if (credential) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        void session.signIn();
      });
    },
    cancel: () => reset(),
    abandon: () => reset(),
    signOut: () => reset(true),
    async signIn() {
      if (disposed || attempt) return;
      reset(true, false);
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        const storage = await accountStorage(result.account.subject);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        viewerLifetime = new AbortController();
        viewer = {
          federated: result.revision,
          storage,
          signal: viewerLifetime.signal,
        };
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  } satisfies BuilderlabSession;
  return session;
}
