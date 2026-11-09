import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../../bundled/builderlab/session";
import type { HostRequest, HostResponse } from "../host/service";
import { BackupError, type BackupStatus, createBackupStatus } from "./backup";
import { BACKUP_FAILURES } from "./backup-failure";
import { oauthTarget } from "../../bundled/builderlab/oauth/browser";
import {
  federatedFixture,
  forwardingSession,
} from "../federated-identity/testing";
import {
  backupOfferedFor,
  federatedBuilderlabAccount,
  seededAccount,
} from "./builderlab-account";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));

const credential: Credential = {
  revision: "revision-1",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: false,
    canUseBuilderlabDecisions: false,
  },
};
const pubkey = "ab".repeat(32);
const answer = (status: number, body: unknown) => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});
/** kgoose puts one on every identity and community route reply, error or not. */
const correlationId = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
/** kgoose's error reply: its code, its own message and the correlation ID. */
const refusal = (status: number, code: string) =>
  answer(status, {
    error: { code, message: "kgoose's own wording" },
    correlation_id: correlationId,
  });
/** misk's answer to a lapsed session on any `@Authenticated` route. */
const lapsed = answer(401, "Unauthenticated");
const signedOut = "Your Builderlab sign-in is no longer valid.";
/** One request stub per call, in order; remembers what was sent. */
function kgoose(...replies: Array<ReturnType<typeof answer> | Error | string>) {
  const sent: HostRequest[] = [];
  const request = vi.fn(async (input: HostRequest) => {
    sent.push(input);
    const reply = replies.shift();
    if (reply === undefined) throw new Error("No reply scripted");
    if (reply instanceof Error || typeof reply === "string") throw reply;
    return reply;
  });
  return { request, sent };
}
type BackupIdentity = Parameters<typeof federatedBuilderlabAccount>[2];
/** The account over a signed-in session whose forwarder sends each call
 * through `request`, at the URL native would call for the build. */
const forwardedAccount = (
  signedIn: Credential,
  request: (input: HostRequest) => Promise<HostResponse>,
  identity: BackupIdentity,
) =>
  federatedBuilderlabAccount(
    signedIn,
    forwardingSession(
      signedIn.revision,
      request,
      new URL(oauthTarget()).origin,
    ),
    identity,
  );
/** Only Restore from backup drives native recovery. */
const noRecovery = {
  subscribe: () => {
    throw new Error("Watched the identity");
  },
  snapshot: () => {
    throw new Error("Read the identity");
  },
  beginRecovery: () => {
    throw new Error("Began recovery");
  },
  installRecovery: () => {
    throw new Error("Installed a recovered key");
  },
  cancelRecovery: () => {
    throw new Error("Canceled recovery");
  },
} satisfies Omit<BackupIdentity, "backup" | "setBackupChoice">;
/** The reads and binding never touch the backup status or consent. */
const untouched: BackupIdentity = {
  ...noRecovery,
  backup: createBackupStatus(() => {
    throw new Error("Read the backup status");
  }),
  setBackupChoice: () => {
    throw new Error("Wrote backup consent");
  },
};
// The trailing slash checks that routes and Origin use the canonical origin.
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://t.example/");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

describe("linkedKey", () => {
  it("POSTs the card's identity route at the build URL through the NIP-FI forwarder and reads the bound key", async () => {
    const { request, sent } = kgoose(
      answer(200, {
        identity: { npub: "npub1x", pubkey_hex: pubkey },
        correlation_id: correlationId,
      }),
    );
    const account = forwardedAccount(credential, request, untouched);
    expect(await account.linkedKey()).toBe(pubkey);
    expect(sent).toEqual([
      {
        url: "https://t.example/api/goose/v1/buzz/nostr-identities/current",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://t.example",
        },
        body: "{}",
      },
    ]);
  });

  // kgoose's `current` answers 200 with `identity` null or absent for an
  // account with no mapping; MISSING_MAPPING is the list route's shape, kept
  // for symmetry.
  it.each([
    [
      "a 200 with identity null",
      answer(200, { identity: null, correlation_id: correlationId }),
    ],
    ["a 200 with no identity", answer(200, { correlation_id: correlationId })],
    [
      "a 400 MISSING_MAPPING",
      answer(400, { error: { code: "MISSING_MAPPING" } }),
    ],
    [
      "a 400 setup_needed",
      answer(400, { error: { code: "other", setup_needed: true } }),
    ],
  ])("reads %s as not linked", async (_label, reply) => {
    const { request } = kgoose(reply);
    const account = forwardedAccount(credential, request, untouched);
    expect(await account.linkedKey()).toBeNull();
  });

  it.each([
    [
      "an account without the USER role",
      refusal(403, "unauthorized"),
      "This Builderlab account can't manage Buzz identities right now. Try signing in again.",
    ],
    ["a lapsed session", lapsed, signedOut],
    [
      "a bound identity without a usable key",
      answer(200, { identity: { npub: "npub1x" } }),
      "Builderlab account check failed (HTTP 200: unusable linked key).",
    ],
    [
      "a bound identity with a malformed key",
      answer(200, { identity: { pubkey_hex: "not-hex" } }),
      "Builderlab account check failed (HTTP 200: unusable linked key).",
    ],
    [
      "a non-JSON failure",
      answer(403, "Forbidden"),
      "Builderlab account check failed (HTTP 403: not JSON).",
    ],
    [
      "an unstructured failure",
      answer(500, { message: "boom" }),
      "Builderlab account check failed (HTTP 500).",
    ],
    [
      "a malformed error code",
      answer(400, { error: { code: 42 } }),
      "Could not check this Builderlab account.",
    ],
    [
      "an oversize body",
      answer(200, `{"identity":{"pubkey_hex":"${"a".repeat(70_000)}"}}`),
      "Builderlab account check failed (HTTP 200: response too large).",
    ],
    ["a native refusal string", "host request denied", /host request denied/],
    ["a transport error", new Error("offline"), /offline/],
  ])("fails on %s instead of answering", async (_label, reply, message) => {
    const { request } = kgoose(reply);
    const account = forwardedAccount(credential, request, untouched);
    await expect(account.linkedKey()).rejects.toThrow(message);
  });

  it("warns in development with the route and status, never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request } = kgoose(answer(403, "secret body"));
    const account = forwardedAccount(credential, request, untouched);
    await expect(account.linkedKey()).rejects.toThrow(/HTTP 403/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toBe(
      "Builderlab account check: POST /v1/buzz/nostr-identities/current answered HTTP 403 Builderlab account check failed (HTTP 403: not JSON).",
    );
    expect(warn.mock.calls[0]?.join(" ")).not.toContain("secret body");
  });
});

