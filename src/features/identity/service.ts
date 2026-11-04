import { invoke, isTauri } from "@tauri-apps/api/core";
import { createBackupStatus } from "./backup";

export type BackupChoice = Readonly<{
  available: boolean;
  pubkey: string;
  automatic: boolean | null;
}>;

export type IdentitySnapshot =
  | { status: "loading" }
  | {
      status: "missing";
      busy: boolean;
      error?: string;
      recovery?: RecoveryState;
    }
  | { status: "error"; error: string }
  | { status: "ready"; viewer: string };

export type RecoveryResult = {
  candidates: { handle: string; pubkey: string }[];
  currentPubkey: string | null;
  failedCount: number;
};
export type RecoveryState =
  | { status: "waiting" }
  | { status: "saving" }
  | { status: "canceling" }
  | ({ status: "choosing" } & RecoveryResult)
  | { status: "error"; error: string };

/** Native recovery's answer when this build or the tenant has no recovery (`nsec_backup.rs` UNAVAILABLE). */
export const RECOVERY_UNAVAILABLE = "Backup recovery is unavailable.";
/** Native recovery's refusal for this account (`nsec_backup.rs` REFUSED: a public org, or no Buzz access). */
export const RECOVERY_REFUSED =
  "Backup recovery is not offered for this account.";
/** A recovery error no retry changes: none here, or the account is refused it. */
export const recoveryOff = (recovery: RecoveryState | undefined) =>
  recovery?.status === "error" &&
  (recovery.error === RECOVERY_UNAVAILABLE ||
    recovery.error === RECOVERY_REFUSED);

