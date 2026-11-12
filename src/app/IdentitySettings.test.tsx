// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  type BackupStatus,
  createBackupStatus,
} from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { backupOfferedFor } from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import type { FederatedIdentity } from "../features/federated-identity/service";
import { IdentitySettings } from "./IdentitySettings";
import { federatedFixture } from "../features/federated-identity/testing";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    constructor(public onmessage: (status: unknown) => void) {}
  },
}));

const viewer = "ab".repeat(32);
async function confirmProviderSignOut(name: string) {
  await userEvent.click(await screen.findByRole("button", { name }));
  const confirmation = await screen.findByRole("alertdialog");
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "Sign out" }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Send = NonNullable<Parameters<typeof createBackupStatus>[0]>;
type Progress<S = BackupStatus> = S extends unknown
  ? Omit<S, "seq" | "pass" | "builderlab">
  : never;
const at = (seq: number, progress: Progress, builderlab = true) =>
  ({
    seq,
    pass: seq,
    builderlab,
    management: {
      pubkey: viewer,
      policy: "self-managed",
      initialBackupConfirmed: false,
    },
    ...progress,
  }) as BackupStatus;

/** The real status store over a native side that answers `initial` and records its watcher. */
function backupHost(initial: BackupStatus) {
  const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
  const send = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as (typeof watchers)[number]);
        return undefined;
      }
      if (command === "nsec_backup_state") return initial;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const store = createBackupStatus(send as Send);
  const setBackupChoice = vi.fn(async (pubkey: string, automatic: boolean) => ({
    available: true,
    pubkey,
    automatic,
  }));
  return {
    identity: {
      exportKey: vi.fn(),
      backup: store,
      setBackupChoice,
    } as unknown as Identity,
    setBackupChoice,
    push: (status: BackupStatus) =>
      act(() => watchers.at(-1)?.onmessage(status)),
    /** Settles once the row's own offer check has: it started first on the same store. */
    settled: () => act(() => backupOfferedFor(store)),
  };
}

const renderBackup = (initial: BackupStatus, openBuilderlab?: () => void) => {
  const host = backupHost(initial);
  render(
    <IdentitySettings
      viewer={viewer}
      identity={host.identity}
      openBuilderlab={openBuilderlab}
    />,
  );
  return host;
};
function accountResponse(path: string, key = viewer, backups = [key]) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify(
      path.endsWith("/nostr-identities/current")
        ? { identity: { pubkey_hex: key } }
        : { current_nostr_pubkey: key, backup_nostr_pubkeys: backups },
    ),
  };
}

function accountFixture(initial: BackupStatus) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = backupHost(initial);
  const fi = federatedFixture();
  fi.publish({ status: "signed-in", email: "a@example.com" });
  return {
    host,
    fi,
    mount: () =>
      render(
        <IdentitySettings
          viewer={viewer}
          identity={host.identity}
          builderlabIdentity={fi.service}
        />,
        { wrapper: ToastProvider },
      ),
  };
}

const backupRow = () => screen.queryByText("Key backup");
const description = () => screen.getByText("Back up this key to Builderlab");
async function showKeyDetails() {
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
}
async function chooseKeyAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: "Private key actions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

it.each([false, true])(
  "keeps focus after a delayed private-key reveal (moved elsewhere: %s)",
  async (moved) => {
    const h = backupHost(at(1, { status: "idle" }));
    let finish!: (key: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    vi.mocked(h.identity.exportKey).mockReturnValue(pending);
    render(
      <>
        <IdentitySettings viewer={viewer} identity={h.identity} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await h.settled();
    const user = userEvent.setup();
    await showKeyDetails();
    await chooseKeyAction(user, "Reveal private key");
    const trigger = screen.getByRole("button", { name: "Private key actions" });
    // Hold export until the menu has closed and returned focus to the masked trigger.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    if (moved) await user.click(elsewhere);
    await act(async () => {
      finish("nsec-public-test-fixture");
      await pending;
    });
    const field = screen.getByLabelText("Private key (nsec)");
    expect(field).toHaveValue("nsec-public-test-fixture");
    expect(moved ? elsewhere : field).toHaveFocus();
  },
);

it("clears a pending private-key reveal when the badge flips back", async () => {
  const h = backupHost(at(1, { status: "idle" }));
  let finish!: (key: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  vi.mocked(h.identity.exportKey).mockReturnValue(pending);
  render(<IdentitySettings viewer={viewer} identity={h.identity} />);
  await h.settled();
  const user = userEvent.setup();
  await showKeyDetails();
  expect(h.identity.exportKey).not.toHaveBeenCalled();
  await chooseKeyAction(user, "Reveal private key");
  expect(h.identity.exportKey).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Back" }));
  await act(async () => {
    finish("nsec-public-test-fixture");
    await pending;
  });
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Private key actions" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Remove from device" }),
  ).toBeNull();
  await showKeyDetails();
  expect(
    screen.getByRole("button", { name: "Private key actions" }),
  ).toHaveTextContent("••••••••••••••••");
  expect(h.identity.exportKey).toHaveBeenCalledOnce();
  vi.mocked(h.identity.exportKey).mockRejectedValueOnce(new Error("denied"));
  await chooseKeyAction(user, "Reveal private key");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t reveal your private key",
  );
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
});