describe("communityList", () => {
  it("lists joinable hosts from the card's list route, skipping archived and unusable rows", async () => {
    const { request, sent } = kgoose(
      answer(200, {
        communities: [
          { id: "1", normalized_host: "wss://Design.Example.com" },
          { id: "2", normalized_host: "buzz.example.org:8443" },
          {
            id: "3",
            normalized_host: "old.example.org",
            archived_at: "2026-01-01T00:00:00Z",
          },
          { id: "4", normalized_host: "" },
          { id: "5", normalized_host: "bad host/with/path" },
          { id: "6" },
        ],
      }),
    );
    const account = forwardedAccount(credential, request, untouched);
    expect((await account.communityList()).owned).toEqual([
      { host: "design.example.com", url: "https://design.example.com" },
      { host: "buzz.example.org:8443", url: "https://buzz.example.org:8443" },
    ]);
    expect(sent[0]?.url).toBe(
      "https://t.example/api/goose/v1/buzz/communities/list",
    );
  });

  it("answers an unlinked account with no communities and fails on other errors", async () => {
    const unlinked = forwardedAccount(
      credential,
      kgoose(answer(400, { error: { code: "missing_mapping" } })).request,
      untouched,
    );
    expect(await unlinked.communityList()).toEqual({
      owned: [],
      canCreate: false,
      quotaLimit: undefined,
    });
    const failing = forwardedAccount(
      credential,
      kgoose(answer(503, { error: { code: "relay_unavailable" } })).request,
      untouched,
    );
    await expect(failing.communityList()).rejects.toThrow(
      /temporarily unavailable/,
    );
    const unparseable = forwardedAccount(
      credential,
      kgoose(answer(502, "<html>bad gateway</html>")).request,
      untouched,
    );
    await expect(unparseable.communityList()).rejects.toThrow(
      "Builderlab community list failed (HTTP 502: not JSON).",
    );
  });
});

describe("hosted community creation", () => {
  const listed = (quota: object) => answer(200, { communities: [], ...quota });
  const create = (reply: ReturnType<typeof answer>) =>
    forwardedAccount(credential, kgoose(reply).request, untouched);

  it("allows creation within the list's quota, and lets a list with no readable quota through as the card does", async () => {
    expect(
      await create(
        listed({ quota_used: 0, quota_limit: 2, can_create: true }),
      ).communityList(),
    ).toEqual({ owned: [], canCreate: true, quotaLimit: 2 });
    expect(await create(listed({})).communityList()).toEqual({
      owned: [],
      canCreate: true,
      quotaLimit: undefined,
    });
  });

  it("refuses at the quota's limit", async () => {
    expect(
      await create(
        listed({ quota_used: 1, quota_limit: 1, can_create: false }),
      ).communityList(),
    ).toEqual({ owned: [], canCreate: false, quotaLimit: 1 });
  });

  it("checks and creates an address through the card's routes, resolving the origin a join uses", async () => {
    const { request, sent } = kgoose(
      answer(200, { available: true }),
      answer(200, {
        community: {
          id: "1",
          normalized_host: "north-star.communities.buzz.xyz",
        },
      }),
    );
    const account = forwardedAccount(credential, request, untouched);
    expect(await account.communityAvailable("north-star")).toBe(true);
    expect(await account.createCommunity("north-star")).toBe(
      "https://north-star.communities.buzz.xyz",
    );
    expect(sent.map(({ url, body }) => [url, body])).toEqual([
      [
        "https://t.example/api/goose/v1/buzz/communities/availability",
        '{"name":"north-star"}',
      ],
      [
        "https://t.example/api/goose/v1/buzz/communities",
        '{"name":"north-star"}',
      ],
    ]);
  });

  it("refuses with the card's copy", async () => {
    const account = forwardedAccount(
      credential,
      kgoose(
        refusal(409, "taken"),
        refusal(400, "missing_mapping"),
        answer(200, { community: {} }),
      ).request,
      untouched,
    );
    await expect(account.createCommunity("north-star")).rejects.toThrow(
      "That Buzz address is already taken.",
    );
    await expect(account.communityAvailable("north-star")).rejects.toThrow(
      "Connect your Buzz identity before creating a community.",
    );
    await expect(account.createCommunity("north-star")).rejects.toThrow(
      "Builderlab community create failed (HTTP 200: no community address).",
    );
  });

  it("words a limit refusal with the list's quota, as the card does", async () => {
    const account = forwardedAccount(
      credential,
      kgoose(refusal(409, "limit_reached"), refusal(409, "limit_reached"))
        .request,
      untouched,
    );
    await expect(account.createCommunity("north-star", 3)).rejects.toThrow(
      "You've reached your limit of 3 communities.",
    );
    await expect(account.createCommunity("north-star")).rejects.toThrow(
      "You've reached your community limit.",
    );
  });
});

