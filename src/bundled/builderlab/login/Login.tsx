import { useEffect, useRef, useSyncExternalStore } from "react";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import { brokerBuilderlab } from "../dev-session";
import { nativeBuilderlab, type BuilderlabSession } from "../session";

const kept = () =>
  brokerBuilderlab()
    ? "Your sign-in stays on the development server through app reloads, until you sign out or the session expires."
    : "Buzz keeps your sign-in in your system keychain until you sign out.";

export function Login({
  session,
  available,
  active,
  showHeading = true,
  cancelOnUnmount = true,
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
  openIdentity,
}: {
  session: BuilderlabSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  /** Settings owns its pending login; shared app panels only observe it. */
  cancelOnUnmount?: boolean;
  unavailableReason?: string;
  /** Opens Identity, where an FI build's shared organization sign-in ends. */
  openIdentity?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(
    () => () => {
      if (cancelOnUnmount && session.snapshot().status === "pending")
        session.abandon();
    },
    [cancelOnUnmount, session],
  );
  // A successful FI retry replaces the focused sign-in button with the
  // Identity link; focus follows only if the button still had it.
  const action = useRef(false);
  const identityLink = useRef<HTMLButtonElement>(null);
  const showsIdentity = nativeBuilderlab() && state.status === "signed-in";
  useEffect(() => {
    if (!showsIdentity || !action.current) return;
    action.current = false;
    identityLink.current?.focus();
  }, [showsIdentity]);
  const intro =
    state.status === "signed-in"
      ? kept()
      : `Connect your Builderlab account. ${kept()}`;
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      {showHeading ? (
        <Header title="Builderlab" subtitle={intro} />
      ) : (
        <p className="m-0 text-body-sm text-secondary">{intro}</p>
      )}
      {!available ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          <p role="status" className="text-body-sm text-secondary">
            {state.checking
              ? "Checking your Builderlab sign-in…"
              : state.status === "pending"
                ? "Finish sign-in in your browser, then return to Buzz."
                : state.account
                  ? state.account.email
                    ? `Signed in as ${state.account.email}.`
                    : "Signed in to Builderlab."
                  : "Sign in securely in your browser."}
          </p>
          {state.error && (
            <p role="alert" className="text-body-sm text-danger">
              {state.error}
            </p>
          )}
          {showsIdentity ? (
            // The native session is shared with community sign-in, so it
            // ends only where that sign-in is managed.
            <p className="m-0 text-body-sm text-secondary">
              Builderlab uses your organization sign-in. To sign out, go to{" "}
              {openIdentity ? (
                <Button
                  ref={identityLink}
                  variant="link"
                  size="inline"
                  onClick={() => {
                    if (active()) openIdentity();
                  }}
                >
                  Identity → Organization sign-in
                </Button>
              ) : (
                "Identity → Organization sign-in"
              )}
              .
            </p>
          ) : (
            <Button
              variant={state.status === "signed-out" ? "prominent" : "outline"}
              loading={state.checking === true}
              ref={(node) => {
                if (!node) return;
                // React detaches the ref before removing the node.
                return () => {
                  action.current = document.activeElement === node;
                };
              }}
              onClick={() => {
                if (!active()) return;
                if (state.status === "pending") session.cancel();
                else if (state.status === "signed-in") session.signOut();
                else void session.signIn();
              }}
            >
              {state.checking
                ? "Checking sign-in"
                : state.status === "pending"
                  ? "Cancel sign-in"
                  : state.status === "signed-in"
                    ? "Sign out"
                    : "Sign in with Builderlab"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
