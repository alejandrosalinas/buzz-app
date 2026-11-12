import { useCallback, useEffect, useRef, useState } from "react";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { LockIcon } from "../shared/design-system/icons";
import { ExternalIdentityAuthorization } from "./ExternalIdentityAuthorization";
import {
  listPairedTools,
  onPairingEvents,
  revokePairedTool,
  type PairedTool,
} from "../features/credential-pairing/service";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Local paired tools and authorization for applications with their own key. */
export function SecuritySettings({
  viewer,
}: {
  /** Available only when the host has a native identity. */
  viewer?: string | undefined;
}) {
  const [tools, setTools] = useState<PairedTool[] | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<PairedTool | null>(null);
  const [revoking, setRevoking] = useState(false);
  /** Why the open confirmation's revoke failed. Owned by the dialog, apart
   * from the list's read error: a `changed` refresh that succeeds or fails
   * while the dialog is open must neither clear nor replace it. */
  const [revokeError, setRevokeError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  /** The paired-tools heading: where the dialog leaves focus when no row's
   * Revoke can take it, so it never drops to body. Base UI refines a landing
   * to its first tabbable descendant, which for this whole section would be
   * the Authorize form's key field when a viewer is shown; the heading has
   * none, so focus lands on the heading itself. */
  const heading = useRef<HTMLHeadingElement>(null);
  /** Each row's Revoke, so the dialog can hand focus back to one. */
  const revokes = useRef(new Map<string, HTMLElement>());
  /** After a revoke, where the dialog leaves focus: the Revoke that takes the
   * row's place, else the previous row's, else the heading. Base UI picks the
   * target before the row leaves the DOM, so it is chosen when the revoke
   * succeeds. */
  const landing = useRef<HTMLElement | null>(null);
  const refresh = useCallback(async () => {
    try {
      setTools(await listPairedTools());
      setError("");
    } catch (reason) {
      setTools(null);
      setError(String(reason));
    }
  }, []);
  useEffect(() => {
    void refresh();
    return onPairingEvents({ changed: () => void refresh() });
  }, [refresh]);
  const dismiss = () => {
    setConfirming(null);
    setRevokeError("");
  };
  const revoke = async (tool: PairedTool) => {
    setRevoking(true);
    setRevokeError("");
    try {
      await revokePairedTool(tool.id);
      const listed = tools ?? [];
      const index = listed.findIndex((t) => t.id === tool.id);
      // A `changed` refresh may have dropped the row while the dialog was
      // open; with no place to count from, the heading is the landing.
      landing.current =
        index === -1
          ? heading.current
          : ([...listed.slice(index + 1), ...listed.slice(0, index).reverse()]
              .map((t) => revokes.current.get(t.id))
              .find(Boolean) ?? heading.current);
      setTools((current) => current?.filter((t) => t.id !== tool.id) ?? null);
      setConfirming(null);
    } catch (reason) {
      setRevokeError(String(reason));
    } finally {
      setRevoking(false);
    }
  };
  const alert = (message: string) =>
    message && (
      <p role="alert" className="text-body-sm text-danger">
        {message}
      </p>
    );
  return (
    <section aria-labelledby="security-settings-title">
      <Header
        id="security-settings-title"
        title="Security"
        subtitle="Tools paired on this device, and applications you authorize to act as you."
      />
      <InlineHeader
        ref={heading}
        tabIndex={-1}
        id="paired-tools-title"
        title="Paired command-line tools"
      />
      {alert(error)}
      {tools?.length === 0 ? (
        <EmptyState
          icon={<LockIcon />}
          title="No paired tools"
          description="Run buzz auth desktop pair in a terminal to let a command-line tool use Buzz as you."
        />
      ) : (
        tools && (
          <SettingsGroup>
            {tools.map((tool) => (
              <PreferenceRow
                key={tool.id}
                title={tool.client}
                subtitle={`${tool.relay} · Paired ${date(tool.created)} · Last used ${date(tool.lastUsed)} · Expires ${date(tool.expires)} unless used`}
                trailing={
                  <Button
                    ref={(button) => {
                      if (button) revokes.current.set(tool.id, button);
                      else revokes.current.delete(tool.id);
                    }}
                    onClick={() => {
                      landing.current = null;
                      setRevokeError("");
                      setConfirming(tool);
                    }}
                  >
                    Revoke
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
        )
      )}
      {confirming && (
        <AlertDialog
          title={`Revoke ${confirming.client}?`}
          description="It stops working until you pair it again with buzz auth desktop pair."
          pending={revoking}
          initialFocus={cancel}
          finalFocus={() =>
            // On Cancel, the row's Revoke; if a refresh removed the row while
            // the dialog was open, the heading rather than body.
            landing.current ??
            revokes.current.get(confirming.id) ??
            heading.current
          }
          onClose={dismiss}
          actions={
            <>
              <Button ref={cancel} disabled={revoking} onClick={dismiss}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={revoking}
                onClick={() => void revoke(confirming)}
              >
                Revoke
              </Button>
            </>
          }
        >
          {alert(revokeError)}
        </AlertDialog>
      )}
      {viewer && <ExternalIdentityAuthorization key={viewer} viewer={viewer} />}
    </section>
  );
}
