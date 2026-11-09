import { useEffect, useRef, useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { prepareRemoteAgentAuthorization } from "../features/host/service";
import { writeClipboardText } from "../shared/clipboard";
import { Button } from "../shared/design-system/ui/Button";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Field } from "../shared/design-system/ui/Field";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { Input } from "../shared/design-system/ui/Input";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../shared/design-system/ui/Textarea";

/** Mounted with the viewer as its key, so a different owner gets a fresh form. */
export function ExternalIdentityAuthorization({ viewer }: { viewer: string }) {
  const [publicKey, setPublicKey] = useState("");
  const [proof, setProof] = useState("");
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState<{
    proof: string;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copyAttempt = useRef(0);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  function requestApproval() {
    if (operation.current) return;
    setProof("");
    setCopyStatus(null);
    const agent = publicKey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(agent) || agent === viewer) {
      setError(
        "Enter the application's 64-character hexadecimal public key, different from your own key.",
      );
      return;
    }
    setError("");
    setConfirmKey(agent);
  }

  async function authorize(agent: string) {
    if (operation.current) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setConfirmKey(null);
    setPending(true);
    setError("");
    try {
      const tag = await prepareRemoteAgentAuthorization(agent, attempt.signal);
      if (attempt.signal.aborted) return;
      if (tag[1] !== viewer)
        throw new Error(
          "Your Buzz identity changed. Reopen Security settings before authorizing.",
        );
      setProof(JSON.stringify(tag));
    } catch (failure) {
      if (!attempt.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn’t authorize this identity.",
        );
    } finally {
      if (!attempt.signal.aborted) {
        operation.current = null;
        setPending(false);
      }
    }
  }

  async function copy() {
    const attempt = ++copyAttempt.current;
    try {
      await writeClipboardText(proof);
      if (attempt === copyAttempt.current)
        setCopyStatus({ proof, message: "Ownership proof copied." });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          proof,
          message:
            "Couldn’t copy. Select the ownership proof and copy it manually.",
        });
    }
  }

  return (
    <div className="mt-8">
      <InlineHeader
        title="Authorize external identity"
        subtitle="For an application such as Nexus that keeps its own agent key. Only authorize a public key you recognize: this ownership proof has no time or event-kind limits."
      />
      <SettingsGroup layout="form">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            requestApproval();
          }}
        >
          <Field
            label="Application public key (hex)"
            description="Copy this public key from the application’s identity settings."
            error={error}
          >
            <Input
              value={publicKey}
              readOnly={pending || confirmKey !== null}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onValueChange={(value) => {
                setPublicKey(value);
                setProof("");
                setError("");
                setCopyStatus(null);
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="prominent"
              loading={pending}
              disabled={!publicKey.trim()}
            >
              {pending ? "Authorizing…" : "Authorize identity"}
            </Button>
          </div>
          {proof && (
            <>
              <Field
                label="Ownership proof"
                description="Paste this signed proof into the application’s owner attestation field. It is bound to the public key above."
              >
                <Textarea variant="code" readOnly value={proof} rows={4} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void copy()}>
                  Copy ownership proof
                </Button>
              </div>
            </>
          )}
          {copyStatus?.proof === proof && (
            <p role="status" className="text-body-sm text-muted">
              {copyStatus.message}
            </p>
          )}
        </form>
      </SettingsGroup>
      {confirmKey && (
        <AlertDialog
          title="Authorize this identity?"
          description="The holder of this key can act as your agent, including directing your Buzz coding agents to run commands as you. This permission has no time or event-kind limits."
          initialFocus={cancelButton}
          onClose={() => setConfirmKey(null)}
          actions={
            <>
              <Button ref={cancelButton} onClick={() => setConfirmKey(null)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                onClick={() => void authorize(confirmKey)}
              >
                Authorize this key
              </Button>
            </>
          }
        >
          <Field label="Application identity (npub)">
            <Textarea
              variant="code"
              readOnly
              value={npubEncode(confirmKey)}
              rows={2}
            />
          </Field>
        </AlertDialog>
      )}
    </div>
  );
}