// Methods that need their receiver, like the real service's class methods.
function bound(service: FederatedIdentity): FederatedIdentity {
  const self: FederatedIdentity = {
    apiAvailable: service.apiAvailable,
    request: service.request,
    snapshot: service.snapshot,
    subscribe: service.subscribe,
    signIn() {
      expect(this).toBe(self);
      return service.signIn();
    },
    cancelSignIn() {
      expect(this).toBe(self);
      return service.cancelSignIn();
    },
    signOut() {
      expect(this).toBe(self);
      return service.signOut();
    },
  };
  return self;
}

it("shows the organization account and signs out of it once", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  const badge = screen.getByRole("region", { name: "Your Buzz ID" });
  const signIns = screen.getByRole("heading", { name: "Community sign-ins" });
  expect(
    badge.compareDocumentPosition(signIns) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("a@example.com")).toBeVisible();
  await confirmProviderSignOut("Sign out of organization");
  expect(h.service.signOut).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
});

it("only shows renewal and expiry within seven days, with the default caret and guarded sign-out", async () => {
  const h = federatedFixture();
  const now = Date.now();
  const expiresAt = new Date(now + 7 * 86_400_000).toISOString();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(now + 8 * 86_400_000).toISOString(),
  });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.queryByText(/^Expires at /)).toBeNull();
  expect(screen.queryByRole("button", { name: "Renew sign-in" })).toBeNull();
  act(() => h.publish({ expiresAt }));
  expect(screen.getByText(/^Expires at /)).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Renew sign-in" }));
  expect(h.service.signIn).toHaveBeenCalledOnce();
  const menu = screen.getByRole("button", {
    name: "More actions for builderlab.example",
  });
  await user.click(menu);
  await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  expect(h.service.signOut).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Renew sign-in" })).toHaveFocus(),
  );
});

it("shows a renewal in progress with a Cancel that ends only the browser step", async () => {
  const h = federatedFixture();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  // Like native: a renewal keeps the session signed in until the browser
  // step ends, and canceling ends it without a new session.
  let finish: () => void = () => {};
  vi.mocked(h.service.signIn).mockImplementation(
    () =>
      new Promise((resolve) => {
        h.publish({ renewing: true });
        finish = () => {
          h.publish({ renewing: false });
          resolve(h.service.snapshot());
        };
      }),
  );
  vi.mocked(h.service.cancelSignIn).mockImplementation(async () => finish());
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Renew sign-in" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish in your browser",
  );
  expect(screen.queryByRole("button", { name: "Renew sign-in" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("button", { name: "Renew sign-in" }),
  ).toBeVisible();
  expect(screen.queryByText("Finish in your browser")).toBeNull();
  expect(screen.getByText("a@example.com")).toBeVisible();
  expect(h.service.signOut).not.toHaveBeenCalled();
});

it("keeps keyboard focus on the renewal action as Renew and Cancel swap", async () => {
  const h = federatedFixture();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  let finish: () => void = () => {};
  vi.mocked(h.service.signIn).mockImplementation(
    () =>
      new Promise((resolve) => {
        h.publish({ renewing: true });
        finish = () => {
          h.publish({ renewing: false });
          resolve(h.service.snapshot());
        };
      }),
  );
  vi.mocked(h.service.cancelSignIn).mockImplementation(async () => finish());
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Renew sign-in" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Renew sign-in" })).toHaveFocus(),
  );
});

// No click arms these: native ends the renewal on its own.
it("keeps keyboard focus on the renewal action when native ends a renewal", async () => {
  const h = federatedFixture();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    renewing: true,
  });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  screen.getByRole("button", { name: "Cancel" }).focus();
  act(() => h.publish({ renewing: false }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Renew sign-in" })).toHaveFocus(),
  );
});

// Native records a renewal only once it starts the browser step: a Cancel
// before then waits for it, then ends that step.
it("holds a Cancel chosen before native records the renewal, then ends it", async () => {
  const h = federatedFixture();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  let start: () => void = () => {};
  let finish: () => void = () => {};
  vi.mocked(h.service.signIn).mockImplementation(
    () =>
      new Promise((resolve) => {
        start = () => h.publish({ renewing: true });
        finish = () => {
          h.publish({ renewing: false });
          resolve(h.service.snapshot());
        };
      }),
  );
  vi.mocked(h.service.cancelSignIn).mockImplementation(async () => finish());
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Renew sign-in" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.service.cancelSignIn).not.toHaveBeenCalled();
  act(() => start());
  await waitFor(() => expect(h.service.cancelSignIn).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole("button", { name: "Renew sign-in" }),
  ).toBeVisible();
  expect(h.service.signOut).not.toHaveBeenCalled();
});

it("does not take focus back after the person moves away from Cancel", async () => {
  const h = federatedFixture();
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    renewing: true,
  });
  let finish: () => void = () => {};
  vi.mocked(h.service.cancelSignIn).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          h.publish({ renewing: false });
          resolve();
        };
      }),
  );
  render(
    <>
      <IdentitySettings viewer={viewer} federatedIdentity={h.service} />
      <button type="button">Elsewhere</button>
    </>,
    { wrapper: ToastProvider },
  );
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Cancel" }).focus();
  await user.keyboard("{Enter}");
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  act(() => finish());
  expect(
    await screen.findByRole("button", { name: "Renew sign-in" }),
  ).toBeVisible();
  expect(elsewhere).toHaveFocus();
});

