import { createTestSession } from "../test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostRequest } from "../../../features/host/service";
import type { Credential } from "../session";
import { createNativeBackend } from "./native";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const API = "https://app.builderlab.xyz/api/goose";
type Reply = { status?: number; body: unknown };

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://app.builderlab.xyz"),
);
afterEach(() => vi.unstubAllEnvs());

const credential = (revision: string): Credential =>
  Object.freeze({
    revision,
    account: Object.freeze({
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: false,
      canUseBuilderlabDecisions: false,
    }),
  });

function setup(
  replies: Record<string, Reply | (() => Reply | Promise<Reply>)>,
  commands: Record<string, (input?: Record<string, unknown>) => unknown> = {},
) {
  const requests: HostRequest[] = [];
  const host: Host = {
    runCommand: async () => null,
    request: vi.fn(async (input: HostRequest) => {
      requests.push(input);
      const entry = replies[input.url.slice(API.length)];
      if (!entry) throw "Host request failed";
      const { status = 200, body } = await (typeof entry === "function"
        ? entry()
        : entry);
      return {
        status,
        headers: {},
        body: typeof body === "string" ? body : JSON.stringify(body),
      };
    }),
  };
  const invoke = vi.fn(
    async (name: string, input?: Record<string, unknown>) => {
      const handlers: typeof commands = {
        nsec_backup_retry: () => undefined,
        ...commands,
      };
      const handler = handlers[name];
      if (!handler) throw `Unexpected ${name}`;
      return handler(input);
    },
  );
  let token = "token";
  let link = Promise.resolve();
  const session = createTestSession(
    async () => credential(token),
    undefined,
    host,
  );
  const backend = createNativeBackend(session, () => link, {
    invoke: invoke as <T>(n: string, a?: Record<string, unknown>) => Promise<T>,
  });
  const signIn = async (next = "token") => {
    token = next;
    await session.signIn();
  };
  const holdLink = (held: Promise<void>) => {
    link = held;
  };
  return { backend, session, signIn, holdLink, requests, invoke };
}
const signedIn = {
  "/v1/auth/me": {
    body: {
      email: "a@example.com",
      expires_at: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  },
};

it("reports no account before sign-in and refuses account calls", async () => {
  const { backend, requests } = setup({});
  await expect(backend.auth()).resolves.toBeNull();
  await expect(backend.send("list")).rejects.toThrow(
    "Sign in to Builderlab first",
  );
  expect(requests).toEqual([]);
});

it("signs in through the shared session and keeps its credential out of results", async () => {
  const { backend, session } = setup(signedIn);
  const { value } = await backend.send(
    "login",
    {},
    new AbortController().signal,
  );
  expect(session.snapshot().status).toBe("signed-in");
  expect(value).toEqual({
    auth: {
      email: "a@example.com",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  });
  expect(JSON.stringify(value)).not.toContain("token");
  await expect(backend.send("sign-out")).resolves.toEqual({
    status: 200,
    value: {},
  });
  expect(session.snapshot().status).toBe("signed-out");
  await expect(backend.auth()).resolves.toBeNull();
});

it("forwards only allowlisted fields to the configured Builderlab", async () => {
  const { backend, signIn, requests } = setup({
    ...signedIn,
    "/v1/buzz/communities/archive": { body: { community: { id: "c" } } },
  });
  await signIn();
  expect(backend.origin).toBe("https://app.builderlab.xyz");
  await backend.send("archive", { community_id: "c", extra: "dropped" });
  expect(requests.at(-1)).toEqual({
    url: `${API}/v1/buzz/communities/archive`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.builderlab.xyz",
    },
    body: JSON.stringify({ community_id: "c" }),
  });
  await expect(backend.send("archive", {})).rejects.toThrow(
    "Missing community_id",
  );
  await expect(backend.send("unknown")).rejects.toThrow(
    "Unknown Builderlab route",
  );
});

it("passes structured errors through with their status and rejects others", async () => {
  let reply: Reply = {
    status: 409,
    body: { error: { code: "deletion_conflict" } },
  };
  const { backend, signIn } = setup({
    ...signedIn,
    "/v1/buzz/communities/list": () => reply,
  });
  await signIn();
  await expect(backend.send("list")).resolves.toEqual({
    status: 409,
    value: { error: { code: "deletion_conflict" } },
  });
  reply = { status: 502, body: "<html>" };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab returned an invalid response",
  );
  reply = { status: 500, body: {} };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab request failed (HTTP 500).",
  );
  reply = { body: [] };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab request failed (HTTP 200).",
  );
  reply = { body: { padding: "x".repeat(64 * 1024) } };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab response was too large",
  );
});

