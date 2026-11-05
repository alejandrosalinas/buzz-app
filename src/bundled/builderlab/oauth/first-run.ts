import type { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { recoveryMessage } from "../../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../../features/federated-identity/service";
import type { Host } from "../../../features/host/service";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import { federatedAccount } from "../session";
import { browserCredential, type Credential } from "./browser";

/**
 * First launch runs before this plugin can share its Settings session, so the
 * welcome screen signs in through the same OAuth client under the bundled
 * plugin's own native network grant. Native code grants that origin at build
 * time; it does not depend on the plugin's JavaScript having started.
 */
export const bundledHost: Host = {
  runCommand: () => Promise.resolve(null),
  request: (request) =>
    invoke("plugin_host_request", {
      id: manifest.id,
      revision: "bundled",
      request,
    }),
};

/**
 * The NIP-FI session as the bundled plugin's installation calls it. An FI
 * build grants that installation the native forwarder instead of network
 * origins, and native admission checks only that grant, so first run can
 * use it whether or not the plugin's JavaScript has started, as
 * `bundledHost` does.
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
 * The bundled grant exists only while this plugin is enabled, so with it
 * turned off the browser sign-in could finish but never exchange its code.
 * Refuse before opening the browser instead. With `federated`, an FI build's
 * sign-in: see `federatedCredential`.
 */
export async function firstRunCredential(
  signal: AbortSignal,
  federated?: FirstRunIdentity,
  /** Open the create-account page; an FI build's native sign-in has one page. */
  signup = false,
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
  return federated
    ? federatedCredential(federated, signal)
    : browserCredential(bundledHost, signal, undefined, signup);
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
 * restores, signs in again, so the browser can choose the account. The
 * credential's value is the session's public revision, which first run's
 * later calls are fenced to (`federatedBuilderlabAccount`).
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
    return Object.freeze({ value: session.revision, account });
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