it("shows a renewal that native reports as waiting, after the page reopens", async () => {
  const h = federatedFixture();
  // Settings was left mid-renewal: only native knows it still waits.
  h.publish({
    status: "signed-in",
    email: "a@example.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    renewing: true,
  });
  vi.mocked(h.service.cancelSignIn).mockImplementation(async () => {
    h.publish({ renewing: false });
  });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish in your browser",
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("button", { name: "Renew sign-in" }),
  ).toBeVisible();
  expect(screen.getByText("a@example.com")).toBeVisible();
});

it("signs in to the organization once when signed out", async () => {
  const h = federatedFixture();
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(h.service.signIn).toHaveBeenCalledTimes(1);
});

it("hides organization sign-in without an authority", () => {
  const h = federatedFixture();
  h.publish({ status: "unconfigured", authority: null });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.queryByText("Organization sign-in")).not.toBeInTheDocument();
});

it("keeps a failed organization sign-out visible when storage refuses", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  vi.mocked(h.service.signOut).mockImplementationOnce(async () => {
    h.publish({ status: "unavailable", failure: "storage-busy" });
    return h.service.snapshot();
  });
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  await confirmProviderSignOut("Sign out of organization");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Secure storage is busy",
  );
});

const builderlab = { name: "Builderlab" };

// Builderlab's page connects this key, or switches the account to it. Native
// reaches either only after consent, so the link starts no backup unasked.
it.each([
  [{ status: "waiting", reason: "not_linked" }, "not_linked"],
  [{ status: "failed", kind: "other_key_linked" }, "other_key_linked"],
] as const)(
  "links Builderlab from the %o sentence to its Settings page",
  async (progress, kind) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    const openBuilderlab = vi.fn();
    await renderBackup(at(1, progress), openBuilderlab).settled();
    await showKeyDetails();
    const message = BACKUP_FAILURES[kind].message.replace(/\.$/, "");
    const sentence = screen.getByText(
      (_, el) => el?.tagName === "P" && el.textContent === message,
    );
    expect(sentence.textContent).toBe(message);
    const link = within(sentence).getByRole("button", builderlab);
    expect(within(sentence).getAllByRole("button")).toEqual([link]);
    expect(screen.getByRole("button", { name: "Retry backup" })).toBeEnabled();
    await userEvent.setup().click(link);
    expect(openBuilderlab).toHaveBeenCalledOnce();
  },
);

// Signing in is on this page, and consent is the row's own Sync; retrying
// failures need a new sign-in, and the rest have no fix on Builderlab's page.
it.each([
  { status: "waiting", reason: "no_session" },
  { status: "waiting", reason: "no_consent" },
  { status: "idle" },
  { status: "running" },
  { status: "complete" },
  ...(
    [
      "signed_out",
      "busy",
      "unreachable",
      "unconfirmed",
      "storage",
      "not_offered",
      "invalid_service",
      "refused",
    ] as const
  ).map((kind) => ({ status: "failed", kind }) as const),
] as const)("names no Builderlab link for the %o status", async (progress) => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  await renderBackup(at(1, progress), vi.fn()).settled();
  await showKeyDetails();
  const badge = screen.getByRole("region", { name: "Your Buzz ID" });
  expect(badge).toBeVisible();
  expect(within(badge).queryByRole("button", builderlab)).toBeNull();
});

it("names Builderlab as plain text where Settings can't open it", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  await renderBackup(
    at(1, { status: "waiting", reason: "not_linked" }),
  ).settled();
  await showKeyDetails();
  const message = BACKUP_FAILURES.not_linked.message.replace(/\.$/, "");
  const sentence = screen.getByText(
    (_, el) => el?.tagName === "P" && el.textContent === message,
  );
  expect(sentence.textContent).toBe(message);
  expect(within(sentence).queryByRole("button")).toBeNull();
});

const sync = { name: "Back up key" };
const prompt = () =>
  screen.getByRole("alertdialog", {
    name: "Back up your key?",
  });

it("while backup waits for consent, Back up key opens the backup prompt and saves its answer", async () => {
  const { host, fi, mount } = accountFixture(
    at(1, { status: "waiting", reason: "no_consent" }),
  );
  fi.request.mockRejectedValue(new Error("Account lookup failed"));
  const retry = vi.spyOn(host.identity.backup, "retry");
  mount();
  await host.settled();
  await showKeyDetails();
  const user = userEvent.setup();
  expect(description()).toBeVisible();
  const consent = screen.getByRole("button", sync);
  expect(consent.closest('[aria-label="Your Buzz ID"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Retry backup" })).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  expect(host.setBackupChoice).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", sync));
  const open = prompt();
  // Closing saves nothing, and the surviving action takes focus back.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(open).not.toBeInTheDocument());
  expect(host.setBackupChoice).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", sync)).toHaveFocus());
  await user.click(screen.getByRole("button", sync));
  await user.click(within(prompt()).getByRole("button", sync));
  expect(host.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, true);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // The saved choice wakes the uploader, and the action goes with the wait.
  host.push(at(2, { status: "running" }));
  expect(screen.queryByRole("button", sync)).toBeNull();
});

it("closes the prompt when the consent wait settles without its answer", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "waiting", reason: "no_consent" }));
  await host.settled();
  await showKeyDetails();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", sync));
  const open = prompt();
  // Every pass runs before admission, even one that waits for consent again.
  host.push(at(2, { status: "running" }));
  host.push(at(3, { status: "waiting", reason: "no_consent" }));
  expect(open).toBeVisible();
  // A hosted membership saved consent elsewhere, and its pass backed up.
  host.push(at(4, { status: "running" }));
  host.push(at(5, { status: "complete" }));
  await waitFor(() => expect(open).not.toBeInTheDocument());
  expect(host.setBackupChoice).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Back$/ })).toHaveFocus(),
  );
});