it("turns a host transport rejection into an error", async () => {
  const { backend, signIn } = setup(signedIn);
  await signIn();
  await expect(backend.send("list")).rejects.toThrow("Host request failed");
});

it("reads no account when Builderlab rejects the session, and keeps it", async () => {
  let me: Reply = signedIn["/v1/auth/me"];
  const { backend, session, signIn } = setup({
    ...signedIn,
    "/v1/auth/me": () => me,
  });
  await signIn();
  me = { status: 500, body: {} };
  await expect(backend.auth()).rejects.toThrow(
    "Builderlab session check failed with HTTP 500",
  );
  expect(session.snapshot().status).toBe("signed-in");
  me = { status: 401, body: {} };
  await expect(backend.auth()).resolves.toBeNull();
  expect(session.snapshot().status).toBe("signed-in");
});

it("refuses only the call when a community route returns 401", async () => {
  let answer: (reply: Reply) => void = () => {};
  const { backend, session, signIn, requests } = setup({
    "/v1/buzz/communities/list": () =>
      new Promise<Reply>((resolve) => {
        answer = resolve;
      }),
  });
  await signIn();
  const stale = backend.send("list");
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  session.signOut();
  await signIn("replacement");
  answer({ status: 401, body: {} });
  await expect(stale).rejects.toThrow("Builderlab session changed");
  expect(session.snapshot().status).toBe("signed-in");
  const current = backend.send("list");
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  answer({ status: 401, body: { error: { code: "unauthorized" } } });
  await expect(current).rejects.toThrow(
    "Builderlab didn’t accept this request. Try again.",
  );
  expect(session.snapshot().status).toBe("signed-in");
});

it("reads the account only after sign-in's identity link settles", async () => {
  const { backend, signIn, holdLink, requests } = setup(signedIn);
  let finish: () => void = () => {};
  holdLink(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await signIn();
  const checking = backend.auth();
  await Promise.resolve();
  expect(requests).toEqual([]);
  finish();
  await expect(checking).resolves.toMatchObject({ email: "a@example.com" });
  expect(requests.map(({ url }) => url)).toEqual([`${API}/v1/auth/me`]);
});

it("does not describe a session that ended during its check", async () => {
  let answer: (reply: Reply) => void = () => {};
  const { backend, session, signIn } = setup({
    "/v1/auth/me": () =>
      new Promise<Reply>((resolve) => {
        answer = resolve;
      }),
  });
  await signIn();
  const checking = backend.auth();
  session.signOut();
  answer(signedIn["/v1/auth/me"]);
  await expect(checking).rejects.toThrow("Builderlab session changed");
});

it("returns a challenge error without signing", async () => {
  const sign = vi.fn();
  const { backend, signIn } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": {
        status: 403,
        body: { error: { code: "unauthorized" } },
      },
    },
    { identity_sign_builderlab_binding: sign },
  );
  await signIn();
  await expect(backend.send("bind")).resolves.toMatchObject({
    value: { error: { code: "unauthorized" } },
  });
  expect(sign).not.toHaveBeenCalled();
});