describe("knownCommunities", () => {
  it("POSTs the plugin's list route at the build URL through the NIP-FI forwarder and reads the saved destinations in the device's spelling", async () => {
    const { request, sent } = kgoose(
      answer(200, {
        communities: [
          { community_url: "wss://Design.Example.com/" },
          { community_url: "wss://buzz.example.org:8443" },
          // Rows this device could never save are dropped, as the sync drops them.
          { community_url: "ws://plain.example" },
          { community_url: "wss://bad host" },
          { community_url: "wss://with.example/path" },
        ],
      }),
    );
    const account = forwardedAccount(credential, request, untouched);
    expect(await account.knownCommunities()).toEqual([
      "wss://design.example.com",
      "wss://buzz.example.org:8443",
    ]);
    expect(sent).toEqual([
      {
        url: "https://t.example/api/goose/v1/buzz/known-communities/list",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://t.example",
        },
        body: "{}",
      },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads an omitted list as empty", async () => {
    const { request } = kgoose(answer(200, {}));
    expect(
      await forwardedAccount(credential, request, untouched).knownCommunities(),
    ).toEqual([]);
  });

  // kgoose holds about 1,000 destinations; the card's 64 KiB cap is not this list's.
  it("reads a full account's list past the card's response cap", async () => {
    const urls = Array.from(
      { length: 1000 },
      (_, index) =>
        `wss://community-${String(index).padStart(4, "0")}.buzz.block.builderlab.example.com`,
    );
    const reply = answer(200, {
      communities: urls.map((community_url) => ({ community_url })),
    });
    expect(new TextEncoder().encode(reply.body).byteLength).toBeGreaterThan(
      64 * 1024,
    );
    expect(
      await forwardedAccount(
        credential,
        kgoose(reply).request,
        untouched,
      ).knownCommunities(),
    ).toEqual(urls);
  });

  // The route's refusals are plain strings, not the card's error objects, and
  // a portal without the route answers a plain-text 404.
  it.each([
    [
      "a 403 forbidden",
      answer(403, { error: "forbidden" }),
      "Could not load the communities saved to this account.",
      false,
    ],
    [
      "a plain-text 404",
      answer(404, "Not Found"),
      "Builderlab known communities failed (HTTP 404: not JSON).",
      false,
    ],
    [
      "a 200 that is not JSON",
      answer(200, "<html>block page</html>"),
      "Builderlab known communities failed (HTTP 200: not JSON).",
      false,
    ],
    [
      "a 200 with a row this client cannot read",
      answer(200, { communities: [{ community_url: 1 }] }),
      "Builderlab known communities failed (HTTP 200: unreadable row).",
      false,
    ],
    [
      "a 200 whose list is not a list",
      answer(200, { communities: "wss://a.example" }),
      "Builderlab known communities failed (HTTP 200: unreadable row).",
      false,
    ],
    [
      "a transport failure",
      "Host request failed: connection reset",
      "Host request failed: connection reset",
      true,
    ],
  ])("rejects %s", async (_label, reply, message, retryable) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request, sent } = kgoose(reply);
    const failed: unknown = await forwardedAccount(
      credential,
      request,
      untouched,
    )
      .knownCommunities()
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(message);
    expect((failed as { retryable?: unknown }).retryable === true).toBe(
      retryable,
    );
    expect(sent).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("saveCommunity", () => {
  const add = (origin: string) => ({
    url: `${origin}/api/goose/v1/buzz/known-communities/add`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ community_url: "wss://relay.example.com:8443" }),
  });

  it("POSTs the plugin's add route at the build URL through the NIP-FI forwarder and the address in the device's spelling", async () => {
    const { request, sent } = kgoose(answer(200, {}));
    await forwardedAccount(credential, request, untouched).saveCommunity(
      "https://relay.example.com:8443",
    );
    expect(sent).toEqual([add("https://t.example")]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a 422 limit_reached",
      answer(422, { error: "limit_reached" }),
      "Could not save this community to your Builderlab account.",
      false,
    ],
    [
      "a plain-text 422",
      answer(422, "Unprocessable Entity"),
      "Builderlab community save failed (HTTP 422: not JSON).",
      false,
    ],
    [
      "a transport failure",
      "Host request failed: connection reset",
      "Host request failed: connection reset",
      true,
    ],
  ])("rejects %s", async (_label, reply, message, retryable) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request, sent } = kgoose(reply);
    const failed: unknown = await forwardedAccount(
      credential,
      request,
      untouched,
    )
      .saveCommunity("https://relay.example.com:8443")
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(message);
    expect((failed as { retryable?: unknown }).retryable === true).toBe(
      retryable,
    );
    expect(sent).toHaveLength(1);
  });

  it("resolves without a request for the development seed", async () => {
    await expect(
      seededAccount(
        { linked: null, communities: [] },
        {
          importKey: () => {
            throw new Error("Imported a key");
          },
          snapshot: () => {
            throw new Error("Read the identity");
          },
        },
      ).saveCommunity("https://relay.example.com:8443"),
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("bind", () => {
  const challenge = {
    challenge_id: "550e8400-e29b-41d4-a716-446655440000",
    nonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_-7",
    verification_code: "123456",
    origin: "https://t.example",
    expires_at: "2999-01-01T00:00:00Z",
  };
  const event = {
    id: "e".repeat(64),
    pubkey,
    kind: 24243,
    sig: "s".repeat(128),
  };
  const unbound = answer(200, {
    identity: null,
    correlation_id: correlationId,
  });
  const bound = (key: string) =>
    answer(200, {
      identity: { pubkey_hex: key },
      correlation_id: correlationId,
    });
  const at = (origin: string) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
  });

  it("reads the bound key, then challenges at the build URL, signs natively and verifies with the signed event", async () => {
    vi.mocked(invoke).mockResolvedValue(event);
    const { request, sent } = kgoose(
      unbound,
      // Only the five challenge fields reach the native signer.
      answer(200, { ...challenge, created_at: "2026-01-01T00:00:00Z" }),
      bound(pubkey),
    );
    const account = forwardedAccount(credential, request, untouched);
    await account.bind(pubkey);
    const api = "https://t.example/api/goose/v1/buzz/nostr-identities";
    expect(sent).toEqual([
      { url: `${api}/current`, ...at("https://t.example"), body: "{}" },
      {
        url: `${api}/challenge`,
        ...at("https://t.example"),
        body: JSON.stringify({ origin: "https://t.example" }),
      },
      {
        url: `${api}/verify`,
        ...at("https://t.example"),
        body: JSON.stringify({
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          signed_payload: JSON.stringify(event),
        }),
      },
    ]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["identity_sign_builderlab_binding", { challenge }],
    ]);
  });

  it("sends nothing more when the account already holds this key", async () => {
    const { request, sent } = kgoose(bound(pubkey));
    await forwardedAccount(credential, request, untouched).bind(pubkey);
    expect(sent.map(({ url }) => url)).toEqual([
      "https://t.example/api/goose/v1/buzz/nostr-identities/current",
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a verify for an account bound to another key",
      [answer(200, challenge), refusal(409, "identity_already_bound")],
      "This Builderlab account is connected to another Buzz identity.",
    ],
    [
      "a verify for a key bound to another account",
      [answer(200, challenge), refusal(409, "pubkey_already_bound")],
      "This Buzz identity is connected to another Builderlab account.",
    ],
    // kgoose's codes the card lacks.
    [
      "a challenge refused for its origin",
      [refusal(403, "invalid_origin")],
      "Builderlab didn’t accept this request from Buzz.",
    ],
    [
      "a challenge refused for too many open challenges",
      [refusal(429, "too_many_attempts")],
      "Builderlab has had too many attempts to link a key. Wait a few minutes, then try again.",
    ],
    [
      "a non-JSON challenge answer",
      [answer(502, "<html>bad gateway</html>")],
      "Builderlab account link failed (HTTP 502: not JSON).",
    ],
    [
      "a non-JSON verify answer",
      [answer(200, challenge), answer(403, "Forbidden")],
      "Builderlab account link failed (HTTP 403: not JSON).",
    ],
    [
      "a verify that confirms another key",
      [answer(200, challenge), bound("cd".repeat(32))],
      "Builderlab account link failed (HTTP 200: link not confirmed).",
    ],
    [
      "a verify that confirms no key",
      [answer(200, challenge), answer(200, {})],
      "Builderlab account link failed (HTTP 200: link not confirmed).",
    ],
  ])(
    "fails on %s with the card's or the step's copy",
    async (_label, replies, message) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const { request, sent } = kgoose(unbound, ...replies);
      const account = forwardedAccount(credential, request, untouched);
      const failed = await account.bind(pubkey).catch((error: Error) => error);
      // Never kgoose's own message or its correlation ID.
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(message);
      expect(sent).toHaveLength(1 + replies.length);
      // A refused challenge is never signed; an answered one is, before verify.
      expect(vi.mocked(invoke).mock.calls).toEqual(
        Array(replies.length - 1).fill([
          "identity_sign_builderlab_binding",
          { challenge },
        ]),
      );
    },
  );

  // kgoose's statuses (`NostrIdentityService.verify`). A code about one
  // challenge may clear, since Try again asks for a fresh one; a bad signature
  // or a skewed `created_at` (invalid_challenge) does not.
  it.each([
    [
      "invalid_challenge",
      400,
      "Builderlab couldn’t verify your key’s signature, so the key wasn’t linked.",
      false,
    ],
    [
      "challenge_not_found",
      404,
      "Builderlab couldn’t find the request to link your key, so the key wasn’t linked.",
      true,
    ],
    [
      "challenge_expired",
      400,
      "The request to link your key expired before Builderlab confirmed it.",
      true,
    ],
    [
      "challenge_consumed",
      409,
      "The request to link your key was already used.",
      true,
    ],
    [
      "too_many_attempts",
      429,
      "Builderlab has had too many attempts to link a key. Wait a few minutes, then try again.",
      true,
    ],
    [
      "identity_already_bound",
      409,
      "This Builderlab account is connected to another Buzz identity.",
      false,
    ],
    [
      "pubkey_already_bound",
      409,
      "This Buzz identity is connected to another Builderlab account.",
      false,
    ],
    // Defensive, not a kgoose reply: its identity routes never send `unknown`,
    // which the card reads as its deletion service's.
    [
      "unknown",
      400,
      "Could not link your key to this Builderlab account.",
      false,
    ],
    [
      "a_code_nobody_knows",
      400,
      "Could not link your key to this Builderlab account.",
      false,
    ],
  ] as const)(
    "fails a verify answering %s (HTTP %i) with first run's copy, never kgoose's, and retryable only if it may clear",
    async (code, status, message, retryable) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const { request } = kgoose(
        unbound,
        answer(200, challenge),
        refusal(status, code),
      );
      const failed: unknown = await forwardedAccount(
        credential,
        request,
        untouched,
      )
        .bind(pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(message);
      expect((failed as { retryable?: unknown }).retryable === true).toBe(
        retryable,
      );
    },
  );

  it("keeps kgoose's correlation ID off the message, on the error and in the development log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockResolvedValue(event);
    for (const [code, status, message] of [
      [
        "challenge_expired",
        400,
        "The request to link your key expired before Builderlab confirmed it.",
      ],
      // The card's own copy, whose `ApiFailure` would append the ID.
      [
        "pubkey_already_bound",
        409,
        "This Buzz identity is connected to another Builderlab account.",
      ],
    ] as const) {
      warn.mockClear();
      const failed: unknown = await forwardedAccount(
        credential,
        kgoose(unbound, answer(200, challenge), refusal(status, code)).request,
        untouched,
      )
        .bind(pubkey)
        .catch((error: unknown) => error);
      expect((failed as Error).message).toBe(message);
      expect((failed as Error).message).not.toContain(correlationId);
      expect(failed).toMatchObject({ correlationId });
      expect(warn.mock.calls.map((call) => call.join(" "))).toEqual([
        `Builderlab account link: POST /v1/buzz/nostr-identities/verify answered HTTP ${status} (correlation ID ${correlationId}) ${message}`,
      ]);
    }
  });

  it.each([
    ["the bound-key read", [lapsed]],
    ["the challenge", [unbound, lapsed]],
    ["the verify", [unbound, answer(200, challenge), lapsed]],
  ])(
    "reads a lapsed session's plain-text 401 on %s as an ended sign-in, without Try again",
    async (_label, replies) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const failed: unknown = await forwardedAccount(
        credential,
        kgoose(...replies).request,
        untouched,
      )
        .bind(pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(signedOut);
      expect((failed as { retryable?: unknown }).retryable).toBeUndefined();
    },
  );

  it("surfaces the native signer's refusal and never verifies", async () => {
    vi.mocked(invoke).mockRejectedValue("Invalid Nostr identity challenge");
    const { request, sent } = kgoose(unbound, answer(200, challenge));
    const account = forwardedAccount(credential, request, untouched);
    await expect(account.bind(pubkey)).rejects.toThrow(
      "Invalid Nostr identity challenge",
    );
    expect(sent).toHaveLength(2);
  });

  // Native code signs with whatever key secure storage holds when it runs.
  it.each([
    ["another key", { ...event, pubkey: "cd".repeat(32) }],
    ["no key", { ...event, pubkey: undefined }],
  ])("never verifies a signature by %s", async (_label, signed) => {
    vi.mocked(invoke).mockResolvedValue(signed);
    const { request, sent } = kgoose(unbound, answer(200, challenge));
    const failed: unknown = await forwardedAccount(
      credential,
      request,
      untouched,
    )
      .bind(pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(
      "The key on this device changed before it could be linked, so your Builderlab account wasn’t changed.",
    );
    expect((failed as { retryable?: unknown }).retryable).toBeUndefined();
    expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
      "current",
      "challenge",
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Native code also signs a challenge for production Builderlab.
  it("never signs a challenge for another origin", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request, sent } = kgoose(
      unbound,
      answer(200, { ...challenge, origin: "https://app.builderlab.xyz" }),
    );
    const failed: unknown = await forwardedAccount(
      credential,
      request,
      untouched,
    )
      .bind(pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(
      "Builderlab account link failed (HTTP 200: challenge for another origin).",
    );
    expect((failed as { retryable?: unknown }).retryable).toBeUndefined();
    expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
      "current",
      "challenge",
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["a gateway failure", [answer(502, "<html>bad gateway</html>")], true],
    ["a transport error", [new Error("offline")], true],
    ["a rate limit", [refusal(429, "too_many_attempts")], true],
    [
      "a refused link",
      [answer(200, challenge), refusal(409, "identity_already_bound")],
      false,
    ],
    ["a refused origin", [refusal(403, "invalid_origin")], false],
  ])(
    "lets Try again repeat %s only if it may clear",
    async (_label, replies, retryable) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const failed: unknown = await forwardedAccount(
        credential,
        kgoose(unbound, ...replies).request,
        untouched,
      )
        .bind(pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as { retryable?: unknown }).retryable === true).toBe(
        retryable,
      );
      expect(vi.mocked(invoke).mock.calls).toEqual(
        Array(replies.length - 1).fill([
          "identity_sign_builderlab_binding",
          { challenge },
        ]),
      );
    },
  );

  describe("bindLegacy", () => {
    const legacy = [
      "identity_sign_builderlab_binding",
      { challenge, legacy: true },
    ];

    it("signs with old Buzz's key, verifies it and resolves to the key bound", async () => {
      vi.mocked(invoke).mockResolvedValue(event);
      const { request, sent } = kgoose(
        unbound,
        answer(200, challenge),
        bound(pubkey),
      );
      const account = forwardedAccount(credential, request, untouched);
      expect(await account.bindLegacy()).toBe(pubkey);
      expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
        "current",
        "challenge",
        "verify",
      ]);
      expect(vi.mocked(invoke).mock.calls).toEqual([legacy]);
    });

    it("sends no verify when the account already holds old Buzz's key", async () => {
      vi.mocked(invoke).mockResolvedValue(event);
      const { request, sent } = kgoose(bound(pubkey), answer(200, challenge));
      const account = forwardedAccount(credential, request, untouched);
      expect(await account.bindLegacy()).toBe(pubkey);
      expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
        "current",
        "challenge",
      ]);
    });

    it("resolves null when kgoose refuses old Buzz's key as another account's", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const { request } = kgoose(
        unbound,
        answer(200, challenge),
        refusal(409, "pubkey_already_bound"),
      );
      const account = forwardedAccount(credential, request, untouched);
      expect(await account.bindLegacy()).toBeNull();
    });

    it("resolves null when native can't read old Buzz's key, sending no verify", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      const { request, sent } = kgoose(unbound, answer(200, challenge));
      const account = forwardedAccount(credential, request, untouched);
      expect(await account.bindLegacy()).toBeNull();
      expect(sent).toHaveLength(2);
    });

    it("fails when native refuses to sign, such as an expired challenge, sending no verify", async () => {
      vi.mocked(invoke).mockRejectedValue("Invalid Nostr identity challenge");
      const { request, sent } = kgoose(unbound, answer(200, challenge));
      const account = forwardedAccount(credential, request, untouched);
      await expect(account.bindLegacy()).rejects.toThrow(
        "Invalid Nostr identity challenge",
      );
      expect(sent).toHaveLength(2);
    });

    it.each([
      [
        "an account bound to another key",
        [answer(200, challenge), refusal(409, "identity_already_bound")],
      ],
      ["a challenge outage", [answer(502, "<html>bad gateway</html>")]],
    ])(
      "fails on %s rather than giving up the old key",
      async (_label, replies) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.mocked(invoke).mockResolvedValue(event);
        const { request } = kgoose(unbound, ...replies);
        const account = forwardedAccount(credential, request, untouched);
        await expect(account.bindLegacy()).rejects.toBeInstanceOf(Error);
      },
    );
  });
});

