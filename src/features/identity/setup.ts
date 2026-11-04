import { BackupError } from "./backup";
import type { Communities } from "../communities/service";
import type {
  CommunityList,
  FirstRunAccount,
  OwnedCommunity,
} from "./builderlab-account";
import { type Restored, restoreKnown } from "./restore-communities";
import type { Identity } from "./service";

/** A step may pick where setup rests afterwards, overriding the caller's `then`. */
export type SetupStep = Readonly<{
  label: string;
  run: () => Promise<void> | Promise<Resting | undefined>;
  /** Links the key on this device to the account: skipping it leaves the key unlinked. */
  links?: boolean;
  /** Only backup steps may be continued when the deployment lacks support. */
  backup?: boolean;
}>;
/**
 * Where setup rests for a decision: the connect choice for a found
 * community that is not Builderlab-hosted, the key choice, an import,
 * or the returning-user pages (Welcome back, a restore from backup, the
 * start-over page for a lost key).
 */
export type SetupPause =
  | "connect-choice"
  | "key-choice"
  | "key-import"
  | "welcome-back"
  | "key-restore"
  | "key-lost";
export type SetupSnapshot = Readonly<
  | { status: "idle" }
  | { status: "running"; label: string }
  | { status: "paused"; at: SetupPause }
  | {
      status: "failed";
      error: string;
      /** The error says Try again can help, as a retryable `BackupError` does. */
      retryable: boolean;
      /** Continuing past the failure skips the link, so the key stays unlinked. */
      skipsLink: boolean;
      unsupportedBackup?: boolean;
    }
  | { status: "done" }
>;
/** Idle ends setup outright: with a key on the device, the gate lifts. */
export type Resting = Extract<
  SetupSnapshot,
  { status: "idle" | "paused" | "done" }
>;

/** The key now on this device, which the account steps act on. */
function viewer(identity: Identity) {
  const state = identity.snapshot();
  if (state.status !== "ready")
    throw new Error("Your key could not be saved on this device.");
  return state.viewer;
}

/** `identity.create` and `importKey` report failure through the snapshot, not by throwing. */
function saved(identity: Identity) {
  const state = identity.snapshot();
  if (state.status === "ready") return;
  throw new Error(
    (state.status === "missing" && state.error) ||
      "Your key could not be saved on this device.",
  );
}

/** Creates a key on this device, which the account steps then act on. */
export function createKey(identity: Identity): SetupStep {
  return {
    label: "Creating your key…",
    run: async () => {
      await identity.create();
      saved(identity);
    },
  };
}

/**
 * Stores a key the user already has through the key setup screen's native
 * import command, which takes the nsec as typed. Not a step: a refusal belongs
 * under the import page's field, not on the failed page.
 */
export async function importKey(identity: Identity, nsec: string) {
  await identity.importKey(nsec);
  saved(identity);
}

/**
 * Real: the key bound to the signed-in account picks the lane. Binding is 1:1
 * and enforced, so a linked account must never be given a second key: it rests
 * on Welcome back instead of the key choice, and later steps still run. The
 * destinations saved to the account are read alongside, under the same label;
 * that list never fails setup and is reported as `undefined` when it did.
 */
export function checkAccount(
  account: FirstRunAccount,
  onLinked: (pubkey: string) => void,
  onKnown: (known: readonly string[] | undefined) => void,
): SetupStep {
  return {
    label: "Checking your account…",
    run: async () => {
      const [pubkey, known] = await Promise.all([
        account.linkedKey(),
        account.knownCommunities().catch(() => undefined),
      ]);
      onKnown(known);
      if (!pubkey) return undefined;
      onLinked(pubkey);
      return { status: "paused", at: "welcome-back" };
    },
  };
}

/**
 * Real: binds the key now on this device to the signed-in account, so the
 * account is this key's and a backup can be accepted for it. The account sends
 * nothing more when it already holds the key, so a re-run is harmless.
 */
export function linkKey(
  identity: Identity,
  account: FirstRunAccount,
): SetupStep {
  return {
    label: "Linking your key…",
    run: () => account.bind(viewer(identity)),
    links: true,
  };
}

/**
 * Real: unbinds `old`, the key the account held before starting over, so the
 * new key created on this device can be linked in its place: binding is 1:1
 * and never overwrites. Runs once that key exists, just before `linkKey`, as
 * the hosted card's switch does. The account deletes only while it still holds
 * `old`, so a re-run never removes the new key's binding, and the step fails
 * unless the account is then left with no key or the new one.
 */
export function unlinkKey(
  identity: Identity,
  account: FirstRunAccount,
  old: string,
): SetupStep {
  return {
    label: "Unlinking your old key…",
    run: () => account.unbind(old, viewer(identity)),
  };
}

/**
 * Real: backs the key now on this device up to the signed-in account and waits
 * for the native uploader's own result (`backUpWith`), which kgoose accepts
 * only for the key bound to the account: the linked lane's own, or one
 * `linkKey` bound first.
 */
export function backUp(
  identity: Identity,
  account: FirstRunAccount,
): SetupStep {
  return {
    label: "Backing up your key…",
    backup: true,
    run: () => account.backUp(viewer(identity)),
  };
}

/**
 * Real: a key the account already holds a backup of stays backed up. Only its
 * automatic choice is saved, unless one already is, so setup uploads nothing
 * and no backup prompt asks about it later. A build whose uploader cannot back
 * up to Builderlab (a dev account seed's backups) has no choice to save.
 * Rejects with a `BackupError`.
 */
export function keepBackup(identity: Identity): SetupStep {
  return {
    label: "Backing up your key…",
    run: async () => {
      if ((await identity.backup.ready()).builderlab)
        await identity
          .setBackupChoice(viewer(identity), true, true)
          .catch(() => {
            throw new BackupError("interrupted");
          });
    },
  };
}