it("does not sign a challenge issued to a session that has since ended", async () => {
  let issue: (reply: Reply) => void = () => {};
  const sign = vi.fn();
  const { backend, session, signIn, requests } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": () =>
        new Promise<Reply>((resolve) => {
          issue = resolve;
        }),
    },
    { identity_sign_builderlab_binding: sign },
  );
  await signIn();
  const binding = backend.send("bind");
  await vi.waitFor(() =>
    expect(requests.at(-1)?.url).toBe(
      `${API}/v1/buzz/nostr-identities/challenge`,
    ),
  );
  session.signOut();
  issue({ body: { challenge_id: "x" } });
  await expect(binding).rejects.toThrow("Builderlab session changed");
  expect(sign).not.toHaveBeenCalled();
});

it("forwards a native signing refusal as an error", async () => {
  const { backend, signIn, requests } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": {
        body: { challenge_id: "x", origin: "https://example.com" },
      },
    },
    {
      identity_sign_builderlab_binding: () => {
        throw "Invalid Nostr identity challenge";
      },
    },
  );
  await signIn();
  await expect(backend.send("bind")).rejects.toThrow(
    "Invalid Nostr identity challenge",
  );
  expect(requests.some(({ url }) => url.endsWith("/verify"))).toBe(false);
});

it("reads this device's key from the native identity", async () => {
  const key = "A".repeat(64);
  await expect(
    setup({}, { identity_restore: () => key }).backend.localKey(),
  ).resolves.toBe("a".repeat(64));
  await expect(
    setup({}, { identity_restore: () => null }).backend.localKey(),
  ).resolves.toBeNull();
  await expect(
    setup(
      {},
      {
        identity_restore: () => {
          throw "locked";
        },
      },
    ).backend.localKey(),
  ).resolves.toBeNull();
});

const challenge = {
  challenge_id: "x",
  nonce: "n",
  verification_code: "123456",
  origin: "https://app.builderlab.xyz",
  expires_at: "2030",
};

function bindingWithHeldSignature() {
  let sign: (event: object) => void = () => {};
  const native = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": { body: challenge },
      "/v1/buzz/nostr-identities/verify": { body: { identity: {} } },
    },
    {
      identity_sign_builderlab_binding: () =>
        new Promise((resolve) => {
          sign = resolve;
        }),
    },
  );
  const start = async () => {
    await native.signIn();
    const binding = native.backend.send("bind");
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        "identity_sign_builderlab_binding",
        { challenge },
      ),
    );
    return { binding, release: () => sign({ id: "event" }) };
  };
  const verified = () =>
    native.requests.filter(({ url }) => url.endsWith("/verify"));
  return { ...native, start, verified };
}

it("verifies a signed binding with the session that requested it", async () => {
  const { start, verified, invoke, requests } = bindingWithHeldSignature();
  const { binding, release } = await start();
  expect(
    JSON.parse(
      String(requests.find(({ url }) => url.endsWith("/challenge"))?.body),
    ),
  ).toEqual({ origin: "https://app.builderlab.xyz" });
  release();
  await expect(binding).resolves.toEqual({
    status: 200,
    value: { identity: {} },
  });
  expect(verified()).toHaveLength(1);
  expect(verified()[0]).toMatchObject({
    body: JSON.stringify({
      challenge_id: "x",
      nonce: "n",
      signed_payload: JSON.stringify({ id: "event" }),
    }),
  });
  expect(invoke).toHaveBeenCalledWith("nsec_backup_retry");
});

it.each([
  [
    "sign-out",
    (native: ReturnType<typeof bindingWithHeldSignature>) =>
      native.session.signOut(),
  ],
  [
    "a replacement sign-in",
    async (native: ReturnType<typeof bindingWithHeldSignature>) => {
      native.session.signOut();
      await native.signIn("replacement");
    },
  ],
  [
    "plugin disposal",
    (native: ReturnType<typeof bindingWithHeldSignature>) =>
      native.session.dispose(),
  ],
])("does not verify a signature completed after %s", async (_, end) => {
  const native = bindingWithHeldSignature();
  const { binding, release } = await native.start();
  await end(native);
  release();
  await expect(binding).rejects.toThrow("Builderlab session changed");
  expect(native.verified()).toEqual([]);
  expect(native.invoke).not.toHaveBeenCalledWith("nsec_backup_retry");
});
