import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { launchVisible, subscribeLaunch } from "../../app/launch";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { communityDestination } from "../communities/destination";
import {
  legacyImportPending,
  subscribeLegacyImport,
} from "../communities/legacy-communities";
import type { CommunityReader, Membership } from "../communities/service";
import type { BackupStatus } from "./backup";
import { hostedByThisBuilderlab } from "./builderlab-hosted";
import type { BackupChoice, Identity } from "./service";

/**
 * What a key with no saved backup choice gets: saved on at once when it is a
 * member of a community this build's Builderlab hosts, otherwise a prompt.
 * Only while the uploader waits for consent, which it reports only with a
 * Builderlab session on a configured build; a saved choice always stands.
 */
export function decideBackup(
  status: BackupStatus | undefined,
  choice: Pick<BackupChoice, "automatic">,
  memberships: readonly Pick<Membership, "id">[],
  build?: string,
): "save" | "ask" | undefined {
  if (
    status?.status !== "waiting" ||
    status.reason !== "no_consent" ||
    !status.builderlab ||
    choice.automatic !== null
  )
    return undefined;
  return memberships.some(({ id }) => hosted(id, build)) ? "save" : "ask";
}

/** By the saved relay host alone: no relay is read for its NIP-11 `self`. */
function hosted(id: string, build?: string) {
  try {
    return hostedByThisBuilderlab({ url: communityDestination(id).url }, build);
  } catch {
    return false;
  }
}

/** Answers given in a backup prompt, here or in Settings, still being saved. */
let answering = 0;

/**
 * Fills in a missing backup choice once first run is over: Welcome renders
 * this only with the app, so onboarding keeps its own backup step. It decides
 * again each time the uploader waits for consent (launch, a Builderlab
 * sign-in, a key install such as old Buzz's) and when memberships change; a
 * refused save or failed read decides again on the next emission. Nothing is
 * decided or asked under the launch screen or while old Buzz's communities
 * are offered or added, which the app starts once launch ends, so the prompt
 * never opens over that dialog and decides with the communities it adds.
 * Closing the prompt saves nothing and keeps it closed until Builderlab signs
 * out or the app next starts.
 */
export function BackupConsent({
  identity,
  communities,
}: {
  identity: Identity;
  communities: Pick<CommunityReader, "snapshot" | "subscribe">;
}) {
  const status = useSyncExternalStore(
    identity.backup.subscribe,
    identity.backup.snapshot,
  );
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  const importing = useSyncExternalStore(
    subscribeLegacyImport,
    legacyImportPending,
  );
  const held = launching || importing;
  const [asking, setAsking] = useState<string>();
  const dismissed = useRef(false);
  const waiting =
    status?.status === "waiting" && status.reason === "no_consent";
  const signedOut =
    status?.status === "waiting" && status.reason === "no_session";
  useEffect(() => {
    if (!signedOut) return;
    dismissed.current = false;
    setAsking(undefined);
  }, [signedOut]);
  // Memberships are read only while the uploader waits for consent.
  useEffect(() => {
    // A held prompt is decided again once the hold ends.
    if (held) setAsking(undefined);
    if (!waiting || held) return;
    let latest: readonly Membership[] | undefined;
    const retry = (memberships: readonly Membership[]) => {
      if (memberships === latest) latest = undefined;
    };
    const decide = () => {
      const client = communities.snapshot();
      const { memberships } = client;
      if (client.status !== "ready" || memberships === latest) return;
      latest = memberships;
      identity.getBackupChoice().then(
        (choice) => {
          if (memberships !== latest) return;
          const decision = decideBackup(
            identity.backup.snapshot(),
            choice,
            memberships,
          );
          if (decision === "save") {
            // The user's own answer, still being saved, stands; the next
            // update decides again in case it is refused.
            if (answering) return retry(memberships);
            setAsking(undefined);
            // A choice saved since the read, here or in another copy, stands.
            void identity
              .setBackupChoice(choice.pubkey, true, true)
              .catch(() => retry(memberships));
          } else if (decision === "ask" && !dismissed.current)
            setAsking(choice.pubkey);
        },
        () => retry(memberships),
      );
    };
    const stop = communities.subscribe(decide);
    decide();
    return () => {
      latest = undefined;
      stop();
    };
  }, [identity, communities, waiting, held]);
  if (!asking || held) return null;
  return (
    <BackupPrompt
      identity={identity}
      pubkey={asking}
      onClose={() => {
        dismissed.current = true;
        setAsking(undefined);
      }}
    />
  );
}

/**
 * Asks whether to sync this device's identity with Builderlab. Sync with
 * Builderlab and I will manage my own key save the answer for `pubkey` and
 * close with it; Close and Escape save nothing. A refused save stays in the
 * dialog. Once `ended`, it closes as Close does unless its own answer is
 * still being saved or was refused.
 */
export function BackupPrompt({
  identity,
  pubkey,
  onClose,
  finalFocus,
  ended = false,
}: {
  identity: Pick<Identity, "setBackupChoice">;
  pubkey: string;
  onClose(saved?: boolean): void;
  finalFocus?: ComponentProps<typeof AlertDialog>["finalFocus"];
  /** The consent wait is over, by this answer or another. */
  ended?: boolean;
}) {
  const [saving, setSaving] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (ended && saving === undefined && error === undefined) onClose();
  }, [ended, saving, error, onClose]);
  const answer = (automatic: boolean) => {
    setSaving(automatic);
    setError(undefined);
    answering++;
    identity
      .setBackupChoice(pubkey, automatic)
      .finally(() => {
        answering--;
      })
      .then(
        () => onClose(automatic),
        (reason) => {
          setSaving(undefined);
          setError(
            typeof reason === "string"
              ? reason
              : "Could not save your choice. Try again.",
          );
        },
      );
  };
  return (
    <AlertDialog
      title="Sync your identity with Builderlab?"
      description="Buzz will save an encrypted copy of your identity key with your Builderlab account. That copy can restore your identity, including in other apps where you use the same key."
      onClose={onClose}
      finalFocus={finalFocus}
      pending={saving !== undefined}
      actions={
        <>
          <Button
            type="button"
            disabled={saving === true}
            loading={saving === false}
            onClick={() => answer(false)}
          >
            I will manage my own key
          </Button>
          <Button
            type="button"
            variant="prominent"
            disabled={saving === false}
            loading={saving === true}
            onClick={() => answer(true)}
          >
            Sync with Builderlab
          </Button>
        </>
      }
    >
      {error && <p role="alert">{error}</p>}
    </AlertDialog>
  );
}
