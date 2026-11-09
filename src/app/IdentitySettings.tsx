import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { BackupStatus } from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { BackupPrompt } from "../features/identity/BackupConsent";
import {
  backupOfferedFor,
  federatedBuilderlabAccount,
} from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import {
  signInServers,
  type FederatedIdentity,
  type SessionSnapshot,
} from "../features/federated-identity/service";
import type { Membership } from "../features/communities/service";
import {
  coveredCommunities,
  serverName,
} from "../features/federated-identity/community-servers";
import { recoveryMessage } from "../features/federated-identity/CommunitySignIn";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Button } from "../shared/design-system/ui/Button";
import { relativeTimestamp } from "../shared/relative-timestamp";
import { CHANNEL_ACTIVITY_KINDS } from "../features/relay/channel-activity";
import type { RelaySession } from "../features/relay/session";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { CopyIcon } from "../shared/design-system/icons";
import styles from "./IdentitySettings.module.css";
import { writeClipboardText } from "../shared/clipboard";

const WAITING = {
  no_consent: undefined,
  no_session: "Sign in to Builderlab to sync your identity.",
  not_linked: BACKUP_FAILURES.not_linked.message,
} as const;

/** Running and complete show beside the row instead. */
const INDICATOR = {
  running: "Syncing…",
  complete: "Synced with Builderlab",
} as const;

/**
 * Loading, sign-in and failure feedback below the row's fixed description;
 * failures read as first run's copy. Waiting for consent shows the action.
 */
function backupFeedback(status: BackupStatus) {
  switch (status.status) {
    case "idle":
      // Nothing has run this launch; a copy may still exist from an earlier one.
      return "Buzz hasn’t checked whether your identity is synced since it opened.";
    case "running":
    case "complete":
      return undefined;
    case "waiting":
      return WAITING[status.reason];
    case "failed": {
      // Settings has no Try again; a new Builderlab sign-in hands the
      // uploader a session, which starts another pass, so a kind it clears
      // (every retryable one, and a lapsed sign-in) says so.
      const failure: { cause?: string; message: string } =
        BACKUP_FAILURES[status.kind];
      return failure.cause
        ? `${failure.cause} Buzz tries again when you next sign in to Builderlab.`
        : failure.message;
    }
  }
}

/**
 * What sync is for, and the uploader's status. While it waits for consent
 * (signed in to Builderlab, backup off or not yet chosen), Sync with
 * Builderlab opens the backup prompt, so a declined prompt can be reversed;
 * the prompt closes if the wait settles otherwise. Synced shows only once an
 * upload is confirmed. Hidden wherever first run would not offer backup, by
 * the same rule.
 */
function BackupRow({
  identity,
  viewer,
}: {
  identity: Identity;
  viewer: string;
}) {
  const { backup } = identity;
  const status = useSyncExternalStore(backup.subscribe, backup.snapshot);
  const [offered, setOffered] = useState(false);
  const [asking, setAsking] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const sentence = useRef<HTMLSpanElement>(null);
  const backedUp = useRef(false);
  useEffect(() => {
    void backupOfferedFor(backup).then(setOffered);
  }, [backup]);
  const close = useCallback((saved?: boolean) => {
    backedUp.current = saved === true;
    setAsking(false);
  }, []);
  if (!offered || !status) return null;
  const waiting = status.status === "waiting" && status.reason === "no_consent";
  // Every pass runs before it is admitted, so only a settled outcome ends the wait.
  const settled =
    status.status !== "running" && status.status !== "idle" && !waiting;
  const feedback = backupFeedback(status);
  const indicator =
    status.status === "running" || status.status === "complete"
      ? INDICATOR[status.status]
      : undefined;
  return (
    <>
      <PreferenceRow
        title="Identity sync"
        subtitle={
          <span ref={sentence} tabIndex={-1}>
            Save your identity key with your Builderlab account so you can log
            in more easily on another device.
            {/* Mounted empty so a later sentence is announced. */}
            <span role="status" className="block">
              {feedback}
            </span>
          </span>
        }
        trailing={
          <>
            {waiting && (
              <Button
                ref={action}
                type="button"
                onClick={() => setAsking(true)}
              >
                Sync with Builderlab
              </Button>
            )}
            {/* Mounted empty so a later indicator is announced. */}
            <span role="status" className="text-body-sm text-subtle">
              {indicator}
            </span>
          </>
        }
      />
      {asking && (
        <BackupPrompt
          identity={identity}
          pubkey={viewer}
          ended={settled}
          onClose={close}
          // Sync ends the consent wait, which removes the action, perhaps
          // only after the prompt has closed; the description stays.
          finalFocus={() =>
            (backedUp.current ? null : action.current) ?? sentence.current
          }
        />
      )}
    </>
  );
}

