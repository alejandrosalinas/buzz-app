// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { SignInAction } from "./SignInAction";
import type { BuilderlabSession } from "../session";
import { createOAuthSession } from "../oauth/session";
import {
  browserCredential,
  type Credential,
  type OAuthCallback,
  type BrowserBridge,
} from "../oauth/browser";
import type { Agent } from "../../../features/agents/service";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createSettingsTab } from "./Instructions";
import { deferred } from "../test-helpers";
import { AccountRecoverySheet, createProfileActions } from "./SignInFooter";

vi.mock("../oauth/browser", async (original) => ({
  ...(await original<typeof import("../oauth/browser")>()),
  browserLoginAvailable: () => true,
}));
const signInControl = (session: BuilderlabSession) => () => (
  <SignInAction session={session} />
);

const credential: Credential = {
  value: "private-credential",
  account: {
    subject: "account",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("keeps account verification non-cancellable after the browser guidance deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = createOAuthSession(async () => credential);
  const cancel = vi.fn();
  const Footer = signInControl({
    ...session,
    snapshot: () => checking,
    cancel,
  });
  const checking = { status: "pending" as const, checking: true };
  render(<Footer />);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your Builderlab sign-in",
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  );
  expect(cancel).not.toHaveBeenCalled();
  session.dispose();
});

it("offers browser logout for FI account recovery and explicitly ends its session", () => {
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createOAuthSession(async () => credential);
  const signOut = vi.spyOn(session, "signOut");
  render(<AccountRecoverySheet session={session} active mismatch={false} />);
  const action = screen.getByRole("button", { name: "Use another account" });
  expect(action).toHaveAttribute("href", "https://builderlab.example/logout");
  fireEvent.click(action);
  expect(signOut).toHaveBeenCalledOnce();
  session.dispose();
});

it("automatically starts once, keeps slow login inline, and does not loop after cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const held = deferred<Credential>();
  const acquire = vi.fn((_signal: AbortSignal) => held.promise);
  const session = createOAuthSession(acquire);
  render(<SignInAction session={session} automatic />, { wrapper: StrictMode });
  expect(acquire).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(screen.queryByRole("region")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole("status")).toHaveTextContent(/Finish signing in/);
  expect(screen.queryByRole("region")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(acquire.mock.calls[0]?.[0].aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(acquire).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  ).toBeEnabled();
  await act(async () => held.resolve(credential));
  expect(session.snapshot().status).toBe("signed-out");
  session.dispose();
});

it("finishes a fast automatic sign-in without showing its sheet", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const held = deferred<Credential>();
  const session = createOAuthSession(() => held.promise);
  const signIn = vi.spyOn(session, "signIn");
  render(<SignInAction session={session} automatic />);
  await act(async () => {
    held.resolve(credential);
    await signIn.mock.results[0]?.value;
  });
  expect(session.snapshot().status).toBe("signed-in");
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByRole("region")).toBeNull();
  session.dispose();
});

it("shows automatic login failures inline and retries only when asked", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  render(<SignInAction session={session} automatic />);
  await act(async () => held.reject(new Error("Browser could not open.")));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Browser could not open.",
  );
  expect(acquire).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region")).toBeNull();
  acquire.mockResolvedValueOnce(credential);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  );
  await waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
  expect(acquire).toHaveBeenCalledTimes(2);
  session.dispose();
});

it("returns a timed-out automatic login to inline retry without a sheet", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  render(<SignInAction session={session} automatic />);
  await act(async () =>
    held.reject(new Error("Builderlab authentication timed out")),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("timed out");
  expect(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  ).toBeEnabled();
  expect(screen.queryByRole("region")).toBeNull();
  expect(acquire).toHaveBeenCalledOnce();
  acquire.mockResolvedValueOnce(credential);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  );
  await waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
  expect(acquire).toHaveBeenCalledTimes(2);
  session.dispose();
});

it("retains an existing sign-in failure on opening instead of starting another attempt", async () => {
  const acquire = vi.fn(async () => {
    throw new Error("Sign-in failed.");
  });
  const session = createOAuthSession(acquire);
  await session.signIn();
  render(<SignInAction session={session} automatic />, { wrapper: StrictMode });
  expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed.");
  expect(acquire).toHaveBeenCalledOnce();
  session.dispose();
});

