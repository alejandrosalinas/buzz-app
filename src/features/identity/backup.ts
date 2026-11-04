import { Channel, invoke } from "@tauri-apps/api/core";
import { BACKUP_FAILURES, type BackupFailureKind } from "./backup-failure";
import type { Identity } from "./service";

type Send = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// Shared by both login owners so re-enabling a plugin cannot reuse an old revision.
let generation = 0;
/** Resolves to the ticket of the backup pass this handoff starts, or `null` when
 * none will (or the handoff was refused). Never rejects. */
export function handoffBackupSession(
  source: "builderlab" | "hosted",
  credential: string | null,
  send: Send = invoke,
): Promise<number | null> {
  return handoff({ source, credential }, send);
}

/** As `handoffBackupSession` for Builderlab under a NIP-FI deployment: only the
 * public session `revision` crosses IPC, and native resolves the token itself.
 * `null` hands the slot back. */
export function handoffFederatedBackupSession(
  revision: string | null,
  send: Send = invoke,
): Promise<number | null> {
  return handoff(
    { source: "builderlab", credential: null, federated: revision },
    send,
  );
}

function handoff(args: Record<string, unknown>, send: Send) {
  return send<unknown>("nsec_backup_session", {
    ...args,
    generation: ++generation,
  }).then(
    (ticket) => (typeof ticket === "number" ? ticket : null),
    () => null,
  );
}

/** What the native uploader last did for this device's key. `seq` orders
 * statuses; a pass numbered at or above a handoff's ticket started after it. */
export type BackupStatus = Readonly<
  { seq: number; pass: number; builderlab: boolean } & (
    | { status: "idle" | "running" | "complete" }
    | { status: "waiting"; reason: "no_consent" | "no_session" | "not_linked" }
    | {
        status: "failed";
        kind:
          | "busy"
          | "signed_out"
          | "not_offered"
          | "other_key_linked"
          | "invalid_service"
          | "refused"
          | "unreachable"
          | "unconfirmed"
          | "storage";
      }
  )
>;

/** Nothing is registered until the first `subscribe` or `ready()`. The channel is
 * watched before the snapshot is read and the higher `seq` wins, so a transition
 * between the two is never lost. */
export function createBackupStatus(send: Send = invoke) {
  let status: BackupStatus | undefined;
  let started: Promise<void> | undefined;
  let channel: Channel<BackupStatus> | undefined;
  const listeners = new Set<() => void>();
  const accept = (next: BackupStatus) => {
    if (status && next.seq <= status.seq) return;
    status = next;
    for (const listener of listeners) listener();
  };
  function register() {
    channel = new Channel<BackupStatus>(accept);
    const attempt = send("nsec_backup_watch", { onEvent: channel })
      .then(() => send<BackupStatus>("nsec_backup_state"))
      .then(accept);
    attempt.catch(() => {
      // The next reader registers again.
      if (started === attempt) started = undefined;
    });
    return attempt;
  }
  /** Resolves with the current status once the watcher is registered. */
  function ready() {
    started ??= register();
    // The snapshot has been accepted, so a status is held.
    return started.then(() => status as BackupStatus);
  }
  return {
    snapshot: () => status,
    ready,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void ready().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (channel) channel.onmessage = () => {};
      listeners.clear();
    },
  };
}

/** A first-run backup that did not complete, with the table's copy as its message. */
export class BackupError extends Error {
  readonly kind: BackupFailureKind;
  readonly retryable: boolean;
  constructor(kind: BackupFailureKind) {
    super(BACKUP_FAILURES[kind].message);
    this.name = "BackupError";
    this.kind = kind;
    this.retryable = BACKUP_FAILURES[kind].retryable;
  }
}

/** Resolves after `ms`; aborting `signal` clears the timer. */
const timer = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(id));
  });

/**
 * A pass that stopped without uploading would only be retried on a later wake,
 * and nothing wakes it once first run hands its credential back: a failure.
 */
function failure(status: BackupStatus): BackupFailureKind | undefined {
  switch (status.status) {
    case "complete":
      return undefined;
    case "failed":
      return status.kind;
    case "waiting":
      return status.reason === "not_linked" ? "not_linked" : "interrupted";
    default:
      return "interrupted";
  }
}

/**
 * Backs `pubkey` up through the native uploader, the only thing that runs a
 * pass: consent on, then the first-run sign-in handed to the shared
 * `builderlab` slot (its credential, or in an FI build its NIP-FI session
 * revision), whose ticket names the pass to wait for. The first status
 * at or past it that is not `running` answers, or `timeout` does. The slot is
 * handed back on every exit after the handoff, so the credential never
 * outlives the step; a settled pass is not running, so that publishes nothing
 * and the outcome stays visible. Consent stays on after a failure, so a later
 * Builderlab sign-in may finish what the user asked for. Continue without
 * backup keeps what was saved: consent after `not_offered`, and no choice on a
 * build that can't back up to Builderlab, which fails before saving one, so
 * `BackupConsent` fills it in once the app opens.
 * The caller must hold the `builderlab` slot alone for the step: handing it
 * back empties it rather than restoring an earlier credential, so a signed-in
 * Builderlab plugin would lose its native session until its own changes. An
 * FI revision is the session that plugin hands over too, so after a completed
 * pass it stays in the slot, at the cost of a fresh pass. After a failure it
 * is emptied like any other exit, and Try again hands it over again. Rejects
 * with a `BackupError`.
 */
export async function backUpWith(
  identity: Pick<Identity, "backup" | "setBackupChoice">,
  pubkey: string,
  session: Readonly<{ credential: string } | { federated: string }>,
  {
    timeout = 60_000,
    after = timer,
    send = invoke,
  }: {
    timeout?: number;
    after?: (ms: number, signal: AbortSignal) => Promise<void>;
    send?: Send;
  } = {},
) {
  const { backup } = identity;
  const status = await backup.ready().catch(() => {
    throw new BackupError("unknown");
  });
  if (!status.builderlab) throw new BackupError("unavailable");
  await identity.setBackupChoice(pubkey, true).catch(() => {
    throw new BackupError("interrupted");
  });
  const settled = new AbortController();
  let unsubscribe = () => {};
  let completed = false;
  try {
    const ticket = await ("federated" in session
      ? handoffFederatedBackupSession(session.federated, send)
      : handoffBackupSession("builderlab", session.credential, send));
    if (ticket === null) throw new BackupError("unavailable");
    const outcome = new Promise<BackupStatus>((resolve) => {
      const check = () => {
        const current = backup.snapshot();
        if (current && current.pass >= ticket && current.status !== "running")
          resolve(current);
      };
      unsubscribe = backup.subscribe(check);
      check();
    });
    const result = await Promise.race([
      outcome,
      after(timeout, settled.signal),
    ]);
    const kind = result ? failure(result) : "timeout";
    if (kind) throw new BackupError(kind);
    completed = true;
  } finally {
    unsubscribe();
    settled.abort();
    // After a timeout this also retires the pass still running. Native
    // refuses an FI revision that is no longer current.
    await (completed && "federated" in session
      ? handoffFederatedBackupSession(session.federated, send)
      : handoffBackupSession("builderlab", null, send));
  }
}
