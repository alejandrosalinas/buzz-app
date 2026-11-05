// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { keypair, signed } from "../features/relay/testing";
import { communityDestination } from "../features/communities/destination";

// The startup `home` visit is created inside createServices(), before React
// renders. On a native first run `Welcome` hides `ConnectedApp`, the only
// presenter, for far longer than the visit deadline; that deadline runs only
// while a presenter is attached, so the gate lifting presents the visit as-is.
// The key the gate waits for already holds one community on this device, as
// every setup lane leaves it (joined, restored or handed off), so the channels
// page is what presents.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  Channel: class {
    id = 1;
    onmessage = () => {};
  },
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
  ],
}));
const catalogPlugin = (id: string, name: string) => ({
  manifest: { id, name, apiVersion: 1 },
  source: "bundled",
  revision: "bundled",
  enabled: true,
  previous: null,
  reloadable: false,
  error: null,
});
const member = keypair();
const relayA = "https://relay-a.example";
// Its channel list never arrives: a presenter that waits on it never finishes.
const relayB = "https://relay-b.example";
const relaySelf: Record<string, string> = {
  [relayA]: keypair().pubkey,
  [relayB]: keypair().pubkey,
};
let services: AppServices | undefined;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(isTauri).mockReturnValue(true);
  localStorage.setItem(
    `buzz-client.v1:${member.pubkey}`,
    JSON.stringify({
      profile: { name: "Ada", picture: "", about: "" },
      memberships: [
        { id: relayA, name: "relay-a.example" },
        { id: relayB, name: "relay-b.example" },
      ],
      selected: relayA,
    }),
  );
  let created = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return created ? member.pubkey : null;
    if (command === "identity_legacy_available") return false;
    if (command === "identity_create") {
      created = true;
      return member.pubkey;
    }
    if (command === "get_os_idle_seconds") return 0;
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command === "relay_http") return relayAnswer(args);
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "plugin_catalog")
      return {
        status: "ready",
        externalPluginsPaused: false,
        catalog: {
          profile: "fixture",
          location: "fixture",
          plugins: [catalogPlugin("buzz.channels", "Channels")],
        },
      };
    // Other native owners may initialize, but no actual native operations run.
    throw new Error(`Fixture native capability unavailable: ${command}`);
  });
});
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Both relays answer discovery; only relay-a answers reads, with nothing in them. */
function relayAnswer(args: unknown) {
  const request = args as { community: string; path: string };
  const answer = (status: number, value?: unknown) => ({
    status,
    headers: {},
    body: value === undefined ? "" : JSON.stringify(value),
  });
  const self = relaySelf[request.community];
  if (!self) return answer(404);
  if (request.path === "/") return answer(200, { name: "Buzz Relay", self });
  if (request.path === "/query") {
    if (request.community === relayB) return new Promise(() => {});
    return answer(200, []);
  }
  return answer(404);
}

const notice = () => screen.queryByText("This destination couldn’t open");
/** The first-run landing, which a build without Builderlab still shows. */
const landing = () => screen.queryByRole("button", { name: "Other options" });
async function firstRun() {
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await waitFor(() => expect(landing()).toBeVisible());
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opening",
    entry: { target: { kind: "home" } },
  });
  return current;
}
/** A key lands in the credential store, as every setup lane ends; the gate lifts. */
async function openGate(current: AppServices) {
  await act(async () => {
    await current.identity?.create();
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(notice()).not.toBeInTheDocument();
  expect(landing()).not.toBeInTheDocument();
}

it("presents the startup visit as-is however long the first-run gate stays up", async () => {
  const current = await firstRun();
  const { attempt } = current.navigation.snapshot();
  // Sign-in, setup, join and profile outlast the 15 s deadline many times over.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opening",
    attempt,
  });
  expect(notice()).not.toBeInTheDocument();
  await openGate(current);
  // The same attempt completed on the channels page; nothing was retried.
  expect(current.navigation.snapshot().attempt.id).toBe(attempt.id);
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(current.navigation.snapshot().status).toBe("opened");
  expect(notice()).not.toBeInTheDocument();
});

it("still times out a visit the mounted presenter never finishes", async () => {
  const current = await firstRun();
  await openGate(current);
  const pending = current.navigation.open({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: {
      viewer: member.pubkey,
      communityOrigin: communityDestination(relayB).url,
    },
  });
  // Real time also advances the fake clock here, so leave the boundary a margin.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_000);
  });
  expect(current.navigation.snapshot().status).toBe("opening");
  expect(current.communities.snapshot().selected).toBe(relayB);
  expect(notice()).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await expect(pending).resolves.toEqual({
    status: "failed",
    reason: "timeout",
  });
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});
