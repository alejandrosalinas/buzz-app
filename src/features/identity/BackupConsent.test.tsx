// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { emptySync, type SyncState } from "../communities/known-communities";
import { importLegacyCommunities } from "../communities/legacy-communities";
import type { ClientSnapshot } from "../communities/service";
import { type BackupStatus, createBackupStatus } from "./backup";
import { BackupConsent, BackupPrompt, decideBackup } from "./BackupConsent";
import type { Identity } from "./service";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    constructor(public onmessage: (status: unknown) => void) {}
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  document.body.replaceChildren();
});

const viewer = "ab".repeat(32);
/** bb-public's community hosts, as its compiled sign-in server lists them. */
const PUBLIC_HOSTS = ["*.communities.buzz.xyz", "communities.buzz.xyz"];
/** A build whose first compiled sign-in server is bb-public. */
const publicServers = async () =>
  [
    {
      status: "signed-out",
      authority: {
        id: "bb-public",
        identityOrigin: "https://app.builderlab.xyz",
        apiBasePath: "/api/goose/",
        signIn: "on-demand",
        organization: null,
        communityHosts: PUBLIC_HOSTS,
      },
      revision: "",
      email: null,
      failure: null,
      expiresAt: null,
      expiring: false,
      cleanup: false,
    },
  ] as const;
const HOSTED = "https://communities.buzz.xyz";
const INDEPENDENT = "https://relay.example.com";

type Progress<S = BackupStatus> = S extends unknown
  ? Omit<S, "seq" | "pass" | "builderlab">
  : never;
const at = (seq: number, progress: Progress, builderlab = true) =>
  ({ seq, pass: seq, builderlab, ...progress }) as BackupStatus;
const consent = (seq = 1) =>
  at(seq, { status: "waiting", reason: "no_consent" });
const memberships = (ids: readonly string[]) =>
  ids.map((id) => ({ id, name: id }));

it.each([
  ["a hosted community", "save", [HOSTED]],
  [
    "a hosted community among independent ones",
    "save",
    [INDEPENDENT, "https://design.communities.buzz.xyz"],
  ],
  ["only independent communities", "ask", [INDEPENDENT, "acme"]],
  ["no communities", "ask", []],
] as const)(
  "a key with no saved choice in %s decides %s",
  (_label, decision, ids) => {
    expect(
      decideBackup(
        consent(),
        { automatic: null },
        memberships(ids),
        PUBLIC_HOSTS,
      ),
    ).toBe(decision);
  },
);

it("a build whose Builderlab doesn't host a community asks even for a hosted one", () => {
  for (const hosts of [["buzz.acme.builderlab.xyz"], [], undefined])
    expect(
      decideBackup(
        consent(),
        { automatic: null },
        memberships([HOSTED]),
        hosts,
      ),
    ).toBe("ask");
});

it.each([
  ["a saved opt-in", consent(), true],
  ["a saved opt-out", consent(), false],
  ["no status yet", undefined, null],
  ["an idle uploader", at(1, { status: "idle" }), null],
  ["a completed backup", at(1, { status: "complete" }), null],
  [
    "a Builderlab sign-out",
    at(1, { status: "waiting", reason: "no_session" }),
    null,
  ],
  [
    "an uploader with no Builderlab source",
    at(1, { status: "waiting", reason: "no_consent" }, false),
    null,
  ],
] as const)("%s decides nothing", (_label, status, automatic) => {
  for (const ids of [[HOSTED], [INDEPENDENT]])
    expect(
      decideBackup(status, { automatic }, memberships(ids), PUBLIC_HOSTS),
    ).toBeUndefined();
});

/**
 * The real status store over a native uploader that answers `initial`, a
 * saved choice of `automatic`, and memberships of `ids`.
 */
