import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Host } from "../../../features/host/service";
import { browserCredential, type BrowserBridge, oauthTarget } from "./browser";
import { createOAuthSession } from "./session";
import { deferred } from "../test-helpers";
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const attemptId = "native-attempt-id";
const account = {
  subject: "user",
  name: "A",
  email: "a@example.com",
  workspaces: { active: [{ name: "Block" }] },
};
function fixture() {
  const bridge: BrowserBridge = {
    begin: vi.fn(async ({ callbackPath }) => ({
      id: attemptId,
      callbackUrl: `http://127.0.0.1:12345${callbackPath}`,
    })),
    wait: vi.fn(async () => ({ parameters: [["code", "one-time"]] as const })),
    cancel: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
  };
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async ({ url }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(
        url.endsWith("/exchange")
          ? { session_credential: "private-token" }
          : account,
      ),
    })),
  };
  return { host, bridge, controller: new AbortController() };
}
it("acquires a verified credential with the RFC 7636 S256 proof", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  vi.spyOn(crypto, "getRandomValues").mockReturnValueOnce(
    new Uint8Array(Buffer.from(verifier, "base64url")),
  );
  const origin = "https://builderlab.example";
  const { host, bridge, controller } = fixture();
  expect(await browserCredential(host, controller.signal, bridge)).toEqual({
    value: "private-token",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: false,
      canUseBuilderlabDecisions: false,
      needsDetails: false,
    },
  });
  const options = vi.mocked(bridge.begin).mock.calls[0]?.[0];
  expect(options).not.toHaveProperty("id");
  const login = new URL(options?.authorizationUrl ?? "");
  expect(login.origin).toBe(origin);
  expect(login.pathname).toBe("/api/goose/v1/auth/login");
  expect(Object.fromEntries(login.searchParams)).toEqual({
    type: "cli",
    product: "buzz",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });
  expect(options).toMatchObject({ useState: true });
  expect(options?.callbackPath).toMatch(/^\/callback\/[0-9a-f-]{36}$/);
  expect(host.request).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      url: `${origin}/api/goose/v1/auth/login/exchange`,
      method: "POST",
      body: JSON.stringify({ code: "one-time", code_verifier: verifier }),
    }),
  );
  expect(host.request).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      url: `${origin}/api/goose/v1/auth/me`,
      headers: {
        Accept: "application/json",
        "X-BB-Session-Credential": "private-token",
      },
    }),
  );
  expect(bridge.wait).toHaveBeenCalledWith(attemptId);
  expect(bridge.complete).toHaveBeenCalledWith(attemptId);
  await expect
    .poll(() => vi.mocked(bridge.cancel).mock.calls)
    .toEqual([[attemptId]]);
});

it("opens the create-account page only when asked to sign up", async () => {
  const hint = async (signup?: boolean) => {
    const { host, bridge, controller } = fixture();
    await browserCredential(host, controller.signal, bridge, signup);
    const options = vi.mocked(bridge.begin).mock.calls[0]?.[0];
    return new URL(options?.authorizationUrl ?? "").searchParams.get(
      "screen_hint",
    );
  };
  expect(await hint(true)).toBe("signup");
  expect(await hint()).toBeNull();
  expect(await hint(false)).toBeNull();
});

it("keeps verified login usable when native focus return fails", async () => {
  const { host, bridge, controller } = fixture();
  vi.mocked(bridge.complete).mockRejectedValue(new Error("Focus unavailable"));
  expect(
    await browserCredential(host, controller.signal, bridge),
  ).toMatchObject({
    value: "private-token",
  });
  expect(bridge.complete).toHaveBeenCalledWith(attemptId);
  await expect
    .poll(() => vi.mocked(bridge.cancel).mock.calls)
    .toEqual([[attemptId]]);
});

it.each(["resolve", "reject"] as const)(
  "signs in before focus return settles and cleans up after it %ss",
  async (outcome) => {
    const { host, bridge } = fixture();
    const started = deferred<void>();
    const focus = deferred<void>();
    const cleaned = deferred<void>();
    vi.mocked(bridge.complete).mockImplementation(() => {
      started.resolve();
      return focus.promise;
    });
    vi.mocked(bridge.cancel).mockImplementation(async () => {
      cleaned.resolve();
    });
    const session = createOAuthSession((signal) =>
      browserCredential(host, signal, bridge),
    );
    const login = session.signIn();
    try {
      await started.promise;
      await expect.poll(() => session.snapshot().status).toBe("signed-in");
      await login;
      expect(session.credential().value).toBe("private-token");
      expect(bridge.complete).toHaveBeenCalledWith(attemptId);
      expect(bridge.cancel).not.toHaveBeenCalled();
    } finally {
      if (outcome === "resolve") focus.resolve();
      else focus.reject(new Error("Focus unavailable"));
      await login;
      await cleaned.promise;
      session.dispose();
    }
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(attemptId);
  },
);

