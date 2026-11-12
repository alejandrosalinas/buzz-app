import { Fragment, useRef, useState, useSyncExternalStore } from "react";
import { ApiKeyForm } from "../../features/settings/ApiKeyForm";
import { SavedApiKey } from "../../features/settings/SavedApiKey";
import { isApplePlatform } from "../../features/shortcuts/format";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { KeyState, TypeSafeKey } from "./key";

const KEY_STATUS: Record<KeyState, string | undefined> = {
  checking: "Checking for a saved key…",
  saved: "Saved securely on this computer.",
  missing: undefined,
  unreadable:
    "Buzz could not read your saved key. Unlock your keychain, or replace or remove the key.",
  refused:
    "TypeSafe did not accept your key. Replace it to keep using TypeSafe.",
};

/** Sets or removes the TypeSafe key. The key goes straight to native storage
 * and is never shown again. */
export function TypeSafeSettings({
  typesafe,
  active,
  grouped = true,
  apple = isApplePlatform(navigator.platform),
}: {
  typesafe: Pick<
    TypeSafeKey,
    "snapshot" | "subscribe" | "save" | "clear" | "desktop"
  >;
  active(): boolean;
  grouped?: boolean;
  /** Whether the key goes to the macOS Keychain, which only Buzz can read. */
  apple?: boolean;
}) {
  const keyState = useSyncExternalStore(
    typesafe.subscribe,
    typesafe.snapshot,
    typesafe.snapshot,
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const writing = useRef(false);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const storage = apple
    ? "this Mac’s Keychain"
    : "this device’s secure storage";
  // A key may be saved in each state but these two.
  const saved = keyState !== "missing" && keyState !== "checking";
  const run = async (action: () => Promise<void>) => {
    if (!active() || busy || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      setKey("");
      setConfirm(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  if (!typesafe.desktop())
    return (
      <p role="status" className="m-0 text-body-sm text-secondary">
        Open the Buzz desktop app to use TypeSafe.
      </p>
    );
  const Group = grouped ? SettingsGroup : Fragment;
  const description = (
    <span role="status">
      {keyState === "missing"
        ? "Your key will be stored securely on this computer."
        : KEY_STATUS[keyState]}
    </span>
  );
  return (
    <div ref={container} className="w-full">
      <Group {...(grouped ? { layout: "form" as const } : {})}>
        {saved ? (
          <SavedApiKey
            label="TypeSafe API key"
            labelVisibility="visible"
            credential={typesafe}
            active={active}
            disabled={busy || !active()}
            conceal={confirm || !active()}
            description={description}
            onSavingChange={setBusy}
            trigger={actionsButton}
            onRemove={() => {
              if (!active() || busy) return;
              setError("");
              setConfirm(true);
            }}
          />
        ) : (
          <ApiKeyForm
            label="TypeSafe API key"
            description={description}
            value={key}
            onValueChange={setKey}
            onSave={() => {
              const value = key.trim();
              if (value && keyState !== "checking")
                void run(() => typesafe.save(value));
            }}
            disabled={!active() || keyState === "checking"}
            saving={busy}
            feedback={
              error && (
                <p role="alert" className="buzz-field-error m-0">
                  {error}
                </p>
              )
            }
          />
        )}
        {!apple && (
          <p className="m-0 text-body-sm text-secondary">
            Other programs you run, agent shells included, can read the saved
            key.
          </p>
        )}
      </Group>
      {confirm && (
        <AlertDialog
          title="Remove TypeSafe API key?"
          description={`This removes the key from ${storage}. Add a key again to keep using TypeSafe.`}
          pending={busy}
          onClose={() => setConfirm(false)}
          finalFocus={() =>
            actionsButton.current ??
            container.current?.querySelector<HTMLInputElement>("input")
          }
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                onClick={() => void run(() => typesafe.clear())}
              >
                Remove key
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className="buzz-field-error m-0">
              {error}
            </p>
          )}
        </AlertDialog>
      )}
    </div>
  );
}
