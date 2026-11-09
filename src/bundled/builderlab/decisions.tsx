// Builderlab as a decision provider: the user's Builderlab sign-in, which
// native code sends with each call. The NIP-FI session is named by its
// revision; its token never leaves native. It is offered while the user is
// signed in, and ready only while that account may use decisions; see
// `offerBuilderlabDecisions`. Settings >
// Decisions API shows the same sign-in control as this plugin's card while it
// is selected.
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
} from "../../features/decisions/service";
import { Login } from "./login/Login";
import type { BuilderlabSession, Credential } from "./session";

/** Native `decide` on Builderlab, as the sign-in `credential`. */
export type BuilderlabDecide = (
  request: unknown,
  credential: Credential,
) => Promise<unknown>;
export const nativeBuilderlabDecide = (): BuilderlabDecide | undefined =>
  isTauri()
    ? (request, credential) =>
        invoke("decide", {
          backend: "builderlab",
          request,
          federated: credential.revision,
        })
    : undefined;

/** Registers Builderlab in Settings > Decisions API while the user is signed
 * in, and removes it otherwise. It is ready while Builderlab reports that the
 * account may use decisions; reading its status keeps that fresh. While it is
 * ready it is a default provider, so it answers unless the user chose another.
 * Builds without native calls never offer it. `openIdentity` opens where an
 * FI build's shared sign-in ends. */
export function offerBuilderlabDecisions(
  ctx: Context,
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabDecide | undefined = nativeBuilderlabDecide(),
  openIdentity?: () => void,
) {
  if (!native) return;
  const provider = builderlabProvider(
    session,
    loginAvailable,
    native,
    openIdentity,
  );
  let withdraw: (() => void) | undefined;
  const update = () => {
    const allowed = session.snapshot().status === "signed-in";
    if (allowed && !withdraw)
      withdraw = ctx.decisions.registerProvider(provider);
    else if (!allowed && withdraw) {
      withdraw();
      withdraw = undefined;
    }
  };
  ctx.effect(() => {
    const stop = session.subscribe(update);
    update();
    return stop;
  });
}

export function builderlabProvider(
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabDecide | undefined = nativeBuilderlabDecide(),
  openIdentity?: () => void,
): DecisionProvider {
  const signedIn = () =>
    session.snapshot().status === "signed-in"
      ? session.credential()
      : undefined;
  // Builderlab reports whether this account may use decisions.
  // Only an explicit yes enables them; otherwise no call goes to Builderlab.
  const permitted = (credential: Credential) =>
    credential.account.canUseBuilderlabDecisions;
  return {
    id: "builderlab",
    label: "Builderlab",
    description: "Use your Builderlab account.",
    // A sign-in in progress cannot answer yet. Permissions being re-read
    // are waited for only when the cached ones refuse: a grant may be new.
    status: (): DecisionProviderStatus => {
      const state = session.snapshot();
      const credential = signedIn();
      if (!native || !credential) return "needs-setup";
      if (permitted(credential)) return "ready";
      return state.checkingPermissions ? "checking" : "needs-setup";
    },
    subscribe: session.subscribe,
    decide: async (request, { signal }) => {
      if (!native) return { outcome: "failed", reason: "unavailable" };
      if (!signedIn())
        return { outcome: "failed", reason: "missing_credentials" };
      let credential: Credential;
      try {
        credential = await session.freshCredential(signal);
      } catch {
        return { outcome: "failed", reason: "missing_credentials" };
      }
      if (!permitted(credential))
        return { outcome: "failed", reason: "unauthorized" };
      let reply: unknown;
      try {
        reply = await native(request, credential);
      } catch (error) {
        // Tauri rejects arguments that do not deserialize before any call:
        // a malformed request. Any other rejection is the IPC itself failing.
        return {
          outcome: "failed",
          reason: (error instanceof Error
            ? error.message
            : String(error)
          ).startsWith("invalid args")
            ? "invalid_request"
            : "service_error",
        };
      }
      if (!reply || typeof reply !== "object")
        return { outcome: "failed", reason: "invalid_response" };
      const { outcome, reason, model, answers } = reply as Record<
        string,
        unknown
      >;
      // A Builderlab 401 refuses this call only, never the sign-in that
      // other Builderlab features share: native asks the adapter whether a
      // NIP-FI session ended, and the broker owns its own.
      if (reason === "session_expired")
        return { outcome: "failed", reason: "unauthorized" };
      // The host checks the reply's shape and answers.
      return (
        outcome === "answered"
          ? { outcome, model, answers }
          : { outcome, reason }
      ) as DecisionReply;
    },
    Settings: ({ active }) => {
      const state = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <>
          <Login
            session={session}
            available={loginAvailable}
            active={active}
            showHeading={false}
            openIdentity={openIdentity}
          />
          {state.status === "signed-in" &&
            !state.checkingPermissions &&
            !state.account?.canUseBuilderlabDecisions && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab decisions are unavailable for this account.
              </p>
            )}
        </>
      );
    },
  };
}
