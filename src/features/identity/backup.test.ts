import { expect, it, vi } from "vitest";
import {
  BackupError,
  type BackupStatus,
  backUpWith,
  createBackupStatus,
  handoffFederatedBackupSession,
} from "./backup";
import { BACKUP_FAILURES } from "./backup-failure";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));

type Send = NonNullable<Parameters<typeof createBackupStatus>[0]>;
type Watcher = { onmessage: (status: BackupStatus) => void };
const at = (
  seq: number,
  pass: number,
  status: "idle" | "running" | "complete",
): BackupStatus => ({ seq, pass, builderlab: true, status });

function native(initial: BackupStatus = at(1, 0, "idle")) {
  const watchers: Watcher[] = [];
  let state = (): Promise<BackupStatus> => Promise.resolve(initial);
  let watch = (): Promise<void> => Promise.resolve();
  // The first-run handoff starts pass 1; handing the slot back starts none.
  const session = vi.fn(
    async (credential: unknown): Promise<unknown> => (credential ? 1 : null),
  );
  const choice = vi.fn(async (): Promise<unknown> => ({}));
  const send = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as Watcher);
        return watch();
      }
      if (command === "nsec_backup_state") return state();
      if (command === "nsec_backup_session") return session(args?.federated);
      if (command === "nsec_backup_set_choice") return choice();
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  return {
    send,
    session,
    choice,
    store: () => createBackupStatus(send as Send),
    watchers,
    failState(error: unknown) {
      state = () => Promise.reject(error);
    },
    holdState(status: BackupStatus) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      state = () => held.then(() => status);
      return release;
    },
    failWatch(error: unknown) {
      watch = () => Promise.reject(error);
      return () => {
        watch = () => Promise.resolve();
      };
    },
  };
}

it("registers nothing until read, then watches before reading the snapshot", async () => {
  const host = native();
  const store = host.store();
  expect(store.snapshot()).toBeUndefined();
  expect(host.send).not.toHaveBeenCalled();

  const listener = vi.fn();
  store.subscribe(listener);
  await expect(store.ready()).resolves.toEqual(at(1, 0, "idle"));
  expect(host.send.mock.calls).toEqual([
    ["nsec_backup_watch", { onEvent: host.watchers[0] }],
    ["nsec_backup_state"],
  ]);
  expect(listener).toHaveBeenCalledTimes(1);

  host.watchers[0]?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(2, 1, "running"));
  await expect(store.ready()).resolves.toEqual(at(2, 1, "running"));
  expect(host.send).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(2);
});

