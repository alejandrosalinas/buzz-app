import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FederatedIdentityService } from "../../../features/federated-identity/service";
import { federatedFixture } from "../../../features/federated-identity/testing";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import { bundledFederatedIdentity, firstRunCredential } from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const catalog = (enabled: boolean): StorageResult => ({
  status: "ready",
  catalog: {
    profile: "default",
    location: "/profiles/default",
    plugins: [
      {
        manifest: { ...manifest, apiVersion: 1 },
        source: "bundled",
        revision: "bundled",
        enabled,
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  },
  externalPluginsPaused: false,
});

// A disabled bundled plugin has no native grant, so its account read fails.
it.each([
  [
    "Builderlab is turned off",
    () => vi.mocked(invoke).mockResolvedValueOnce(catalog(false)),
    "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
  ],
  [
    "the plugin catalog cannot be read",
    () => vi.mocked(invoke).mockRejectedValueOnce("Plugin manager unavailable"),
    "Could not complete Builderlab sign-in. Try again.",
  ],
])(
  "refuses before opening the browser when %s",
  async (_label, answer, message) => {
    answer();
    const fi = federatedFixture();
    await expect(
      firstRunCredential(new AbortController().signal, fi.service),
    ).rejects.toThrow(new Error(message));
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
    expect(fi.service.signIn).not.toHaveBeenCalled();
  },
);

describe("the NIP-FI sign-in", () => {
  const me = {
    subject: "user",
    email: " a@example.com ",
    capabilities: { can_use_remote_agents: true },
  };

  it("calls the NIP-FI forwarder as the bundled installation, before the plugin starts", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "federated_identity_snapshot")
        return { ...federatedFixture().service.snapshot(), revision: "r" };
      if (command === "federated_identity_request")
        return { status: 200, headers: {}, body: "{}" };
    });
    const root = new Context();
    new FederatedIdentityService(root);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot"),
    );
    const request = { path: "/api/goose/v1/auth/me", method: "GET" as const };
    await bundledFederatedIdentity(root).request(request);
    expect(invoke).toHaveBeenCalledWith("federated_identity_register", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
    });
    expect(invoke).toHaveBeenCalledWith("federated_identity_request", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
      session: "r",
      request,
    });
    await root.fiber.dispose();
  });

  it("reads the account as the session sign-in answered with, when its event arrives after the answer", async () => {
    let emit!: (payload: unknown) => void;
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      if (name === "federated-identity")
        emit = (payload) => handler({ payload } as never);
      return () => {};
    });
    const base = federatedFixture().service.snapshot();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "plugin_catalog") return catalog(true);
      if (command === "federated_identity_snapshot") return base;
      if (command === "federated_identity_register") return undefined;
      if (command === "federated_identity_sign_in") {
        // The browser step's event, then native answers before its final event.
        emit({ ...base, status: "signing-in", revision: "login" });
        setTimeout(() =>
          emit({ ...base, status: "signed-in", revision: "chosen" }),
        );
        return { ...base, status: "signed-in", revision: "chosen" };
      }
      if (command === "federated_identity_request") {
        if ((args as { session: string }).session !== "chosen")
          throw new Error("stale-session");
        return { status: 200, headers: {}, body: JSON.stringify(me) };
      }
      throw new Error(`Unexpected ${command}`);
    });
    const root = new Context();
    new FederatedIdentityService(root);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot"),
    );
    const credential = await firstRunCredential(
      new AbortController().signal,
      bundledFederatedIdentity(root),
    );
    expect(credential.revision).toBe("chosen");
    await root.fiber.dispose();
  });

  it.each([
    ["continues as the renewal", "renewed"],
    ["yields to a newer session", "newer"],
    ["stops on Cancel", "cancel"],
  ] as const)(
    "after adopting a session and renewing it with delayed events, %s",
    async (_, ending) => {
      let emit!: (payload: unknown) => void;
      vi.mocked(listen).mockImplementation(async (name, handler) => {
        if (name === "federated-identity")
          emit = (payload) => handler({ payload } as never);
        return () => {};
      });
      const base = federatedFixture().service.snapshot();
      const at = (revision: string) => ({
        ...base,
        status: "signed-in",
        revision,
      });
      const requests: string[] = [];
      let signIns = 0;
      let renewed!: () => void;
      const answered = new Promise<void>((resolve) => {
        renewed = resolve;
      });
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === "plugin_catalog") return catalog(true);
        if (command === "federated_identity_snapshot") return base;
        if (command === "federated_identity_register") return undefined;
        if (command === "federated_identity_cancel_sign_in") return undefined;
        if (command === "federated_identity_sign_in") {
          // Adoption answers before B's event; that event lands mid-renewal,
          // and the renewal answers C before C's event.
          if (++signIns === 1) return at("B");
          emit(at("B"));
          renewed();
          return at("C");
        }
        if (command === "federated_identity_request") {
          requests.push((args as { session: string }).session);
          return { status: 200, headers: {}, body: JSON.stringify(me) };
        }
        throw new Error(`Unexpected ${command}`);
      });
      const root = new Context();
      new FederatedIdentityService(root);
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot"),
      );
      const abort = new AbortController();
      const result = firstRunCredential(
        abort.signal,
        bundledFederatedIdentity(root),
      );
      await answered;
      await new Promise((resolve) => setTimeout(resolve));
      expect(requests).toEqual([]);
      if (ending === "renewed") emit(at("C"));
      if (ending === "newer") emit(at("D"));
      if (ending === "cancel") abort.abort();
      if (ending === "renewed") expect((await result).revision).toBe("C");
      else await expect(result).rejects.toThrow();
      expect(requests).toEqual(ending === "renewed" ? ["C"] : []);
      await root.fiber.dispose();
    },
  );

  it("signs in through the native session and reads its account", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify(me),
    });
    const credential = await firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    expect(credential).toEqual({
      revision: fi.service.snapshot().revision,
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    });
    expect(fi.service.signIn).toHaveBeenCalledOnce();
    expect(fi.request.mock.calls).toEqual([
      [
        {
          path: "/api/goose/v1/auth/me",
          method: "GET",
          headers: { Accept: "application/json" },
        },
      ],
    ]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  });

  it.each([
    [
      "the native sign-in did not finish",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () => ({
          ...fi.service.snapshot(),
          failure: "sign-in-canceled",
        })),
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "a renewal of the existing session does not finish",
      (fi: ReturnType<typeof federatedFixture>) => {
        fi.publish({ status: "signed-in", revision: "existing" });
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
          fi.service.snapshot(),
        );
      },
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "native refuses the sign-in with a failure code",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi
          .mocked(fi.service.signIn)
          .mockRejectedValueOnce(new Error("storage-busy")),
      "Secure storage is busy. Close another Buzz instance and try again.",
    ],
    [
      "the browser step outlasts native's wait",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi
          .mocked(fi.service.signIn)
          .mockRejectedValueOnce(new Error("sign-in-timed-out")),
      "Sign-in timed out. Try again.",
    ],
    [
      "the account read is not JSON",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: "<html>",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the account read is refused",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 403,
          headers: {},
          body: "",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the session changes during the account read",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockImplementationOnce(async () => {
          fi.publish({ revision: "replaced" });
          return { status: 200, headers: {}, body: JSON.stringify(me) };
        }),
      "Could not load your Builderlab account. Try again.",
    ],
  ])("fails when %s", async (_label, arrange, message) => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    arrange(fi);
    await expect(
      firstRunCredential(new AbortController().signal, fi.service),
    ).rejects.toThrow(new Error(message));
  });

  it.each([
    {},
    { signup: true },
    { forceLogin: true },
    { signup: true, forceLogin: true },
  ])(
    "asks the native sign-in for the sign-up screen and a forced login only as Welcome chose (%o)",
    async (options) => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify(me),
      });
      await firstRunCredential(
        new AbortController().signal,
        fi.service,
        options,
      );
      expect(vi.mocked(fi.service.signIn).mock.calls).toEqual([[options]]);
    },
  );

  it("continues as the account the browser chose again for a session that already exists", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "signed-in", revision: "existing" });
    fi.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify(me),
    });
    const credential = await firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    expect(credential.revision).toBe("user:1");
    expect(fi.service.signIn).toHaveBeenCalledOnce();
  });

  it("waits for the stored session to be restored, then signs in again rather than continuing as it", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "restoring" });
    const subscribe = vi.spyOn(fi.service, "subscribe");
    // The renewal is canceled in the browser.
    vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
      fi.service.snapshot(),
    );
    const credential = firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    expect(fi.service.signIn).not.toHaveBeenCalled();
    fi.publish({ status: "signed-in", revision: "restored" });
    await expect(credential).rejects.toThrow(
      "Sign-in was canceled. Sign in when you’re ready.",
    );
    expect(fi.service.signIn).toHaveBeenCalledOnce();
  });

  it("cancels while waiting for the restore without signing in", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "restoring" });
    const subscribe = vi.spyOn(fi.service, "subscribe");
    // Native has no sign-in to cancel yet, so nothing is published.
    vi.mocked(fi.service.cancelSignIn).mockImplementationOnce(async () => {});
    const attempt = new AbortController();
    const credential = firstRunCredential(attempt.signal, fi.service);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    attempt.abort();
    await expect(credential).rejects.toThrow("Sign-in canceled.");
    expect(fi.service.signIn).not.toHaveBeenCalled();
  });

  describe("from signed out, when another copy saved a session", () => {
    const adopt = (fi: ReturnType<typeof federatedFixture>) =>
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        // Native adopts the shared session: no browser step.
        fi.publish({ status: "signed-in", revision: "other-copy" });
        return fi.service.snapshot();
      });

    it("renews the adopted session so the browser chooses the account", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      adopt(fi);
      fi.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify(me),
      });
      const credential = await firstRunCredential(
        new AbortController().signal,
        fi.service,
      );
      expect(credential.revision).toBe("user:1");
      expect(fi.service.signIn).toHaveBeenCalledTimes(2);
    });

    it("never continues as the adopted account when its renewal is canceled", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      adopt(fi);
      // A canceled renewal answers with the session it would have replaced.
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
        fi.service.snapshot(),
      );
      await expect(
        firstRunCredential(new AbortController().signal, fi.service),
      ).rejects.toThrow();
      expect(fi.service.signIn).toHaveBeenCalledTimes(2);
      expect(fi.request).not.toHaveBeenCalled();
    });
  });

  describe("after a failed restore", () => {
    const account = (fi: ReturnType<typeof federatedFixture>) =>
      fi.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify(me),
      });

    it("renews a stored session that signing in restores with no browser step", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      account(fi);
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        fi.publish({ status: "signed-in", revision: "stored", failure: null });
        return fi.service.snapshot();
      });
      const options = { signup: true, forceLogin: true };
      const credential = await firstRunCredential(
        new AbortController().signal,
        fi.service,
        options,
      );
      expect(credential.revision).toBe("user:1");
      // The renewal is the one that opens the browser: it keeps the choices.
      expect(vi.mocked(fi.service.signIn).mock.calls).toEqual([
        [options],
        [options],
      ]);
    });

    it("continues after a browser sign-in, without renewing it", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      account(fi);
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        fi.publish({ status: "signing-in", revision: "login", failure: null });
        fi.publish({ status: "signed-in", revision: "chosen" });
        return fi.service.snapshot();
      });
      const credential = await firstRunCredential(
        new AbortController().signal,
        fi.service,
      );
      expect(credential.revision).toBe("chosen");
      expect(fi.service.signIn).toHaveBeenCalledOnce();
    });

    it("fails without signing in again when the restore fails again", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
        fi.service.snapshot(),
      );
      await expect(
        firstRunCredential(new AbortController().signal, fi.service),
      ).rejects.toThrow(new Error("Sign-in did not finish. Try again."));
      expect(fi.service.signIn).toHaveBeenCalledOnce();
    });

    it("cancels a browser step that begins after Cancel found nothing to cancel, but not a newer sign-in's", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      // Native is still restoring when Cancel arrives, so it cancels nothing.
      vi.mocked(fi.service.cancelSignIn).mockImplementationOnce(async () => {});
      let restored!: () => void;
      const restoring = new Promise<void>((resolve) => {
        restored = resolve;
      });
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        started();
        await restoring;
        // The browser step ends only when it is canceled.
        const canceled = new Promise<void>((resolve) =>
          vi
            .mocked(fi.service.cancelSignIn)
            .mockImplementationOnce(async () => resolve()),
        );
        fi.publish({ status: "signing-in", revision: "login", failure: null });
        await canceled;
        fi.publish({ status: "signed-out", failure: "sign-in-canceled" });
        const answer = fi.service.snapshot();
        // Signing in again after Cancel opens the browser before this call's
        // answer arrives.
        fi.publish({ status: "signing-in", revision: "newer", failure: null });
        return answer;
      });
      const attempt = new AbortController();
      const credential = firstRunCredential(attempt.signal, fi.service);
      await pending;
      attempt.abort();
      expect(fi.service.cancelSignIn).toHaveBeenCalledOnce();
      const canceled = expect(credential).rejects.toThrow("Sign-in canceled.");
      restored();
      await vi.waitFor(() =>
        expect(fi.service.cancelSignIn).toHaveBeenCalledTimes(2),
      );
      await canceled;
      expect(fi.service.cancelSignIn).toHaveBeenCalledTimes(2);
    });
  });

  it("cancels the native sign-in when first run cancels", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
      fi.publish({ status: "signing-in", revision: "login" });
      started();
      await new Promise<void>((resolve) =>
        vi
          .mocked(fi.service.cancelSignIn)
          .mockImplementationOnce(async () => resolve()),
      );
      fi.publish({ status: "signed-out", failure: "sign-in-canceled" });
      const answer = fi.service.snapshot();
      // Signing in again after Cancel opens the browser before this call's
      // answer arrives.
      fi.publish({ status: "signing-in", revision: "newer" });
      return answer;
    });
    const attempt = new AbortController();
    const credential = firstRunCredential(attempt.signal, fi.service);
    await pending;
    attempt.abort();
    await expect(credential).rejects.toThrow("Sign-in canceled.");
    expect(fi.service.cancelSignIn).toHaveBeenCalledOnce();
    expect(fi.request).not.toHaveBeenCalled();
  });
});
