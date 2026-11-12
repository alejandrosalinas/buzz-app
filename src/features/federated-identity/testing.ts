import { vi } from "vitest";
import type {
  FederatedIdentity,
  SessionSnapshot,
  AuthenticatedRequest,
} from "./service";
import type { HostRequest, HostResponse } from "../host/service";

/** Consumer fixtures supply public host events; they do not implement credential custody. */
export function federatedFixture(
  revision = "user",
  email: string | null = "a@example.com",
) {
  let state: SessionSnapshot = {
    status: "signed-out",
    authority: {
      id: "test",
      identityOrigin: "https://builderlab.example",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
      communityHosts: ["relay.example"],
    },
    revision: `${revision}:0`,
    email: null,
    failure: null,
    expiresAt: null,
    expiring: false,
    cleanup: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<SessionSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
    return state;
  };
  let logins = 0;
  const service: FederatedIdentity &
    Required<Pick<FederatedIdentity, "recheck" | "askAgain">> = {
    apiAvailable: true,
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signIn: vi.fn(async () => {
      // Like native, a login without a session browses as `signing-in`.
      if (state.status !== "signed-in") publish({ status: "signing-in" });
      publish({
        status: "signed-in",
        revision: `${revision}:${++logins}`,
        email,
      });
      return state;
    }),
    cancelSignIn: vi.fn(async () => {
      publish({
        status: "signed-out",
        revision: crypto.randomUUID(),
        email: null,
      });
    }),
    recheck: vi.fn(async () => state),
    askAgain: vi.fn(async (_relay: string) => {}),
    signOut: vi.fn(async (options?: { revision?: string }) => {
      if (!options?.revision || options.revision === state.revision)
        publish({
          status: "signed-out",
          revision: crypto.randomUUID(),
          email: null,
          failure: null,
          cleanup: false,
        });
      return state;
    }),
    request: vi.fn(
      async (_input: AuthenticatedRequest): Promise<HostResponse> => {
        throw new Error("Fixture response required");
      },
    ),
  };
  return {
    service,
    publish,
    request: vi.mocked(service.request),
  };
}

/**
 * A signed-in NIP-FI session at `revision` whose forwarder answers through
 * `request`, called with the URL native would send to at `origin`.
 */
export function forwardingSession(
  revision: string,
  request: (input: HostRequest) => Promise<HostResponse>,
  origin = "https://builderlab.example",
): Pick<FederatedIdentity, "snapshot" | "request"> {
  const snapshot: SessionSnapshot = {
    status: "signed-in",
    authority: {
      id: "test",
      identityOrigin: origin,
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
      communityHosts: [],
    },
    revision,
    email: null,
    failure: null,
    expiresAt: null,
    expiring: false,
    cleanup: false,
  };
  return {
    snapshot: () => snapshot,
    request: ({ path, method, headers, body }) =>
      request({
        url: `${origin}${path}`,
        ...(method ? { method } : {}),
        ...(headers ? { headers } : {}),
        ...(body === undefined ? {} : { body }),
      }),
  };
}
