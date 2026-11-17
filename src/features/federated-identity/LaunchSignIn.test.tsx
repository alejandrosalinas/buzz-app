// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { LaunchSignIn, SignInEnding } from "./LaunchSignIn";
import type { SessionSnapshot } from "./service";
import { federatedFixture } from "./testing";
afterEach(cleanup);
// Lets a test say when the launch mark has left.
const launch = vi.hoisted(() => new Set<() => void>());
vi.mock("../../app/launch", async (actual) => ({
  ...(await actual<typeof import("../../app/launch")>()),
  subscribeLaunch: (listener: () => void) => {
    launch.add(listener);
    return () => launch.delete(listener);
  },
}));

function launchFixture(organization: string | null = "Block") {
  const h = federatedFixture();
  const authority = h.service.snapshot().authority;
  if (!authority) throw new Error("Fixture authority required");
  h.publish({
    status: "restoring",
    authority: { ...authority, signIn: "at-launch", organization },
  });
  // Native moves to signing-in and stays there until the browser returns.
  vi.mocked(h.service.signIn).mockImplementation(async () => {
    h.publish({ status: "signing-in", revision: crypto.randomUUID() });
    return h.service.snapshot();
  });
  const set = (next: Partial<SessionSnapshot>) => act(() => h.publish(next));
  return { ...h, set };
}

const mounts = vi.fn();
function Workspace() {
  useEffect(() => {
    mounts();
  }, []);
  return <textarea aria-label="Draft" />;
}