// App-owned, not registered on the plugin context. Snapshots contain public data only.
export function createIdentity() {
  let state: IdentitySnapshot = { status: "loading" };
  let disposed = false;
  let busy = false;
  let recoveryGeneration = 0;
  let recoveryAttempt: Promise<{ attempt: string }> | undefined;
  const listeners = new Set<() => void>();
  const backup = createBackupStatus();
  let resolveReady!: (viewer: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  const update = (next: IdentitySnapshot) => {
    if (disposed) return;
    state = next;
    if (next.status === "ready") resolveReady(next.viewer);
    for (const listener of listeners) listener();
  };
  const recoveryError = (reason: unknown) =>
    typeof reason === "string"
      ? reason
      : "Couldn’t restore your identity. Try again.";
  async function cancelRecovery() {
    const attempt = recoveryAttempt;
    const generation = ++recoveryGeneration;
    if (!attempt) return true;
    update({
      status: "missing",
      busy: true,
      recovery: { status: "canceling" },
    });
    try {
      const result = await attempt.catch(() => undefined);
      if (result) await invoke("nsec_restore_cancel", result);
      if (generation !== recoveryGeneration) return false;
      recoveryAttempt = undefined;
      busy = false;
      update({ status: "missing", busy: false });
      return true;
    } catch {
      if (disposed || generation !== recoveryGeneration) return false;
      update({
        status: "missing",
        busy: true,
        recovery: {
          status: "error",
          error: "Couldn’t cancel recovery. Try Back again.",
        },
      });
      return false;
    }
  }
  async function beginRecovery() {
    if (disposed || state.status !== "missing") return;
    if (recoveryAttempt) {
      if (
        state.recovery?.status !== "error" &&
        !(
          state.recovery?.status === "choosing" &&
          state.recovery.candidates.length === 0
        )
      )
        return;
      if (!(await cancelRecovery())) return;
    }
    if (busy || disposed) return;
    busy = true;
    const generation = ++recoveryGeneration;
    update({ status: "missing", busy: true, recovery: { status: "waiting" } });
    const attempt = invoke<{ attempt: string }>("nsec_restore_begin");
    recoveryAttempt = attempt;
    try {
      const result = await attempt;
      if (disposed || generation !== recoveryGeneration) return;
      const recovered = await invoke<RecoveryResult>(
        "nsec_restore_wait",
        result,
      );
      if (disposed || generation !== recoveryGeneration) return;
      update({
        status: "missing",
        busy: true,
        recovery: { status: "choosing", ...recovered },
      });
    } catch (reason) {
      if (disposed || generation !== recoveryGeneration) return;
      update({
        status: "missing",
        busy: true,
        recovery: { status: "error", error: recoveryError(reason) },
      });
    }
  }
  async function installRecovery(handle: string) {
    if (disposed || state.status !== "missing" || !recoveryAttempt) return;
    const recovery = state.recovery;
    if (recovery?.status !== "choosing") return;
    const selected = recovery.candidates.find(
      (candidate) => candidate.handle === handle,
    );
    if (!selected) return;
    const generation = recoveryGeneration;
    update({ status: "missing", busy: true, recovery: { status: "saving" } });
    try {
      const { attempt } = await recoveryAttempt;
      const viewer = await invoke<string>("nsec_restore_install", {
        attempt,
        handle,
      });
      if (disposed || generation !== recoveryGeneration) return;
      if (viewer !== selected.pubkey)
        throw "The restored identity could not be verified. Restart the app.";
      recoveryAttempt = undefined;
      busy = false;
      update({ status: "ready", viewer });
    } catch (reason) {
      if (disposed || generation !== recoveryGeneration) return;
      update({
        status: "missing",
        busy: true,
        recovery: { status: "error", error: recoveryError(reason) },
      });
    }
  }
  async function run(
    command:
      | "identity_restore"
      | "identity_create"
      | "identity_import"
      | "identity_import_legacy",
    nsec?: string,
  ) {
    if (busy || disposed) return;
    const restoring = command === "identity_restore";
    if (!restoring && state.status !== "missing") return;
    busy = true;
    update(
      restoring ? { status: "loading" } : { status: "missing", busy: true },
    );
    try {
      const viewer = await invoke<string | null>(
        command,
        nsec === undefined ? {} : { nsec },
      );
      if (viewer === null && restoring)
        update({ status: "missing", busy: false });
      else if (typeof viewer === "string" && /^[a-f0-9]{64}$/.test(viewer))
        update({ status: "ready", viewer });
      else
        throw new Error(
          "The saved identity could not be verified. Restart the app.",
        );
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      update(
        restoring
          ? { status: "error", error }
          : { status: "missing", busy: false, error },
      );
    } finally {
      busy = false;
    }
  }
  void run("identity_restore");
  return {
    ready,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: () => run("identity_restore"),
    importKey: (nsec: string) => run("identity_import", nsec),
    create: () => run("identity_create"),
    /** Whether installed old Buzz left data here; never opens secure storage. */
    legacyAvailable: () => invoke<boolean>("identity_legacy_available"),
    /** Reads old Buzz's saved key only now, so any OS prompt follows this click. */
    importLegacy: () => run("identity_import_legacy"),
    backupAvailable: () => invoke<boolean>("nsec_backup_available"),
    beginRecovery,
    installRecovery,
    cancelRecovery,
    exportKey: () => invoke<string>("identity_export"),
    /** Public consent only; enabling it wakes the configured native uploader after sign-in. */
    getBackupChoice: () => invoke<BackupChoice>("nsec_backup_choice"),
    /**
     * Pass the key returned by getBackupChoice so a stale selection cannot affect another key.
     * With `unlessSaved`, a choice already saved for it stands and is returned instead.
     */
    setBackupChoice: (pubkey: string, automatic: boolean, unlessSaved?: true) =>
      invoke<BackupChoice>("nsec_backup_set_choice", {
        pubkey,
        automatic,
        unlessSaved,
      }),
    /** Why this build can't wipe, if it can't; `sign_out` enforces it either way. */
    wipeRefusal: () => invoke<string | null>("sign_out_wipe_refusal"),
    /** Stops agents and restarts; the key (and data, with wipe) goes on next launch. */
    signOut: (choices: { wipe: boolean; removeAgents: boolean }) =>
      invoke<void>("sign_out", choices),
    /** The native uploader's status; registers on first read, outside the snapshot. */
    backup,
    dispose() {
      disposed = true;
      void cancelRecovery();
      backup.dispose();
      listeners.clear();
    },
  };
}
export type Identity = ReturnType<typeof createIdentity>;
export const nativeIdentityEnabled = () =>
  isTauri() &&
  /Mac|Win|Linux/i.test(navigator.platform) &&
  import.meta.env.VITE_BUZZ_LIVE !== "1";
