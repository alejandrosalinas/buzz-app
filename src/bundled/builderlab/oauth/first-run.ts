import type { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { recoveryMessage } from "../../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../../features/federated-identity/service";
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

/** What first run uses of the NIP-FI session: it never signs out. */
export type FirstRunIdentity = Pick<
  FederatedIdentity,
  "snapshot" | "subscribe" | "signIn" | "cancelSignIn" | "request"
>;

/**
 * First run's Builderlab sign-in (`federatedCredential`). The bundled grant
 * exists only while this plugin is enabled, so with it turned off the
 * account could never be read; refuse before opening the browser instead.
 */
export async function firstRunCredential(
  signal: AbortSignal,
  federated: FirstRunIdentity,
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
  return federatedCredential(federated, signal);
}

// Native rejects with a bare failure code, such as a refused renewal's.
const signIn = (identity: FirstRunIdentity) =>
  identity.signIn().catch((error: unknown) => {
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
    let session = await signIn(identity);
    signal.throwIfAborted();
    // After a failed restore, `signIn` restores again first and answers with
    // the stored session it finds: renew that, so the browser chooses.
    if (
      before.status === "unavailable" &&
      session.status === "signed-in" &&
      !browsed
    ) {
      before = session;
      session = await signIn(identity);
      signal.throwIfAborted();
    }
    // A renewal that is canceled (in the browser, by Cancel, or by a newer
    // sign-in's callback) answers with the session it would have replaced:
    // never continue as it. One that times out rejects (`callback-refused`).
    if (before.status === "signed-in" && session.revision === before.revision)
      throw new Error(recoveryMessage("sign-in-canceled"));
    if (session.status !== "signed-in")
      throw new Error(recoveryMessage(session.failure ?? ""));
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
) {
  let credential: Credential | undefined;
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
  };
}
