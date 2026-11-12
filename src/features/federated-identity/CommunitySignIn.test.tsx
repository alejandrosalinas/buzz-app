// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { SessionSnapshot } from "./service";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { CommunitySignIn, useExplainedRefusal } from "./CommunitySignIn";
import { federatedFixture } from "./testing";
afterEach(cleanup);
it.each(["storage-unavailable", "storage-denied"])(
  "gives secure-storage recovery instead of exposing %s",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "unavailable", failure });
    render(
      <CommunitySignIn
        identity={h.service}
        error="Federated sign-in is required"
        retry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check your system’s credential permissions and try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(failure);
    expect(h.service.signIn).not.toHaveBeenCalled();
  },
);
it("says an unreadable saved sign-in is not a permissions problem, and that signing in can't fix it", () => {
  const h = federatedFixture();
  h.publish({ status: "unavailable", failure: "storage-corrupt" });
  render(
    <CommunitySignIn
      identity={h.service}
      error="Federated sign-in is required"
      retry={vi.fn()}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Buzz can’t read its saved sign-in for this server, and signing in again may not replace it. If this keeps happening, contact support.",
  );
  expect(alert).not.toHaveTextContent("credential permissions");
  expect(alert).not.toHaveTextContent("storage-corrupt");
});
it.each([null, "Builderlab"])(
  "names server %s and requires explicit sign-in before retrying admission",
  async (organization) => {
    const h = federatedFixture();
    const authority = h.service.snapshot().authority;
    if (!authority) throw new Error("Fixture authority missing");
    h.publish({ authority: { ...authority, organization } });
    const server = organization ?? "builderlab.example";
    const retry = vi.fn();
    render(
      <CommunitySignIn
        identity={h.service}
        error="Federated sign-in is required"
        retry={retry}
      />,
    );
    expect(
      screen.getByText(`This community requires ${server} sign-in.`),
    ).toBeVisible();
    expect(h.service.signIn).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: `Sign in with ${server}` }));
    expect(retry).toHaveBeenCalledOnce();
  },
);
it.each(["binding-mismatch", "authorization-denied"])(
  "explains %s without a session to switch",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "signed-out", failure });
    render(
      <CommunitySignIn identity={h.service} error={failure} retry={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      failure === "binding-mismatch" ? "identity link" : "administrator",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);

const memberships = [
  { id: "wss://buzz.acme.builderlab.xyz", name: "Acme" },
  { id: "wss://will.communities.buzz.xyz", name: "will" },
  { id: "wss://kalvin.communities.buzz.xyz", name: "kalvin" },
];
function publicServer() {
  const h = federatedFixture("public", "will@example.com");
  h.publish({
    status: "signed-in",
    email: "will@example.com",
    authority: {
      id: "bb-public",
      identityOrigin: "https://app.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: "Builderlab",
      communityHosts: ["*.communities.buzz.xyz", "communities.buzz.xyz"],
    },
  });
  return h;
}

it.each(["binding-mismatch", "authorization-denied"])(
  "switches only the refusing community's server account on %s",
  async (failure) => {
    const block = federatedFixture("block");
    block.publish({ status: "signed-in" });
    const pub = publicServer();
    const retry = vi.fn();
    render(
      <CommunitySignIn
        identity={pub.service}
        error={failure}
        retry={retry}
        relay="wss://kalvin.communities.buzz.xyz"
        memberships={memberships}
      />,
    );
    const alert = screen.getAllByRole("alert")[0];
    expect(alert).toHaveTextContent("Builderlab account");
    expect(alert).toHaveTextContent("will@example.com");
    if (failure === "binding-mismatch")
      expect(alert).toHaveTextContent("app.builderlab.xyz");
    expect(alert).not.toHaveTextContent("Builderlab hosting");
    // The others on that server, never the refusing one or another server's.
    expect(
      screen.getByText(
        "will also uses this account. Switching may change your access there.",
      ),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Switch account" }));
    expect(pub.service.signOut).toHaveBeenCalledOnce();
    expect(pub.service.signIn).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(block.service.signOut).not.toHaveBeenCalled();
    expect(block.service.signIn).not.toHaveBeenCalled();
    expect(block.service.snapshot().status).toBe("signed-in");
  },
);

it("closes the switch prompt on Not now without changing any session", async () => {
  const pub = publicServer();
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={pub.service}
      error="authorization-denied"
      retry={retry}
      relay="wss://kalvin.communities.buzz.xyz"
      memberships={memberships}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(pub.service.signOut).not.toHaveBeenCalled();
  expect(pub.service.signIn).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
  expect(pub.service.snapshot().status).toBe("signed-in");
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps the switch's controls through sign-out, a pending sign-in, Cancel and Sign in", async () => {
  const pub = publicServer();
  const signedOut = gate<SessionSnapshot>();
  const signIns: ReturnType<typeof gate<SessionSnapshot>>[] = [];
  vi.mocked(pub.service.signOut).mockImplementation(() => signedOut.promise);
  vi.mocked(pub.service.signIn).mockImplementation(() => {
    const next = gate<SessionSnapshot>();
    signIns.push(next);
    return next.promise;
  });
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={pub.service}
      error="authorization-denied"
      retry={retry}
      relay="wss://kalvin.communities.buzz.xyz"
      memberships={memberships}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Switch account" }));
  // Sign-out ends the signed-in state that offered the switch.
  await act(async () => {
    pub.publish({ status: "signed-out", email: null });
    signedOut.resolve(pub.service.snapshot());
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Switching your Builderlab account",
  );
  act(() => pub.publish({ status: "signing-in" }));
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(pub.service.cancelSignIn).toHaveBeenCalledOnce();
  // Native answers the canceled sign-in with a plain signed-out snapshot:
  // no error and no failure code.
  await act(async () => {
    pub.publish({ status: "signed-out", failure: null });
    signIns[0]?.resolve(pub.service.snapshot());
  });
  // A cancel is not a failed switch: the account is signed out, so the
  // prompt says so and offers Sign in.
  expect(screen.getByRole("status")).toHaveTextContent(
    "Sign-in was canceled. Sign in when you’re ready.",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Couldn’t switch/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(pub.service.signOut).toHaveBeenCalledOnce();
  expect(pub.service.signIn).toHaveBeenCalledTimes(2);
  await act(async () => {
    pub.publish({
      status: "signed-in",
      failure: null,
      email: "other@example.com",
    });
    signIns[1]?.resolve(pub.service.snapshot());
  });
  expect(retry).toHaveBeenCalledOnce();
});

it("reports a refused sign-in during a switch even when native doesn't throw", async () => {
  const pub = publicServer();
  const signIn = gate<SessionSnapshot>();
  vi.mocked(pub.service.signIn).mockImplementation(() => signIn.promise);
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={pub.service}
      error="binding-mismatch"
      retry={retry}
      memberships={memberships}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Switch account" }));
  await act(async () => {
    signIn.resolve({
      ...pub.service.snapshot(),
      status: "signed-out",
      failure: "login-refused",
    });
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t switch your Builderlab account.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});

it.each([
  ["rejects", () => Promise.reject(new Error("storage-denied"))],
  ["leaves native unavailable", "unavailable"],
] as const)(
  "redoes a failed sign-out before signing in again when it %s",
  async (_, outcome) => {
    const pub = publicServer();
    const signOut = vi.mocked(pub.service.signOut);
    if (typeof outcome === "function") signOut.mockImplementationOnce(outcome);
    else
      signOut.mockImplementationOnce(async () =>
        pub.publish({ status: "unavailable", failure: "storage-denied" }),
      );
    const retry = vi.fn();
    render(
      <CommunitySignIn
        identity={pub.service}
        error="authorization-denied"
        retry={retry}
        memberships={memberships}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Switch account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t switch your Builderlab account.",
    );
    expect(pub.service.signIn).not.toHaveBeenCalled();
    // The old account is still signed in: retrying must not renew it.
    act(() => pub.publish({ status: "signed-in", email: "will@example.com" }));
    signOut.mockImplementationOnce(async () => pub.service.snapshot());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(pub.service.signIn).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
    // A sign-out that ends the session lets the sign-in start.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(signOut).toHaveBeenCalledTimes(3);
    expect(pub.service.signIn).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  },
);

it("keeps an explained refusal hidden until its error clears, so a resolving sign-in never shows it raw", () => {
  const h = federatedFixture();
  const refusal = "Federated sign-in is required";
  const { result, rerender } = renderHook(
    ({ error }) => useExplainedRefusal(h.service, error),
    { initialProps: { error: refusal } },
  );
  expect(result.current).toBe(true);
  // Signed in before the retry clears the error: still explained.
  act(() => {
    h.publish({ status: "signed-in" });
  });
  expect(result.current).toBe(true);
  rerender({ error: "" });
  expect(result.current).toBe(false);
  // A new refusal is judged fresh: signed in, nothing explains it.
  rerender({ error: refusal });
  expect(result.current).toBe(false);
});