it("does not request focus for an unverified account", async () => {
  const { host, bridge, controller } = fixture();
  vi.mocked(host.request)
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '{"session_credential":"private-token"}',
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '{"subject":""}',
    });
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("valid account");
  expect(bridge.complete).not.toHaveBeenCalled();
  expect(bridge.cancel).toHaveBeenCalledWith(attemptId);
});

it.each([
  [undefined, false],
  [null, false],
  [{}, false],
  [{ can_use_remote_agents: false }, false],
  [{ can_use_remote_agents: "true" }, false],
  [{ can_use_remote_agents: 1 }, false],
  [{ can_use_remote_agents: true }, true],
])(
  "normalizes remote-agent capability %j to %s",
  async (capabilities, expected) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"session_credential":"private-token"}',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ ...account, capabilities }),
      });
    const credential = await browserCredential(host, controller.signal, bridge);
    expect(credential.account.canUseRemoteAgents).toBe(expected);
  },
);

it.each([
  [undefined, false],
  [{}, false],
  [{ can_use_remote_agents: true }, false],
  [{ can_use_builderlab_decisions: false }, false],
  [{ can_use_builderlab_decisions: "true" }, false],
  [{ can_use_builderlab_decisions: 1 }, false],
  [{ can_use_builderlab_decisions: true }, true],
])(
  "normalizes decisions capability %j to %s",
  async (capabilities, expected) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"session_credential":"private-token"}',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ ...account, capabilities }),
      });
    const credential = await browserCredential(host, controller.signal, bridge);
    expect(credential.account.canUseBuilderlabDecisions).toBe(expected);
  },
);

it.each([
  [undefined, false],
  ["ACCOUNT_STATUS_OK", false],
  ["ACCOUNT_STATUS_PENDING", false],
  ["ACCOUNT_STATUS_NEEDS_DETAILS", true],
])(
  "reads account status %j as needing details: %s",
  async (status, expected) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"session_credential":"private-token"}',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ ...account, account_status: status }),
      });
    const credential = await browserCredential(host, controller.signal, bridge);
    expect(credential.account.needsDetails).toBe(expected);
  },
);

it("redacts a rejected exchange and retries with a fresh verifier without downgrading", async () => {
  const { host, bridge, controller } = fixture();
  vi.mocked(host.request).mockResolvedValueOnce({
    status: 401,
    headers: {},
    body: '{"error":"private-detail"}',
  });
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow(/^Builderlab sign-in failed \(HTTP 401\). Try again\.$/);
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(bridge.cancel).toHaveBeenCalledWith(attemptId);
  await browserCredential(host, controller.signal, bridge);
  const verifiers = [0, 1].map((index) => {
    const request = vi.mocked(host.request).mock.calls[index]?.[0];
    const { code_verifier } = JSON.parse(request?.body ?? "{}");
    expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const options = vi.mocked(bridge.begin).mock.calls[index]?.[0];
    const login = new URL(options?.authorizationUrl ?? "");
    expect(login.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(code_verifier).digest("base64url"),
    );
    expect(login.searchParams.has("code_verifier")).toBe(false);
    return code_verifier;
  });
  expect(verifiers[0]).not.toBe(verifiers[1]);
});

it.each(["", "x".repeat(4097)])(
  "refuses invalid one-time codes",
  async (code) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(bridge.wait).mockResolvedValue({ parameters: [["code", code]] });
    await expect(
      browserCredential(host, controller.signal, bridge),
    ).rejects.toThrow("callback code");
    expect(host.request).not.toHaveBeenCalled();
  },
);
describe("failed responses", () => {
  it.each([
    ["{", "invalid sign-in response"],
    ['{"session_credential":""}', "valid credential"],
    ['{"session_credential":"bad\\nheader"}', "valid credential"],
    ['{"session_credential":"invalid-é"}', "valid credential"],
  ])("rejects malformed exchange response %s", async (body, message) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request).mockResolvedValue({
      status: 200,
      headers: {},
      body,
    });
    await expect(
      browserCredential(host, controller.signal, bridge),
    ).rejects.toThrow(message);
    expect(bridge.cancel).toHaveBeenCalled();
  });
  it.each([null, { ...account, subject: " " }, { ...account, subject: 123 }])(
    "refuses an unverified account",
    async (value) => {
      const { host, bridge, controller } = fixture();
      vi.mocked(host.request)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: '{"session_credential":"private-token"}',
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: JSON.stringify(value),
        });
      await expect(
        browserCredential(host, controller.signal, bridge),
      ).rejects.toThrow("valid account");
    },
  );
});
it.each([
  [" a@example.com ", "a@example.com"],
  [undefined, ""],
  [123, ""],
])(
  "accepts an account without workspace data and keeps subject and email %j",
  async (email, expected) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"session_credential":"private-token"}',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          subject: "user",
          email,
          name: "A",
          username: "a",
        }),
      });
    expect(await browserCredential(host, controller.signal, bridge)).toEqual({
      value: "private-token",
      account: {
        subject: "user",
        email: expected,
        canUseRemoteAgents: false,
        canUseBuilderlabDecisions: false,
        needsDetails: false,
      },
    });
  },
);
it("keeps native's timeout apart from other browser failures", async () => {
  const { host, bridge, controller } = fixture();
  // Native rejects with this exact string (`oauth_callback::TIMED_OUT`).
  vi.mocked(bridge.wait).mockRejectedValue("Sign-in timed out. Try again.");
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow(/^Sign-in timed out\. Try again\.$/);
  vi.mocked(bridge.wait).mockRejectedValue("Sign-in listener failed");
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("Could not complete");
});

