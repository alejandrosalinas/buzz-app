import { useEffect, useRef, useSyncExternalStore } from "react";
import { ManagementFacts } from "../ManagementSection";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import { InfoIcon } from "../../../shared/design-system/icons";
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
  notice = false,
}: {
  session: BuilderlabSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  /** Settings owns its pending login; shared app panels only observe it. */
  cancelOnUnmount?: boolean;
  unavailableReason?: string;
  /** Opens Identity, where the shared provider account is managed. */
  openIdentity?: (() => void) | undefined;
  /** A small Settings hint without account fields; actions keep their owner. */
  notice?: boolean;
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
  const provider = session.providerName ?? "Builderlab";
  const actionBesideEmail =
    !showHeading && state.status === "signed-in" && !showsIdentity;
  useEffect(() => {
    if (!showsIdentity || !action.current) return;
    action.current = false;
    identityLink.current?.focus();
  }, [showsIdentity]);
  const intro =
    state.status === "signed-in"
      ? kept()
      : `Connect your Builderlab account. ${kept()}`;
  const accountAction = showsIdentity ? (
    // The native session is shared with community sign-in, so it
    // ends only where that sign-in is managed.
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-body-sm text-secondary">
      <span>Uses your {provider} sign-in.</span>
      {openIdentity ? (
        <Button
          ref={identityLink}
          variant="link"
          size="text"
          onClick={() => {
            if (active()) openIdentity();
          }}
        >
          Manage account
        </Button>
      ) : (
        "Manage account in Identity"
      )}
    </p>
  ) : (
    <Button
      variant={
        notice
          ? "link"
          : state.status === "signed-out"
            ? "prominent"
            : "outline"
      }
      size={notice ? "text" : "md"}
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
            : `Sign in with ${provider}`}
    </Button>
  );
  if (notice)
    return (
      <div className="flex flex-col items-start gap-2">
        <div
          role="note"
          className="flex items-center gap-2 text-body-sm text-secondary"
        >
          <InfoIcon size={16} className="shrink-0" aria-hidden="true" />
          {!available ? (
            <span role="status">{unavailableReason}</span>
          ) : showsIdentity ? (
            accountAction
          ) : (
            <span>
              {state.status === "signed-in" && "Signed in to Builderlab. "}
              {accountAction}
            </span>
          )}
        </div>
        {available && state.status === "pending" && !state.checking && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            Finish sign-in in your browser, then return to Buzz.
          </p>
        )}
        {available && state.error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    );
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      {showHeading ? (
        <Header title="Builderlab" subtitle={intro} />
      ) : state.status === "signed-in" ? (
        <ManagementFacts
          items={[
            {
              label: "Email",
              value: state.account?.email || "—",
              action:
                available && actionBesideEmail ? accountAction : undefined,
            },
          ]}
        />
      ) : null}
      {!available ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          {(showHeading || state.status !== "signed-in") && (
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
          )}
          {state.error && (
            <p role="alert" className="text-body-sm text-danger">
              {state.error}
            </p>
          )}
          {!actionBesideEmail && accountAction}
        </>
      )}
    </div>
  );
}