// Native publishes `running` before it answers, but the two reach the page
// on different channels, so either can arrive first.
it.each([
  ["after the save is answered", false],
  ["before the save is answered", true],
] as const)(
  "Consent returns focus to Back when the wait ends %s",
  async (_, waitEndsFirst) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    const host = renderBackup(
      at(1, { status: "waiting", reason: "no_consent" }),
    );
    await host.settled();
    await showKeyDetails();
    let answer = () => {};
    host.setBackupChoice.mockImplementationOnce(
      (pubkey, automatic) =>
        new Promise((resolve) => {
          answer = () => resolve({ available: true, pubkey, automatic });
        }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", sync));
    await user.click(within(prompt()).getByRole("button", sync));
    expect(host.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, true);
    if (waitEndsFirst) host.push(at(2, { status: "running" }));
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (!waitEndsFirst) host.push(at(2, { status: "running" }));
    expect(screen.queryByRole("button", sync)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry backup" }),
    ).toHaveAttribute("aria-busy", "true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Back$/ })).toHaveFocus(),
    );
  },
);

it("hides consent actions wherever first run would not offer backup", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  await renderBackup(
    at(1, { status: "waiting", reason: "no_consent" }, false),
  ).settled();
  await showKeyDetails();
  expect(screen.queryByRole("button", sync)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry backup" })).toBeNull();
  cleanup();
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  await renderBackup(
    at(1, { status: "waiting", reason: "no_consent" }),
  ).settled();
  await showKeyDetails();
  expect(screen.queryByRole("button", sync)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry backup" })).toBeNull();
});

it("renders native status transitions and ignores a stale completion", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "idle" }));
  await host.settled();
  await showKeyDetails();
  const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
  expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
  const states: Progress[] = [
    { status: "running" },
    { status: "waiting", reason: "no_session" },
    { status: "waiting", reason: "not_linked" },
    ...(
      ["signed_out", "busy", "unreachable", "unconfirmed", "storage"] as const
    ).map((kind) => ({ status: "failed" as const, kind })),
    { status: "complete" },
  ];
  let seq = 1;
  for (const progress of states) {
    host.push(at(++seq, progress));
    if (progress.status === "complete") {
      expect(badge.getByText(/A backup is saved/)).toBeVisible();
      expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
    } else if (
      // A sign-in on this page starts the next pass itself.
      progress.status === "waiting" &&
      progress.reason === "no_session"
    ) {
      expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
    } else {
      const retry = badge.getByRole("button", { name: "Retry backup" });
      if (progress.status === "running") {
        expect(retry).toBeDisabled();
        expect(retry).toHaveAttribute("aria-busy", "true");
      } else expect(retry).toBeEnabled();
    }
    if (progress.status === "failed" && progress.kind === "busy") {
      host.push(at(seq - 1, { status: "complete" }));
      expect(badge.getByRole("button", { name: "Retry backup" })).toBeEnabled();
    }
    expect(backupRow()).toBeNull();
  }
});

const confirmedAt = (seq: number, progress: Progress) => {
  const status = at(seq, progress);
  return {
    ...status,
    management: { ...status.management, initialBackupConfirmed: true },
  } as BackupStatus;
};

// The native receipt confirms the key at launch: a re-check that can't reach
// or sign in to Builderlab leaves it backed up.
it.each([
  { status: "idle" },
  { status: "waiting", reason: "no_session" },
  ...(
    ["unreachable", "signed_out", "busy", "storage", "not_offered"] as const
  ).map((kind) => ({ status: "failed", kind }) as const),
] as const)(
  "shows a confirmed key as backed up through a %o re-check",
  async (progress) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    await renderBackup(confirmedAt(1, progress)).settled();
    const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
    expect(badge.getByText("Backed up")).toBeVisible();
    expect(badge.queryByRole("button", { name: "Check backup" })).toBeNull();
    await showKeyDetails();
    expect(badge.getByText(/A backup is saved/)).toBeVisible();
    expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
    expect(
      badge.queryByText(/Couldn’t reach|Sign in to Builderlab/),
    ).toBeNull();
  },
);

it("shows a confirmed key as backed up when the account read fails", async () => {
  const { fi, mount } = accountFixture(confirmedAt(1, { status: "idle" }));
  fi.request.mockRejectedValue(new Error("Offline"));
  mount();
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
  await act(async () => {
    await Promise.allSettled(
      fi.request.mock.results.map((result) => result.value),
    );
  });
  const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
  expect(badge.getByText("Backed up")).toBeVisible();
  await showKeyDetails();
  expect(badge.getByText(/A backup is saved/)).toBeVisible();
  expect(badge.queryByText("Backup status unknown")).toBeNull();
  expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
});