/**
 * Real: the communities the linked account owns, for Join a community's rows
 * and the start-over page. Runs only once a key is on the device and the
 * account is linked (the list is meaningless otherwise). A failed list is
 * reported as `undefined`, not a failed setup: the pages work without it.
 *
 * With `onCreatable`, the same list also answers `checkCreation`. Only for a
 * lane whose key on this device is the linked one, which proves the binding.
 */
export function findCommunities(
  account: FirstRunAccount,
  onFound: (owned: readonly OwnedCommunity[] | undefined) => void,
  onCreatable?: (list: CommunityList | undefined) => void,
): SetupStep {
  return {
    label: "Finding communities…",
    run: () =>
      account.communityList().then(
        (list) => {
          onFound(list.owned);
          onCreatable?.(list.canCreate ? list : undefined);
        },
        () => {
          onFound(undefined);
          onCreatable?.(undefined);
        },
      ),
  };
}

/**
 * Real: whether Join a community offers Create a community, for an account at
 * the public Builderlab: the account must be bound to the key now on this
 * device, and its community list must allow one (`canCreate`). `onChecked`
 * receives that list, for the create's quota copy, or `undefined` when it
 * refuses. A failed check is `undefined` too, not a failed setup: joining
 * works without it.
 */
export function checkCreation(
  identity: Identity,
  account: FirstRunAccount,
  onChecked: (list: CommunityList | undefined) => void,
): SetupStep {
  return {
    label: "Finding communities…",
    run: async () => {
      try {
        const [bound, list] = await Promise.all([
          account.linkedKey(),
          account.communityList(),
        ]);
        onChecked(
          bound === viewer(identity) && list.canCreate ? list : undefined,
        );
      } catch {
        onChecked(undefined);
      }
    },
  };
}

/**
 * Real: joins the destinations saved to the account that admit the key now on
 * this device (`restoreKnown`), then lets `decide` pick where setup rests from
 * the outcomes. Never fails setup: a destination that was refused or could not
 * be read is an outcome, not an error.
 */
export function restoreCommunities(
  known: readonly string[],
  communities: Pick<Communities, "snapshot" | "joined">,
  decide: (outcomes: readonly Restored[]) => Resting | undefined,
): SetupStep {
  return {
    label: "Restoring your communities…",
    run: async () =>
      decide(
        await restoreKnown(known, communities, {
          concurrency: 3,
          startBy: 45_000,
        }),
      ),
  };
}

/**
 * Real: the keys the signed-in account holds a backup of, which decide whether
 * Welcome back offers a restore and an import still needs backup.
 * Reported as `undefined` where backup status is unavailable (most Builderlab
 * deployments today) or failed, never as a failed setup: the pages work without it, and
 * no copy implies the user lost a backup.
 */
export function checkBackup(
  account: FirstRunAccount,
  onListed: (pubkeys: readonly string[] | undefined) => void,
): SetupStep {
  return {
    label: "Checking for a backed-up key…",
    run: () =>
      account.backupStatus().then(
        (listed) => onListed(listed === "unavailable" ? undefined : listed),
        () => onListed(undefined),
      ),
  };
}

/**
 * Runs steps in order, stopping at the first failure, then rests at `then` —
 * done, or a pause the caller resumes with another `start` — unless a step
 * picked another resting state. No steps means "nothing more to do" and
 * rests at once. A failed setup may also be resumed: by `retry` from the
 * failed step. Only explicitly unsupported backup can be continued without;
 * unfinished linking and transient backup failures cannot be skipped.
 */
export function createSetup() {
  let state: SetupSnapshot = { status: "idle" };
  // From the failed step on, with where setup would have rested. Taken once,
  // so a second click on Try again does nothing.
  let failed:
    | Readonly<{ steps: readonly SetupStep[]; rest: Resting }>
    | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: SetupSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  async function run(steps: readonly SetupStep[], then: Resting) {
    let rest = then;
    for (const [index, step] of steps.entries()) {
      publish({ status: "running", label: step.label });
      try {
        const picked = await step.run();
        if (picked) rest = picked;
      } catch (error) {
        const left = steps.slice(index);
        failed = { steps: left, rest };
        publish({
          status: "failed",
          error:
            error instanceof Error ? error.message : "Setup failed. Try again.",
          retryable:
            error instanceof Error &&
            "retryable" in error &&
            error.retryable === true,
          skipsLink: left.some((step) => step.links === true),
          ...(step.backup &&
          !left.some((step) => step.links) &&
          error instanceof BackupError &&
          (error.kind === "unavailable" || error.kind === "not_offered")
            ? { unsupportedBackup: true }
            : {}),
        });
        return;
      }
    }
    publish(rest);
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(
      steps: readonly SetupStep[],
      then: Resting = { status: "done" },
    ) {
      if (state.status === "running" || state.status === "done") return;
      failed = undefined;
      await run(steps, then);
    },
    /** Runs the failed step again, then the rest, resting where it would have. */
    async retry() {
      const from = state.status === "failed" ? failed : undefined;
      if (!from) return;
      failed = undefined;
      await run(from.steps, from.rest);
    },
    /** Continue only an unsupported backup, preserving every subsequent step. */
    async continueWithoutBackup() {
      const from =
        state.status === "failed" && state.unsupportedBackup
          ? failed
          : undefined;
      if (!from) return;
      failed = undefined;
      await run(from.steps.slice(1), from.rest);
    },
    reset() {
      if (state.status === "running") return;
      failed = undefined;
      publish({ status: "idle" });
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;
