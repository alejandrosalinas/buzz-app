import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addressInputUrl,
  createBrowserPlatform,
  validateBrowsableUrl,
} from "./platform";

const sdk = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
const native = vi.hoisted(() => ({ value: false }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: sdk.invoke,
}));

afterEach(() => {
  native.value = false;
  sdk.invoke.mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("validateBrowsableUrl", () => {
  it("accepts normalized HTTP(S) URLs", () => {
    expect(validateBrowsableUrl("https://example.com")).toEqual({
      ok: true,
      url: "https://example.com/",
    });
  });

  it("rejects unsafe, credentialed, malformed, and oversized URLs", () => {
    expect(validateBrowsableUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateBrowsableUrl("https://user:pass@example.com").ok).toBe(
      false,
    );
    expect(validateBrowsableUrl("not a url").ok).toBe(false);
    expect(
      validateBrowsableUrl(`https://example.com/#${"文".repeat(300)}`).ok,
    ).toBe(false);
  });
});

describe("addressInputUrl", () => {
  it("defaults address input without a scheme to https with an http fallback", () => {
    const upgraded = (url: string) => ({ url, fallbackToHttp: true });
    expect(addressInputUrl("grugbrain.dev/")).toEqual(
      upgraded("https://grugbrain.dev/"),
    );
    expect(addressInputUrl("  example.com/path?q=1  ")).toEqual(
      upgraded("https://example.com/path?q=1"),
    );
    expect(addressInputUrl("localhost:3000")).toEqual(
      upgraded("https://localhost:3000"),
    );
    expect(addressInputUrl("[::1]:8080/")).toEqual(
      upgraded("https://[::1]:8080/"),
    );
  });

  it("keeps an explicit scheme, without fallback, so validation still rejects unsafe input", () => {
    const typed = (url: string) => ({ url, fallbackToHttp: false });
    expect(addressInputUrl("https://example.com")).toEqual(
      typed("https://example.com"),
    );
    expect(addressInputUrl("http://example.com")).toEqual(
      typed("http://example.com"),
    );
    expect(addressInputUrl("javascript:alert(1)")).toEqual(
      typed("javascript:alert(1)"),
    );
    expect(addressInputUrl("file:///etc/passwd")).toEqual(
      typed("file:///etc/passwd"),
    );
    expect(addressInputUrl("   ")).toEqual(typed(""));
  });
});

describe("createBrowserPlatform", () => {
  it("is available only in the macOS desktop host", () => {
    native.value = true;
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(createBrowserPlatform().available).toBe(true);
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(createBrowserPlatform().available).toBe(false);
    native.value = false;
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(createBrowserPlatform().available).toBe(false);
  });

  it("passes session IDs, bounds, actions, and normalized URLs", async () => {
    native.value = true;
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    sdk.invoke.mockResolvedValueOnce("session-1" as never);
    const platform = createBrowserPlatform();
    const bounds = { x: 1, y: 2, width: 300, height: 400 };
    await expect(platform.attach("https://example.com", bounds)).resolves.toBe(
      "session-1",
    );
    await platform.attach("https://example.com", bounds, "builderlab-apps");
    await platform.setBounds("session-1", bounds, true);
    await platform.navigate("session-1", "https://other.example.com");
    await platform.navigate("session-1", "https://typed.example.com", true);
    await platform.action("session-1", "reload");
    await platform.status("session-1");
    await platform.detach("session-1");
    expect(sdk.invoke.mock.calls).toEqual([
      [
        "browser_attach",
        {
          url: "https://example.com/",
          bounds,
          storage: null,
          builderlab: null,
        },
      ],
      [
        "browser_attach",
        {
          url: "https://example.com/",
          bounds,
          storage: "builderlab-apps",
          builderlab: null,
        },
      ],
      ["browser_set_bounds", { sessionId: "session-1", bounds, visible: true }],
      [
        "browser_navigate",
        {
          sessionId: "session-1",
          url: "https://other.example.com/",
          fallbackToHttp: false,
        },
      ],
      [
        "browser_navigate",
        {
          sessionId: "session-1",
          url: "https://typed.example.com/",
          fallbackToHttp: true,
        },
      ],
      ["browser_action", { sessionId: "session-1", action: "reload" }],
      ["browser_status", { sessionId: "session-1" }],
      ["browser_detach", { sessionId: "session-1" }],
    ]);
  });

  it("does not navigate an authenticated attach that finishes after sign-out", async () => {
    let finish!: (value: string) => void;
    sdk.invoke.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }) as never,
    );
    const lifetime = new AbortController();
    const platform = createBrowserPlatform();
    const attach = platform.attach(
      "https://counter--workspace.apps.example/second",
      { x: 0, y: 0, width: 1, height: 1 },
      "account",
      { credential: "private", storage: "account", signal: lifetime.signal },
    );
    const rejected = expect(attach).rejects.toThrow();
    lifetime.abort();
    finish("late-session");
    await rejected;
    expect(sdk.invoke).toHaveBeenCalledTimes(2);
    expect(sdk.invoke).toHaveBeenNthCalledWith(2, "browser_detach", {
      sessionId: "late-session",
    });
  });

  it("navigates the original deep URL only after authenticated cookie installation", async () => {
    sdk.invoke.mockResolvedValueOnce("viewer" as never);
    const lifetime = new AbortController();
    const url = "https://counter--workspace.apps.example/second?q=1#part";
    await createBrowserPlatform().attach(
      url,
      { x: 0, y: 0, width: 1, height: 1 },
      "account",
      { credential: "private", storage: "account", signal: lifetime.signal },
    );
    expect(sdk.invoke.mock.calls.at(-1)).toEqual([
      "browser_navigate",
      { sessionId: "viewer", url, fallbackToHttp: false },
    ]);
  });

  it("sends only the public federated revision for a federated viewer", async () => {
    sdk.invoke.mockResolvedValueOnce("viewer" as never);
    const lifetime = new AbortController();
    const bounds = { x: 0, y: 0, width: 1, height: 1 };
    await createBrowserPlatform().attach(
      "https://counter--workspace.apps.example/",
      bounds,
      "account",
      { federated: "revision-1", storage: "account", signal: lifetime.signal },
    );
    expect(sdk.invoke.mock.calls[0]).toEqual([
      "browser_attach",
      {
        url: "https://counter--workspace.apps.example/",
        bounds,
        storage: "account",
        builderlab: { federated: "revision-1" },
      },
    ]);
  });

  it("rejects an invalid URL before native invocation", async () => {
    const platform = createBrowserPlatform();
    await expect(
      platform.attach("file:///etc/passwd", {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow("Only http and https URLs are supported");
    expect(sdk.invoke).not.toHaveBeenCalled();
  });
});