/**
 * When `pubkey` was last active in a channel on the current community's relay,
 * in Unix seconds; undefined without any activity there. Throws without a
 * connected session, so that reads as unchecked rather than inactive.
 */
export async function keyActivity(
  session: Pick<RelaySession, "read"> | undefined,
  pubkey: string,
): Promise<number | undefined> {
  if (!session) throw new Error("The relay isn’t connected");
  const [latest] = await session.read(
    // Relay reads must name kinds: channel activity, the messages people see.
    [{ kinds: [...CHANNEL_ACTIVITY_KINDS], authors: [pubkey], limit: 1 }],
    { priority: "background" },
  );
  return latest?.created_at;
}

type BackedUp =
  | { revision: string; key: string | null }
  | { revision: string; failed: string };

/**
 * The account's linked key when it is backed up, read with the organization
 * sign-in as first run reads it (`nsec-backups/status`). Backups of other keys
 * are left out: making one the account's would unlink the linked key, and
 * kgoose never links an unlinked key again.
 */
function BackedUpKey({
  viewer,
  identity,
  federated,
  lastActive,
}: {
  viewer: string;
  identity: Identity;
  federated: FederatedIdentity;
  lastActive?: ((pubkey: string) => Promise<number | undefined>) | undefined;
}) {
  const session = useSyncExternalStore(
    federated.subscribe,
    federated.snapshot,
    federated.snapshot,
  );
  const revision =
    session.status === "signed-in" && session.authority
      ? session.revision
      : undefined;
  // A backup finishing after the read may have just added the linked key.
  const backedUp =
    useSyncExternalStore(identity.backup.subscribe, identity.backup.snapshot)
      ?.status === "complete";
  const [read, setRead] = useState<BackedUp>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished backup reads the account again.
  useEffect(() => {
    if (!revision) return;
    let current = true;
    const account = federatedBuilderlabAccount(
      { revision },
      federated,
      identity,
    );
    Promise.all([account.linkedKey(), account.backupStatus()]).then(
      ([linked, backups]) => {
        if (!current) return;
        const key =
          linked && backups !== "unavailable" && backups.includes(linked)
            ? linked
            : null;
        setRead({ revision, key });
      },
      (error: unknown) => {
        if (current)
          setRead({
            revision,
            failed: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [revision, federated, identity, backedUp]);
  const shown = read?.revision === revision ? read : undefined;
  const key = shown && "key" in shown ? shown.key : null;
  // undefined: checking; null: no events there; false: the read failed.
  const [active, setActive] = useState<number | null | false>();
  useEffect(() => {
    if (!key || !lastActive) return;
    let current = true;
    setActive(undefined);
    lastActive(key).then(
      (at) => {
        if (current) setActive(at ?? null);
      },
      (error: unknown) => {
        console.warn("Couldn’t read the backed-up key’s activity", error);
        if (current) setActive(false);
      },
    );
    return () => {
      current = false;
    };
  }, [key, lastActive]);
  if (!revision)
    return (
      <PreferenceRow
        title="Backed-up key"
        subtitle="Sign in to your organization to see your backed-up key."
      />
    );
  if (!shown)
    return (
      <PreferenceRow
        title="Backed-up key"
        subtitle={<span role="status">Checking your backup…</span>}
      />
    );
  if ("failed" in shown)
    return (
      <PreferenceRow
        title="Backed-up key"
        subtitle={
          <span role="alert">Couldn’t check your backup. {shown.failed}</span>
        }
      />
    );
  if (!shown.key) return null;
  return (
    <PreferenceRow
      title={["Backed-up key", shown.key === viewer && "This device", "Linked"]
        .filter(Boolean)
        .join(" · ")}
      subtitle={
        <>
          <code className={`text-mono ${styles.identityValue}`}>
            {npubEncode(shown.key)}
          </code>
          {lastActive &&
            (active === undefined
              ? "Checking activity…"
              : active === null
                ? "No activity here"
                : active === false
                  ? "Couldn’t check activity"
                  : `Last active ${relativeTimestamp(active)}`)}
        </>
      }
    />
  );
}

export function IdentitySettings({
  viewer,
  identity,
  federatedIdentity,
  memberships = [],
  servers = signInServers,
  builderlabIdentity,
  lastActive,
}: {
  viewer?: string | undefined;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  /** Joined communities, for each server's "Used by". */
  memberships?: readonly Membership[] | undefined;
  /** The build's sign-in servers; native's compiled list by default. */
  servers?: () => Promise<readonly SessionSnapshot[]>;
  /**
   * The same session as the Builderlab plugin's bundled installation, as
   * first run uses it: the host's own refuses authenticated requests.
   */
  builderlabIdentity?: FederatedIdentity | undefined;
  /** When `pubkey` was last active in a channel on the current community's relay. */
  lastActive?: ((pubkey: string) => Promise<number | undefined>) | undefined;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (identity) void backupOfferedFor(identity.backup).then(setOffered);
  }, [identity]);
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const npub = viewer ? npubEncode(viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await writeClipboardText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section aria-labelledby="identity-settings-title">
      <Header
        id="identity-settings-title"
        title="Identity"
        subtitle="Your identity is shared across communities. Public keys are safe to share."
      />
      {!viewer && (
        <p>Your identity is unavailable. Connect your identity to manage it.</p>
      )}
      {viewer && (
        <>
          <SettingsGroup>
            {(
              [
                ["Public key (hex)", "Public key", viewer],
                ["Nostr address (npub)", "Nostr address", npub],
              ] as const
            ).map(([label, copyLabel, value]) => (
              <PreferenceRow
                key={label}
                title={label}
                subtitle={
                  <code className={`text-mono ${styles.identityValue}`}>
                    {value}
                  </code>
                }
                trailing={
                  <Tooltip
                    content={`Copy ${copyLabel.toLowerCase()}`}
                    hint="familiar"
                  >
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Copy ${copyLabel.toLowerCase()}`}
                      icon={<CopyIcon aria-hidden="true" />}
                      onClick={() => void copyIdentity(value, copyLabel)}
                    />
                  </Tooltip>
                }
              />
            ))}
          </SettingsGroup>
          {identity && (
            <div className="mt-6">
              <SettingsGroup layout="form">
                {/* One key widget at a time; the dialog brings its own. */}
                {!signingOut && <PrivateKey identity={identity} />}
              </SettingsGroup>
              <SettingsGroup>
                <BackupRow identity={identity} viewer={viewer} />
                {offered && viewer && builderlabIdentity && (
                  <BackedUpKey
                    viewer={viewer}
                    identity={identity}
                    federated={builderlabIdentity}
                    lastActive={lastActive}
                  />
                )}
                <PreferenceRow
                  title="Sign out of Buzz"
                  subtitle="Remove your private key from this device. Also signs you out of your organization and ends Builderlab and hosted community logins."
                  trailing={
                    <Button type="button" onClick={() => setSigningOut(true)}>
                      Sign out of Buzz
                    </Button>
                  }
                />
              </SettingsGroup>
              {signingOut && (
                <SignOutDialog
                  identity={identity}
                  onClose={() => setSigningOut(false)}
                />
              )}
            </div>
          )}
          {federatedIdentity && (
            <OrganizationSignIns
              identity={federatedIdentity}
              memberships={memberships}
              servers={servers}
            />
          )}
          {copyStatus && (
            <ToastNotice
              title={
                copyStatus.failed
                  ? "Identity wasn’t copied"
                  : copyStatus.message
              }
              {...(copyStatus.failed
                ? { description: copyStatus.message }
                : {})}
              tone={copyStatus.failed ? "error" : "success"}
              timeout={copyStatus.failed ? 0 : 5000}
              onDismiss={() => setCopyStatus(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Every server's session, live: one stable array until one changes. */
function useSessions(sessions: readonly FederatedIdentity[]) {
  const store = useMemo(() => {
    let cached: readonly SessionSnapshot[] = [];
    return {
      subscribe: (listener: () => void) => {
        const stops = sessions.map((session) => session.subscribe(listener));
        return () => {
          for (const stop of stops) stop();
        };
      },
      snapshot: () => {
        const next = sessions.map((session) => session.snapshot());
        if (
          next.length !== cached.length ||
          next.some((state, index) => state !== cached[index])
        )
          cached = next;
        return cached;
      },
    };
  }, [sessions]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** One row per signed-in server, each signing out of that server only, and
 * the build's Builderlab row to sign in from while it isn't signed in. */
function OrganizationSignIns({
  identity,
  memberships,
  servers,
}: {
  identity: FederatedIdentity;
  memberships: readonly Membership[];
  servers: () => Promise<readonly SessionSnapshot[]>;
}) {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let active = true;
    void servers()
      .then((list) => {
        if (active)
          setIds(list.flatMap((server) => server.authority?.id ?? []));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [servers]);
  const sessions = useMemo(
    () => ids.flatMap((id) => identity.forServer?.(id) ?? []),
    [identity, ids],
  );
  const states = useSessions(sessions);
  // Kept here, not in a row: a sign-out that fails still leaves signed-in,
  // so its row goes, and the failure must outlive it.
  const [failures, setFailures] = useState<
    ReadonlyMap<FederatedIdentity, SignOutFailure>
  >(new Map());
  const report = (session: FederatedIdentity, failure?: SignOutFailure) =>
    setFailures((current) => {
      const next = new Map(current);
      if (failure) next.set(session, failure);
      else next.delete(session);
      return next;
    });
  const signOut = (session: FederatedIdentity) => {
    const authority = session.snapshot().authority;
    if (!authority) return;
    report(session);
    void session.signOut().catch((error: unknown) =>
      report(session, {
        authority,
        failure: error instanceof Error ? error.message : "",
      }),
    );
  };
  const signedIn = sessions.filter(
    (_, index) =>
      states[index]?.status === "signed-in" && states[index]?.authority,
  );
  // Native reports a sign-out it couldn't finish, such as a storage failure,
  // as that server's snapshot with `cleanup` rather than an error. Read from
  // the session, it survives Settings closing and a reload until cleanup ends.
  // Any other unavailable session, such as a failed restore, still has a
  // record that may be valid; signing out would delete it.
  const unfinished = new Map(failures);
  sessions.forEach((session, index) => {
    const state = states[index];
    if (state?.cleanup && state.authority)
      unfinished.set(session, {
        authority: state.authority,
        failure: state.failure ?? "",
      });
  });
  const problems = [...unfinished].map(([session, { authority, failure }]) => (
    <div key={authority.id}>
      <p role="alert" className="text-body-sm text-danger">
        {`Couldn’t sign out of ${serverName(authority)}. ${recoveryMessage(failure)}`}
      </p>
      <Button type="button" onClick={() => signOut(session)}>
        Try again
      </Button>
    </div>
  ));
  // The first server's own row would repeat its failure without naming it.
  const first = identity.snapshot().authority?.id;
  const firstFailed = [...unfinished.values()].some(
    ({ authority }) => authority.id === first,
  );
  const firstSignedIn = states.some(
    (state) => state.status === "signed-in" && state.authority?.id === first,
  );
  if (signedIn.length === 0)
    return (
      <>
        {!firstFailed && <OrganizationSignIn identity={identity} />}
        {problems}
      </>
    );
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <InlineHeader
        id="organization-sign-in-title"
        title="Organization sign-in"
      />
      <SettingsGroup>
        {!firstSignedIn && !firstFailed && (
          <OrganizationSignIn identity={identity} listed />
        )}
        {signedIn.map((session) => (
          <ServerSession
            key={session.snapshot().authority?.id}
            session={session}
            memberships={memberships}
            onSignOut={() => signOut(session)}
          />
        ))}
        {problems}
      </SettingsGroup>
    </section>
  );
}

type SignOutFailure = Readonly<{
  authority: NonNullable<SessionSnapshot["authority"]>;
  failure: string;
}>;

function ServerSession({
  session,
  memberships,
  onSignOut,
}: {
  session: FederatedIdentity;
  memberships: readonly Membership[];
  onSignOut: () => void;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  if (!state.authority) return null;
  const host = new URL(state.authority.identityOrigin).host;
  const usedBy = coveredCommunities(
    state.authority.communityHosts,
    memberships,
  );
  const expires = state.expiresAt
    ? new Date(state.expiresAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return (
    <PreferenceRow
      title={serverTitle(state.authority)}
      subtitle={
        <>
          {`Signed in as ${state.email ?? "your organization account"}`}
          {expires && ` · Expires at ${expires}`}
          {usedBy.length > 0 && (
            <>
              <br />
              {`Used by: ${usedBy.join(", ")}`}
            </>
          )}
        </>
      }
      trailing={
        <Button
          type="button"
          aria-label={`Sign out of ${host}`}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      }
    />
  );
}

/** A server's row title: its name, and its host when that differs. */
function serverTitle(authority: NonNullable<SessionSnapshot["authority"]>) {
  const host = new URL(authority.identityOrigin).host;
  const name = serverName(authority);
  return name === host ? host : `${name} (${host})`;
}

/** The build's Builderlab sign-in, in a section of its own; `listed`, only
 * its row, named by its server, among other servers' rows. */
function OrganizationSignIn({
  identity,
  listed = false,
}: {
  identity: FederatedIdentity;
  listed?: boolean;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const problem = failure || state.failure;
  if (!state.authority || state.status === "unconfigured") return null;
  const unavailable = state.status === "unavailable";
  // Controls hide when unavailable, but a failed restore still explains itself.
  if (unavailable && !listed)
    return problem ? (
      <p role="alert" className="mt-6 text-body-sm text-danger">
        {recoveryMessage(problem)}
      </p>
    ) : null;
  const organization = new URL(state.authority.identityOrigin).host;
  const signedIn = state.status === "signed-in";
  const signingIn = state.status === "signing-in";
  const status = signedIn
    ? `Signed in as ${state.email ?? "your organization account"}`
    : "Not signed in";
  const expires =
    signedIn && state.expiresAt
      ? new Date(state.expiresAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) =>
        setFailure(
          error instanceof Error ? error.message : "Sign-in unavailable",
        ),
      );
  }
  const row = (
    <>
      <PreferenceRow
        title={listed ? serverTitle(state.authority) : status}
        subtitle={
          <>
            {listed && !unavailable && (
              <>
                {status}
                <br />
              </>
            )}
            {expires && (
              <>
                Expires at {expires}
                <br />
              </>
            )}
            {`Lets you and your agents into communities that require your ${organization} login. Signing out keeps your Buzz key on this device, but you and your agents can’t connect to those communities again until you sign back in.`}
          </>
        }
        trailing={
          unavailable ? undefined : (
            <Button
              type="button"
              disabled={state.status === "restoring"}
              onClick={() =>
                run(() =>
                  signedIn
                    ? identity.signOut()
                    : signingIn
                      ? identity.cancelSignIn()
                      : identity.signIn(),
                )
              }
            >
              {signedIn
                ? "Sign out of organization"
                : signingIn
                  ? "Cancel sign-in"
                  : "Sign in"}
            </Button>
          )
        }
      />
      {problem && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(problem)}
        </p>
      )}
    </>
  );
  if (listed) return row;
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <InlineHeader
        id="organization-sign-in-title"
        title="Organization sign-in"
      />
      <SettingsGroup>{row}</SettingsGroup>
    </section>
  );
}
