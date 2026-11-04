import { OnboardingBack } from "./OnboardingBack";
import { useId, useRef, useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { useFileDrop } from "../messages/use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { EyeIcon, EyeSlashIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Input } from "../../shared/design-system/ui/Input";
import styles from "./IdentitySetup.module.css";
import { classifyKeyImport, readKeyFile } from "./key-import";
import { OnboardingScreen } from "./OnboardingScreen";
import { SetupProgress } from "./SetupProgress";

/**
 * Pause for a key the user already has: paste or type an `nsec1…` key, or
 * drop or choose a small text file holding one. Valid input previews the
 * npub; Continue hands the nsec to native import. The key exists only in this
 * component's state and is never logged or stored, so leaving the page
 * discards it. While import runs the form gives way to the progress page on
 * the same screen but stays mounted, so a native refusal returns to it with
 * the typed key kept.
 * With `expectedPubkey`, only that key continues: any other valid nsec is
 * refused under the field.
 */
export function KeyImport({
  expectedPubkey,
  automaticBackup = false,
  onBack,
  onLost,
  onImport,
}: {
  /** The hex key linked to the signed-in account, when the lane has one. */
  expectedPubkey?: string | undefined;
  /** `kept`: the account holds the key's backup, so a saved opt-out stands. */
  automaticBackup?: boolean | "kept";
  onBack: () => void;
  onLost?: (() => void) | undefined;
  /** Rejects with the native refusal, shown under the field. */
  onImport: (nsec: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const formId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const input = classifyKeyImport(text);
  const expected =
    expectedPubkey === undefined ? undefined : npubEncode(expectedPubkey);
  const mismatch =
    input.kind === "nsec" && expected !== undefined && input.npub !== expected;
  const ready = input.kind === "nsec" && !mismatch;
  const change = (next: string) => {
    setText(next);
    setFailure(undefined);
  };
  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      change(await readKeyFile(file));
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Couldn’t read that file.",
      );
    }
  };
  // The whole form is the drop target; the hook rebinds when the form returns.
  const dragging = useFileDrop(form, !busy, (files) => void fromFile(files[0]));
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onImport(input.nsec);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Couldn’t import this key.",
      );
    } finally {
      setBusy(false);
    }
  };
  const message =
    failure ??
    (mismatch ? (
      <>
        That isn’t the key linked to this account. It expects{" "}
        <code className="select-text break-all font-mono text-mono">
          {expected}
        </code>{" "}
        (the key on your other device).
      </>
    ) : input.kind === "encrypted" ? (
      "Password-protected backups aren’t supported here yet. Paste the nsec1 key itself."
    ) : input.kind === "invalid" ? (
      "That doesn’t look like a valid nsec. Paste an nsec1 key."
    ) : undefined);
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        busy ? (
          <div className={`${styles.importContent} items-center`}>
            <SetupProgress label="Importing your key…" />
          </div>
        ) : (
          <>
            {/* The onboarding import layout: the actions below submit through `form`. */}
            <form
              ref={form}
              id={formId}
              className={styles.importContent}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h1
                id="welcome-title"
                tabIndex={-1}
                className="text-heading text-standard"
              >
                Enter your private key
              </h1>
              <p className="text-body text-subtle">
                Paste your private key to sign in to Buzz. You can also select
                or drop a text file with your key.
              </p>
              {automaticBackup && (
                <p className="text-body-sm text-subtle">
                  Buzz will automatically sync this key with your Builderlab
                  account
                  {automaticBackup === "kept" &&
                    " unless you chose to manage it yourself"}
                  . Block can use that copy to restore your identity, including
                  anywhere else you use it.
                </p>
              )}
              <div className={styles.importForm}>
                <Field
                  label="Private key (nsec)"
                  error={message}
                  description={
                    input.kind === "nsec" && (
                      <>
                        Public identity:{" "}
                        <code className="select-text break-all font-mono text-mono">
                          {input.npub}
                        </code>
                      </>
                    )
                  }
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <InputGroup
                        trailing={
                          <IconButton
                            type="button"
                            aria-label={
                              revealed
                                ? "Hide private key"
                                : "Reveal private key"
                            }
                            icon={revealed ? <EyeSlashIcon /> : <EyeIcon />}
                            onClick={() => setRevealed(!revealed)}
                          />
                        }
                      >
                        <Input
                          type={revealed ? "text" : "password"}
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          placeholder="nsec1…"
                          value={text}
                          onValueChange={change}
                          autoFocus
                        />
                      </InputGroup>
                    </div>
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="md"
                        onClick={() => picker.current?.click()}
                      >
                        Browse
                      </Button>
                    </div>
                  </div>
                </Field>
                {dragging && (
                  <p className="m-0 text-body-sm text-subtle">
                    Drop to use this file.
                  </p>
                )}
              </div>
              {onLost && (
                <div className="flex justify-start">
                  <Button variant="link" onClick={onLost}>
                    I lost my key
                  </Button>
                </div>
              )}
            </form>
            {/* Outside the form, so the key is its only field and Enter submits. */}
            <input
              ref={picker}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Key file"
              accept=".txt,.key,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void fromFile(file);
              }}
            />
          </>
        )
      }
    >
      {!busy && (
        <>
          <Button
            type="submit"
            form={formId}
            size="lg"
            variant="prominent"
            disabled={!ready}
          >
            Continue with this key
          </Button>
          <OnboardingBack type="button" onClick={onBack} />
        </>
      )}
    </OnboardingScreen>
  );
}
