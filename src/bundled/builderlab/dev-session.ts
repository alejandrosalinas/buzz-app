import {
  capabilitiesFrom,
  createPermissions,
  settledOrAborted,
  type Permissions,
} from "./capabilities";
import { invoke, isTauri } from "@tauri-apps/api/core";
// Public projection of the development server's login; the parent credential stays in Node.
// Trusted local callers can still use its dedicated native viewer/Decisions routes.
import type {
  Host,
  HostRequest,
  HostUpload,
} from "../../features/host/service";
import type { BuilderlabViewerSession } from "../../features/browser/api";
import {
  accountStorage,
  nativeBuilderlab,
  type Account,
  type BuilderlabSession,
  type Credential,
  type LoginSnapshot,
} from "./session";
import { broker, createApi } from "./communities/api";

export const brokerBuilderlab = () =>
  import.meta.env.DEV &&
  import.meta.env.VITE_BUZZ_LIVE === "1" &&
  !nativeBuilderlab();

type State = {
  revision: string;
  pending: boolean;
  capabilitiesCheckedAt?: number;
  error?: string;
  auth: null | {
    subject: string;
    email?: string;
    name?: string;
    expiresAt: string;
    capabilities?: unknown;
  };
};

export function createDevSession() {
  let state: LoginSnapshot = { status: "pending", checking: true };
  let owner: Credential | undefined;
  let permissions: Permissions | undefined;
  let viewer: BuilderlabViewerSession | undefined;
  let lifetime = new AbortController();
  let disposed = false;
  let version = 0;
  let revision: string | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const clear = () => {
    lifetime.abort();
    lifetime = new AbortController();
    owner = undefined;
    permissions = undefined;
    viewer = undefined;
  };
  const check = (expected: Credential) => {
    if (disposed || expected !== owner)
      throw new DOMException("Builderlab session changed.", "AbortError");
  };
  async function project(next: State) {
    if (disposed) return;
    revision = next.revision;
    if (owner?.revision === next.revision && next.auth && !next.pending) {
      if (state.status !== "signed-in")
        publish({ status: "signed-in", account: owner.account });
      return;
    }
    const at = ++version;
    clear();
    if (!next.auth || next.pending) {
      publish({
        status: next.pending ? "pending" : "signed-out",
        ...(!next.pending && next.error ? { error: next.error } : {}),
      });
      return;
    }
    publish({ status: "pending", checking: true });
    const storage = await accountStorage(next.auth.subject);
    if (disposed || version !== at) return;
    let account: Account = Object.freeze({
      subject: next.auth.subject,
      email: next.auth.email ?? "",
      ...(next.auth.name ? { name: next.auth.name } : {}),
      expiresAt: next.auth.expiresAt,
      ...capabilitiesFrom(next.auth.capabilities),
    });
    const current = Object.freeze({
      get account() {
        return account;
      },
      revision: next.revision,
    });
    owner = current;
    permissions = createPermissions({
      initial: account,
      async read() {
        const response = await fetch(
          `/api/builderlab/capabilities?revision=${encodeURIComponent(current.revision)}`,
          { signal: lifetime.signal },
        );
        if (!response.ok) throw new Error("Capability check failed");
        const result = await response.json();
        if (result?.revision !== current.revision)
          throw new Error("Builderlab session changed");
        return result;
      },
      changed(capabilities) {
        if (disposed || owner !== current) return;
        account = Object.freeze({ ...account, ...capabilities });
      },
      settled() {
        if (!disposed && owner === current && state.status === "signed-in")
          publish({ status: "signed-in", account });
      },
      checkedAt: next.capabilitiesCheckedAt,
    });
    viewer = {
      broker: { origin: window.location.origin, revision: next.revision },
      storage,
      signal: lifetime.signal,
    };
    publish({ status: "signed-in", account });
  }
  let events: EventSource;
  const connect = (dispatchError?: string) => {
    const initialVersion = version;
    const source = new EventSource("/api/builderlab/events");
    events = source;
    source.onmessage = (event) => {
      if (disposed || events !== source) return;
      const next = JSON.parse(event.data) as State;
      if (
        dispatchError &&
        version === initialVersion &&
        !next.pending &&
        !next.auth
      )
        next.error ??= dispatchError;
      dispatchError = undefined;
      const projection = project(next);
      const at = version;
      void projection.catch(() => {
        if (disposed || events !== source || version !== at) return;
        clear();
        publish({
          status: "signed-out",
          error: "Could not read the development server's Builderlab sign-in.",
        });
      });
    };
    source.onerror = () => {
      if (disposed || events !== source) return;
      ++version;
      clear();
      publish({ status: "pending", checking: true });
    };
  };
  connect();
  async function send(action: string, body: object = {}, signal?: AbortSignal) {
    const response = await fetch(`/api/builderlab/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : "Builderlab request failed.",
      );
    return result;
  }
  const session: BuilderlabSession = {
    snapshot() {
      if (
        owner &&
        state.status === "signed-in" &&
        !state.checkingPermissions &&
        permissions?.revalidate()
      ) {
        // Readers may be rendering: they see the flag now, listeners later.
        const current = owner;
        state = Object.freeze({ ...state, checkingPermissions: true });
        queueMicrotask(() => {
          if (owner === current) for (const listener of listeners) listener();
        });
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!owner || disposed) throw new Error("Sign in to Builderlab first.");
      return owner;
    },
    async freshCredential(signal) {
      const expected = session.credential();
      session.snapshot();
      if (permissions) await settledOrAborted(permissions, signal);
      check(expected);
      return expected;
    },
    async request(expected, input) {
      check(expected);
      const response = await send("request", {
        ...input,
        revision: owner?.revision,
      });
      check(expected);
      return response;
    },
    // The server processes 401s and expiry for every consumer together.
    viewerSession() {
      if (!viewer || disposed) throw new Error("Sign in to Builderlab first.");
      return viewer;
    },
    async ensureSignedIn(signal) {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (owner) return;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (!disposed && state.status === "pending") return;
          cleanup();
          if (owner) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          listeners.delete(done);
          signal.removeEventListener("abort", abort);
        };
        listeners.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (state.status !== "pending") void session.signIn();
      });
    },
    async signIn() {
      if (disposed || state.status === "pending") return;
      const at = ++version;
      publish({ status: "pending" });
      try {
        await send("login");
      } catch {
        // The broker's revisioned event stream owns login outcomes across all pages.
        if (disposed || version !== at) return;
        // No event accounted for this dispatch. A new stream starts with fresh broker state.
        events.close();
        connect("Could not start Builderlab sign-in. Try again.");
        publish({ status: "pending", checking: true });
      }
    },
    cancel() {
      session.signOut();
    },
    // Closing Settings or reloading the app does not own the server's login.
    abandon() {},
    signOut() {
      if (disposed) return;
      const at = ++version;
      clear();
      publish({ status: "pending", checking: true });
      void send("sign-out", { revision }).catch(() => {
        if (!disposed && version === at)
          publish({
            status: "signed-out",
            error:
              "Could not sign out on the development server. Reconnect and try again.",
          });
      });
    },
    dispose() {
      disposed = true;
      ++version;
      events.close();
      clear();
      publish({ status: "signed-out" });
      listeners.clear();
    },
  };
  const transport = async (input: HostRequest | HostUpload) => {
    const expected = session.credential();
    const url = new URL(input.url);
    const response = await send("request", {
      revision: owner?.revision,
      target: "apps",
      path: `${url.pathname}${url.search}`,
      method: "file" in input ? "POST" : input.method,
      ...("file" in input ? { file: input.file.path } : { body: input.body }),
    });
    // Accepted uploads retain their IDs; the next request checks its original account.
    if (!("file" in input)) check(expected);
    return response;
  };
  const communities = createApi({
    ...broker,
    async auth() {
      const expected = session.credential();
      const value = await broker.auth();
      check(expected);
      return value;
    },
    async send(action, body, signal) {
      const expected = session.credential();
      const response = await broker.send(
        action,
        { ...body, revision: owner?.revision } as Record<string, string>,
        signal,
      );
      check(expected);
      return response;
    },
  });
  return {
    session,
    communities,
    decide: isTauri()
      ? async (request: unknown) => {
          const viewer = session.viewerSession();
          if (!("broker" in viewer))
            throw new Error("Development session unavailable");
          return invoke("decide", {
            backend: "builderlab",
            request,
            broker: viewer.broker,
          });
        }
      : undefined,
    apps: { request: transport, upload: transport } satisfies Pick<
      Host,
      "request" | "upload"
    >,
  };
}