function setup(
  initial: BackupStatus,
  ids: readonly string[],
  automatic: boolean | null = null,
  loading = false,
) {
  const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
  const backup = createBackupStatus(
    async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as (typeof watchers)[number]);
        return undefined as T;
      }
      if (command === "nsec_backup_state") return initial as T;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const getBackupChoice = vi.fn(async () => ({
    available: true,
    pubkey: viewer,
    automatic,
  }));
  const setBackupChoice = vi.fn(async (pubkey: string, value: boolean) => ({
    available: true,
    pubkey,
    automatic: value,
  }));
  let client = {
    status: loading ? "loading" : "ready",
    viewer,
    memberships: memberships(ids),
    sync: emptySync(),
  } as ClientSnapshot;
  const listeners = new Set<() => void>();
  const update = (next: Partial<ClientSnapshot>) => {
    client = { ...client, ...next };
    for (const listener of listeners) listener();
  };
  const communities = {
    snapshot: vi.fn(() => client),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Old Buzz's import adds through here. */
    async applySync(sync: SyncState, add: string[] = []) {
      update({
        sync,
        memberships: [...client.memberships, ...memberships(add)],
      });
    },
  };
  render(
    <BackupConsent
      identity={
        { backup, getBackupChoice, setBackupChoice } as unknown as Identity
      }
      communities={communities}
      servers={publicServers}
    />,
  );
  return {
    backup,
    communities,
    getBackupChoice,
    setBackupChoice,
    push: (status: BackupStatus) =>
      act(() => watchers.at(-1)?.onmessage(status)),
    join: (next: readonly string[]) =>
      act(() => update({ status: "ready", memberships: memberships(next) })),
    /** A community update that leaves the memberships as they were. */
    emit: () =>
      act(() => update({ selected: client.memberships[0]?.id ?? null })),
    /** Runs old Buzz's import of `relayUrl`, held at its dialog until `answer`. */
    importLegacy(relayUrl: string) {
      let answer = (_approved: boolean) => {};
      const confirm = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      let dispose = () => {};
      act(() => {
        dispose = importLegacyCommunities(communities, confirm, async () => [
          { relayUrl, pubkey: viewer },
        ]);
      });
      return {
        confirm,
        answer: (approved: boolean) => act(async () => answer(approved)),
        dispose: () => {
          dispose();
          answer(false);
        },
      };
    },
    /** Settles once the `count`th saved-choice read and its decision have. */
    decided: async (count: number) => {
      await waitFor(() => expect(getBackupChoice).toHaveBeenCalledTimes(count));
      await act(async () => {
        await Promise.resolve(
          getBackupChoice.mock.results[count - 1]?.value,
        ).catch(() => {});
      });
    },
  };
}

const prompt = () => screen.queryByRole("alertdialog");

it("a key in a hosted community is backed up with no prompt", async () => {
  const app = setup(consent(), [INDEPENDENT, HOSTED]);
  await app.decided(1);
  expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(
    viewer,
    true,
    true,
  );
  expect(prompt()).toBeNull();
});

it.each([
  ["Sync with Builderlab", true],
  ["I will manage my own key", false],
] as const)(
  "a key in only independent communities is asked, and %s saves its answer",
  async (action, automatic) => {
    const app = setup(consent(), [INDEPENDENT]);
    const user = userEvent.setup();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Sync your identity with Builderlab?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Buzz will save an encrypted copy of your identity key with your Builderlab account. That copy can restore your identity, including in other apps where you use the same key.",
    );
    expect(app.setBackupChoice).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: action }));
    expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(
      viewer,
      automatic,
    );
    await waitFor(() => expect(prompt()).toBeNull());
  },
);

