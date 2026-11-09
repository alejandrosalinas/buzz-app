import type { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { recoveryMessage } from "../../../features/federated-identity/CommunitySignIn";
import type {
  FederatedIdentity,
  SessionSnapshot,
  SignInOptions,
} from "../../../features/federated-identity/service";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import {
  type Credential,
  federatedAccount,
  type LoginSnapshot,
} from "../session";

/**
 * The NIP-FI session as the bundled plugin's installation calls it. Native
 * grants that installation the forwarder at build time and admission checks
 * only that grant, so first launch can sign in whether or not the plugin's
 * JavaScript has started.
 */
export const bundledFederatedIdentity = (ctx: Context): FederatedIdentity =>
  ctx.extend({ pluginOwner: { id: manifest.id, revision: "bundled" } })
    .federatedIdentity;

/**
 * What first run uses of the NIP-FI session: it signs out only when the
 * person rejects the account (`releaseFirstRunSession`), and it alone passes
 * sign-in choices, which the host's service passes to native.
 */
export type FirstRunIdentity = Pick<
  FederatedIdentity,
  "snapshot" | "subscribe" | "cancelSignIn" | "signOut" | "request"
> & { signIn(options?: SignInOptions): Promise<SessionSnapshot> };

/**
 * "Use a different account": signs the shared session out, but only while it
 * is still the one first run signed in as. Native checks the revision as it
 * retires, so a newer sign-in (from Settings or another copy) stays signed
 * in. Rejects when the sign-out did not finish, including cleanup native
 * reports as `unavailable`, with the revision to retry at: retiring moves
 * native's revision, so a retry fenced to the old one would be refused.
 */
export class SignOutIncomplete extends Error {
  constructor(readonly revision: string) {
    super("Couldn't sign out of that account. Try again.");
  }
}
export async function releaseFirstRunSession(
  identity: Pick<FederatedIdentity, "signOut" | "snapshot">,
  revision: string,
) {
  const after = await identity.signOut({ revision }).catch(() => {
    const now = identity.snapshot();
    throw new SignOutIncomplete(now.cleanup ? now.revision : revision);
  });
  if (after.status === "signed-in" && after.revision !== revision) return;
  if (after.status !== "signed-out" || after.cleanup)
    throw new SignOutIncomplete(after.revision);
}

/**
 * First run's Builderlab sign-in (`federatedCredential`). The bundled grant
 * exists only while this plugin is enabled, so with it turned off the
 * account could never be read; refuse before opening the browser instead.
 */
export async function firstRunCredential(
  signal: AbortSignal,
  federated: FirstRunIdentity,
  /** What the browser step asks for: Create account's sign-up screen, or
   * credentials over the browser's session after Use a different account. */
  options: SignInOptions = {},
): Promise<Credential> {
  const result = await invoke<StorageResult>("plugin_catalog").catch(() => {
    throw new Error("Could not complete Builderlab sign-in. Try again.");
  });
  if (
    result.status !== "ready" ||
    !result.catalog.plugins.some(
      (plugin) =>
        plugin.source === "bundled" &&
        plugin.manifest.id === manifest.id &&
        plugin.enabled,
    )
  )
    throw new Error(
      "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
    );
  return federatedCredential(federated, signal, options);
}

// Native rejects with a bare failure code, such as a refused renewal's.
const signIn = (identity: FirstRunIdentity, options: SignInOptions) =>
  identity.signIn(options).catch((error: unknown) => {
    throw new Error(
      recoveryMessage(error instanceof Error ? error.message : ""),
    );
  });

/**
 * An FI build's sign-in: the native NIP-FI login, whose browser step, code
 * exchange and token stay native, then its account as the Builderlab plugin
 * reads it. A session that already exists, including a stored one native
 * restores, signs in again, so the browser can choose the account. First
 * run's later calls are fenced to the credential's revision
 * (`federatedBuilderlabAccount`).
 */
async function federatedCredential(
  identity: FirstRunIdentity,
  signal: AbortSignal,
  options: SignInOptions,
): Promise<Credential> {
  signal.throwIfAborted();
  let wake = () => {};
  const cancel = () => {
    wake();
    void identity.cancelSignIn().catch(() => {});
  };
  // A login without a session is `signing-in` for its whole browser step;
  // a renewal never is, nor is a stored session native restores.
  let browsed = false;
  const unsubscribe = identity.subscribe(() => {
    wake();
    if (browsed || identity.snapshot().status !== "signing-in") return;
    browsed = true;
    // Native began it after a Cancel that arrived while it was still
    // restoring, which canceled nothing. Only the first is this call's: a
    // later one is a newer sign-in's, begun after Cancel.
    if (signal.aborted) cancel();
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // While native restores a stored session, `signIn` waits for it and
    // answers with that session, with no browser step.
    while (identity.snapshot().status === "restoring") {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      signal.throwIfAborted();
    }
    let before = identity.snapshot();
    // Pushed snapshots from before this sign-in answered; see the wait below.
    const earlier = [before.revision];
    let session = await signIn(identity, options);
    signal.throwIfAborted();
    // After a failed restore, `signIn` restores again first and answers with
    // the stored session it finds; from signed out, it adopts a session
    // another copy saved. Either way no browser opened: renew that, so the
    // browser chooses.
    if (
      (before.status === "unavailable" || before.status === "signed-out") &&
      session.status === "signed-in" &&
      !browsed
    ) {
      before = session;
      earlier.push(session.revision);
      session = await signIn(identity, options);
      signal.throwIfAborted();
    }
    // A renewal that is canceled (in the browser, by Cancel, or by a newer
    // sign-in's callback) answers with the session it would have replaced:
    // never continue as it. One that times out rejects (`sign-in-timed-out`).
    if (before.status === "signed-in" && session.revision === before.revision)
      throw new Error(recoveryMessage("sign-in-canceled"));
    if (session.status !== "signed-in")
      throw new Error(recoveryMessage(session.failure ?? ""));
    // Requests are fenced to the pushed snapshot, which may still be the
    // browser step's or, for a renewal that stays signed in, the session
    // before it: wait for this session's own, unless something newer (a
    // cancel, another sign-in) replaces it first.
    const pending = () => {
      const now = identity.snapshot();
      return (
        now.revision !== session.revision &&
        (now.status === "signing-in" || earlier.includes(now.revision))
      );
    };
    while (pending()) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      signal.throwIfAborted();
    }
    if (identity.snapshot().revision !== session.revision)
      throw new Error(recoveryMessage("sign-in-canceled"));
    const account = await federatedAccount(identity).catch(() => undefined);
    signal.throwIfAborted();
    if (!account || identity.snapshot().revision !== session.revision)
      throw new Error("Could not load your Builderlab account. Try again.");
    return Object.freeze({ revision: session.revision, account });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * First run's hold on one sign-in: `acquire`'s credential while it lasts. A
 * new sign-in or `cancel` ends the attempt and the credential, and a
 * superseded attempt's answer is dropped.
 */
export function createFirstRunLogin(
  acquire: (signal: AbortSignal) => Promise<Credential>,
  release?: (credential: Credential) => Promise<void>,
) {
  let credential: Credential | undefined;
  // A rejected account whose sign-out failed, kept for Try again.
  let releasing: Credential | undefined;
  let attempt: AbortController | undefined;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const reset = (announce = true) => {
    attempt?.abort();
    attempt = undefined;
    credential = undefined;
    releasing = undefined;
    if (announce) publish({ status: "signed-out" });
  };
  return {
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
    async signIn() {
      if (attempt) return;
      reset(false);
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        if (attempt !== current) return;
        credential = result;
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current) return;
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
    cancel: () => reset(),
    /** Rejects the account: ends the attempt and signs its session out. A
     * failure stays retryable (`retrySignOut`) until another sign-in. */
    async signOut(held = credential) {
      reset();
      if (!held || !release) return;
      publish({ status: "pending", checking: true });
      try {
        await release(held);
        if (!attempt && !credential) publish({ status: "signed-out" });
      } catch (error) {
        if (attempt || credential) return;
        releasing =
          error instanceof SignOutIncomplete
            ? { ...held, revision: error.revision }
            : held;
        publish({
          status: "signed-out",
          error: "Couldn't sign out of that account. Try again.",
          retrySignOut: true,
        });
      }
    },
    retrySignOut() {
      return this.signOut(releasing);
    },
  };
}