// Backed up K, turned automatic backup off, then linked K2 elsewhere: native
// stops at consent before it asks the account, so only Settings' own read
// sees K2.
it("withholds a receipt's Backed up while the account shows another backed-up key", async () => {
  const other = "cd".repeat(32);
  const { fi, mount } = accountFixture(
    confirmedAt(1, { status: "waiting", reason: "no_consent" }),
  );
  fi.request.mockImplementation(async ({ path }) =>
    accountResponse(path, other, [viewer, other]),
  );
  mount();
  expect(await screen.findByText("Backed-up key · Linked")).toBeVisible();
  const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
  expect(badge.queryByText("Backed up")).toBeNull();
  await showKeyDetails();
  expect(badge.queryByText(/A backup is saved/)).toBeNull();
});

// A receipt counts for any account. Backed up K with account A, turned
// automatic backup off, then signed in to B: native stops at consent before it
// asks B, and B's read finds no backup of K. The pill stays; the copy names
// this account only once it confirms the backup.
it.each([
  { linked: "cd".repeat(32), backups: [] as string[], holder: "a" },
  { linked: viewer, backups: [viewer], holder: "your" },
])(
  "says a receipt's backup is with $holder account after reading $linked",
  async ({ linked, backups, holder }) => {
    const { fi, mount } = accountFixture(
      confirmedAt(1, { status: "waiting", reason: "no_consent" }),
    );
    fi.request.mockImplementation(async ({ path }) =>
      accountResponse(path, linked, backups),
    );
    mount();
    await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.allSettled(
        fi.request.mock.results.map((result) => result.value),
      );
    });
    const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
    expect(badge.getByText("Backed up")).toBeVisible();
    await showKeyDetails();
    expect(
      badge.getByText(`A backup is saved with ${holder} Builderlab account.`, {
        exact: false,
      }),
    ).toBeVisible();
  },
);

// Another attempt gets the same answer: the copy says what to do instead.
it.each([
  [
    { status: "waiting", reason: "no_session" },
    "Sign in to Builderlab to back up your key",
  ],
  ...(["not_offered", "invalid_service", "refused"] as const).map(
    (kind) =>
      [
        { status: "failed", kind },
        BACKUP_FAILURES[kind].message.replace(/\.$/, ""),
      ] as const,
  ),
] as const)("offers no Retry backup for %o", async (progress, copy) => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  await renderBackup(at(1, progress)).settled();
  await showKeyDetails();
  const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
  expect(badge.getByText(copy)).toBeVisible();
  expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
});

/** bb-acme first, then bb-public, each with its own session. */
function twoServers() {
  const block = federatedFixture("block", "will@acme.example");
  const pub = federatedFixture("public", "will@example.com");
  block.publish({
    authority: {
      id: "bb-acme",
      identityOrigin: "https://acme.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "at-launch",
      organization: "Acme",
      communityHosts: ["buzz.acme.builderlab.xyz"],
    },
  });
  pub.publish({
    authority: {
      id: "bb-public",
      identityOrigin: "https://app.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
      communityHosts: ["*.communities.buzz.xyz", "communities.buzz.xyz"],
    },
  });
  const root: FederatedIdentity = {
    ...block.service,
    forServer: (id) => (id === "bb-acme" ? block.service : pub.service),
  };
  const servers = async () => [
    block.service.snapshot(),
    pub.service.snapshot(),
  ];
  return { block, pub, root, servers };
}
const memberships = [
  { id: "wss://buzz.acme.builderlab.xyz", name: "Acme" },
  { id: "wss://will.communities.buzz.xyz", name: "will" },
  { id: "wss://kalvin.communities.buzz.xyz", name: "kalvin" },
  { id: "wss://buzz.homelab.example", name: "homelab" },
];

// A listed row has no error popup to take focus: Renew gets it back when a
// renewal fails on its own.
it("keeps keyboard focus on a listed server's Renew when its renewal fails", async () => {
  const { block, root, servers } = twoServers();
  block.publish({
    status: "signed-in",
    email: "will@acme.example",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  let fail: () => void = () => {};
  vi.mocked(block.service.signIn).mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error("refused"));
      }),
  );
  const listed = vi.fn(servers);
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      servers={listed}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() => expect(listed).toHaveBeenCalledOnce());
  await act(async () => {
    await listed.mock.results[0]?.value;
  });
  const card = screen.getByRole("article", {
    name: "Acme (acme.builderlab.xyz)",
  });
  within(card).getByRole("button", { name: "Renew sign-in" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(within(card).getByRole("button", { name: "Cancel" })).toHaveFocus();
  await act(async () => fail());
  expect(await within(card).findByRole("alert")).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Renew sign-in" }),
  ).toHaveFocus();
});

it("lists each signed-in server and signs out of one without touching the other", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() =>
    expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible(),
  );
  expect(screen.getByText("app.builderlab.xyz")).toBeVisible();
  expect(screen.getByRole("img", { name: "Acme" })).toBeVisible();
  expect(screen.getByRole("img", { name: "will" })).toBeVisible();
  expect(screen.getByRole("img", { name: "kalvin" })).toBeVisible();
  // A self-hosted relay has no sign-in server.
  expect(screen.queryByText(/homelab/)).not.toBeInTheDocument();
  await confirmProviderSignOut("Sign out of app.builderlab.xyz");
  expect(pub.service.signOut).toHaveBeenCalledOnce();
  expect(block.service.signOut).not.toHaveBeenCalled();
  expect(block.service.snapshot().status).toBe("signed-in");
  expect(
    within(
      screen.getByRole("article", { name: "app.builderlab.xyz" }),
    ).getByText("Not signed in"),
  ).toBeVisible();
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
});

