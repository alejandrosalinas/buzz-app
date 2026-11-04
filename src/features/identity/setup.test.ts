import { expect, it, vi } from "vitest";
import type { FirstRunAccount } from "./builderlab-account";
import { BackupError } from "./backup";
import { BACKUP_FAILURES } from "./backup-failure";
import type { Identity } from "./service";
import {
  checkAccount,
  checkBackup,
  createSetup,
  keepBackup,
  type SetupStep,
} from "./setup";

const ok = (label: string): SetupStep => ({
  label,
  run: vi.fn(() => Promise.resolve()),
});
/** Fails until `heal`, with a retryable error when asked. */
function flaky(label: string, retryable: boolean) {
  let broken = true;
  const run = vi.fn(async () => {
    if (broken)
      throw Object.assign(new Error(`${label} failed`), { retryable });
  });
  const step: SetupStep = { label, run };
  return { step, run, heal: () => (broken = false) };
}

it("retries from the failed step and rests where the steps would have", async () => {
  const setup = createSetup();
  const before = ok("Before");
  const failing = flaky("Linking", true);
  const after = ok("After");
  await setup.start([before, failing.step, after], {
    status: "paused",
    at: "key-choice",
  });
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Linking failed",
    retryable: true,
    skipsLink: false,
  });

  failing.heal();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "paused", at: "key-choice" });
  expect(before.run).toHaveBeenCalledTimes(1);
  expect(failing.run).toHaveBeenCalledTimes(2);
  expect(after.run).toHaveBeenCalledTimes(1);
});

it("reports only an error that says so as retryable", async () => {
  const setup = createSetup();
  await setup.start([flaky("Backing up", false).step]);
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Backing up failed",
    retryable: false,
    skipsLink: false,
  });
  await setup.start([
    { label: "Odd", run: () => Promise.reject<void>("text") },
  ]);
  expect(setup.snapshot()).toMatchObject({ retryable: false });
});

it.each([
  ["the unlink before it", 0, true],
  ["the link itself", 1, true],
  ["the backup after it", 2, false],
])(
  "says Continue skips the link only while a linking step is left: %s failing",
  async (_label, failing, skipsLink) => {
    const run = (index: number) => () =>
      index === failing
        ? Promise.reject(new Error("Failed"))
        : Promise.resolve();
    const setup = createSetup();
    await setup.start([
      { label: "Unlinking", run: run(0) },
      { label: "Linking", run: run(1), links: true },
      { label: "Backing up", run: run(2) },
    ]);
    expect(setup.snapshot()).toMatchObject({ status: "failed", skipsLink });
  },
);

it("ignores Try again unless failed, and a second click", async () => {
  const setup = createSetup();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "idle" });

  let release!: () => void;
  const run = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(
      Object.assign(new Error("Backing up failed"), { retryable: true }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
  const after = ok("After");
  await setup.start([{ label: "Backing up", run }, after]);
  const first = setup.retry();
  expect(setup.snapshot()).toEqual({ status: "running", label: "Backing up" });
  await setup.retry();
  release();
  await first;
  expect(run).toHaveBeenCalledTimes(2);
  expect(after.run).toHaveBeenCalledTimes(1);
  expect(setup.snapshot()).toEqual({ status: "done" });
});

it("reads the linked key and the saved destinations together, and a failed list never fails setup", async () => {
  const pubkey = "ab".repeat(32);
  const check = async (
    linkedKey: FirstRunAccount["linkedKey"],
    knownCommunities: FirstRunAccount["knownCommunities"],
  ) => {
    const onLinked = vi.fn();
    const onKnown = vi.fn();
    const setup = createSetup();
    await setup.start([
      checkAccount(
        { linkedKey, knownCommunities } as FirstRunAccount,
        onLinked,
        onKnown,
      ),
    ]);
    return {
      rest: setup.snapshot(),
      linked: onLinked.mock.calls,
      known: onKnown.mock.calls,
    };
  };
  // Both reads start before either answers.
  let answerKey!: (pubkey: string | null) => void;
  let answerList!: (known: readonly string[]) => void;
  const linkedKey = vi.fn(
    () => new Promise<string | null>((resolve) => (answerKey = resolve)),
  );
  const knownCommunities = vi.fn(
    () => new Promise<readonly string[]>((resolve) => (answerList = resolve)),
  );
  const pending = check(linkedKey, knownCommunities);
  expect(linkedKey).toHaveBeenCalledTimes(1);
  expect(knownCommunities).toHaveBeenCalledTimes(1);
  answerList(["wss://a.example"]);
  answerKey(pubkey);
  expect(await pending).toEqual({
    rest: { status: "paused", at: "welcome-back" },
    linked: [[pubkey]],
    known: [[["wss://a.example"]]],
  });
  expect(
    await check(
      () => Promise.resolve(null),
      () => Promise.reject(new Error("Builderlab known communities failed")),
    ),
  ).toEqual({ rest: { status: "done" }, linked: [], known: [[undefined]] });
  // The key read still decides setup.
  expect(
    await check(
      () => Promise.reject(new Error("Builderlab account check failed")),
      () => Promise.resolve([]),
    ),
  ).toMatchObject({
    rest: { status: "failed", error: "Builderlab account check failed" },
    linked: [],
    known: [],
  });
});

