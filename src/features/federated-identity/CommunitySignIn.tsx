import { useState, useSyncExternalStore } from "react";
import type { FederatedIdentity } from "./service";
import { Button } from "../../shared/design-system/ui/Button";

/** Native's rejection when the browser step outlasts its wait (`oauth_callback::TIMED_OUT`). */
export const SIGN_IN_TIMED_OUT = "Sign-in timed out. Try again.";

export function recoveryMessage(code: string) {
  if (code === "sign-in-timed-out") return SIGN_IN_TIMED_OUT;
  if (code === "storage-busy")
    return "Secure storage is busy. Close another Buzz instance and try again.";
  if (code.startsWith("storage-"))
    return "Sign-in could not access secure storage. Check your system’s credential permissions and try again.";
  if (code === "sign-in-canceled")
    return "Sign-in was canceled. Sign in when you’re ready.";
  if (code === "reauthentication-required")
    return "Your sign-in has expired. Sign in again to continue.";
  return "Sign-in did not finish. Try again.";
}

/** Issuer refusals native keeps for the session revision (`refused()` in
 * assertion.rs) until the app restarts; signing in or retrying repeats them. */
const ISSUER_REFUSALS = new Set([
  "adapter-refused",
  "grant-refused",
  "invalid-assertion",
  "invalid-proof",
  "invalid-response",
  "response-too-large",
]);

/** Explicit recovery from native protected-community admission; never automatic login. */
export function CommunitySignIn({
  identity,
  error,
  retry,
}: {
  identity?: FederatedIdentity | undefined;
  error?: string | undefined;
  retry: () => void;
}) {
  if (!identity) return null;
  return <Action identity={identity} error={error} retry={retry} />;
}
function Action({
  identity,
  error,
  retry,
}: {
  identity: FederatedIdentity;
  error?: string | undefined;
  retry: () => void;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const refusal = error || state.failure || "";
  if (/binding[-_]mismatch/.test(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        This account is linked to a different Buzz identity. Open Settings →
        Builderlab hosting to review the existing identity link. Keep this key
        until you have reviewed the link.
      </p>
    );
  if (/authorization[-_]denied/.test(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        Your account does not have access to this community. Contact its
        administrator.
      </p>
    );
  if (ISSUER_REFUSALS.has(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        Buzz couldn’t confirm your organization sign-in for this community.
        Restart Buzz to try again. If it keeps happening, contact your
        administrator.
      </p>
    );
  if (
    !error ||
    !/Federated sign-in is required|reauthentication-required|Federated authorization (changed|expired)/.test(
      error,
    ) ||
    !state.authority
  )
    return null;
  if (state.status === "signed-in") return null;
  return (
    <>
      <Button
        onClick={() => {
          setFailure("");
          const operation =
            state.status === "signing-in"
              ? identity.cancelSignIn()
              : identity.signIn().then((next) => {
                  if (next.status === "signed-in") retry();
                });
          void operation.catch((error: unknown) =>
            setFailure(
              error instanceof Error ? error.message : "Sign-in unavailable",
            ),
          );
        }}
      >
        {state.status === "signing-in" ? "Cancel sign-in" : "Sign in"}
      </Button>
      {(failure || state.failure) && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(failure || state.failure || "")}
        </p>
      )}
    </>
  );
}