// A covered community that doesn't require NIP-FI is reached with the key
// alone, whatever this session does.
it("names as using a server only the communities that require its sign-in", async () => {
  const { block, pub, root, servers } = twoServers();
  pub.publish({ status: "signed-in", email: "will@example.com" });
  const communityRequiresSignIn = vi.fn(
    async (relay: string) => relay === "https://kalvin.communities.buzz.xyz",
  );
  const publicSession = { ...pub.service, communityRequiresSignIn };
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={{
        ...root,
        forServer: (id) => (id === "bb-acme" ? block.service : publicSession),
      }}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByRole("img", { name: "kalvin" })).toBeVisible();
  expect(communityRequiresSignIn.mock.calls.map(([relay]) => relay)).toEqual([
    "https://will.communities.buzz.xyz",
    "https://kalvin.communities.buzz.xyz",
  ]);
  await waitFor(() =>
    expect(screen.queryByRole("img", { name: "will" })).toBeNull(),
  );
});

it("keeps the first server's sign-in row when no server is signed in", async () => {
  const { root, servers } = twoServers();
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() => {
    const account = within(
      screen.getByRole("article", { name: "Acme (acme.builderlab.xyz)" }),
    );
    expect(account.getByText("Not signed in")).toBeVisible();
    expect(account.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});

it("keeps the first server's sign-in row, named, beside a signed-in server", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({
    status: "reauthentication-required",
    failure: "reauthentication-required",
  });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() =>
    expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible(),
  );
  expect(screen.getByText("Needs attention")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your sign-in has expired. Sign in again to continue.",
  );
  expect(
    screen.getByRole("button", { name: "Sign out of app.builderlab.xyz" }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("heading", { name: "Community sign-ins" }),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(block.service.signIn).toHaveBeenCalledOnce();
  expect(pub.service.signIn).not.toHaveBeenCalled();
  expect(pub.service.signOut).not.toHaveBeenCalled();
});

it("names the first server's failed restore beside a signed-in server, without controls", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "unavailable", failure: "storage-denied" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() =>
    expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible(),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    /^Sign-in could not access secure storage\./,
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("keeps a per-server sign-out that native couldn't finish visible, named, with Try again", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  // Native resolves a storage failure as an unavailable snapshot.
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({
      status: "unavailable",
      failure: "storage-denied",
      cleanup: true,
    });
    return pub.service.snapshot();
  });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  const user = userEvent.setup();
  await confirmProviderSignOut("Sign out of app.builderlab.xyz");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t sign out of app.builderlab.xyz. Sign-in could not access secure storage.",
  );
  // Its row is gone, the other server's stays.
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(block.service.snapshot().status).toBe("signed-in");
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({ status: "signed-out", failure: null, cleanup: false });
    return pub.service.snapshot();
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(pub.service.signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(block.service.signOut).not.toHaveBeenCalled();
});

it("restores an unfinished per-server sign-out's Try again when Settings opens again", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({
      status: "unavailable",
      failure: "storage-denied",
      cleanup: true,
    });
    return pub.service.snapshot();
  });
  const settings = () => (
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />
  );
  const first = render(settings(), { wrapper: ToastProvider });
  const user = userEvent.setup();
  await confirmProviderSignOut("Sign out of app.builderlab.xyz");
  expect(await screen.findByRole("alert")).toBeVisible();
  // Closing Settings and opening it again, as a reload does.
  first.unmount();
  render(settings(), { wrapper: ToastProvider });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t sign out of app.builderlab.xyz. Sign-in could not access secure storage.",
  );
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({ status: "signed-out", failure: null, cleanup: false });
    return pub.service.snapshot();
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(pub.service.signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

// A failed restore keeps a stored session that may still be valid.
it("offers no sign-out retry for a server whose restore failed", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "unavailable", failure: "network-unavailable" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() =>
    expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible(),
  );
  expect(screen.queryByText(/Couldn’t sign out/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(pub.service.signOut).not.toHaveBeenCalled();
  // Only a check of the stored session, which a restore that works answers.
  const row = screen.getByRole("article", {
    name: "app.builderlab.xyz",
  });
  vi.mocked(pub.service.recheck).mockImplementation(async () =>
    pub.publish({ status: "signed-in", failure: null }),
  );
  await userEvent.click(
    within(row).getByRole("button", { name: "Check again" }),
  );
  expect(pub.service.recheck).toHaveBeenCalledOnce();
  expect(
    await within(row).findByRole("button", {
      name: "Sign out of app.builderlab.xyz",
    }),
  ).toBeVisible();
  expect(pub.service.signIn).not.toHaveBeenCalled();
  expect(pub.service.signOut).not.toHaveBeenCalled();
});

it("shows the first server's failed restore as its own recovery text", async () => {
  const { block, root, servers } = twoServers();
  block.publish({ status: "unavailable", failure: "network-unavailable" });
  const listed = vi.fn(servers);
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      servers={listed}
    />,
    { wrapper: ToastProvider },
  );
  // Settings reads each server's session only once the list arrives.
  await waitFor(() => expect(listed).toHaveBeenCalledOnce());
  await act(async () => {
    await listed.mock.results[0]?.value;
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    /^Buzz couldn’t check your saved sign-in\. Check your connection, then choose Check again\.$/,
  );
  // Neither a sign-out retry nor a sign-in while the record is unchecked:
  // only a check that retries the restore and keeps the record.
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  const card = screen.getByRole("article", {
    name: "Acme (acme.builderlab.xyz)",
  });
  expect(within(card).queryByRole("button", { name: "Sign in" })).toBeNull();
  vi.mocked(block.service.recheck).mockImplementation(async () =>
    block.publish({ status: "unavailable", failure: "network-unavailable" }),
  );
  await userEvent.click(
    within(card).getByRole("button", { name: "Check again" }),
  );
  expect(block.service.recheck).toHaveBeenCalledOnce();
  // A check that fails again keeps its recovery text and its button.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /^Buzz couldn’t check your saved sign-in\. Check your connection, then choose Check again\.$/,
  );
  expect(
    within(card).getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  expect(block.service.signIn).not.toHaveBeenCalled();
  expect(block.service.signOut).not.toHaveBeenCalled();
});

it("shows only the account's linked backed-up key when it differs from this device, read-only", async () => {
  const other = "cd".repeat(32);
  const { fi, mount } = accountFixture(
    at(1, { status: "failed", kind: "other_key_linked" }),
  );
  fi.request.mockImplementation(async ({ path }) =>
    accountResponse(path, other, [viewer, other]),
  );
  mount();
  expect(await screen.findByText("Backed-up key · Linked")).toBeVisible();
  expect(screen.getByText(npubEncode(other))).toBeVisible();
  expect(screen.queryByText(npubEncode(viewer))).toBeNull();
  expect(screen.queryByText(/Last active|Checking activity/)).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  // Reads only: nothing that could unlink a key.
  expect(fi.request.mock.calls.map(([{ path }]) => path)).toEqual([
    expect.stringMatching(/\/nostr-identities\/current$/),
    expect.stringMatching(/\/nsec-backups\/status$/),
  ]);
});

it("rechecks the account after backup completes without adding a duplicate same-key row", async () => {
  const { host, fi, mount } = accountFixture(at(1, { status: "running" }));
  let backups: string[] = [];
  fi.request.mockImplementation(async ({ path }) =>
    accountResponse(path, viewer, backups),
  );
  mount();
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.queryByText(/^Backed-up key/)).toBeNull();
  backups = [viewer];
  host.push(at(2, { status: "complete" }));
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(4));
  await act(async () => {
    await Promise.allSettled(
      fi.request.mock.results.map((result) => result.value),
    );
  });
  expect(screen.queryByText(/^Backed-up key/)).toBeNull();
  expect(backupRow()).toBeNull();
});