describe("unbind", () => {
  const old = "cd".repeat(32);
  const bound = (key: string) =>
    answer(200, {
      identity: { pubkey_hex: key },
      correlation_id: correlationId,
    });
  const unbound = answer(200, {
    identity: null,
    correlation_id: correlationId,
  });
  const at = (origin: string) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: "{}",
  });

  it("reads the bound key, then deletes the old key's binding at the build URL through the NIP-FI forwarder and Origin", async () => {
    const { request, sent } = kgoose(bound(old), bound(old));
    await forwardedAccount(credential, request, untouched).unbind(old, pubkey);
    const api = "https://t.example/api/goose/v1/buzz/nostr-identities";
    expect(sent).toEqual([
      { url: `${api}/current`, ...at("https://t.example") },
      { url: `${api}/delete`, ...at("https://t.example") },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["no key", unbound],
    ["the new key, after a re-run", bound(pubkey)],
  ])("sends nothing more when the account holds %s", async (_label, reply) => {
    const { request, sent } = kgoose(reply);
    await forwardedAccount(credential, request, untouched).unbind(old, pubkey);
    expect(sent.map(({ url }) => url)).toEqual([
      "https://t.example/api/goose/v1/buzz/nostr-identities/current",
    ]);
  });

  it("fails without a delete when the account holds a third key", async () => {
    const { request, sent } = kgoose(bound("12".repeat(32)));
    const failed: unknown = await forwardedAccount(
      credential,
      request,
      untouched,
    )
      .unbind(old, pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(
      "Your Builderlab account is linked to a different key, so your new key can’t be linked.",
    );
    expect((failed as { retryable?: unknown }).retryable).toBeUndefined();
    expect(sent.map(({ url }) => url)).toEqual([
      "https://t.example/api/goose/v1/buzz/nostr-identities/current",
    ]);
  });

  // kgoose answers 200 with no `identity` when nothing was bound, and also
  // when the session or its authorization lapsed, removing nothing.
  const deletes = [
    ["no identity", answer(200, { correlation_id: correlationId })],
    ["identity null", unbound],
    ["another key", bound("ef".repeat(32))],
  ] as const;

  it.each(
    deletes.flatMap(([deleted, reply]) => [
      [deleted, "no key", reply, unbound],
      [deleted, "the new key", reply, bound(pubkey)],
    ]),
  )(
    "succeeds when the delete answers %s and the account then holds %s",
    async (_deleted, _now, reply, now) => {
      const { request, sent } = kgoose(bound(old), reply, now);
      await expect(
        forwardedAccount(credential, request, untouched).unbind(old, pubkey),
      ).resolves.toBeUndefined();
      expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
        "current",
        "delete",
        "current",
      ]);
    },
  );

  it.each(
    deletes.flatMap(([deleted, reply]) => [
      [
        deleted,
        "the old key",
        reply,
        bound(old),
        "Builderlab didn’t unlink your old key, so your new key can’t be linked. Your Builderlab sign-in may have ended.",
      ],
      [
        deleted,
        "a third key",
        reply,
        bound("12".repeat(32)),
        "Your Builderlab account is linked to a different key, so your new key can’t be linked.",
      ],
    ]),
  )(
    "fails for good when the delete answers %s and the account still holds %s",
    async (_deleted, _now, reply, now, message) => {
      const failed: unknown = await forwardedAccount(
        credential,
        kgoose(bound(old), reply, now).request,
        untouched,
      )
        .unbind(old, pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(message);
      expect((failed as { retryable?: unknown }).retryable).toBeUndefined();
    },
  );

  it("fails like the account check when the read after a delete fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed: unknown = await forwardedAccount(
      credential,
      kgoose(bound(old), unbound, new Error("offline")).request,
      untouched,
    )
      .unbind(old, pubkey)
      .catch((error: unknown) => error);
    expect((failed as Error).message).toBe("offline");
    expect((failed as { retryable?: unknown }).retryable).toBe(true);
  });

  // kgoose's delete answers 200 or a 403 `invalid_origin`; its
  // `@Authenticated` gate answers a lapsed session with misk's 401.
  it.each([
    ["a lapsed session", lapsed, signedOut, false],
    [
      "a refused origin",
      refusal(403, "invalid_origin"),
      "Builderlab didn’t accept this request from Buzz.",
      false,
    ],
    // Defensive, not a kgoose reply: its identity routes never send `unknown`,
    // and its real 500 is misk's plain text (the non-JSON rows).
    [
      "a defensive `unknown` 500",
      refusal(500, "unknown"),
      "Could not unlink your old key from this Builderlab account.",
      true,
    ],
    [
      "a non-JSON refusal",
      answer(403, "Forbidden"),
      "Builderlab account unlink failed (HTTP 403: not JSON).",
      false,
    ],
    [
      "a non-JSON gateway failure",
      answer(502, "<html>bad gateway</html>"),
      "Builderlab account unlink failed (HTTP 502: not JSON).",
      true,
    ],
    [
      "an unstructured server failure",
      answer(500, { message: "boom" }),
      "Builderlab account unlink failed (HTTP 500).",
      true,
    ],
    ["a transport error", new Error("offline"), "offline", true],
    [
      "a native refusal string",
      "host request denied",
      "host request denied",
      true,
    ],
  ])(
    "fails on %s with the card's or the step's copy, retryable only if it may clear",
    async (_label, reply, message, retryable) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { request, sent } = kgoose(bound(old), reply);
      const failed: unknown = await forwardedAccount(
        credential,
        request,
        untouched,
      )
        .unbind(old, pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(message);
      expect((failed as { retryable?: unknown }).retryable === true).toBe(
        retryable,
      );
      expect(sent).toHaveLength(2);
    },
  );
});

