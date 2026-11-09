// Dev-only Builderlab account broker for the Hosted communities plugin, mirroring
// block/buzz desktop's builderlab.rs. The session credential and the signing key stay
// in this Node process; the page only sees account metadata and API results.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync, openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import { finalizeEvent } from "nostr-tools";

const API = "https://app.builderlab.xyz/api/goose";
// Builderlab checks Origin on identity binding; it also seeds the challenge origin.
export const BUILDERLAB_ORIGIN = "https://app.builderlab.xyz";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_STATUS = Symbol("builderlabResponseStatus");
// Use the agents' callback page and assets, without a second visual implementation.
const callbackRoot = new URL(
  "../src-tauri/src/oauth_callback/",
  import.meta.url,
);
function callbackPage(status) {
  const read = (name) => readFileSync(new URL(name, callbackRoot));
  const style = read("page.css")
    .toString()
    .replace("{{font}}", read("inter-latin.woff2").toString("base64"));
  const script = read("page.js").toString();
  const hash = (value) => createHash("sha256").update(value).digest("base64");
  return {
    body: read("page.html")
      .toString()
      .replace("<!-- {{style}} -->", `<style>${style}</style>`)
      .replace("<!-- {{script}} -->", `<script>${script}</script>`)
      .replace(
        "<!-- {{pageBrand}} -->",
        read("brand.html")
          .toString()
          .replace(
            "{{mark}}",
            readFileSync(
              new URL("../public/builderlab-mark.svg", import.meta.url),
            ).toString(),
          )
          .replace("{{label}}", ""),
      )
      .replace("<!-- {{cardBrand}} -->", "")
      .replace(
        "<!-- {{artwork}} -->",
        read("artwork.html")
          .toString()
          .replace("{{artwork}}", read("cubes.webp").toString("base64")),
      )
      .replace("<!-- {{closeHint}} -->", read("close-hint.html").toString())
      .replaceAll("{{provider}}", "Builderlab")
      .replaceAll("{{complete}}", status === 200 ? "true" : "false")
      .replaceAll("{{closeDelay}}", "3")
      .replace(
        "{{heading}}",
        status === 200 ? "Signing you in…" : "Sign-in needs attention",
      )
      .replace(
        "{{message}}",
        status === 200 ? "" : "Return to Buzz to retry sign-in.",
      ),
    policy: `default-src 'none'; img-src data:; font-src data:; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(script)}'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/** Account routes forwarded with allowlisted string fields only. */
const ROUTES = {
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

/** Upstream status is metadata, not part of the public JSON body. */
export const builderlabResponseStatus = (value) =>
  value?.[RESPONSE_STATUS] ?? 200;

/** Signs the kind 24243 challenge exactly as block/buzz desktop does, after the same checks. */
export function bindingEvent(
  key,
  challenge,
  now = Date.now(),
  expectedOrigin = BUILDERLAB_ORIGIN,
) {
  const { challenge_id, nonce, verification_code, origin, expires_at } =
    challenge ?? {};
  if (
    typeof challenge_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      challenge_id,
    ) ||
    typeof nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    typeof verification_code !== "string" ||
    !/^\d{6}$/.test(verification_code) ||
    origin !== expectedOrigin ||
    typeof expires_at !== "string" ||
    !(Date.parse(expires_at) > now)
  )
    throw new Error("Invalid Nostr identity challenge");
  return finalizeEvent(
    {
      kind: 24243,
      content: "",
      created_at: Math.floor(now / 1000),
      tags: [
        ["challenge_id", challenge_id],
        ["nonce", nonce],
        ["verification_code", verification_code],
        ["audience", "buzz:nostr-identity"],
        ["action", "bind_nostr_identity"],
        ["protocol", "buzz-nostr-identity"],
        ["version", "1"],
        ["origin", origin],
        ["expires_at", expires_at],
      ],
    },
    key,
  );
}

const openBrowser = (url) =>
  new Promise((resolve, reject) =>
    execFile(
      process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      [url],
      (error) => (error ? reject(error) : resolve()),
    ),
  );

/** Waits for one loopback redirect carrying `code`, like the desktop callback listener. */
function awaitCallback(signal, open, api, verifier) {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID().replaceAll("-", "");
    const state = randomUUID();
    let settle;
    let settled = false;
    const server = createServer((req, res) => {
      let url;
      try {
        // Only origin-form targets; anything else is rejected without ending the listener.
        if (!req.url?.startsWith("/") || req.url.startsWith("//"))
          throw new Error("Bad request target");
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("Bad request");
        return;
      }
      if (settled || url.pathname !== `/callback/${nonce}`) {
        res.writeHead(404).end("Not found");
        return;
      }
      const codes = url.searchParams.getAll("code");
      if (
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== state ||
        (!url.searchParams.has("error") &&
          (codes.length !== 1 || !codes[0] || codes[0].length > 4096))
      ) {
        res.writeHead(400).end("Invalid callback");
        return;
      }
      const failed = url.searchParams.has("error");
      const page = callbackPage(failed ? 400 : 200);
      res
        .writeHead(failed ? 400 : 200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": page.policy,
        })
        .end(page.body);
      settle(
        failed ? new Error("Browser sign-in failed. Try again.") : null,
        codes[0],
      );
    });
    const timer = setTimeout(
      () => settle(new Error("Builderlab authentication timed out")),
      LOGIN_TIMEOUT_MS,
    );
    const abort = () => settle(new Error("Builderlab authentication canceled"));
    settle = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(code);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    server.once("error", (error) => settle(error));
    server.listen(0, "127.0.0.1", () => {
      const returnTo = `http://127.0.0.1:${server.address().port}/callback/${nonce}`;
      const login = new URL(`${api}/v1/auth/login`);
      login.searchParams.set("type", "cli");
      login.searchParams.set("product", "buzz");
      login.searchParams.set("state", state);
      login.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      login.searchParams.set("code_challenge_method", "S256");
      login.searchParams.set("redirect_uri", returnTo);
      open(login.href).catch((error) => settle(error));
    });
  });
}

