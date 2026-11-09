import { useEffect, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Input } from "../../shared/design-system/ui/Input";
import { PrivateKey } from "./PrivateKey";
import type { Identity } from "./service";

export const WIPE_PHRASE = "erase all my data";

/** Confirm only after the key was revealed or copied and the user says they have it. */
export function signOutReady(state: {
  touched: boolean;
  haveKey: boolean;
  wipe: boolean;
  phrase: string;
}) {
  return (
    state.touched &&
    state.haveKey &&
    (!state.wipe || state.phrase.trim() === WIPE_PHRASE)
  );
}

/** Native refusals carry `{ message }`; anything else is a plain error. */
export function signOutFailure(reason: unknown) {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  )
    return reason.message;
  return String(reason);
}

export function SignOutDialog({
  identity,
  onClose,
}: {
  identity: Identity;
  onClose(): void;
}) {
  const [touched, setTouched] = useState(false);
  const [haveKey, setHaveKey] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [removeAgents, setRemoveAgents] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // Asked of the native side, which enforces it; wipe stays off until it answers.
  const [wipeRefusal, setWipeRefusal] = useState<string | null>();
  useEffect(() => {
    let current = true;
    identity
      .wipeRefusal()
      .catch(() => "Couldn’t check whether erasing is available")
      .then((reason) => {
        if (current) setWipeRefusal(reason ?? null);
      });
    return () => {
      current = false;
    };
  }, [identity]);
  const ready = signOutReady({ touched, haveKey, wipe, phrase });
  async function confirm() {
    setPending(true);
    setError("");
    try {
      await identity.signOut({ wipe, removeAgents: wipe && removeAgents });
    } catch (reason) {
      setError(signOutFailure(reason));
      setPending(false);
    }
  }
  return (
    <AlertDialog
      title="Sign out of Buzz?"
      description="Signing out removes your private key from this device. Your key is how you sign in, so save it before you continue. You’ll need it to sign back in as this identity."
      onClose={onClose}
      pending={pending}
      actions={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ready || pending}
            onClick={() => void confirm()}
          >
            {wipe ? "Sign out and erase" : "Sign out"}
          </Button>
        </>
      }
    >
      <PrivateKey identity={identity} onInteraction={() => setTouched(true)} />
      <div className="mt-6 flex flex-col gap-3">
        <Checkbox
          label="I have my key"
          checked={haveKey}
          disabled={!touched || pending}
          onCheckedChange={setHaveKey}
        />
        <Checkbox
          label="Also erase everything else Buzz stores on this device"
          checked={wipe}
          disabled={pending || wipeRefusal !== null}
          onCheckedChange={(checked) => {
            setWipe(checked);
            if (!checked) {
              setRemoveAgents(false);
              setPhrase("");
            }
          }}
        />
        {wipeRefusal && (
          <p className="text-body-sm text-muted">{wipeRefusal}.</p>
        )}
        {wipe && (
          <>
            <Checkbox
              label="Also remove my agents"
              checked={removeAgents}
              disabled={pending}
              onCheckedChange={setRemoveAgents}
            />
            <label className="block text-label-sm" htmlFor="sign-out-phrase">
              Type “{WIPE_PHRASE}” to confirm
            </label>
            <Input
              id="sign-out-phrase"
              autoComplete="off"
              value={phrase}
              disabled={pending}
              onChange={(event) => setPhrase(event.currentTarget.value)}
            />
            <p className="text-body-sm text-muted">
              Erasing clears this app’s data, local storage, caches and plugin
              storage on this device only. It can’t reach your clipboard, keys
              you exported, or relay data; your npub and its history stay on the
              relays.
              {!removeAgents &&
                " Kept agents keep their names, types and keys; their settings on this device are erased."}
            </p>
          </>
        )}
        {!wipe && (
          <p className="text-body-sm text-muted">
            Your settings, agents and other Buzz data stay on this device. Sign
            back in with this key and they’ll be here. Agents start only for
            this key.
          </p>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </AlertDialog>
  );
}