describe("backup", () => {
  const status = (
    seq: number,
    pass: number,
    builderlab = true,
    progress: "idle" | "running" | "complete" = "idle",
  ): BackupStatus => ({ seq, pass, builderlab, status: progress });
  /** The identity's real status store over a scripted native host. */
  function host(snapshot: BackupStatus) {
    const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
    const send = vi.fn(async (command: string, args?: unknown) => {
      if (command === "nsec_backup_watch")
        watchers.push((args as { onEvent: (typeof watchers)[number] }).onEvent);
      else if (command === "nsec_backup_state") return snapshot;
      else throw new Error(`Unexpected command ${command}`);
    });
    const setBackupChoice = vi.fn(
      (_pubkey: string, automatic: boolean): Promise<never> =>
        Promise.resolve({ available: true, pubkey, automatic } as never),
    );
    const identity: BackupIdentity = {
      ...noRecovery,
      backup: createBackupStatus(send as never),
      setBackupChoice,
    };
    return { identity, send, setBackupChoice, watchers };
  }

  it("refuses with unavailable where backup is not offered, handing the uploader nothing", async () => {
    const native = host(status(1, 0, false));
    const failed = await forwardedAccount(
      credential,
      kgoose().request,
      native.identity,
    )
      .backUp(pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BackupError);
    expect(failed).toMatchObject({ kind: "unavailable" });
    expect(native.setBackupChoice).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a backup status it cannot read as unknown, handing the uploader nothing", async () => {
    const native = host(status(1, 0));
    native.send.mockRejectedValueOnce(
      "Backup status belongs to the main window",
    );
    const failed = await forwardedAccount(
      credential,
      kgoose().request,
      native.identity,
    )
      .backUp(pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BackupError);
    expect(failed).toMatchObject({ kind: "unknown" });
    expect(native.setBackupChoice).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is offered only where native backup runs", async () => {
    const offered = (builderlab: boolean) =>
      backupOfferedFor(host(status(1, 0, builderlab)).identity.backup);
    expect(await offered(true)).toBe(true);
    expect(await offered(false)).toBe(false);
    // A status that cannot be read is not an offer.
    const refused = host(status(1, 0));
    refused.send.mockRejectedValueOnce(
      "Backup status belongs to the main window",
    );
    expect(await backupOfferedFor(refused.identity.backup)).toBe(false);
    // A build without a Builderlab URL offers no backup.
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
    expect(await offered(true)).toBe(false);
  });

  describe("backupStatus", () => {
    const other = "cd".repeat(32);
    /** An account where backup is offered: native backup is running. */
    const offeredWith = (...replies: Parameters<typeof kgoose>) => {
      vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example/");
      const native = host(status(1, 0));
      const { request, sent } = kgoose(...replies);
      return {
        account: forwardedAccount(credential, request, native.identity),
        sent,
      };
    };

    it("POSTs status through the NIP-FI forwarder and lists the backed-up keys", async () => {
      const { account, sent } = offeredWith(
        answer(200, {
          current_nostr_pubkey: pubkey,
          backup_nostr_pubkeys: [pubkey, other.toUpperCase()],
        }),
      );
      expect(await account.backupStatus()).toEqual([pubkey, other]);
      expect(sent).toEqual([
        {
          url: "https://builderlab.example/api/goose/v1/buzz/nsec-backups/status",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://builderlab.example",
          },
          body: "{}",
        },
      ]);
    });

    it("lists nothing for an account with no backups", async () => {
      const { account } = offeredWith(
        answer(200, { current_nostr_pubkey: null, backup_nostr_pubkeys: [] }),
      );
      expect(await account.backupStatus()).toEqual([]);
    });

    it("is unavailable, not empty, where kgoose has no backups configured", async () => {
      const { account } = offeredWith(answer(404, "Not Found"));
      expect(await account.backupStatus()).toBe("unavailable");
    });

    it("is unavailable without a request where backup is not offered", async () => {
      const { request } = kgoose();
      const account = forwardedAccount(
        credential,
        request,
        host(status(1, 0, false)).identity,
      );
      expect(await account.backupStatus()).toBe("unavailable");
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      ["a transport failure", new Error("offline"), "unreachable"],
      ["401", answer(401, "Unauthorized"), "signed_out"],
      ["403", answer(403, "Forbidden"), "not_offered"],
      ["429", answer(429, "Too Many Requests"), "unreachable"],
      [
        "a 500 for an invalid stored backup",
        answer(500, "oops"),
        "unreachable",
      ],
      ["400", answer(400, "Bad Request"), "refused"],
      ["a 200 that is not JSON", answer(200, "<html>"), "invalid_service"],
      [
        "a 200 with no list",
        answer(200, { current_nostr_pubkey: null }),
        "invalid_service",
      ],
      [
        "a 200 listing a non-key",
        answer(200, { backup_nostr_pubkeys: [pubkey, "npub1x"] }),
        "invalid_service",
      ],
      [
        "an oversized 200",
        answer(200, {
          backup_nostr_pubkeys: Array(1100).fill(pubkey),
        }),
        "invalid_service",
      ],
    ] as const)(
      "rejects %s with the %s backup failure",
      async (_label, reply, kind) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { account } = offeredWith(reply);
        const failed = await account
          .backupStatus()
          .catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(BackupError);
        expect(failed).toMatchObject({
          kind,
          retryable: BACKUP_FAILURES[kind].retryable,
        });
      },
    );
  });
});