// Only literal true grants a capability; sign-in and capability checks share this.
const capabilityFlags = (capabilities) => ({
  can_use_remote_agents: capabilities?.can_use_remote_agents === true,
  can_use_builderlab_decisions:
    capabilities?.can_use_builderlab_decisions === true,
  can_delete_buzz_communities:
    capabilities?.can_delete_buzz_communities === true,
});

export function createBuilderlab({
  key,
  fetch = globalThis.fetch,
  open = openBrowser,
  api = API,
  appsBase,
}) {
  let credential;
  let account;
  let capabilitiesCheckedAt;
  let capabilityRead;
  let pending = false;
  let loginError;
  let linking = Promise.resolve();
  let expiry;
  let revision = randomUUID();
  const listeners = new Set();
  const snapshot = () => ({
    revision,
    pending,
    auth: account ?? null,
    capabilitiesCheckedAt,
    ...(loginError ? { error: loginError } : {}),
  });
  const notify = () => {
    for (const listener of listeners) listener(snapshot());
  };
  const current = (expected) => {
    if (!credential || expected !== revision)
      throw new Error("Builderlab session changed");
  };
  const request = async (path, body, session = credential) => {
    if (!session) throw new Error("Sign in to Builderlab first");
    const started = generation;
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-Session-Credential": session,
        Origin: new URL(api).origin,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (started !== generation) throw new Error("Builderlab session changed");
    if (response.status === 401) revoke();
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new Error("Builderlab response was too large");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Builderlab returned an invalid response");
    }
    // Structured `{ error: { code, ... } }` bodies pass through for friendly UI messages.
    if (value && typeof value === "object" && (response.ok || value.error)) {
      Object.defineProperty(value, RESPONSE_STATUS, {
        value: response.status,
        enumerable: false,
      });
      return value;
    }
    throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
  };
  const me = async (session, signal, capabilitiesOnly = false) => {
    const started = generation;
    const response = await fetch(`${api}/v1/auth/me`, {
      headers: { "X-BB-Session-Credential": session },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) {
      if (
        response.status === 401 &&
        !capabilitiesOnly &&
        started === generation &&
        credential === session
      )
        revoke();
      throw new Error(
        `Builderlab session check failed with HTTP ${response.status}`,
      );
    }
    if (capabilitiesOnly) {
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Builderlab returned invalid capabilities");
      const { capabilities } = value;
      if (
        capabilities !== undefined &&
        (!capabilities ||
          typeof capabilities !== "object" ||
          Array.isArray(capabilities))
      )
        throw new Error("Builderlab returned invalid capabilities");
      return {
        capabilities: capabilityFlags(capabilities),
      };
    }
    const { subject, email, name, expires_at, capabilities } =
      await response.json();
    if (
      typeof subject !== "string" ||
      !subject.trim() ||
      !Number.isFinite(Date.parse(expires_at))
    )
      throw new Error("Builderlab returned an invalid account");
    return {
      subject,
      email,
      name,
      expiresAt: expires_at,
      capabilities: capabilityFlags(capabilities),
    };
  };
  // Sign-in and sign-out bump the generation; late results from an older one never
  // write, clear or describe the current session.
  let generation = 0;
  let session;
  const revoke = (announce = true) => {
    generation += 1;
    revision = randomUUID();
    clearTimeout(expiry);
    pending = false;
    loginError = undefined;
    account = undefined;
    capabilitiesCheckedAt = undefined;
    capabilityRead = undefined;
    session?.abort();
    session = new AbortController();
    credential = undefined;
    if (announce) notify();
  };
  revoke();
  const signOut = (announce = true) => {
    const previous = credential;
    revoke(announce);
    if (previous)
      void fetch(`${api}/v1/auth/logout`, {
        method: "POST",
        headers: { "X-BB-Session-Credential": previous },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      }).catch(() => {});
  };
  const publishAccount = (value) => {
    account = value;
    capabilitiesCheckedAt = Date.now();
    notify();
  };
  const broker = {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async capabilities(expected) {
      current(expected);
      if (capabilityRead) return capabilityRead;
      const started = generation;
      const checkedAt = Date.now();
      capabilityRead = (async () => {
        try {
          const result = await me(credential, session.signal, true);
          if (started !== generation)
            throw new Error("Builderlab session changed");
          // Restored pages retain refreshed flags without changing the sign-in profile.
          account = { ...account, capabilities: result.capabilities };
          return { revision, ...result };
        } finally {
          if (started === generation) {
            capabilitiesCheckedAt = checkedAt;
            capabilityRead = undefined;
          }
        }
      })();
      return capabilityRead;
    },
    async auth() {
      const current = credential;
      if (!current) return null;
      const started = generation;
      // Transport failures do not revoke a valid shared sign-in.
      await linking;
      const account = await me(current, session.signal);
      if (started !== generation) throw new Error("Builderlab session changed");
      return account;
    },
    async login(signal) {
      signOut(false);
      const started = generation;
      pending = true;
      notify();
      const attempt = signal
        ? AbortSignal.any([signal, session.signal])
        : session.signal;
      let loginCredential;
      try {
        const verifier = randomBytes(32).toString("base64url");
        const code = await awaitCallback(attempt, open, api, verifier);
        const response = await fetch(`${api}/v1/auth/login/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier }),
          redirect: "error",
          signal: AbortSignal.any([attempt, AbortSignal.timeout(30000)]),
        });
        if (!response.ok)
          throw new Error(
            `Builderlab code exchange failed with HTTP ${response.status}`,
          );
        const exchanged = await response.json();
        if (
          typeof exchanged.session_credential !== "string" ||
          !exchanged.session_credential ||
          exchanged.session_credential.length > 4096 ||
          [...exchanged.session_credential].some(
            (character) =>
              character.charCodeAt(0) <= 32 || character.charCodeAt(0) > 126,
          )
        )
          throw new Error(
            "Builderlab code exchange returned an empty credential",
          );
        loginCredential = exchanged.session_credential;
        const account = await me(loginCredential, attempt);
        if (account.expiresAt !== exchanged.expires_at)
          throw new Error(
            "Builderlab session expiry did not match code exchange",
          );
        if (attempt.aborted || started !== generation)
          throw new Error("Builderlab authentication canceled");
        credential = exchanged.session_credential;
        const delay = Date.parse(account.expiresAt) - Date.now();
        if (delay <= 0) throw new Error("Builderlab sign-in expired");
        expiry = setTimeout(revoke, Math.min(delay, 2_147_483_647));
        expiry.unref?.();
        // Bind before subsequent remote-agent operations.
        void broker.bind();
        if (started !== generation)
          throw new Error("Builderlab session changed");
        publishAccount(account);
        return account;
      } catch (error) {
        const message = (
          error instanceof Error ? error.message : "Builderlab sign-in failed"
        ).replaceAll(loginCredential || "\u0000", "[redacted]");
        if (started === generation) {
          const canceled = attempt.aborted;
          revoke(false);
          loginError = canceled ? undefined : message;
          notify();
        }
        throw new Error(message);
      } finally {
        if (started === generation) {
          pending = false;
          notify();
        }
      }
    },

    signOut,
    // Only the broker's fixed viewer/Decisions handlers opt into native routes.
    async request(input, signal, native = false) {
      // Activation must not overtake the sign-in's automatic key binding.
      if (
        typeof input.path === "string" &&
        input.path.startsWith("/v3/beekeeper/")
      )
        await linking;
      current(input.revision);
      const started = generation;
      const secret = credential;
      const apps = input.target === "apps";
      if (apps && !appsBase)
        throw new Error(
          "Apps are not configured for this Builderlab environment",
        );
      const base = new URL(apps ? appsBase : api);
      const prefix = base.pathname.replace(/\/$/, "");
      let url;
      try {
        if (
          typeof input.path !== "string" ||
          !input.path.startsWith("/") ||
          input.path.startsWith("//") ||
          input.path.includes("#") ||
          input.path.includes("\\")
        )
          throw new Error();
        url = new URL(`${base.href.replace(/\/$/, "")}${input.path}`);
      } catch {
        throw new Error("Unsupported Builderlab request");
      }
      const path = url.pathname.slice(prefix.length);
      if (
        url.origin !== base.origin ||
        !url.pathname.startsWith(`${prefix}/`) ||
        !(native
          ? !apps &&
            [
              "/v3/builderlab/decisions",
              "/v1/auth/hosted-site/native-session",
            ].includes(path)
          : apps
            ? /^\/v1\/agent\//.test(path)
            : /^\/(?:v3\/beekeeper\/|v1\/buzz\/known-communities\/(?:list|add|remove)$)/.test(
                path,
              ))
      )
        throw new Error("Unsupported Builderlab request");
      const method = input.method ?? "GET";
      if (
        !(apps ? ["GET", "POST", "PUT", "DELETE"] : ["GET", "POST"]).includes(
          method,
        )
      )
        throw new Error("Unsupported Builderlab method");
      const headers = {
        Accept: "application/json",
        ...(apps
          ? {
              Authorization: `BBIdentity ${secret}`,
              "X-Hotpod-Agent-Client-Version": "0.2.0",
            }
          : { "X-BB-Session-Credential": secret, Origin: new URL(api).origin }),
      };
      if (path === "/v3/builderlab/decisions") {
        if (
          typeof input.community !== "string" ||
          !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(input.community) ||
          input.community.length > 253
        )
          throw new Error("Invalid decision community");
        headers["X-Buzz-Community"] = input.community;
      }
      let body = input.body;
      if (input.file) {
        if (
          !apps ||
          !/^\/v1\/agent\/apps\/[A-Za-z0-9_-]+\/deploy$/.test(path) ||
          method !== "POST"
        )
          throw new Error("Unsupported Apps upload");
        const home = await realpath(homedir());
        const file = await realpath(input.file);
        if (
          file !== input.file ||
          !file.startsWith(`${home}${sep}`) ||
          !file.endsWith(".tar.gz") ||
          !(await stat(file)).isFile() ||
          (await stat(file)).size > 100 * 1024 * 1024
        )
          throw new Error(
            "Apps artifact must be a .tar.gz file under home, at most 100 MB",
          );
        body = new FormData();
        body.set(
          "artifact",
          await openAsBlob(file, { type: "application/gzip" }),
          "artifact.tar.gz",
        );
      } else if (body !== undefined) {
        if (typeof body !== "string")
          throw new Error("Invalid Builderlab body");
        headers["Content-Type"] = "application/json";
      }
      current(input.revision);
      const response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          // A dispatched upload keeps its receipt after sign-out/account switch.
          ...(input.file ? [] : [session.signal]),
          AbortSignal.timeout(
            input.file || path.endsWith("/initialize") ? 180000 : 60000,
          ),
        ]),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 16 * 1024 * 1024)
        throw new Error("Builderlab response was too large");
      if (started !== generation && !input.file)
        throw new Error("Builderlab session changed");
      if (response.status === 401 && started === generation && !apps) revoke();
      return {
        status: response.status,
        headers: {},
        body: text.replaceAll(secret, "[redacted]"),
      };
    },
    bind() {
      const done = (async () => {
        const session = credential;
        const started = generation;
        const challenge = await request(
          "/v1/buzz/nostr-identities/challenge",
          { origin: new URL(api).origin },
          session,
        );
        if (challenge.error) return challenge;
        // A sign-out or new sign-in while the challenge was pending must not let the
        // old credential claim this device's key.
        if (started !== generation)
          throw new Error("Builderlab session changed");
        const event = bindingEvent(
          key(),
          challenge,
          Date.now(),
          new URL(api).origin,
        );
        return request(
          "/v1/buzz/nostr-identities/verify",
          {
            challenge_id: challenge.challenge_id,
            nonce: challenge.nonce,
            signed_payload: JSON.stringify(event),
          },
          session,
        );
      })();
      // Every attempt, including a manual retry, replaces the previous result.
      linking = done.catch(() => {});
      return done;
    },
    async call(action, input) {
      const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;
      if (!route) return undefined;
      const [path, fields] = route;
      const body = {};
      for (const field of fields) {
        const value = input?.[field];
        if (field === "acknowledgement_version") {
          if (!Number.isInteger(value)) throw new Error(`Missing ${field}`);
          body[field] = value;
          continue;
        }
        if (typeof value !== "string" || !value || value.length > 253)
          throw new Error(`Missing ${field}`);
        body[field] = value;
      }
      return request(path, body);
    },
  };
  return broker;
}