it("waits for restoration and leaves the subsequent login running when Identity closes", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  const signIn = vi.spyOn(session, "signIn");
  const checking = { status: "pending" as const, checking: true };
  let restoring = true;
  const listeners = new Set<() => void>();
  const projected: BuilderlabSession = {
    ...session,
    snapshot: () => (restoring ? checking : session.snapshot()),
    subscribe: (listener) => {
      listeners.add(listener);
      const stop = session.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  };
  const view = render(<SignInAction session={projected} automatic />, {
    wrapper: StrictMode,
  });
  expect(acquire).not.toHaveBeenCalled();
  expect(screen.queryByRole("region")).toBeNull();
  act(() => {
    restoring = false;
    for (const changed of listeners) changed();
  });
  expect(acquire).toHaveBeenCalledOnce();
  view.unmount();
  expect(session.snapshot().status).toBe("pending");
  held.resolve(credential);
  await signIn.mock.results[0]?.value;
  expect(session.snapshot().status).toBe("signed-in");
  session.dispose();
});

it("keeps Message independent of the compact sign-in action and gates profile edits", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  const ProfileActions = createProfileActions(session);
  const Footer = signInControl(session);
  render(
    <>
      <button type="button">Message</button>
      <ProfileActions>
        <button type="button">Edit profile</button>
      </ProfileActions>
      <Footer />
    </>,
    { wrapper: StrictMode },
  );
  expect(screen.queryByRole("button", { name: "Edit profile" })).toBeNull();
  expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
  expect(screen.queryByText(/Offline|Signed out of Builderlab/)).toBeNull();
  expect(acquire).not.toHaveBeenCalled();
  const signIn = screen.getByRole("button", {
    name: "Sign in to Builderlab",
  });
  fireEvent.click(signIn);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Offline|Signed out of Builderlab/)).toBeNull();
  await waitFor(() => expect(signIn).toBeVisible());
  expect(signIn).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(async () => held.resolve(credential));
  expect(
    await screen.findByRole("button", { name: "Edit profile" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Sign in to Builderlab" }),
  ).toBeNull();
  act(() => session.signOut());
  expect(screen.queryByRole("button", { name: "Edit profile" })).toBeNull();
  expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: "Sign in to Builderlab" }),
  ).toHaveLength(1);
  session.dispose();
});

it("keeps keyboard focus while sign-in is pending and blocks repeat activation", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  const Footer = signInControl(session);
  render(<Footer />);
  const user = userEvent.setup();
  const signIn = screen.getByRole("button", { name: "Sign in to Builderlab" });
  try {
    await user.tab();
    expect(signIn).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(signIn).toHaveAttribute("aria-busy", "true");
    expect(signIn).toHaveAttribute("aria-disabled", "true");
    expect(signIn).not.toHaveAttribute("disabled");
    expect(signIn).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(signIn);
    expect(signIn).toHaveFocus();
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => held.resolve(credential));
    session.dispose();
  }
});

it("keeps early sign-in passive, then offers guidance and cancellation without accepting late results", async () => {
  // Control browser-guidance deadlines without replacing Motion's frame clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const old = deferred<Credential>();
  const next = deferred<Credential>();
  const acquire = vi
    .fn<(signal: AbortSignal) => Promise<Credential>>()
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => next.promise);
  const session = createOAuthSession(acquire);
  const Footer = signInControl(session);
  render(<Footer />, { wrapper: StrictMode });
  expect(acquire).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  const signIn = screen.getByRole("button", { name: "Sign in to Builderlab" });
  fireEvent.click(signIn);
  fireEvent.click(signIn);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(signIn).toHaveAttribute("aria-busy", "true");
  expect(signIn).toHaveAttribute("aria-disabled", "true");
  expect(signIn).not.toHaveAttribute("disabled");
  expect(session.snapshot().status).toBe("pending");
  expect(acquire.mock.calls[0]?.[0].aborted).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(screen.queryByText(/Finish signing in/)).toBeNull();
  expect(signIn).toHaveAttribute("aria-busy", "true");
  expect(signIn).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  const subtitle = screen.getByRole("status");
  expect(subtitle).toHaveTextContent(
    "Finish signing in to Builderlab in your browser, then return to Buzz.",
  );
  expect(screen.getAllByRole("status")).toEqual([subtitle]);
  expect(screen.queryByText(/Use your Builderlab account/)).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(acquire.mock.calls[0]?.[0].aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(acquire).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  );
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(signIn).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  vi.useRealTimers();
  await act(async () => {
    old.resolve(credential);
    await old.promise;
  });
  expect(session.snapshot().status).toBe("pending");
  await act(async () => {
    next.resolve(credential);
  });
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  expect(session.snapshot().status).toBe("signed-in");
  session.dispose();
});

