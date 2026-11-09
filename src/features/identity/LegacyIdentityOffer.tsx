import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { Identity } from "./service";

/**
 * The offer to continue with installed old Buzz's identity, a dialog over
 * Welcome's Other options, the self-hosted route; Builderlab setup uses that
 * identity without asking. Called with the gate's hooks so the folder check (once
 * per entry into `missing`) and a dismissal outlive a visit to another page;
 * Welcome renders the result on the landing, and `open` holds it closed while
 * a sign-in is pending. Only the click reads old Buzz's secure storage, so any
 * OS prompt follows it. A successful import lifts the gate with no setup.
 */
export function useLegacyIdentityOffer(identity: Identity, open: boolean) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const missing = state.status === "missing";
  // Old Buzz's data folder is here, and the offer has not been dismissed.
  const [offered, setOffered] = useState(false);
  // An identity error before the click belongs to setup's own pages.
  const [tried, setTried] = useState(false);
  const proceed = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!missing) return;
    let active = true;
    void identity
      .legacyAvailable()
      .catch(() => false)
      .then((legacy) => active && setOffered(legacy));
    return () => {
      active = false;
    };
  }, [identity, missing]);
  if (!open || !offered || state.status !== "missing") return null;
  const dismiss = () => setOffered(false);
  return (
    <AlertDialog
      title="Continue with your Buzz identity?"
      description="Old Buzz was used on this device. Continue with the identity it saved instead of setting up a new one. Your computer may ask you to allow access."
      onClose={dismiss}
      pending={state.busy}
      initialFocus={proceed}
      // Launch focuses nothing, so the landing's heading takes focus back.
      finalFocus={() => document.getElementById("welcome-title")}
      actions={
        <>
          <Button type="button" disabled={state.busy} onClick={dismiss}>
            Not now
          </Button>
          <Button
            ref={proceed}
            type="button"
            variant="prominent"
            loading={state.busy}
            onClick={() => {
              setTried(true);
              void identity.importLegacy();
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      {tried && state.error && <p role="alert">{state.error}</p>}
    </AlertDialog>
  );
}
