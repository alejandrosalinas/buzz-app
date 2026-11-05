import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import type { BuilderlabSession } from "../session";
import { useSignInProgress } from "../login/use-sign-in-progress";

/** The same compact account action beside Harness in creation and editing. */
export function SignInAction({
  session,
  disabled = false,
  automatic = false,
}: {
  session: BuilderlabSession;
  disabled?: boolean;
  automatic?: boolean;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const attempted = useRef(false);
  useEffect(() => {
    if (!automatic || attempted.current || login.checking) return;
    attempted.current = true;
    if (login.status === "signed-out" && !login.error) void session.signIn();
  }, [automatic, session, login.status, login.checking, login.error]);
  const { pending, waiting } = useSignInProgress(login);
  if (login.status === "signed-in") return null;
  return (
    <>
      <Button
        size="sm"
        variant={waiting ? "outline" : "subtle"}
        disabled={(disabled || pending) && !waiting}
        focusableWhenDisabled={pending && !waiting}
        loading={pending && !waiting}
        aria-label={waiting ? "Cancel sign-in" : "Sign in to Builderlab"}
        onClick={() => {
          if (waiting) session.cancel();
          else if (!pending) void session.signIn();
        }}
      >
        {waiting ? "Cancel sign-in" : "Sign in"}
      </Button>
      {(waiting || login.checking) && (
        <p
          role="status"
          className="m-0 basis-full text-right text-body-sm text-secondary"
        >
          {login.checking
            ? "Checking your Builderlab sign-in…"
            : "Finish signing in to Builderlab in your browser, then return to Buzz."}
        </p>
      )}
      {login.error && (
        <p
          role="alert"
          className="m-0 basis-full text-right text-body-sm text-danger"
        >
          {login.error}
        </p>
      )}
    </>
  );
}