it.each(["success", "failure"] as const)(
  "retries an account lookup through the card with %s while blocking duplicate starts",
  async (outcome) => {
    const { host, fi, mount } = accountFixture(at(1, { status: "idle" }));
    const retry = vi.spyOn(host.identity.backup, "retry").mockResolvedValue(2);
    let retrying = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fi.request.mockImplementation(async ({ path }) => {
      if (!retrying) throw new Error("Initial account lookup failed");
      await gate;
      if (outcome === "failure") throw new Error("Still offline");
      return accountResponse(path);
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Check backup" }),
    );
    const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
    expect(badge.getByText("Backup status unknown")).toBeVisible();
    expect(
      badge.getByText("This key is stored securely on this device."),
    ).toBeVisible();
    expect(badge.queryByText(/A backup is saved/)).toBeNull();
    expect(screen.queryByText(/Couldn’t check your backup/)).toBeNull();
    retrying = true;
    const action = badge.getByRole("button", { name: "Retry backup" });
    try {
      await userEvent.click(action);
      await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(4));
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(badge.getByRole("button", { name: /^Back$/ })).toHaveFocus();
      await userEvent.click(action);
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => release());
    }
    if (outcome === "success") {
      await waitFor(() =>
        expect(badge.queryByText("Backup status unknown")).toBeNull(),
      );
      expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
    } else {
      await waitFor(() => expect(action).toBeEnabled());
      expect(badge.getByText("Backup status unknown")).toBeVisible();
      expect(badge.queryByText(/A backup is saved/)).toBeNull();
    }
    expect(screen.queryByText(/^Backed-up key/)).toBeNull();
    expect(backupRow()).toBeNull();
  },
);