it("reports the backed-up keys, and an unavailable or failed status as none listed without failing setup", async () => {
  const listed = "ab".repeat(32);
  const lookup = async (status: FirstRunAccount["backupStatus"]) => {
    const onListed = vi.fn();
    const setup = createSetup();
    await setup.start([
      checkBackup({ backupStatus: status } as FirstRunAccount, onListed),
    ]);
    expect(setup.snapshot()).toEqual({ status: "done" });
    return onListed.mock.calls;
  };
  expect(await lookup(() => Promise.resolve([listed]))).toEqual([[[listed]]]);
  expect(await lookup(() => Promise.resolve([]))).toEqual([[[]]]);
  expect(await lookup(() => Promise.resolve("unavailable"))).toEqual([
    [undefined],
  ]);
  expect(
    await lookup(() => Promise.reject(new BackupError("unreachable"))),
  ).toEqual([[undefined]]);
});

it("keeping a listed backup saves automatic backup only where this build backs up to Builderlab", async () => {
  const viewer = "ab".repeat(32);
  const kept = async (builderlab: boolean) => {
    const setBackupChoice = vi.fn(async () => ({
      available: true,
      pubkey: viewer,
      automatic: true,
    }));
    const identity = {
      snapshot: () => ({ status: "ready", viewer }),
      backup: { ready: async () => ({ builderlab }) },
      setBackupChoice,
    } as unknown as Identity;
    const setup = createSetup();
    await setup.start([keepBackup(identity)]);
    expect(setup.snapshot()).toEqual({ status: "done" });
    return setBackupChoice.mock.calls;
  };
  expect(await kept(true)).toEqual([[viewer, true, true]]);
  // A dev account seed lists backups on a build with no uploader.
  expect(await kept(false)).toEqual([]);
});

it("a refused save while keeping a listed backup fails setup as an interrupted backup", async () => {
  const viewer = "ab".repeat(32);
  const identity = {
    snapshot: () => ({ status: "ready", viewer }),
    backup: { ready: async () => ({ builderlab: true }) },
    setBackupChoice: vi.fn(async () => {
      throw "A backup is in progress. Wait for it to finish and try again.";
    }),
  } as unknown as Identity;
  const setup = createSetup();
  await setup.start([keepBackup(identity)]);
  expect(setup.snapshot()).toMatchObject({
    status: "failed",
    error: BACKUP_FAILURES.interrupted.message,
    retryable: true,
  });
});

it("a step that rests idle ends setup past the caller's rest, also when a retry reaches it", async () => {
  const setup = createSetup();
  const failing = flaky("Linking", true);
  const enter: SetupStep = {
    label: "Restoring",
    run: async () => ({ status: "idle" }) as const,
  };
  await setup.start([failing.step, enter], { status: "done" });
  expect(setup.snapshot()).toMatchObject({ status: "failed" });
  failing.heal();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "idle" });
  // Idle, unlike done, lets setup start again.
  await setup.start([], { status: "paused", at: "key-choice" });
  expect(setup.snapshot()).toEqual({ status: "paused", at: "key-choice" });
});

it.each([
  ["transient backup", true, false, "timeout"],
  ["non-backup step", false, false, "unavailable"],
  ["unfinished linking", true, true, "not_offered"],
] as const)("cannot bypass %s", async (_name, backup, links, kind) => {
  const setup = createSetup();
  const after = ok("Finish");
  await setup.start([
    {
      label: "Fail",
      backup,
      run: async () => {
        throw new BackupError(kind);
      },
    },
    { ...after, links },
  ]);
  await setup.continueWithoutBackup();
  expect(setup.snapshot().status).toBe("failed");
  expect(after.run).not.toHaveBeenCalled();
});
