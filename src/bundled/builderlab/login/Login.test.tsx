// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Login } from "./Login";
import type { Credential } from "../session";
import { deferred, createTestSession } from "../test-helpers";
import { federatedFixture } from "../../../features/federated-identity/testing";
import { createNativeSession } from "../session";

afterEach(cleanup);
const credential: Credential = {
  revision: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
};
it("shows a desktop requirement in the browser", () => {
  const acquire = vi.fn();
  render(
    <Login
      session={createTestSession(acquire)}
      notice
      available={false}
      active={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(acquire).not.toHaveBeenCalled();
});
it("sign-out clears the credential and restores the sign-in action", async () => {
  const session = createTestSession(async () => credential);
  render(
    <StrictMode>
      <Login session={session} available active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  expect(screen.getByText(/Connect your Builderlab account/)).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(
    screen.queryByText(/Connect your Builderlab account/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/keeps your sign-in in your system keychain/),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeEnabled();
  expect(screen.getByText(/Connect your Builderlab account/)).toBeVisible();
  expect(() => session.credential()).toThrow("Sign in");
});
it("shows a signed-in confirmation when email is unavailable", async () => {
  const session = createTestSession(async () => ({
    revision: "private-token",
    account: {
      subject: "user",
      email: "",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  render(<Login session={session} available active={() => true} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Signed in to Builderlab.",
  );
});
it.each(["cancel", "unmount"])(
  "%s cancels a pending sign-in",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const acquire = vi.fn(async (current: AbortSignal) => {
      signal = current;
      return release.promise;
    });
    const session = createTestSession(acquire);
    const mounted = render(
      <StrictMode>
        <Login session={session} notice available active={() => true} />
      </StrictMode>,
    );
    const user = userEvent.setup();
    try {
      await user.click(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      );
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Finish sign-in in your browser",
      );
      expect(
        screen.queryByRole("button", { name: "Sign in with Builderlab" }),
      ).not.toBeInTheDocument();
      if (action === "cancel")
        await user.click(
          screen.getByRole("button", { name: "Cancel sign-in" }),
        );
      else mounted.unmount();
      expect(signal?.aborted).toBe(true);
    } finally {
      await act(async () => {
        release.resolve(credential);
        await release.promise;
      });
    }
    if (action === "cancel")
      expect(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      ).toBeEnabled();
  },
);
it("shows failures and permits retry; inactive contributions cannot start sign-in", async () => {
  const acquire = vi
    .fn()
    .mockRejectedValueOnce(new Error("Browser could not open."))
    .mockResolvedValueOnce(credential);
  const session = createTestSession(acquire);
  let active = false;
  render(<Login session={session} available active={() => active} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(acquire).not.toHaveBeenCalled();
  active = true;
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(
    await screen.findByRole("button", { name: "Sign out" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
const me = {
  status: 200,
  headers: {},
  body: JSON.stringify({ subject: "user", email: "a@example.com" }),
};

it("keeps compact actions and progress with the account notice", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createTestSession(acquire);
  render(
    <Login
      session={session}
      available
      active={() => true}
      showHeading={false}
      notice
    />,
  );
  const user = userEvent.setup();
  expect(screen.queryByText("Sign-in state")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  await act(async () => held.reject(new Error("Sign-in failed")));
  expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed");
  acquire.mockResolvedValueOnce(credential);
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  await screen.findByRole("button", { name: "Sign out" });
  expect(screen.queryByText("a@example.com")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeVisible();
  session.dispose();
});

it("shows the account email when the notice is omitted", async () => {
  const session = createTestSession(async () => credential);
  await session.signIn();
  render(
    <Login
      session={session}
      available
      active={() => true}
      showHeading={false}
      notice={false}
    />,
  );
  expect(screen.getByText("a@example.com")).toBeVisible();
  session.dispose();
});

it("names the provider and preserves shared account management", async () => {
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  try {
    const h = federatedFixture();
    h.request.mockResolvedValue(me);
    const authority = h.service.snapshot().authority;
    if (!authority) throw new Error("Missing fixture authority");
    h.publish({ authority: { ...authority, organization: "Example Org" } });
    const session = createNativeSession(h.service);
    const openIdentity = vi.fn();
    render(
      <Login
        session={session}
        available
        active={() => true}
        showHeading={false}
        notice
        openIdentity={openIdentity}
      />,
    );
    const provider = "Example Org";
    await userEvent.click(
      screen.getByRole("button", { name: `Sign in with ${provider}` }),
    );
    expect(h.service.signIn).toHaveBeenCalledOnce();
    await screen.findByRole("button", { name: "Manage account" });
    expect(screen.queryByText("a@example.com")).toBeNull();
    expect(screen.queryByText("Email", { selector: "dt" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Manage account" }).closest("p"),
    ).toHaveTextContent(`Uses your ${provider} sign-in.`);
    expect(screen.queryByText("Sign-in state")).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage account" }),
    );
    expect(openIdentity).toHaveBeenCalledOnce();
    expect(h.service.signOut).not.toHaveBeenCalled();
    session.dispose();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("uses the provider host when its organization label is absent", () => {
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  try {
    const h = federatedFixture();
    const authority = h.service.snapshot().authority;
    if (!authority) throw new Error("Missing fixture authority");
    h.publish({ authority: { ...authority, organization: null } });
    const session = createNativeSession(h.service);
    render(<Login session={session} available active={() => true} />);
    expect(
      screen.getByRole("button", { name: "Sign in with builderlab.example" }),
    ).toBeVisible();
    session.dispose();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("shows a restore or account read as checking, without a browser step to cancel", async () => {
  const h = federatedFixture();
  h.publish({ status: "restoring" });
  const session = createNativeSession(h.service);
  render(<Login session={session} available active={() => true} />);
  const user = userEvent.setup();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your Builderlab sign-in",
  );
  await user.click(screen.getByRole("button", { name: "Checking sign-in" }));
  const read = deferred<typeof me>();
  h.request.mockReturnValueOnce(read.promise);
  act(() => h.publish({ status: "signed-in", revision: "user:1" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your Builderlab sign-in",
  );
  await user.click(screen.getByRole("button", { name: "Checking sign-in" }));
  expect(h.service.cancelSignIn).not.toHaveBeenCalled();
  await act(async () => read.resolve(me));
  expect(
    await screen.findByRole("button", { name: "Sign out" }),
  ).toBeInTheDocument();
  // A browser sign-in is still the one pending state that cancels.
  act(() => h.publish({ status: "signing-in" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  session.dispose();
});
it.each([true, false])(
  "moves focus to Identity after an FI retry only when the retry button had it (%s)",
  async (kept) => {
    vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
    try {
      const h = federatedFixture();
      h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
      h.publish({ status: "signed-in", revision: "user:1" });
      const session = createNativeSession(h.service);
      render(
        <>
          <Login
            session={session}
            available
            active={() => true}
            openIdentity={() => {}}
            notice
          />
          <input aria-label="Elsewhere" />
        </>,
      );
      const retry = await screen.findByRole("button", {
        name: "Sign in with builderlab.example",
      });
      const read = deferred<typeof me>();
      h.request.mockReturnValueOnce(read.promise);
      const user = userEvent.setup();
      await user.click(retry);
      if (!kept) await user.click(screen.getByLabelText("Elsewhere"));
      await act(async () => read.resolve(me));
      const identity = await screen.findByRole("button", {
        name: "Manage account",
      });
      if (kept) expect(identity).toHaveFocus();
      else expect(screen.getByLabelText("Elsewhere")).toHaveFocus();
      session.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
