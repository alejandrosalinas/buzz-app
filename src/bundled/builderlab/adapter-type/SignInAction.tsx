import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CircleNotchIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import type { BuilderlabSession } from "../session";

/** The same compact account action beside Harness in creation and editing. */
export function SignInAction({
  session,
  disabled = false,
  automatic = false,
  retry,
  render,
}: {
  session: BuilderlabSession;
  disabled?: boolean;
  automatic?: boolean;
  retry?: { waiting: boolean; cancel(): void } | undefined;
  render?: (action: ReactNode, feedback: ReactNode) => ReactNode;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const attempted = useRef(false);
  useEffect(() => {
    if (!automatic || attempted.current || login.checking) return;
    attempted.current = true;
    if (login.status === "signed-out" && !login.error) void session.signIn();
  }, [automatic, session, login.status, login.checking, login.error]);
  const pending = login.status === "pending";
  const signedIn = login.status === "signed-in";
  const busy = pending || !!retry?.waiting;
  const cancellable = busy && !login.checking;
  const action = signedIn ? null : (
    <Button
      size="sm"
      variant="subtle"
      shape={busy ? "icon" : "capsule"}
      disabled={(disabled && !cancellable) || !!login.checking}
      focusableWhenDisabled={!!login.checking}
      loading={!!login.checking}
      aria-busy={busy}
      title={
        cancellable
          ? "Cancel sign-in"
          : retry
            ? "Retry"
            : "Sign in to edit settings"
      }
      aria-label={
        cancellable
          ? "Cancel sign-in"
          : retry
            ? "Retry"
            : "Sign in to Builderlab"
      }
      onClick={() => {
        if (pending && cancellable) session.cancel();
        else if (retry?.waiting) retry.cancel();
        else if (!pending) void session.signIn();
      }}
    >
      {busy ? (
        <CircleNotchIcon size={18} className="motion-safe:animate-spin" />
      ) : retry ? (
        "Retry"
      ) : (
        "Sign in"
      )}
    </Button>
  );
  const feedback =
    !signedIn && (login.checking || login.error) ? (
      <>
        {login.checking && (
          <p
            role="status"
            className="m-0 basis-full text-right text-body-sm text-secondary"
          >
            Checking your Builderlab sign-in…
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
    ) : null;
  return render ? (
    render(action, feedback)
  ) : (
    <>
      {action}
      {feedback}
    </>
  );
}