describe("federatedBuilderlabAccount", () => {
  const signedIn = async () => {
    const fi = federatedFixture();
    await fi.service.signIn();
    return {
      ...fi,
      credential: { ...credential, revision: fi.service.snapshot().revision },
    };
  };

  it("sends the card's routes through the NIP-FI forwarder under the session's API base, with no session credential", async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: "e".repeat(64),
      pubkey,
      kind: 24243,
      sig: "s".repeat(128),
    });
    const fi = await signedIn();
    fi.request
      .mockResolvedValueOnce(answer(200, { identity: null }))
      .mockResolvedValueOnce(
        answer(200, {
          challenge_id: "550e8400-e29b-41d4-a716-446655440000",
          nonce: "n",
          verification_code: "123456",
          origin: "https://t.example",
          expires_at: "2999-01-01T00:00:00Z",
        }),
      )
      .mockResolvedValueOnce(answer(200, { identity: { pubkey_hex: pubkey } }));
    await federatedBuilderlabAccount(fi.credential, fi.service, untouched).bind(
      pubkey,
    );
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://t.example",
    };
    expect(fi.request.mock.calls.map(([input]) => input)).toEqual([
      {
        path: "/api/goose/v1/buzz/nostr-identities/current",
        method: "POST",
        headers,
        body: "{}",
      },
      {
        path: "/api/goose/v1/buzz/nostr-identities/challenge",
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://t.example" }),
      },
      expect.objectContaining({
        path: "/api/goose/v1/buzz/nostr-identities/verify",
      }),
    ]);
  });

  it("refuses without a request once the session it signed in with has changed", async () => {
    const fi = await signedIn();
    const account = federatedBuilderlabAccount(
      fi.credential,
      fi.service,
      untouched,
    );
    await fi.service.signIn();
    await expect(account.linkedKey()).rejects.toThrow(signedOut);
    fi.publish({ status: "signed-out" });
    await expect(account.communityList()).rejects.toThrow(signedOut);
    expect(fi.request).not.toHaveBeenCalled();
  });

  it("refuses without a request while the session it signed in with is unavailable", async () => {
    const fi = await signedIn();
    const account = federatedBuilderlabAccount(
      fi.credential,
      fi.service,
      untouched,
    );
    fi.publish({ status: "unavailable", failure: "storage-unavailable" });
    expect(fi.service.snapshot().revision).toBe(fi.credential.revision);
    await expect(account.linkedKey()).rejects.toThrow(signedOut);
    expect(fi.request).not.toHaveBeenCalled();
  });

  it("reads backup status through the forwarder and hands the uploader the session revision", async () => {
    const fi = await signedIn();
    const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
    const send = vi.fn(async (command: string, args?: unknown) => {
      if (command === "nsec_backup_watch")
        watchers.push((args as { onEvent: (typeof watchers)[number] }).onEvent);
      else if (command === "nsec_backup_state")
        return { seq: 1, pass: 0, builderlab: true, status: "idle" };
    });
    const account = federatedBuilderlabAccount(fi.credential, fi.service, {
      ...noRecovery,
      backup: createBackupStatus(send as never),
      setBackupChoice: () =>
        Promise.resolve({ available: true, pubkey, automatic: true } as never),
    });
    fi.request.mockResolvedValueOnce(
      answer(200, {
        current_nostr_pubkey: null,
        backup_nostr_pubkeys: [pubkey],
      }),
    );
    expect(await account.backupStatus()).toEqual([pubkey]);
    expect(fi.request.mock.calls.map(([input]) => input)).toEqual([
      {
        path: "/api/goose/v1/buzz/nsec-backups/status",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://t.example",
        },
        body: "{}",
      },
    ]);
    vi.mocked(invoke).mockImplementation(async (_command, args) =>
      (args as { federated?: string | null }).federated ? 1 : null,
    );
    const done = account.backUp(pubkey);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    watchers[0]?.onmessage({
      seq: 2,
      pass: 1,
      builderlab: true,
      status: "complete",
    });
    await done;
    expect(vi.mocked(invoke).mock.calls).toEqual([
      [
        "nsec_backup_session",
        {
          federated: fi.credential.revision,
          generation: expect.any(Number),
        },
      ],
      // The Builderlab plugin hands over the same session, so it stays.
      [
        "nsec_backup_session",
        {
          federated: fi.credential.revision,
          generation: expect.any(Number),
        },
      ],
    ]);
    expect(fi.request).toHaveBeenCalledTimes(1);
  });
});