it("keeps the higher seq whether the older status arrives on the channel or in the snapshot", async () => {
  const host = native();
  const release = host.holdState(at(4, 2, "running"));
  const store = host.store();
  const listener = vi.fn();
  store.subscribe(listener);
  const ready = store.ready();
  await vi.waitFor(() =>
    expect(host.send).toHaveBeenCalledWith("nsec_backup_state"),
  );

  // Published after the watch registered, delivered before the snapshot reply.
  host.watchers[0]?.onmessage(at(5, 2, "complete"));
  release();
  await expect(ready).resolves.toEqual(at(5, 2, "complete"));
  expect(listener).toHaveBeenCalledTimes(1);

  host.watchers[0]?.onmessage(at(5, 3, "running"));
  host.watchers[0]?.onmessage(at(3, 3, "running"));
  expect(store.snapshot()).toEqual(at(5, 2, "complete"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("registers again after a failed watch", async () => {
  const host = native();
  const refused = new Error("Backup status belongs to the main window");
  const recover = host.failWatch(refused);
  const store = host.store();
  await expect(store.ready()).rejects.toBe(refused);
  expect(host.send).toHaveBeenCalledTimes(1);

  recover();
  await expect(store.ready()).resolves.toEqual(at(1, 0, "idle"));
  expect(host.watchers).toHaveLength(2);
  expect(host.watchers[1]).not.toBe(host.watchers[0]);
  host.watchers[1]?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(2, 1, "running"));
});

it("silences the channel and its listeners on dispose", async () => {
  const host = native();
  const store = host.store();
  const listener = vi.fn();
  store.subscribe(listener);
  await store.ready();
  const watcher = host.watchers[0];
  store.dispose();

  watcher?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(1, 0, "idle"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("hands off only the public revision, resolving to its ticket, or null when none is issued or the handoff fails", async () => {
  const send = vi.fn<
    (command: string, args?: Record<string, unknown>) => Promise<unknown>
  >(async () => 2);
  await expect(
    handoffFederatedBackupSession("revision-1", send as Send),
  ).resolves.toBe(2);
  send.mockResolvedValueOnce(null);
  await expect(
    handoffFederatedBackupSession(null, send as Send),
  ).resolves.toBeNull();
  expect(send.mock.calls.map(([, args]) => args)).toEqual([
    { federated: "revision-1", generation: expect.any(Number) },
    { federated: null, generation: expect.any(Number) },
  ]);
  const [first = 0, second = 0] = send.mock.calls.map(
    ([, args]) => args?.generation as number,
  );
  expect(second - first).toBe(1);
  send.mockRejectedValueOnce(new Error("Invalid backup session"));
  await expect(
    handoffFederatedBackupSession("stale", send as Send),
  ).resolves.toBeNull();
});

type Waiter = Parameters<typeof backUpWith>[0];
const pubkey = "a".repeat(64);
const commands = (host: ReturnType<typeof native>) =>
  host.send.mock.calls.map(([command, args]) =>
    command === "nsec_backup_session"
      ? `${command}(${args?.federated ?? null})`
      : command,
  );
/** The first-run waiter against the identity's real store over `host`, with a
 * deadline the test expires. */
function backUp(host: ReturnType<typeof native>, revision = "fi-revision") {
  const identity: Waiter = {
    backup: host.store(),
    setBackupChoice: ((pubkey: string, automatic: boolean) =>
      host.send("nsec_backup_set_choice", {
        pubkey,
        automatic,
      })) as Waiter["setBackupChoice"],
  };
  let expire!: () => void;
  let signal!: AbortSignal;
  const after = vi.fn((_ms: number, cleared: AbortSignal) => {
    signal = cleared;
    return new Promise<void>((resolve) => {
      expire = resolve;
    });
  });
  const done = backUpWith(identity, pubkey, revision, {
    after,
    send: host.send as Send,
  });
  const failed = done.then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    done,
    failed,
    after,
    expire: () => expire(),
    cleared: () => signal.aborted,
    started: () =>
      vi.waitFor(() =>
        expect(host.send).toHaveBeenCalledWith(
          "nsec_backup_session",
          expect.objectContaining({ federated: revision }),
        ),
      ),
  };
}
const settledAt = (seq: number, pass: number, settled: object) =>
  ({ seq, pass, builderlab: true, ...settled }) as BackupStatus;

it("turns consent on, hands the revision over and waits for the pass its ticket names", async () => {
  // A stale failure from before the handoff must not answer.
  const host = native(
    settledAt(1, 0, { status: "failed", kind: "unreachable" }),
  );
  const backup = backUp(host);
  await backup.started();
  expect(backup.after).toHaveBeenCalledWith(60_000, expect.anything());
  host.watchers[0]?.onmessage(at(2, 1, "running"));
  // Drains every microtask an answer would have queued.
  await new Promise((resolve) => setTimeout(resolve));
  expect(commands(host)).not.toContain("nsec_backup_session(null)");

  host.watchers[0]?.onmessage(at(3, 1, "complete"));
  await expect(backup.done).resolves.toBeUndefined();
  expect(commands(host)).toEqual([
    "nsec_backup_watch",
    "nsec_backup_state",
    "nsec_backup_set_choice",
    "nsec_backup_session(fi-revision)",
    "nsec_backup_session(fi-revision)",
  ]);
  expect(host.send).toHaveBeenCalledWith("nsec_backup_set_choice", {
    pubkey,
    automatic: true,
  });
  expect(backup.cleared()).toBe(true);
});

it.each([
  [{ status: "failed", kind: "refused" }, "refused"],
  [{ status: "failed", kind: "unreachable" }, "unreachable"],
  [{ status: "waiting", reason: "not_linked" }, "not_linked"],
  // Each would only be retried on a later wake.
  [{ status: "waiting", reason: "no_session" }, "interrupted"],
  [{ status: "waiting", reason: "no_consent" }, "interrupted"],
  [{ status: "idle" }, "interrupted"],
] as const)(
  "fails a pass that ended %o as %s, and hands the slot back",
  async (ended, kind) => {
    const host = native();
    const backup = backUp(host);
    await backup.started();
    host.watchers[0]?.onmessage(settledAt(2, 1, ended));
    const error = await backup.failed;
    expect(error).toBeInstanceOf(BackupError);
    expect(error).toMatchObject({
      name: "BackupError",
      kind,
      message: BACKUP_FAILURES[kind].message,
      retryable: BACKUP_FAILURES[kind].retryable,
    });
    expect(commands(host).at(-1)).toBe("nsec_backup_session(null)");
    expect(backup.cleared()).toBe(true);
  },
);

it("offers no Try again for an ended sign-in, which would send the same revision", () => {
  expect(new BackupError("signed_out")).toMatchObject({
    message:
      "Your Builderlab sign-in is no longer valid, so your key wasn’t backed up.",
    retryable: false,
  });
});

it("answers from the snapshot when the pass settled before the subscription", async () => {
  const host = native();
  host.session.mockImplementationOnce(async () => {
    host.watchers[0]?.onmessage(at(2, 1, "complete"));
    return 1;
  });
  await expect(backUp(host).done).resolves.toBeUndefined();
});

it("times out on the deadline, handing the slot back so the running pass retires", async () => {
  const host = native();
  const backup = backUp(host);
  await backup.started();
  host.watchers[0]?.onmessage(at(2, 1, "running"));
  backup.expire();
  expect(await backup.failed).toMatchObject({
    kind: "timeout",
    retryable: true,
  });
  expect(commands(host).at(-1)).toBe("nsec_backup_session(null)");
});

it.each([
  [
    "completed",
    (host: ReturnType<typeof native>) =>
      host.watchers[0]?.onmessage(at(2, 1, "complete")),
    "nsec_backup_session(fi-revision)",
  ],
  [
    "timed-out",
    (_host: ReturnType<typeof native>, backup: ReturnType<typeof backUp>) =>
      backup.expire(),
    "nsec_backup_session(null)",
  ],
] as const)(
  "leaves an FI session, which the Builderlab plugin shares, with the uploader only after a %s pass",
  async (_label, end, last) => {
    const host = native();
    const backup = backUp(host);
    await backup.started();
    end(host, backup);
    await backup.failed;
    expect(commands(host).slice(3)).toEqual([
      "nsec_backup_session(fi-revision)",
      last,
    ]);
  },
);

it("is unavailable without writing consent where native backup does not run", async () => {
  const host = native({ ...at(1, 0, "idle"), builderlab: false });
  expect(await backUp(host).failed).toMatchObject({ kind: "unavailable" });
  expect(commands(host)).toEqual(["nsec_backup_watch", "nsec_backup_state"]);
});

it("is unavailable when the handoff starts no pass, and still hands the slot back", async () => {
  const host = native();
  host.session.mockResolvedValueOnce(null);
  expect(await backUp(host).failed).toMatchObject({ kind: "unavailable" });
  expect(commands(host).slice(-2)).toEqual([
    "nsec_backup_session(fi-revision)",
    "nsec_backup_session(null)",
  ]);
});

it("never shows native text when the status cannot be read or consent written", async () => {
  const unread = native();
  unread.failState(new Error("Backup status belongs to the main window"));
  const error = await backUp(unread).failed;
  expect(error).toMatchObject({
    kind: "unknown",
    message: "Your key wasn’t backed up.",
  });
  expect(commands(unread)).not.toContain("nsec_backup_set_choice");

  const unwritten = native();
  unwritten.choice.mockRejectedValueOnce(
    new Error("keychain: errSecInteractionNotAllowed"),
  );
  expect(await backUp(unwritten).failed).toMatchObject({
    kind: "interrupted",
    message: BACKUP_FAILURES.interrupted.message,
  });
  // The credential is never handed over without consent.
  expect(commands(unwritten).at(-1)).toBe("nsec_backup_set_choice");
});

it("refreshes public management metadata without replacing the watcher or regressing a newer identity", async () => {
  const first: BackupStatus = {
    ...at(1, 0, "idle"),
    management: {
      pubkey: "ab".repeat(32),
      policy: "self-managed",
      initialBackupConfirmed: false,
    },
  };
  const host = native(first);
  const store = host.store();
  await store.ready();
  const release = host.holdState({ ...first, seq: 2 });
  const refresh = store.refresh();
  await vi.waitFor(() =>
    expect(
      host.send.mock.calls.filter(([name]) => name === "nsec_backup_state"),
    ).toHaveLength(2),
  );
  const next: BackupStatus = {
    ...first,
    seq: 3,
    management: {
      pubkey: "cd".repeat(32),
      policy: "organization-managed",
      initialBackupConfirmed: false,
    },
  };
  host.watchers[0]?.onmessage(next);
  release();
  await expect(refresh).resolves.toEqual(next);
  expect(host.watchers).toHaveLength(1);
});
