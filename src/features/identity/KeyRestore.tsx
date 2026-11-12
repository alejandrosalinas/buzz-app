import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { Recovery } from "./builderlab-account";
import { OnboardingBack } from "./OnboardingBack";
import { OnboardingScreen } from "./OnboardingScreen";
import { recoveryOff } from "./service";

/** First-run recovery only installs the key linked to the current account. */
export function KeyRestore({
  recovery,
  expectedPubkey,
  email,
  onBack,
  onLost,
  onImport,
  onInstalled,
}: {
  recovery: Recovery;
  expectedPubkey: string;
  email?: string | undefined;
  onBack: () => void;
  onLost?: (() => void) | undefined;
  onImport: () => void;
  onInstalled: () => void;
}) {
  const state = useSyncExternalStore(recovery.subscribe, recovery.snapshot);
  const candidate =
    state?.status === "choosing"
      ? state.candidates.find((item) => item.pubkey === expectedPubkey)
      : undefined;
  const installedHandle = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!candidate || installedHandle.current === candidate.handle) return;
    installedHandle.current = candidate.handle;
    void recovery.installRecovery(candidate.handle).then(onInstalled);
  }, [candidate, recovery, onInstalled]);
  const leave = async (then: () => void) => {
    if (await recovery.cancelRecovery()) then();
  };
  const retry = async () => {
    if (!(await recovery.cancelRecovery())) return;
    installedHandle.current = undefined;
    await recovery.beginRecovery();
  };
  const saving = !!candidate || state?.status === "saving";
  const canceling = state?.status === "canceling";
  const failed =
    state?.status === "error" || (state?.status === "choosing" && !candidate);
  const partial = state?.status === "choosing" && state.failedCount > 0;
  const off = recoveryOff(state);
  const canRetry = !off && (state?.status === "error" || partial);
  const description = off
    ? "Backup restoration isn’t available for this account. Enter your private key to continue."
    : partial
      ? "We couldn’t check all your backups. Try again, or enter your private key if you have a copy."
      : state?.status === "choosing" && !candidate
        ? state.candidates.length === 0
          ? "We couldn’t find a key backup in this Builderlab account. If you have a copy of your private key, you can enter it instead."
          : "We found backups, but none contains the key linked to your account. Enter your private key to continue."
        : state?.status === "error"
          ? // Native names the cause: canceled, timed out, offline or a retry.
            `${state.error} Or enter your private key if you have a copy.`
          : saving
            ? "Restoring your key…"
            : canceling
              ? "Canceling recovery…"
              : "Restoring your key…";
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            {failed ? "Couldn’t restore your key" : "Restore your key"}
          </h1>
          {email && (
            <p className="break-words text-body-sm text-subtle">
              Signed in as {email}
            </p>
          )}
          <p
            role={failed ? "alert" : "status"}
            className="mt-2 text-body text-subtle"
          >
            {description}
          </p>
          {state?.status === "waiting" && (
            <p className="text-body-sm text-subtle">
              Complete sign-in in your browser if prompted.
            </p>
          )}
        </>
      }
    >
      {failed && (
        <>
          <Button
            size="lg"
            variant="prominent"
            onClick={() => void leave(onImport)}
          >
            Enter my private key
          </Button>
          {onLost && (
            <Button size="lg" onClick={() => void leave(onLost)}>
              I lost my key
            </Button>
          )}
          {canRetry && (
            <Button size="lg" variant="ghost" onClick={() => void retry()}>
              Try again
            </Button>
          )}
        </>
      )}
      <div data-onboarding-actions="">
        <OnboardingBack
          aria-label={!failed && !saving ? "Cancel" : "Back"}
          disabled={saving || canceling}
          onClick={() => void leave(onBack)}
        />
      </div>
    </OnboardingScreen>
  );
}
