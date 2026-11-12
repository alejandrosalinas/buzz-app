// Packaged-desktop Builderlab account backend, mirroring browser-host/builderlab.mjs route for
// route. It uses the plugin's shared Builderlab sign-in; native code owns host HTTP
// and the kind 24243 binding signature.
import { invoke } from "@tauri-apps/api/core";
import type { HostResponse } from "../../../features/host/service";
import { oauthTarget } from "../oauth/browser";
import {
  UNAUTHORIZED,
  type BuilderlabRequest,
  type BuilderlabSession,
  type Credential,
} from "../session";
import { boundKey, type Account, type Backend } from "./api";

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Account routes forwarded with allowlisted string fields only. */
const ROUTES: Record<string, readonly [string, readonly string[]]> = {
  identity: ["/v1/buzz/nostr-identities/current", []],
  unbind: ["/v1/buzz/nostr-identities/delete", []],
  list: ["/v1/buzz/communities/list", []],
  availability: ["/v1/buzz/communities/availability", ["name"]],
  create: ["/v1/buzz/communities", ["name"]],
  archive: ["/v1/buzz/communities/archive", ["community_id"]],
  unarchive: ["/v1/buzz/communities/unarchive", ["community_id"]],
  delete: [
    "/v1/buzz/communities/delete",
    ["community_id", "host", "request_id", "acknowledgement_version"],
  ],
  // Builderlab's transfer endpoint takes camelCase keys.
  transfer: [
    "/v1/buzz/communities/transfer",
    ["communityId", "transfereeNpub"],
  ],
};

type Native = Readonly<{
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}>;
const native: Native = { invoke };

/** Native commands and host HTTP reject with strings; surface them as errors. */
const asError = (error: unknown) =>
  typeof error === "string" ? new Error(error) : error;
const command = <T>(
  bridge: Native,
  name: string,
  args?: Record<string, unknown>,
) =>
  bridge.invoke<T>(name, args).catch((error: unknown) => {
    throw asError(error);
  });

export function createNativeBackend(
  session: BuilderlabSession,
  /** Settles once sign-in's automatic identity link has finished. */
  linked: () => Promise<void>,
  bridge: Native = native,
): Backend {
  const origin = new URL(oauthTarget()).origin;
  const http = (
    credential: Credential,
    input: BuilderlabRequest,
  ): Promise<HostResponse> =>
    session.request(credential, input).catch((error: unknown) => {
      throw asError(error);
    });
  const parse = (body: string) => {
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
      throw new Error("Builderlab response was too large");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Builderlab returned an invalid response");
    }
  };
  // Results from an earlier sign-in never describe or act for the current one.
  const ensureCurrent = (credential: object) => {
    if (
      session.snapshot().status !== "signed-in" ||
      session.credential() !== credential
    )
      throw new Error("Builderlab session changed");
  };
  const request = async (
    path: string,
    body: object,
    credential = session.credential(),
  ): Promise<{ status: number; value: object }> => {
    const response = await http(credential, {
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify(body),
    });
    ensureCurrent(credential);
    if (response.status === 401) throw new Error(UNAUTHORIZED);
    const value = parse(response.body);
    const ok = response.status >= 200 && response.status < 300;
    // Structured `{ error: { code, ... } }` bodies pass through for friendly UI messages.
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (ok || (value as { error?: unknown }).error)
    )
      return { status: response.status, value };
    throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
  };
  const auth = async (): Promise<Account | null> => {
    if (session.snapshot().status !== "signed-in") return null;
    const credential = session.credential();
    // Read the account after sign-in links this device's key, so the
    // identity it then shows is settled.
    await linked();
    ensureCurrent(credential);
    const response = await http(credential, { path: "/v1/auth/me" });
    ensureCurrent(credential);
    if (response.status === 401) return null;
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `Builderlab session check failed with HTTP ${response.status}`,
      );
    const { email, name, expires_at, capabilities } = (parse(response.body) ??
      {}) as {
      email?: unknown;
      name?: unknown;
      expires_at?: unknown;
      capabilities?: { can_delete_buzz_communities?: unknown };
    };
    if (typeof expires_at !== "string")
      throw new Error("Builderlab returned an invalid response");
    return {
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof name === "string" ? { name } : {}),
      expiresAt: expires_at,
      capabilities: {
        can_delete_buzz_communities:
          capabilities?.can_delete_buzz_communities === true,
      },
    };
  };
  const bind = async () => {
    // A sign-out or new sign-in while the challenge or native signature is
    // pending must not let the old credential claim this device's key.
    const credential = session.credential();
    const challenge = await request(
      "/v1/buzz/nostr-identities/challenge",
      { origin },
      credential,
    );
    if ((challenge.value as { error?: unknown }).error) return challenge;
    const {
      challenge_id,
      nonce,
      verification_code,
      origin: challengeOrigin,
      expires_at,
    } = challenge.value as Record<string, unknown>;
    const event = await command<object>(
      bridge,
      "identity_sign_builderlab_binding",
      {
        challenge: {
          challenge_id,
          nonce,
          verification_code,
          origin: challengeOrigin,
          expires_at,
        },
      },
    );
    ensureCurrent(credential);
    const verified = await request(
      "/v1/buzz/nostr-identities/verify",
      { challenge_id, nonce, signed_payload: JSON.stringify(event) },
      credential,
    );
    if (
      verified.status >= 200 &&
      verified.status < 300 &&
      !(verified.value as { error?: unknown }).error
    )
      void bridge.invoke("nsec_backup_retry").catch(() => {});
    return verified;
  };
  const call = (action: string, input?: Record<string, unknown>) => {
    const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;
    if (!route) throw new Error("Unknown Builderlab route");
    const [path, fields] = route;
    const body: Record<string, string | number> = {};
    for (const field of fields) {
      const value = input?.[field];
      if (field === "acknowledgement_version") {
        if (!Number.isInteger(value)) throw new Error(`Missing ${field}`);
        body[field] = value as number;
        continue;
      }
      if (typeof value !== "string" || !value || value.length > 253)
        throw new Error(`Missing ${field}`);
      body[field] = value;
    }
    return request(path, body);
  };
  return {
    origin,
    auth,
    async send(action, body, signal) {
      if (action === "login") {
        await session.ensureSignedIn(signal ?? new AbortController().signal);
        return { status: 200, value: { auth: await auth() } };
      }
      if (action === "sign-out") {
        session.signOut();
        return { status: 200, value: {} };
      }
      if (action === "bind") return bind();
      return call(action, body);
    },
    async localKey() {
      try {
        const viewer = await command<string | null>(bridge, "identity_restore");
        return boundKey(viewer ? { pubkey_hex: viewer } : null);
      } catch {
        return null;
      }
    },
  };
}
