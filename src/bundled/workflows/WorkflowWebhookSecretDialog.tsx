import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ConfirmAction } from "./ConfirmAction";
import { writeClipboardText } from "../../shared/clipboard";

/** Shown when the user leaves before revealing or copying; the relay cannot re-issue the secret. */
export const continueWithoutSecret = {
  title: "Continue without this secret?",
  description:
    "This private webhook secret cannot be recovered. Copy and store it before continuing, or explicitly leave it behind.",
  action: "Continue",
  cancel: "Go back",
  destructive: true,
};

/** One-time display of a webhook secret. The value lives in component state only. */
export function WorkflowWebhookSecretDialog({
  workflowId,
  hookUrl,
  take,
  onContinue,
}: {
  workflowId: string;
  /** Display address, or undefined when the host advertised no relay HTTP base. */
  hookUrl: string | undefined;
  /** One-shot hand-off from the capability; called once, when this dialog mounts. */
  take: () => string | undefined;
  onContinue: () => void;
}) {
  const id = useId();
  const [secret, setSecret] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [handled, setHandled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const taken = useRef(false);
  useEffect(() => {
    // StrictMode re-runs mount effects on the same instance; the ref keeps the
    // hand-off single-shot so a second pass cannot take nothing and lose it.
    if (taken.current) return;
    taken.current = true;
    const value = take();
    if (value !== undefined) setSecret(value);
  }, [take]);
  const copy = async (value: string, label: "URL" | "secret") => {
    try {
      await writeClipboardText(value);
      setNotice({
        text: `${label === "URL" ? "URL" : "Secret"} copied.`,
        error: false,
      });
      if (label === "secret") setHandled(true);
    } catch {
      setNotice({
        text:
          label === "secret"
            ? "Couldn’t copy the secret. Reveal it and copy it manually."
            : "Couldn’t copy the URL. Select it and copy it manually.",
        error: true,
      });
    }
  };
  const leave = () => {
    if (secret === undefined || handled) onContinue();
    else setConfirming(true);
  };
  return (
    <>
      <Dialog
        open
        dismissOnOutsideClick={false}
        onOpenChange={(open) => {
          if (!open) leave();
        }}
        title="Webhook ready"
        description="This private secret is shown once and cannot be recovered. Copy and store it before continuing."
        actions={
          <Button variant="primary" onClick={leave}>
            Continue
          </Button>
        }
      >
        <div className="workflow-secret">
          <p id={`${id}-url`} className="text-label-sm">
            Webhook URL
          </p>
          {hookUrl ? (
            <div className="workflow-secret-row">
              <code
                className="workflow-secret-value text-mono-sm"
                data-testid="webhook-url"
              >
                {hookUrl}
              </code>
              <Button size="compact" onClick={() => void copy(hookUrl, "URL")}>
                Copy URL
              </Button>
            </div>
          ) : (
            <p className="text-body-sm text-secondary">
              The relay’s HTTP address is unavailable from this host. Send
              requests to <code>/hooks/{workflowId}</code> on the relay.
            </p>
          )}
          <p id={`${id}-secret`} className="text-label-sm">
            X-Webhook-Secret header
          </p>
          <div className="workflow-secret-row">
            <code
              className="workflow-secret-value text-mono-sm"
              data-testid="webhook-secret"
            >
              {secret === undefined
                ? "Unavailable"
                : revealed
                  ? secret
                  : "•".repeat(24)}
            </code>
            <Button
              size="compact"
              aria-label={
                revealed ? "Hide webhook secret" : "Reveal webhook secret"
              }
              disabled={secret === undefined}
              onClick={() => {
                setRevealed((value) => !value);
                setHandled(true);
              }}
            >
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <Button
              size="compact"
              disabled={secret === undefined}
              onClick={() =>
                secret !== undefined && void copy(secret, "secret")
              }
            >
              Copy secret
            </Button>
          </div>
          {secret === undefined && (
            <p role="alert" className="text-body-sm text-danger">
              This secret is no longer available from this session.
            </p>
          )}
          {notice && (
            <p
              role="status"
              className={`text-body-sm ${notice.error ? "text-danger" : "text-secondary"}`}
            >
              {notice.text}
            </p>
          )}
        </div>
      </Dialog>
      {confirming && (
        <ConfirmAction
          {...continueWithoutSecret}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onContinue();
          }}
        />
      )}
    </>
  );
}
