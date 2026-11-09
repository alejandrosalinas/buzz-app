import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { MeshStatus } from "./index";

/** Creation borrows the existing compute page's lifecycle; no setup record or runner. */
export function MeshCreateSetup({
  status,
  busy,
  disabled,
  leaseReady,
  otherCommunity,
  error,
  share,
  refresh,
}: {
  status: MeshStatus | null;
  busy: boolean;
  disabled: boolean;
  leaseReady: boolean;
  otherCommunity: boolean;
  error: string | null;
  share(): void;
  refresh(): void;
}) {
  const [choice, setChoice] = useState<"share" | "use" | null>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const phase = status?.lifecycle?.state;
  const sharing =
    !otherCommunity &&
    Boolean(status?.sharing) &&
    (phase === "ready" || phase === "starting");
  const failure =
    error ??
    status?.settingsError ??
    (phase === "failed"
      ? "Shared compute needs recovery. Open Settings → Shared compute."
      : null);
  const confirmed =
    choice === "use" || (choice === "share" && sharing && !failure);
  useEffect(() => {
    if (confirmed) confirmation.current?.focus();
  }, [confirmed]);
  // Existing sharing needs no setup; a choice made here keeps its confirmation.
  if (sharing && choice === null && !failure) return null;
  const canShare =
    status &&
    leaseReady &&
    !otherCommunity &&
    phase !== "failed" &&
    phase !== "stopping";
  return (
    <section aria-label="Set up shared compute" className="grid gap-2">
      <p className="m-0 text-body-sm text-secondary">
        Members serving your model can read the prompts and conversation history
        sent to them. In Agent mode, this includes tool output and core memory;
        their model directs tools on this computer.
      </p>
      {confirmed ? (
        <div className="grid gap-2">
          <p
            ref={confirmation}
            tabIndex={-1}
            role="status"
            className="m-0 text-body"
          >
            {choice === "use"
              ? "Using community compute. You can create your agent now."
              : phase === "ready"
                ? "This computer is sharing. You can create your agent now."
                : "Sharing is starting. Downloads continue in the background; you can create your agent now."}
          </p>
          {choice === "use" && (
            <Button
              size="sm"
              disabled={disabled || busy}
              onClick={() => setChoice(null)}
            >
              Change
            </Button>
          )}
        </div>
      ) : (
        <>
          <SettingsGroup>
            <PreferenceRow
              title="Use this computer"
              subtitle="Auto picks and downloads a model in the background. Create your agent while it starts."
              trailing={
                <Button
                  size="sm"
                  variant="primary"
                  aria-label="Start sharing with Auto"
                  disabled={disabled || busy || !canShare}
                  loading={busy}
                  onClick={() => {
                    setChoice("share");
                    share();
                  }}
                >
                  Start sharing
                </Button>
              }
            />
            <PreferenceRow
              title="Use community compute"
              subtitle="No download. Needs someone in your community to be sharing."
              trailing={
                <Button
                  size="sm"
                  aria-label="Continue without sharing"
                  disabled={disabled || busy}
                  onClick={() => setChoice("use")}
                >
                  Continue
                </Button>
              }
            />
          </SettingsGroup>
          {(busy || !status || otherCommunity) && (
            <p role="status" className="m-0 text-body-sm text-secondary">
              {busy
                ? "Starting shared compute. You can create your agent while setup continues."
                : !status
                  ? "Checking shared compute…"
                  : otherCommunity
                    ? "This computer is connected to another community. Switch communities in Settings → Shared compute to share here."
                    : "You can change sharing in Settings → Shared compute."}
            </p>
          )}
        </>
      )}
      {failure && (
        <div className="grid gap-2">
          <p role="alert" className="m-0 text-body-sm text-danger">
            {failure}
          </p>
          <Button size="sm" disabled={disabled || busy} onClick={refresh}>
            Check again
          </Button>
        </div>
      )}
    </section>
  );
}