it("discards a failed account lookup after the session changes", async () => {
  const { fi, mount } = accountFixture(at(1, { status: "complete" }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fi.request.mockImplementation(async () => {
    await gate;
    throw new Error("Retired lookup failed");
  });
  mount();
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
  act(() => fi.publish({ status: "signed-out", revision: "retired" }));
  await act(async () => {
    release();
    await Promise.allSettled(
      fi.request.mock.results.map((result) => result.value),
    );
  });
  await showKeyDetails();
  expect(screen.queryByText("Backup status unknown")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry backup" })).toBeNull();
});

it("keeps guarded removal available while key management is unknown", async () => {
  const { management: _, ...unknown } = at(1, { status: "idle" });
  const h = renderBackup(unknown);
  h.identity.wipeRefusal = vi.fn(async () => null);
  h.identity.signOut = vi.fn(async () => {});
  await h.settled();
  await showKeyDetails();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Remove from device" }));
  const dialog = within(screen.getByRole("alertdialog"));
  expect(
    dialog.getByRole("button", { name: "Remove from device" }),
  ).toBeDisabled();
  expect(
    dialog.getByRole("checkbox", { name: "I have my key" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(h.identity.signOut).not.toHaveBeenCalled();
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("button", { name: "Remove from device" }),
  ).toHaveFocus();
});

it("checks on page opening and shares the bottom action space with backup retry", async () => {
  const { management: _, ...unknown } = at(1, { status: "running" });
  const h = backupHost(unknown);
  const management = {
    pubkey: viewer,
    policy: "organization-managed" as const,
    initialBackupConfirmed: false,
  };
  const retryBackup = vi
    .spyOn(h.identity.backup, "retry")
    .mockImplementation(async () => {
      h.push(at(3, { status: "running", management }));
      return 3;
    });
  let resolveRead!: (status: BackupStatus) => void;
  const retryRead = new Promise<BackupStatus>((resolve) => {
    resolveRead = resolve;
  });
  let reject!: (reason: Error) => void;
  const pending = new Promise<BackupStatus>((_resolve, fail) => {
    reject = fail;
  });
  const refresh = vi
    .spyOn(h.identity.backup, "refresh")
    .mockImplementationOnce(() => pending)
    .mockImplementationOnce(async () => {
      const confirmed = await retryRead;
      h.push(confirmed);
      return confirmed;
    });
  const user = userEvent.setup();
  render(<IdentitySettings viewer={viewer} identity={h.identity} />);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(
    screen.queryByRole("status", { name: "Backing up your key" }),
  ).toBeNull();
  await showKeyDetails();
  const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
  expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
  await act(async () => reject(new Error("Secure storage unavailable")));
  expect(badge.getByRole("status")).toHaveTextContent("Backup status unknown");
  const retryStatus = badge.getByRole("button", { name: "Retry backup" });
  await user.click(retryStatus);
  expect(retryStatus).toBeDisabled();
  expect(retryStatus).toHaveAttribute("aria-busy", "true");
  expect(retryBackup).not.toHaveBeenCalled();
  await user.click(retryStatus);
  expect(refresh).toHaveBeenCalledTimes(2);
  await user.click(badge.getByRole("button", { name: "Back" }));
  await showKeyDetails();
  expect(badge.getByRole("button", { name: "Retry backup" })).toBeDisabled();
  await act(async () => resolveRead(at(2, { status: "idle", management })));
  await waitFor(() => expect(retryBackup).toHaveBeenCalledOnce());
  expect(badge.queryByText("Backup status unknown")).toBeNull();
  expect(badge.getByRole("button", { name: "Retry backup" })).toBeDisabled();
  expect(badge.getByRole("button", { name: "Back" })).toHaveFocus();
  expect(refresh).toHaveBeenCalledTimes(2);
  h.push(at(4, { status: "complete", management }));
  expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
  expect(badge.getByText(/This key is stored securely/)).toHaveTextContent(
    "A backup is saved",
  );
});

it.each([
  "read failed",
  "different key",
  "unmounted",
  "already running",
  "upload refused",
  "upload rejected",
] as const)(
  "handles %s while retrying an unknown backup status",
  async (outcome) => {
    const { management: _, ...unknown } = at(1, { status: "idle" });
    const h = backupHost(unknown);
    const management = {
      pubkey: viewer,
      policy: "organization-managed" as const,
      initialBackupConfirmed: false,
    };
    let resolveRead!: (status: BackupStatus) => void;
    let rejectRead!: (reason: Error) => void;
    const read = new Promise<BackupStatus>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    const refresh = vi
      .spyOn(h.identity.backup, "refresh")
      .mockRejectedValueOnce(new Error("Controlled initial read failure"))
      .mockImplementationOnce(async () => {
        const next = await read;
        h.push(next);
        return next;
      });
    const retry = vi.spyOn(h.identity.backup, "retry");
    if (outcome === "upload rejected")
      retry.mockRejectedValue(new Error("Controlled upload refusal"));
    else retry.mockResolvedValue(null);
    const user = userEvent.setup();
    const view = render(
      <IdentitySettings viewer={viewer} identity={h.identity} />,
    );
    await showKeyDetails();
    const badge = within(screen.getByRole("region", { name: "Your Buzz ID" }));
    await badge.findByText("Backup status unknown");
    await user.click(badge.getByRole("button", { name: "Retry backup" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    if (outcome === "unmounted") view.unmount();
    await act(async () => {
      if (outcome === "read failed")
        rejectRead(new Error("Controlled second read failure"));
      else
        resolveRead(
          at(2, {
            status: outcome === "already running" ? "running" : "idle",
            management: {
              ...management,
              pubkey: outcome === "different key" ? "cd".repeat(32) : viewer,
            },
          }),
        );
    });
    if (outcome === "upload refused" || outcome === "upload rejected") {
      expect(await badge.findByRole("alert")).toHaveTextContent(
        "Couldn’t start the backup",
      );
      expect(retry).toHaveBeenCalledOnce();
      expect(
        badge.getByRole("button", { name: "Retry backup" }),
      ).not.toBeDisabled();
      h.push(at(3, { status: "complete", management }));
      expect(badge.queryByRole("alert")).toBeNull();
      expect(badge.queryByRole("button", { name: "Retry backup" })).toBeNull();
    } else {
      expect(retry).not.toHaveBeenCalled();
      if (outcome === "read failed" || outcome === "different key") {
        expect(badge.getByText("Backup status unknown")).toBeVisible();
        expect(
          badge.getByRole("button", { name: "Retry backup" }),
        ).not.toBeDisabled();
      } else if (outcome === "already running") {
        expect(
          badge.getByRole("button", { name: "Retry backup" }),
        ).toBeDisabled();
      }
    }
  },
);
