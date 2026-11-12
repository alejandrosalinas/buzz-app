import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { launchVisible, subscribeLaunch } from "../../app/launch";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  legacyImportPending,
  subscribeLegacyImport,
} from "../communities/legacy-communities";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../federated-identity/service";
import { federatedBuilderlabAccount } from "./builderlab-account";
import type { Identity } from "./service";

type Session = Pick<FederatedIdentity, "snapshot" | "subscribe" | "request">;

const noSession = () => () => {};

/**
 * What a Not now or OK was given for: `linked:viewer:restorable`, so the
 * no-backup OK asks again, with Replace, once the account's key is backed up.
 */
const DISMISSED = "buzz.linked-key-dismissed.v1";
const asked = (linked: string, viewer: string, restorable: boolean) =>
  `${linked}:${viewer}:${restorable}`;
function dismissedPair() {
  try {
    return localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}
function rememberDismissed(value: string) {
  try {
    localStorage.setItem(DISMISSED, value);
  } catch {
    // Storage refused: it stays quiet for this run only.
  }
}
const noSnapshot = (): SessionSnapshot | undefined => undefined;

/** The build's Builderlab session, or `undefined` for a build without one. */
export const useSession = (
  federated: Pick<FederatedIdentity, "snapshot" | "subscribe"> | undefined,
) =>
  useSyncExternalStore(
    federated?.subscribe ?? noSession,
    federated?.snapshot ?? noSnapshot,
  );

/**
 * Checks, with the app already open, that the Builderlab account signed in
 * here is linked to this device's key. Launch never waits on it: once the
 * saved session is signed in, it reads the account's linked key, the read
 * Settings makes, and asks only when that is another key. No linked key, a
 * refused or absent session, or a failed read (of the linked key or the
 * account's backups) leaves the app as it is.
 *
 * Replace is offered only when Builderlab holds a backup of the account's key,
 * so the Welcome back it restarts into can restore it: it is setup's own
 * replace step, which removes this key and restarts. Otherwise it only says
 * where the account's key is. Not now (or OK) is remembered for this pair of
 * keys and whether Replace was offered, so it asks again only when either key
 * changes or the account's key gets a backup. While it asks, `children` (the
 * backup prompt) stays mounted, keeping what it was told, and is told to wait.
 */
export function LinkedKeyCheck({
  federated,
  identity,
  viewer,
  onReplace,
  children,
}: {
  /** The build's Builderlab session; without one there is nothing to check. */
  federated?: Session | undefined;
  identity: Identity;
  /** The key on this device. */
  viewer: string;
  /** Replace, for the account linked to `linked`. */
  onReplace: (linked: string) => void;
  /** Rendered throughout, told whether this check is asking. */
  children?: (asking: boolean) => ReactNode;
}) {
  const session = useSession(federated);
  const revision =
    session?.status === "signed-in" && session.authority
      ? session.revision
      : undefined;
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  const importing = useSyncExternalStore(
    subscribeLegacyImport,
    legacyImportPending,
  );
  // The mismatch found, for the session and key it was read with.
  const [found, setFound] = useState<{
    revision: string;
    viewer: string;
    linked: string;
    /** Builderlab holds a backup of the account's key: Welcome back restores it. */
    restorable: boolean;
    /** This device confirmed a backup of its own key. */
    backedUp: boolean;
  }>();
  // Not now's pair, should storage refuse it.
  const dismissed = useRef<string | null>(null);
  useEffect(() => {
    if (!federated || !revision) return;
    let current = true;
    // A build that can't make the account (no Builderlab URL) has nothing to check.
    Promise.resolve()
      .then(async () => {
        const account = federatedBuilderlabAccount(
          { revision },
          federated,
          identity,
        );
        const linked = await account.linkedKey();
        if (!current || !linked || linked === viewer) return;
        const [backups, backedUp] = await Promise.all([
          account.backupStatus().catch(() => "failed" as const),
          identity.backedUp(viewer).catch(() => false),
        ]);
        // Without an answer it can't say whether Replace would restore it.
        if (backups === "failed") return;
        const restorable =
          backups !== "unavailable" && backups.includes(linked);
        const question = asked(linked, viewer, restorable);
        if (dismissed.current === question || dismissedPair() === question)
          return;
        if (current)
          setFound({ revision, viewer, linked, restorable, backedUp });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [federated, identity, viewer, revision]);
  const asking =
    !!found &&
    found.revision === revision &&
    found.viewer === viewer &&
    !launching &&
    !importing;
  if (!asking) return children?.(false);
  const dismiss = () => {
    const question = asked(found.linked, found.viewer, found.restorable);
    dismissed.current = question;
    rememberDismissed(question);
    setFound(undefined);
  };
  const account = session?.email ?? "Your Builderlab account";
  const prompt = found.restorable ? (
    <AlertDialog
      title="Your account uses a different key"
      description={`${account} is linked to a different key than the one on this computer, and Builderlab has a backup of it. Replacing removes this computer’s key and restarts Buzz to restore your account’s key. ${
        found.backedUp
          ? "This computer’s key was backed up in Builderlab: sign in to its account to restore it."
          : "This computer’s key may not be backed up: copy its private key from Settings → Identity first, or you could lose it."
      }`}
      onClose={dismiss}
      actions={
        <>
          <Button onClick={dismiss}>Not now</Button>
          <Button variant="destructive" onClick={() => onReplace(found.linked)}>
            Replace
          </Button>
        </>
      }
    />
  ) : (
    <AlertDialog
      title="Your account uses a different key"
      description={`${account} is linked to a key that lives on another device, and Builderlab has no backup of it. Buzz keeps using this computer’s key. To use your account’s key here, turn on Identity sync in Settings → Identity on that device, or bring its private key here.`}
      onClose={dismiss}
      actions={<Button onClick={dismiss}>OK</Button>}
    />
  );
  return (
    <>
      {children?.(true)}
      {prompt}
    </>
  );
}
