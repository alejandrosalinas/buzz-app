import { invoke, isTauri } from "@tauri-apps/api/core";
import { SIGN_IN_TIMED_OUT } from "../../../features/federated-identity/CommunitySignIn";
import type { Host } from "../../../features/host/service";

export const browserLoginAvailable = () => isTauri();

/** The configured HTTPS origin is granted to this plugin at build time. */
export function oauthTarget(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Builderlab sign-in is not configured for this Buzz build.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "This Buzz build does not support the configured Builderlab sign-in address.",
    );
  return `${url.href.replace(/\/$/, "")}/api/goose`;
}

export type Credential = Readonly<{
  value: string;
  account: Readonly<{
    subject: string;
    email: string;
    canUseRemoteAgents: boolean;
    canUseBuilderlabDecisions: boolean;
    /** The account hasn't finished Builderlab's account setup (name, birthday, country). */
    needsDetails?: boolean;
  }>;
}>;

export type OAuthCallback = Readonly<{
  parameters: readonly (readonly [string, string])[];
}>;
export type BrowserBridge = {
  begin(options: {
    authorizationUrl: string;
    callbackPath: string;
    useState?: boolean;
  }): Promise<{ id: string; callbackUrl: string }>;
  wait(id: string): Promise<OAuthCallback>;
  cancel(id: string): Promise<void>;
  complete(id: string): Promise<void>;
};
const nativeBridge: BrowserBridge = {
  begin: (options) => invoke("oauth_callback_begin", options),
  wait: (id) => invoke("oauth_callback_wait", { id }),
  cancel: (id) => invoke("oauth_callback_cancel", { id }),
  complete: (id) => invoke("oauth_callback_complete", { id }),
};

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Acquire and verify a credential. No UI, storage, or authenticated API consumers. */
export async function browserCredential(
  host: Host,
  signal: AbortSignal,
  bridge: BrowserBridge = nativeBridge,
  /** Opens the create-account page rather than sign-in. */
  signup = false,
): Promise<Credential> {
  signal.throwIfAborted();
  const target = oauthTarget();
  let id: string | undefined;
  let completion: Promise<void> | undefined;
  const path = `/callback/${crypto.randomUUID()}`;
  const login = new URL(`${target}/v1/auth/login`);
  const cancel = () => {
    if (id) void bridge.cancel(id).catch(() => {});
  };
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    signal.throwIfAborted();
    login.search = new URLSearchParams({
      type: "cli",
      product: "buzz",
      code_challenge: base64url(new Uint8Array(digest)),
      code_challenge_method: "S256",
      ...(signup ? { screen_hint: "signup" } : {}),
    }).toString();
    const attempt = await bridge.begin({
      authorizationUrl: login.href,
      callbackPath: path,
      useState: true,
    });
    id = attempt.id;
    signal.addEventListener("abort", cancel, { once: true });
    signal.throwIfAborted();
    const response = await bridge.wait(id);
    signal.throwIfAborted();
    const parameters = new URLSearchParams(
      response.parameters.map(([name, value]) => [name, value]),
    );
    if (parameters.has("error"))
      throw new Error("Browser sign-in failed. Try again.");
    const codes = parameters.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || !code || code.length > 4096)
      throw new Error("Invalid Builderlab callback code.");
    const request = async (
      path: string,
      credential?: string,
      body?: string,
    ) => {
      signal.throwIfAborted();
      const response = await host.request({
        url: `${target}${path}`,
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(credential ? { "X-BB-Session-Credential": credential } : {}),
        },
        ...(body ? { body } : {}),
      });
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `Builderlab sign-in failed (HTTP ${response.status}). Try again.`,
        );
      try {
        return JSON.parse(response.body);
      } catch {
        throw new Error("Builderlab returned an invalid sign-in response.");
      }
    };
    const exchange = await request(
      "/v1/auth/login/exchange",
      undefined,
      JSON.stringify({ code, code_verifier: verifier }),
    );
    const session_credential = exchange?.session_credential;
    if (
      typeof session_credential !== "string" ||
      !session_credential ||
      session_credential.length > 4096 ||
      [...session_credential].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) > 126,
      )
    )
      throw new Error("Builderlab did not return a valid credential.");
    const account = await request("/v1/auth/me", session_credential);
    if (typeof account?.subject !== "string" || !account.subject.trim())
      throw new Error("Builderlab did not return a valid account.");
    signal.throwIfAborted();
    // Focus return is best effort and must not delay verified login.
    completion = bridge.complete(id).catch(() => {});
    return Object.freeze({
      value: session_credential,
      account: Object.freeze({
        subject: account.subject,
        email: typeof account.email === "string" ? account.email.trim() : "",
        canUseRemoteAgents:
          account.capabilities?.can_use_remote_agents === true,
        canUseBuilderlabDecisions:
          account.capabilities?.can_use_builderlab_decisions === true,
        needsDetails: account.account_status === "ACCOUNT_STATUS_NEEDS_DETAILS",
      }),
    });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    // Native errors are strings. Never forward provider bodies or credentials;
    // a timeout keeps its message so the person can pick up where they left off.
    if (error === SIGN_IN_TIMED_OUT) throw new Error(SIGN_IN_TIMED_OUT);
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  } finally {
    signal.removeEventListener("abort", cancel);
    // Canceling before completion settles would retire its focus permission.
    if (completion) void completion.then(cancel);
    else if (id) await bridge.cancel(id);
  }
}