it("leaves on-demand builds alone", () => {
  const h = federatedFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("signs in before the app opens, then opens it", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  // The saved session is still being checked: nothing to show yet.
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();

  h.set({ status: "signed-out" });
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("heading", { name: "Signing you in to Block" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();

  h.set({ status: "signed-in", email: "a@example.com" });
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("opens straight away with a restored session", () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("leaves the choice to the person after a cancel, and lets them continue", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByRole("heading", { name: "Sign in to Block" }),
  ).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Sign in with Block" }),
  ).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("copies the sign-in link when the browser didn't open", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  const copy = await screen.findByRole("button", { name: "Copy sign-in link" });
  vi.mocked(h.service.signInLink).mockResolvedValueOnce(null);
  await user.click(copy);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the sign-in link. Try again.",
  );

  await user.click(copy);
  expect(
    await screen.findByText("Sign-in link copied. Paste it into your browser."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(await navigator.clipboard.readText()).toBe(
    "https://builderlab.example/v1/login/start",
  );
});

it("signs in again when a session ends, keeping the app and its focus", async () => {
  const user = userEvent.setup();
  mounts.mockClear();
  const h = launchFixture(null);
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  const draft = screen.getByLabelText("Draft");
  await user.type(draft, "half a thought");

  h.set({ status: "reauthentication-required" });
  expect(h.service.signIn).toHaveBeenCalledOnce();
  const heading = await screen.findByRole("heading", {
    name: "Signing you in to your organization",
  });
  expect(heading).toBeVisible();
  // Above any dialog or menu the app had open.
  expect(
    screen.getByRole("dialog", { name: "Signing you in to your organization" }),
  ).toContainElement(heading);
  expect(draft).not.toBeVisible();
  // The app's window shortcuts don't act behind the screen.
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  await user.keyboard("{Meta>}k{/Meta}");
  window.removeEventListener("keydown", shortcut);
  expect(shortcut).not.toHaveBeenCalled();

  h.set({ status: "signed-in" });
  expect(draft).toBeVisible();
  expect(draft).toHaveValue("half a thought");
  expect(draft).toHaveFocus();
  expect(mounts).toHaveBeenCalledOnce();
});

it("asks without opening the browser after an explicit sign-out", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  h.set({ status: "signed-out" });
  expect(
    await screen.findByRole("heading", { name: "Sign in to Block" }),
  ).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("explains a failed sign-in without exposing its code", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  h.set({ status: "signed-out", failure: "callback-refused" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign-in did not finish. Try again.",
  );
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("offers a retry when the saved sign-in can't be checked", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "unavailable", failure: "network-unavailable" });
  expect(
    await screen.findByRole("heading", {
      name: "Couldn’t reach Block sign-in",
    }),
  ).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("waits for the build's policy before mounting the app, then mounts it once", () => {
  mounts.mockClear();
  const h = federatedFixture();
  const authority = h.service.snapshot().authority;
  h.publish({ status: "restoring", authority: null });
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  act(() => h.publish({ status: "restoring", authority }));
  act(() => h.publish({ status: "signed-out" }));
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(mounts).toHaveBeenCalledOnce();
});

it("says it is signing in before the browser opens, and while a retry checks", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  let release = () => {};
  vi.mocked(h.service.signIn).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(h.service.snapshot());
      }),
  );
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  // Native has not reported the attempt yet.
  expect(
    screen.getByRole("heading", { name: "Signing you in to Block" }),
  ).toBeVisible();
  await act(async () => release());
  h.set({ status: "unavailable", failure: "network-unavailable" });

  await user.click(screen.getByRole("button", { name: "Try again" }));
  h.set({ status: "restoring", failure: null });
  expect(screen.getByText("Checking your sign-in…")).toBeVisible();
  // The check may go on to open the browser, so it can't be dismissed.
  expect(
    screen.queryByRole("button", { name: "Not now" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  await act(async () => release());
  h.set({ status: "signed-in" });
  expect(screen.getByLabelText("Draft")).toBeVisible();
});

it("returns focus to an app dialog portaled outside the app", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
      {createPortal(<input aria-label="Search Buzz" />, document.body)}
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  const search = screen.getByLabelText("Search Buzz");
  await user.type(search, "query");

  h.set({ status: "reauthentication-required" });
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  await user.click(await screen.findByRole("button", { name: "Not now" }));
  expect(search).toHaveFocus();
  expect(search).toHaveValue("query");
});

it("focuses the sign-in action once the launch mark leaves", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  const reopen = await screen.findByRole("button", {
    name: "Open the sign-in page again",
  });
  // Under the launch mark the window is inert and autofocus doesn't land.
  reopen.blur();
  act(() => {
    for (const listener of launch) listener();
  });
  expect(reopen).toHaveFocus();
});

function expiringFixture() {
  const h = launchFixture();
  h.publish({
    status: "signed-in",
    expiresAt: "2099-01-02T15:00:00Z",
    expiring: true,
  });
  render(
    <ToastProvider>
      <SignInEnding identity={h.service} />
    </ToastProvider>,
  );
  return h;
}

it("warns before the session ends and signs in again without leaving the app", async () => {
  const h = expiringFixture();
  let release = () => {};
  vi.mocked(h.service.signIn).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(h.service.snapshot());
      }),
  );
  // Canceling a renewal leaves the current session as it was.
  vi.mocked(h.service.cancelSignIn).mockImplementation(async () => {});
  expect(
    await screen.findByText(/^Your Block sign-in ends /),
  ).toBeInTheDocument();
  // Clicks without focus moves: jsdom hands Sonner a non-element focus origin.
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByText("Finish signing in in your browser."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(
    await screen.findByRole("button", { name: "Sign in again" }),
  ).toBeInTheDocument();
});

it("reports only its own renewal's failure", async () => {
  const h = expiringFixture();
  // A community refusing access isn't a failed sign-in.
  h.set({ failure: "authorization-denied" });
  expect(
    await screen.findByText("Sign in again to keep Buzz open."),
  ).toBeInTheDocument();
  vi.mocked(h.service.signIn).mockRejectedValueOnce(
    new Error("callback-refused"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(
    await screen.findByText("Sign-in did not finish. Try again."),
  ).toBeInTheDocument();
  // A later session's warning doesn't carry the old attempt's failure.
  h.set({ revision: "next", failure: null });
  expect(
    await screen.findByText("Sign in again to keep Buzz open."),
  ).toBeInTheDocument();
});

it("warns only in at-launch builds, once the session is ending", () => {
  const onDemand = federatedFixture();
  const early = launchFixture();
  for (const h of [onDemand, early])
    h.publish({
      status: "signed-in",
      expiresAt: "2099-01-02T15:00:00Z",
      expiring: h === onDemand,
    });
  render(
    <ToastProvider>
      <SignInEnding identity={onDemand.service} />
      <SignInEnding identity={early.service} />
    </ToastProvider>,
  );
  expect(screen.queryByText(/sign-in ends/)).not.toBeInTheDocument();
});