it("closing the prompt saves nothing and keeps it closed until Builderlab signs out", async () => {
  const app = setup(consent(), [INDEPENDENT], null, true);
  const user = userEvent.setup();
  // Memberships still loading decide nothing.
  await act(() => app.backup.ready());
  expect(app.getBackupChoice).not.toHaveBeenCalled();
  await app.join([INDEPENDENT]);
  await screen.findByRole("alertdialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(prompt()).toBeNull());
  await app.join([INDEPENDENT, "https://other.example.com"]);
  await app.decided(2);
  expect(prompt()).toBeNull();
  expect(app.setBackupChoice).not.toHaveBeenCalled();
  // The next Builderlab sign-in asks again.
  await app.push(at(2, { status: "waiting", reason: "no_session" }));
  await app.push(consent(3));
  await app.decided(3);
  expect(await screen.findByRole("alertdialog")).toBeVisible();
});

it("joining a hosted community while asked saves the choice and closes the prompt", async () => {
  const app = setup(consent(), [INDEPENDENT]);
  await screen.findByRole("alertdialog");
  await app.join([INDEPENDENT, HOSTED]);
  await app.decided(2);
  expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(
    viewer,
    true,
    true,
  );
  expect(prompt()).toBeNull();
});

it("a user's answer still being saved stands over a hosted community joined meanwhile", async () => {
  const app = setup(consent(), [INDEPENDENT]);
  const user = userEvent.setup();
  let release = () => {};
  app.setBackupChoice.mockImplementationOnce(
    (pubkey, automatic) =>
      new Promise((resolve) => {
        release = () => resolve({ available: true, pubkey, automatic });
      }),
  );
  await screen.findByRole("alertdialog");
  try {
    await user.click(
      screen.getByRole("button", { name: "I will manage my own key" }),
    );
    expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, false);
    // The saved choice still reads as missing, so this decides to save.
    await app.join([INDEPENDENT, HOSTED]);
    await app.decided(2);
    expect(app.setBackupChoice).toHaveBeenCalledOnce();
    expect(prompt()).toBeVisible();
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(prompt()).toBeNull());
  expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, false);
});

it("a hosted community joined while the user's answer was saving is backed up once that answer is refused and the prompt closed", async () => {
  const app = setup(consent(), [INDEPENDENT]);
  const user = userEvent.setup();
  let refuse = () => {};
  app.setBackupChoice.mockImplementationOnce(
    () =>
      new Promise<never>((_resolve, reject) => {
        refuse = () => reject("Another backup of this key is in progress.");
      }),
  );
  await screen.findByRole("alertdialog");
  try {
    await user.click(
      screen.getByRole("button", { name: "I will manage my own key" }),
    );
    await app.join([INDEPENDENT, HOSTED]);
    await app.decided(2);
    expect(app.setBackupChoice).toHaveBeenCalledOnce();
  } finally {
    await act(async () => refuse());
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another backup of this key is in progress.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(prompt()).toBeNull());
  // An update that leaves the memberships as they were decides again.
  await app.emit();
  await app.decided(3);
  expect(app.setBackupChoice.mock.calls).toEqual([
    [viewer, false],
    [viewer, true, true],
  ]);
  expect(prompt()).toBeNull();
});

it("a failed read or refused save decides again on the next community update", async () => {
  const app = setup(consent(), [HOSTED]);
  app.getBackupChoice.mockRejectedValueOnce(new Error("Storage is locked"));
  app.setBackupChoice.mockRejectedValueOnce(
    "Another backup of this key is in progress.",
  );
  await app.decided(1);
  expect(app.setBackupChoice).not.toHaveBeenCalled();
  await app.emit();
  await app.decided(2);
  await waitFor(() => expect(app.setBackupChoice).toHaveBeenCalledOnce());
  await act(async () => {
    await app.setBackupChoice.mock.results[0]?.value.catch(() => {});
  });
  await app.emit();
  await app.decided(3);
  expect(app.setBackupChoice.mock.calls).toEqual([
    [viewer, true, true],
    [viewer, true, true],
  ]);
  expect(prompt()).toBeNull();
});

it("nothing is decided under the launch screen", async () => {
  document.body.innerHTML = '<div id="buzz-launch"></div>';
  const app = setup(consent(), [HOSTED]);
  await act(() => app.backup.ready());
  await app.emit();
  expect(app.getBackupChoice).not.toHaveBeenCalled();
  expect(app.setBackupChoice).not.toHaveBeenCalled();
});

