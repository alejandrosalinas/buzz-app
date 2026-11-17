import { useCallback, useEffect, useRef, useState } from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Header } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SignIn } from "./auth";
import { SavedApiKey } from "../../features/settings/SavedApiKey";
import type { ClaudeSetup } from "./setup";

export type ClaudeConnection = {
  open: boolean;
  onOpenChange(open: boolean): void;
};

type Credentials = Readonly<{
  /** Whether the person has a Claude setup of their own, which Claude uses
   * over a saved key. */
  own: boolean;
  /** Whether a key is saved; security reviews always use it. */
  key: boolean;
}>;

/** Credentials are independent of the installed Claude version, so a missing
 * or outdated runtime never prevents removing a saved key. */
export function ClaudeSettings({
  setup,
  active,
  read,
  connect,
  clearKey,
  connection,
}: {
  setup: ClaudeSetup;
  active(): boolean;
  read(): Promise<Credentials>;
  /** What to say while Claude has neither a setup of its own nor a key. */
  connect: string;
  clearKey(): Promise<void>;
  connection?: ClaudeConnection | undefined;
}) {
  const [configured, setConfigured] = useState<boolean>();
  const [own, setOwn] = useState<Credentials["own"]>();
  const [checking, setChecking] = useState(true);
  const [readError, setReadError] = useState("");
  const request = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionId, setConnectionId] = useState(0);
  const connectionOpen = connection?.open ?? connecting;
  const changeConnection = useCallback(
    (open: boolean) => {
      setConnecting(open);
      if (!open) setConnectionId((id) => id + 1);
      connection?.onOpenChange(open);
    },
    [connection],
  );
  const section = useRef<HTMLElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const setButton = useRef<HTMLButtonElement>(null);
  const connectForm = useRef<HTMLDivElement>(null);
  const storage = isApplePlatform(navigator.platform)
    ? "this Mac’s Keychain"
    : "this device’s secure storage";
  const check = useCallback(async () => {
    const current = ++request.current;
    setChecking(true);
    setReadError("");
    try {
      const credentials = await read();
      if (request.current === current) {
        setConfigured(credentials.key);
        setOwn(credentials.own);
      }
      return credentials;
    } catch (error) {
      if (request.current === current) {
        setReadError(String(error));
      }
    } finally {
      if (request.current === current) setChecking(false);
    }
  }, [read]);
  useEffect(() => {
    const unsubscribe = setup.auth.subscribe(() => void check());
    void check();
    return () => {
      request.current++;
      unsubscribe();
    };
  }, [setup, check]);
  /** Looks again for the person's own setup, made with the Claude CLI, which
   * ends key entry once it is found. */
  const refresh = async () => {
    await setup.check().catch(() => undefined);
    if ((await check())?.own) changeConnection(false);
  };
  useEffect(() => {
    if (connection?.open) void check();
  }, [connection?.open, check]);
  useEffect(() => {
    if (connectionOpen && configured === true) changeConnection(false);
  }, [connectionOpen, configured, changeConnection]);

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
  const feedback = readError ? (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="buzz-field-error m-0">
        {readError}
      </p>
      <Button
        onClick={() => {
          void check();
          if (connectionOpen)
            connectForm.current
              ?.querySelector<HTMLInputElement>("input")
              ?.focus();
        }}
      >
        Retry
      </Button>
    </div>
  ) : undefined;
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="claude-settings-title"
    >
      <Header
        id="claude-settings-title"
        title="Claude"
        subtitle={
          configured === false && !own && !checking && !readError
            ? connect
            : "Manage Claude’s credentials on this computer."
        }
      />
      <div className="mt-section-gap grid gap-section-gap">
        <LoadingRegion
          pending={checking}
          label="Checking for a saved key…"
          statusVisibility="screen-reader"
          feedback={
            connectionOpen && configured === false ? undefined : feedback
          }
        >
          {configured === true ? (
            <SettingsGroup layout="form">
              <SavedApiKey
                label="Anthropic API key"
                labelVisibility="visible"
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
            </SettingsGroup>
          ) : (
            <SettingsGroup>
              <PreferenceRow
                title="Anthropic API key"
                subtitle={
                  configured === false && !readError
                    ? "No key saved."
                    : undefined
                }
                trailing={
                  <Button
                    ref={setButton}
                    size="sm"
                    disabled={disabled || configured === undefined}
                    onClick={() => {
                      if (active() && !disabled) changeConnection(true);
                    }}
                  >
                    Set
                  </Button>
                }
              />
            </SettingsGroup>
          )}
        </LoadingRegion>
      </div>
      {configured === false && (
        <SignIn
          key={connectionId}
          variant="dialog"
          setup={setup}
          disabled={disabled}
          readOnly={checking || !!readError}
          active={active}
          onSavingChange={setSaving}
          onSaved={() => changeConnection(false)}
          render={(form) => (
            <Dialog
              open={connectionOpen && active()}
              visit
              title="Connect Claude"
              description={
                <>
                  {!own && <>{connect} </>}
                  Create an API key at{" "}
                  <Button
                    variant="link"
                    size="text"
                    nativeButton={false}
                    role="link"
                    render={
                      <a
                        href="https://console.anthropic.com/settings/keys"
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    console.anthropic.com
                  </Button>{" "}
                  and paste it below.
                </>
              }
              actions={
                !own && (
                  <Button
                    disabled={checking || saving}
                    // Natively disabled, it would blur out of the open dialog.
                    focusableWhenDisabled
                    onClick={() => void refresh()}
                  >
                    Refresh
                  </Button>
                )
              }
              preventClose={saving}
              onOpenChange={(open) => !open && changeConnection(false)}
              initialFocus={() =>
                connectForm.current?.querySelector("input") ?? null
              }
              finalFocus={() =>
                actionsButton.current ?? setButton.current ?? section.current
              }
            >
              <LoadingRegion
                pending={checking}
                label="Checking for a saved key…"
                statusVisibility="screen-reader"
                feedback={feedback}
              >
                <div ref={connectForm}>{form}</div>
              </LoadingRegion>
            </Dialog>
          )}
        />
      )}
      {confirm && (
        <AlertDialog
          title="Remove Claude API key?"
          description={`This removes the key from ${storage}. ${own ? "Security reviews" : "New local Claude sessions"} will need a key. A turn already running can finish.`}
          pending={clearing}
          onClose={() => setConfirm(false)}
          finalFocus={() =>
            actionsButton.current ??
            setButton.current ??
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
