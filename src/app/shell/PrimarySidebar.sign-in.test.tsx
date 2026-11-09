// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { connectSignedTransport } from "../../features/relay/transport";
import { nativeSocket } from "../../features/relay/native-socket";
import { hostSigner } from "../../features/relay/testing";
import { federatedFixture } from "../../features/federated-identity/testing";
import { fixture, owners } from "./sidebar-testing";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(),
}));
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.resetAllMocks();
});

/** A protected community whose transport was handed back before NIP-FI
 * admission, as native discovery and local-key restore do: the relay's
 * refusal arrives later, on the live socket. */
async function refusedLive(refusal: string) {
  let connects = 0;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command !== "relay_socket_connect") return Promise.resolve();
    return ++connects === 1 ? Promise.reject(refusal) : new Promise(() => {});
  });
  const identity = federatedFixture();
  const transport = await connectSignedTransport(
    hostSigner(),
    "https://relay.test",
    "e".repeat(64),
    nativeSocket,
  );
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      transport,
      federatedIdentity: identity.service,
    },
  );
  await waitFor(() => expect(f.session.live.snapshot().status).toBe("error"));
  return { identity, connects: () => connects };
}

it("offers explicit sign-in when the live socket refuses a protected community", async () => {
  const h = await refusedLive("Federated sign-in is required");
  // The cached channel list stays; nothing signs in on its own.
  expect(screen.getByRole("button", { name: "Chats" })).toBeVisible();
  expect(
    await screen.findByText(
      "This community requires builderlab.example sign-in.",
    ),
  ).toBeVisible();
  expect(h.identity.service.signIn).not.toHaveBeenCalled();
  expect(h.connects()).toBe(1);
  await userEvent.setup().click(
    await screen.findByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  );
  expect(h.identity.service.signIn).toHaveBeenCalledOnce();
  // A completed sign-in reconnects the live socket with the new session.
  await waitFor(() => expect(h.connects()).toBe(2));
});

it.each([
  ["binding-mismatch", "identity link"],
  ["authorization-denied", "administrator"],
])("shows %s recovery from the live socket", async (refusal, text) => {
  await refusedLive(refusal);
  expect(await screen.findByRole("alert")).toHaveTextContent(text);
  expect(
    screen.queryByRole("button", { name: "Sign in with builderlab.example" }),
  ).toBeNull();
});

it.each(["adapter-refused", "grant-refused", "invalid-response"])(
  "explains a final %s issuer refusal without offering sign-in",
  async (refusal) => {
    const h = await refusedLive(refusal);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restart Buzz to try again",
    );
    expect(screen.getByRole("button", { name: "Chats" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in with builderlab.example" }),
    ).toBeNull();
    expect(h.connects()).toBe(1);
  },
);