it("waits while old Buzz's communities are offered, then decides with the ones added", async () => {
  const app = setup(consent(), [INDEPENDENT]);
  const legacy = app.importLegacy("wss://communities.buzz.xyz");
  try {
    await waitFor(() => expect(legacy.confirm).toHaveBeenCalledOnce());
    await act(() => app.backup.ready());
    expect(app.getBackupChoice).not.toHaveBeenCalled();
    expect(prompt()).toBeNull();
    await legacy.answer(true);
    await app.decided(1);
    expect(app.communities.snapshot().memberships).toEqual(
      memberships([INDEPENDENT, HOSTED]),
    );
    expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(
      viewer,
      true,
      true,
    );
    expect(prompt()).toBeNull();
  } finally {
    legacy.dispose();
  }
});

it("a prompt already open is held while old Buzz's import runs, and stays closed until it is decided again", async () => {
  const app = setup(consent(), [INDEPENDENT]);
  await screen.findByRole("alertdialog");
  let read = () => {};
  app.getBackupChoice.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        read = () =>
          resolve({ available: true, pubkey: viewer, automatic: null });
      }),
  );
  const legacy = app.importLegacy("wss://communities.buzz.xyz");
  try {
    expect(prompt()).toBeNull();
    await waitFor(() => expect(legacy.confirm).toHaveBeenCalledOnce());
    await legacy.answer(true);
    await waitFor(() => expect(app.getBackupChoice).toHaveBeenCalledTimes(2));
    expect(prompt()).toBeNull();
  } finally {
    await act(async () => read());
    legacy.dispose();
  }
  await app.decided(2);
  expect(app.setBackupChoice).toHaveBeenCalledExactlyOnceWith(
    viewer,
    true,
    true,
  );
  expect(prompt()).toBeNull();
});

it("a saved opt-out is not asked about, and nothing reads memberships outside a consent wait", async () => {
  const declined = setup(consent(), [INDEPENDENT, HOSTED], false);
  await declined.decided(1);
  expect(prompt()).toBeNull();
  expect(declined.setBackupChoice).not.toHaveBeenCalled();
  cleanup();
  const idle = setup(at(1, { status: "complete" }), [INDEPENDENT]);
  await act(() => idle.backup.ready());
  expect(idle.communities.snapshot).not.toHaveBeenCalled();
  expect(idle.getBackupChoice).not.toHaveBeenCalled();
});

it("a refused save stays in the prompt with its reason after the wait ends elsewhere", async () => {
  let refuse = () => {};
  const setBackupChoice = vi.fn<Identity["setBackupChoice"]>(
    () =>
      new Promise<never>((_resolve, reject) => {
        refuse = () => reject("Another backup of this key is in progress.");
      }),
  );
  const onClose = vi.fn();
  const user = userEvent.setup();
  const prompt = (ended: boolean) => (
    <BackupPrompt
      identity={{ setBackupChoice }}
      pubkey={viewer}
      onClose={onClose}
      ended={ended}
    />
  );
  const { rerender } = render(prompt(false));
  await user.click(
    await screen.findByRole("button", { name: "I will manage my own key" }),
  );
  rerender(prompt(true));
  await act(async () => refuse());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another backup of this key is in progress.",
  );
  expect(onClose).not.toHaveBeenCalled();
});

it("a refused save stays in the prompt with its reason, and Escape then closes it saving nothing more", async () => {
  const setBackupChoice = vi
    .fn<Identity["setBackupChoice"]>()
    .mockRejectedValueOnce("Another backup of this key is in progress.");
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <BackupPrompt
      identity={{ setBackupChoice }}
      pubkey={viewer}
      onClose={onClose}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Sync with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another backup of this key is in progress.",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Sync with Builderlab" }),
  ).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  expect(setBackupChoice).toHaveBeenCalledOnce();
});