it("shows failure inline and leaves retry user-started", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  const Footer = signInControl(session);
  render(<Footer />);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  );
  await act(async () => {
    held.reject(new Error("Sign-in timed out. Try again."));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign-in timed out",
  );
  expect(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  ).toBeEnabled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(acquire).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("observes an existing attempt and leaves it running when the pane closes", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  const Footer = signInControl(session);
  const mounted = render(<Footer />, { wrapper: StrictMode });
  expect(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  ).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  mounted.unmount();
  expect(session.snapshot().status).toBe("pending");
  expect(acquire).toHaveBeenCalledTimes(1);
  held.resolve(credential);
  await pending;
  expect(session.snapshot().status).toBe("signed-in");
  session.dispose();
});

it("stays absent for an existing account and returns on explicit sign-out", async () => {
  const session = createOAuthSession(async () => credential);
  await session.signIn();
  const Footer = signInControl(session);
  render(<Footer />);
  expect(screen.queryByRole("button")).toBeNull();
  act(() => session.signOut());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in to Builderlab" }),
    ).toBeVisible(),
  );
  session.dispose();
});

it("loads the pane after a late browser callback and verified exchange without waiting for tab closure or focus return", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const callback = deferred<OAuthCallback>();
  const callbackStarted = deferred<void>();
  const accountStarted = deferred<void>();
  const verified = deferred<HostResponse>();
  const focus = deferred<void>();
  const bridge: BrowserBridge = {
    begin: vi.fn(async () => ({
      id: "attempt",
      callbackUrl: "http://127.0.0.1/callback",
    })),
    wait: vi.fn(() => {
      callbackStarted.resolve();
      return callback.promise;
    }),
    complete: vi.fn(() => focus.promise),
    cancel: vi.fn(async () => {}),
  };
  const pubkey = "ab".repeat(32);
  const reply = (body: unknown): HostResponse => ({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
  });
  const request = vi.fn<Host["request"]>(async ({ url }) => {
    if (url.endsWith("/exchange"))
      return reply({ session_credential: credential.value });
    if (url.endsWith("/me")) {
      accountStarted.resolve();
      return verified.promise;
    }
    if (url.endsWith("/list-agents"))
      return reply({
        status: 1,
        agents: [
          {
            agent_id: "agent",
            agent_pubkey: pubkey,
            agent_name: "Helper",
            status: 2,
            agent_instructions: "Loaded after the browser handoff.",
          },
        ],
      });
    return reply({ models: [] });
  });
  const host: Host = { request, runCommand: vi.fn() };
  const session = createOAuthSession(
    (signal) => browserCredential(host, signal, bridge),
    undefined,
    { request: (input) => host.request(input) },
  );
  const Settings = createSettingsTab(createAgentClient(session), session);
  const agent = { pubkey, name: "Helper" } as Agent;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  render(<Settings agent={agent} save={vi.fn()} settingsSection="identity" />);
  await act(async () => {
    await callbackStarted.promise;
  });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish signing in to Builderlab in your browser, then return to Buzz.",
  );
  await act(async () => {
    callback.resolve({ parameters: [["code", "late-code"]] });
    await accountStarted.promise;
  });
  // A code alone is not a verified account. The pending card stays actionable.
  expect(session.snapshot().status).toBe("pending");
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  vi.useRealTimers();
  await act(async () => {
    verified.resolve(
      reply({
        subject: "account",
        capabilities: { can_use_remote_agents: true },
      }),
    );
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Loaded after the browser handoff.",
    ),
  );
  expect(session.snapshot().status).toBe("signed-in");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(bridge.cancel).not.toHaveBeenCalled();
  await act(async () => {
    focus.resolve();
  });
  expect(bridge.cancel).toHaveBeenCalledTimes(1);
  session.dispose();
});
