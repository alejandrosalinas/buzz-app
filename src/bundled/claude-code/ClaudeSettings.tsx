import { useCallback, useEffect, useRef, useState } from "react";
import { SavedApiKey } from "../../features/settings/SavedApiKey";
import { isApplePlatform } from "../../features/shortcuts/format";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SignIn } from "./auth";
import type { ClaudeSetup } from "./setup";

/** Credentials are independent of the installed Claude version, so a missing
 * or outdated runtime never prevents removing a saved key. */
export function ClaudeSettings({
  setup,
  active,
  clearKey,
}: {
  setup: ClaudeSetup;
  active(): boolean;
  clearKey(): Promise<void>;
}) {
  const [configured, setConfigured] = useState<boolean>();
  const [checking, setChecking] = useState(true);
  const [readError, setReadError] = useState("");
  const request = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [saving, setSaving] = useState(false);
  const section = useRef<HTMLElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const storage = isApplePlatform(navigator.platform)
    ? "this Mac’s Keychain"
    : "this device’s secure storage";
  const check = useCallback(async () => {
    const current = ++request.current;
    setChecking(true);
    setReadError("");
    try {
      const account = await setup.auth.check();
      if (request.current === current) setConfigured(account !== undefined);
    } catch (error) {
      if (request.current === current) setReadError(String(error));
    } finally {
      if (request.current === current) setChecking(false);
    }
  }, [setup]);
  useEffect(() => {
    const unsubscribe = setup.auth.subscribe(() => void check());
    void check();
    return () => {
      request.current++;
      unsubscribe();
    };
  }, [setup, check]);

  const clear = async () => {
    if (!active() || saving || clearing) return;
    setClearing(true);
    setClearError("");
    try {
      await clearKey();
      setConfigured(false);
      setConfirm(false);
      // A runtime refresh cannot undo the completed credential removal.
      await setup.check().catch(() => undefined);
    } catch (error) {
      setClearError(String(error));
    } finally {
      setClearing(false);
    }
  };
  const disabled = checking || saving || clearing || !!readError || !active();
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="claude-settings-title"
    >
      <Header
        id="claude-settings-title"
        title="Claude"
        subtitle="Manage Claude’s credentials on this computer."
      />
      <div className="mt-section-gap grid gap-section-gap">
        <div>
          <InlineHeader title="Anthropic API key" />
          <SettingsGroup layout="form">
            <LoadingRegion
              pending={checking}
              label="Checking for a saved key…"
              statusVisibility="screen-reader"
              feedback={
                readError ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p role="alert" className="buzz-field-error m-0">
                      {readError}
                    </p>
                    <Button onClick={() => void check()}>Retry</Button>
                  </div>
                ) : undefined
              }
            >
              {configured === true ? (
                <SavedApiKey
                  credential={setup.auth}
                  onSaved={() => setup.check()}
                  active={active}
                  disabled={disabled}
                  conceal={confirm || clearing || !!readError || !active()}
                  onSavingChange={setSaving}
                  trigger={actionsButton}
                  onRemove={() => {
                    if (active()) {
                      setClearError("");
                      setConfirm(true);
                    }
                  }}
                />
              ) : (
                <SignIn
                  setup={setup}
                  disabled={disabled || configured === undefined}
                  active={active}
                  onSavingChange={setSaving}
                />
              )}
            </LoadingRegion>
          </SettingsGroup>
        </div>
      </div>
      {confirm && (
        <AlertDialog
          title="Remove Claude API key?"
          description={`This removes the key from ${storage}. New local Claude sessions will need a key. A turn already running can finish.`}
          pending={clearing}
          onClose={() => setConfirm(false)}
          finalFocus={() =>
            actionsButton.current ??
            section.current?.querySelector<HTMLInputElement>("input") ??
            section.current
          }
          actions={
            <>
              <Button disabled={clearing} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={clearing}
                onClick={() => void clear()}
              >
                Remove key
              </Button>
            </>
          }
        >
          {clearError && (
            <p role="alert" className="buzz-field-error m-0">
              {clearError}
            </p>
          )}
        </AlertDialog>
      )}
    </section>
  );
}
