// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MobileSettings, mobileAppStores } from "./MobileApp";
import type { ClientSnapshot } from "../../features/communities/service";
import type { SessionSnapshot } from "../../features/federated-identity/service";
import type {
  PairingNative,
  PairingStatus,
} from "../../features/pairing/client";

vi.mock("@tauri-apps/api/core", async (actual) => ({
  ...(await actual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));

beforeEach(() => {
  // No native QR renderer unless a test supplies one.
  vi.mocked(invoke).mockRejectedValue(new Error("no renderer"));
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

const stores = [
  { name: "the App Store", url: "https://apps.example.com/ios" },
  { name: "Google Play", url: "https://apps.example.com/android" },
];

const viewer = "a".repeat(64);

function session(state: SessionSnapshot["status"]) {
  let snapshot = {
    status: state,
    email: "you@example.com",
    revision: "r1",
    authority: { apiBasePath: "/api/goose/" },
  } as SessionSnapshot;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: Partial<SessionSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

/** The app-owned account check, answering `ok` (or rejecting). */
const restores = (answer: () => Promise<boolean> = async () => true) =>
  vi.fn(async (_viewer: string) => answer());

/** This device's key backup, which a test can finish. */
function backups() {
  let complete = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    backupComplete: () => complete,
    finish() {
      complete = true;
      for (const listener of listeners) listener();
    },
  };
}

function pairing() {
  let status: PairingStatus = { phase: "idle" };
  const native = {
    account: vi.fn(async () => "a".repeat(64)),
    start: vi.fn(async () => {
      status = { phase: "qr", svg: "<svg/>", uri: "nostrpair://fixture" };
    }),
    status: vi.fn(async (): Promise<PairingStatus> => status),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
  } satisfies PairingNative;
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected: "wss://relay.example",
    profile: { name: "", picture: "" },
    memberships: [],
    sync: { known: [], outbox: [] },
  };
  return {
    native,
    props: {
      communities: { snapshot: () => snapshot, subscribe: () => () => {} },
      active: () => true,
    },
  };
}

const GET_THE_APP = { name: "Get Buzz on your phone" };
const PAIR = { name: "Pair mobile" };

function renderCard(
  federatedIdentity: ReturnType<typeof session> | undefined,
  cardStores: readonly { name: string; url: string }[] = stores,
  restoresOnPhone: ReturnType<typeof restores> | undefined = restores(),
  backup: ReturnType<typeof backups> = backups(),
  available = false,
) {
  const { native, props } = pairing();
  render(
    <MobileSettings
      {...props}
      native={native}
      available={available}
      federatedIdentity={federatedIdentity}
      phone={federatedIdentity ? { ...backup, restoresOnPhone } : undefined}
      stores={cardStores}
    />,
  );
  return native;
}

it("when this key is the account's backed-up key, says to get the app and sign in there, with each store's link and QR code, and never pairs", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "qr_code") throw new Error(`Unexpected ${command}`);
    return `<svg data-value="${(args as { value: string }).value}"/>`;
  });
  const check = restores();
  const native = renderCard(session("signed-in"), stores, check);
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  expect(check).toHaveBeenCalledExactlyOnceWith(viewer);
  expect(
    screen.getByText(
      "Install Buzz on your phone, then sign in with Builderlab as you@example.com.",
    ),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Get it on the App Store" })
      .getAttribute("href"),
  ).toBe("https://apps.example.com/ios");
  expect(
    screen
      .getByRole("link", { name: "Get it on Google Play" })
      .getAttribute("href"),
  ).toBe("https://apps.example.com/android");
  const ios = await screen.findByAltText(
    "Scan with your phone to get Buzz from the App Store",
  );
  expect(decodeURIComponent(ios.getAttribute("src") ?? "")).toContain(
    'data-value="https://apps.example.com/ios"',
  );
  expect(
    await screen.findByAltText(
      "Scan with your phone to get Buzz from Google Play",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/pair/i)).toBeNull();
  expect(native.account).not.toHaveBeenCalled();
  expect(native.start).not.toHaveBeenCalled();
});

it("while the account is read, shows neither view, so pairing never mounts", async () => {
  let answer!: (ok: boolean) => void;
  const check = restores(
    () => new Promise<boolean>((resolve) => (answer = resolve)),
  );
  renderCard(session("signed-in"), stores, check);
  await waitFor(() => expect(check).toHaveBeenCalledOnce());
  // The card's heading holds its place; the surface is never blank.
  expect(screen.getByRole("heading", { name: "Mobile app" })).toBeTruthy();
  expect(screen.queryByRole("heading", PAIR)).toBeNull();
  expect(screen.queryByRole("heading", GET_THE_APP)).toBeNull();
  await act(async () => answer(true));
  expect(screen.getByRole("heading", GET_THE_APP)).toBeTruthy();
  expect(screen.queryByRole("heading", PAIR)).toBeNull();
});