it("does not cancel an unknown attempt when begin rejects", async () => {
  const { host, bridge, controller } = fixture();
  vi.mocked(bridge.begin).mockRejectedValue("listener unavailable");
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("Could not complete");
  expect(bridge.cancel).not.toHaveBeenCalled();
  expect(host.request).not.toHaveBeenCalled();
});

it("cancellation during challenge hashing does not start a browser attempt", async () => {
  const { host, bridge, controller } = fixture();
  const started = deferred<void>();
  const release = deferred<ArrayBuffer>();
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => {
    started.resolve();
    return release.promise;
  });
  const pending = browserCredential(host, controller.signal, bridge);
  try {
    await started.promise;
    controller.abort();
  } finally {
    release.resolve(new ArrayBuffer(32));
  }
  await expect(pending).rejects.toThrow("canceled");
  expect(bridge.begin).not.toHaveBeenCalled();
  expect(bridge.cancel).not.toHaveBeenCalled();
  expect(host.request).not.toHaveBeenCalled();
});

it.each(["begin", "wait", "exchange", "account"] as const)(
  "cancellation during a held %s ignores its late result and closes the listener",
  async (boundary) => {
    const { host, bridge, controller } = fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    if (boundary === "exchange" || boundary === "account") {
      vi.mocked(host.request).mockImplementation(async ({ url }) => {
        if (url.endsWith(boundary === "exchange" ? "/exchange" : "/auth/me")) {
          started.resolve();
          await release.promise;
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            url.endsWith("/exchange")
              ? { session_credential: "private-token" }
              : account,
          ),
        };
      });
    } else {
      vi.mocked(bridge[boundary]).mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return (
          boundary === "begin"
            ? { id: attemptId, callbackUrl: "http://127.0.0.1:12345/callback" }
            : boundary === "wait"
              ? { parameters: [["code", "one-time"]] }
              : undefined
        ) as never;
      });
    }
    const pending = browserCredential(host, controller.signal, bridge);
    try {
      await started.promise;
      controller.abort();
      if (boundary === "begin") expect(bridge.cancel).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toThrow("canceled");
    expect(bridge.cancel).toHaveBeenCalledWith(attemptId);
    expect(bridge.wait).toHaveBeenCalledTimes(boundary === "begin" ? 0 : 1);
    expect(host.request).toHaveBeenCalledTimes(
      boundary === "account" ? 2 : boundary === "exchange" ? 1 : 0,
    );
  },
);

it("uses the configured public URL without a deployment default", async () => {
  expect(oauthTarget("https://builderlab.example/")).toBe(
    "https://builderlab.example/api/goose",
  );
  expect(oauthTarget("https://builderlab.example/deployment/")).toBe(
    "https://builderlab.example/deployment/api/goose",
  );
  expect(oauthTarget("https://login.example:8443/deployment/")).toBe(
    "https://login.example:8443/deployment/api/goose",
  );
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  const { host, bridge, controller } = fixture();
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("not configured");
  expect(bridge.begin).not.toHaveBeenCalled();
  expect(host.request).not.toHaveBeenCalled();
});
it.each([
  "http://builderlab.example",
  "https://user:secret@builderlab.example",
  "https://builderlab.example/?query=x",
  "https://builderlab.example/#x",
])("refuses unsafe configuration %s", (value) => {
  expect(() => oauthTarget(value)).toThrow("does not support");
});

it.each([
  [
    ["error", "access_denied"],
    ["state", "private-state"],
    ["error_description", "private-detail"],
  ],
  [
    ["code", "one"],
    ["code", "two"],
  ],
] as const)(
  "rejects error or ambiguous callback parameters before exchange",
  async (...parameters) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(bridge.wait).mockResolvedValue({ parameters });
    const result = await browserCredential(
      host,
      controller.signal,
      bridge,
    ).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).not.toContain("private-detail");
    expect(String(result)).not.toContain("private-state");
    expect(host.request).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalled();
  },
);