it.each([
  ["the account check answers no", async () => false],
  ["the account check fails", () => Promise.reject(new Error("timed out"))],
])("pairs the phone when %s", async (_, answer) => {
  renderCard(session("signed-in"), stores, restores(answer));
  expect(await screen.findByRole("heading", PAIR)).toBeTruthy();
  expect(screen.queryByRole("heading", GET_THE_APP)).toBeNull();
});

it("reads the account again for a new Builderlab session", async () => {
  const federated = session("signed-in");
  const check = restores();
  renderCard(federated, [], check);
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  await act(async () => federated.publish({ revision: "r2" }));
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
});

it("reads the account again when a backup finishes, and offers the app once it holds this key", async () => {
  const backup = backups();
  const check = vi.fn(async () => backup.backupComplete());
  renderCard(session("signed-in"), [], check, backup);
  expect(await screen.findByRole("heading", PAIR)).toBeTruthy();
  await act(async () => backup.finish());
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  expect(check).toHaveBeenCalledTimes(2);
});

it.each(["restoring", "signing-in"] as const)(
  "while Builderlab is %s, waits instead of starting pairing",
  async (status) => {
    const federated = session(status);
    const check = restores();
    const native = renderCard(federated, [], check, backups(), true);
    expect(screen.getByRole("heading", { name: "Mobile app" })).toBeTruthy();
    expect(screen.queryByRole("heading", PAIR)).toBeNull();
    await act(async () => federated.publish({ status: "signed-in" }));
    expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
    expect(native.start).not.toHaveBeenCalled();
  },
);

it("keeps a shown pairing while a new session reads the account again", async () => {
  const federated = session("signed-in");
  let answer: ((ok: boolean) => void) | undefined;
  const check = vi.fn(
    (_viewer: string) =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const native = renderCard(federated, [], check, backups(), true);
  await waitFor(() => expect(check).toHaveBeenCalledOnce());
  await act(async () => answer?.(false));
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
  await waitFor(() => expect(native.start).toHaveBeenCalledOnce());
  await act(async () => federated.publish({ revision: "r2" }));
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  // Still pairing while r2 is read, and after it answers the same.
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
  await act(async () => answer?.(false));
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
  expect(native.start).toHaveBeenCalledOnce();
  expect(native.cancel).not.toHaveBeenCalled();
});

it("without store links, gives the same instructions without links", async () => {
  renderCard(session("signed-in"), []);
  expect(
    await screen.findByText(
      "Install Buzz on your phone from its app store, then sign in with Builderlab as you@example.com.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("qr_code", expect.anything());
});

it("keeps a store's link when its QR code can't be drawn", async () => {
  renderCard(session("signed-in"), stores.slice(0, 1));
  expect(
    await screen.findByRole("link", { name: "Get it on the App Store" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("qr_code", {
      value: "https://apps.example.com/ios",
      variant: "light",
    }),
  );
  await waitFor(() =>
    expect(document.querySelector(".bg-surface-inset")).toBeNull(),
  );
  expect(screen.queryByRole("img")).toBeNull();
});

it.each([
  ["signed out of Builderlab", () => session("signed-out")],
  ["in a build without Builderlab", () => undefined],
])("pairs the phone without reading the account when %s", (_, make) => {
  const check = restores();
  renderCard(make(), stores, check);
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(check).not.toHaveBeenCalled();
});

it("switches to pairing when the Builderlab session ends", async () => {
  const federated = session("signed-in");
  renderCard(federated, []);
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  act(() => federated.publish({ status: "reauthentication-required" }));
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
});

it("lists only the store links the build sets", () => {
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_IOS_URL", "");
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_ANDROID_URL", "https://apps.example.com/a");
  expect(mobileAppStores()).toEqual([
    { name: "Google Play", url: "https://apps.example.com/a" },
  ]);
});

it("draws store codes in the color mode's variant and redraws them when it changes", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "qr_code") throw new Error(`Unexpected ${command}`);
    return `<svg data-variant="${(args as { variant: string }).variant}"/>`;
  });
  document.documentElement.dataset.colorMode = "dark";
  try {
    renderCard(session("signed-in"), stores.slice(0, 1));
    const alt = "Scan with your phone to get Buzz from the App Store";
    const variant = () =>
      decodeURIComponent(screen.getByAltText(alt).getAttribute("src") ?? "");
    await screen.findByAltText(alt);
    expect(variant()).toContain('data-variant="dark"');
    act(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    await waitFor(() => expect(variant()).toContain('data-variant="light"'));
  } finally {
    delete document.documentElement.dataset.colorMode;
  }
});
