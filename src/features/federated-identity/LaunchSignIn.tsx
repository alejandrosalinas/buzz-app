import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import {
  launchVisible,
  setLaunchReady,
  subscribeLaunch,
} from "../../app/launch";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import styles from "../identity/IdentitySetup.module.css";
import { recoveryMessage } from "./CommunitySignIn";
import type { FederatedIdentity, SessionSnapshot } from "./service";

/** Failures that mean this desktop has no native session owner at all. */
const NO_HOST = new Set(["desktop-required", "native-unavailable"]);

function needsSignIn(state: SessionSnapshot) {
  return (
    state.status === "signed-out" ||
    state.status === "signing-in" ||
    state.status === "reauthentication-required" ||
    (state.status === "unavailable" && !NO_HOST.has(state.failure ?? ""))
  );
}

/**
 * Builds whose descriptor says `signIn: "at-launch"` sign in to the
 * organization before the app opens, and again whenever the session ends.
 * Other builds render `children` unchanged and sign in on demand.
 */
export function LaunchSignIn({
  identity,
  children,
}: {
  identity: FederatedIdentity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  // Native sends the build's sign-in policy with its first state, and it
  // never changes during a run. Until then nothing renders: the launch mark
  // stays up, and the app mounts once, under the right policy.
  const unknown =
    identity.apiAvailable && state.status === "restoring" && !state.authority;
  const required =
    identity.apiAvailable && state.authority?.signIn === "at-launch";
  // "Not now" lasts until a session is established; a later end asks again.
  const [dismissed, setDismissed] = useState(false);
  // Once asked, the screen stays up while Try again checks the saved sign-in.
  const [asked, setAsked] = useState(false);
  if ((dismissed || asked) && state.status === "signed-in") {
    setDismissed(false);
    setAsked(false);
  }
  const showing =
    required &&
    !dismissed &&
    (needsSignIn(state) || (asked && state.status === "restoring"));
  if (showing && !asked) setAsked(true);
  // The app mounts once, after launch settles, and then stays mounted (covered
  // and inert) under a later sign-in, so drafts, scroll and navigation survive.
  const [opened, setOpened] = useState(false);
  const settled = !showing && state.status !== "restoring";
  if (required && !opened && settled) setOpened(true);

  // Start the browser sign-in only when this screen is why it opens: the
  // first settled state of the run, and a session ending. Never after a
  // cancel, a failure or a sign-out, which leave the choice to the person.
  // Until native reports the attempt, the screen already says it is signing in.
  const previous = useRef<SessionSnapshot["status"] | null>(null);
  const [starting, setStarting] = useState<SessionSnapshot["status"] | null>(
    null,
  );
  if (starting && state.status !== starting) setStarting(null);
  useLayoutEffect(() => {
    const from = previous.current;
    if (state.status === "restoring") return;
    previous.current = state.status;
    if (!required || dismissed) return;
    const launch =
      from === null &&
      (state.status === "signed-out" ||
        state.status === "reauthentication-required");
    const ended =
      from === "signed-in" && state.status === "reauthentication-required";
    if (!launch && !ended) return;
    setStarting(state.status);
    void identity
      .signIn()
      .catch(() => {})
      .finally(() => setStarting(null));
  }, [identity, required, dismissed, state.status]);

  // The launch mark covers the window until something is ready to show.
  useEffect(() => {
    if (showing && launchVisible()) setLaunchReady(true);
  }, [showing]);

  // Return focus to where it was in the app when a session ends mid-run,
  // including the app's portaled dialogs. Layout timing stops listening
  // before the sign-in screen takes focus.
  const focus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (showing) return;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focus.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [showing]);
  useLayoutEffect(() => {
    if (!showing && focus.current?.isConnected) focus.current.focus();
  }, [showing]);

  if (unknown) return null;
  if (!required) return children;
  return (
    <>
      {showing &&
        (opened ? (
          // Mid-run, the app may have dialogs and menus open in portals.
          <TopLayer>
            <SignInScreen
              identity={identity}
              state={state}
              starting={!!starting}
              dismiss={() => setDismissed(true)}
            />
          </TopLayer>
        ) : (
          <SignInScreen
            identity={identity}
            state={state}
            starting={!!starting}
            dismiss={() => setDismissed(true)}
          />
        ))}
      {opened && (
        // Covered rather than `hidden`: display none would drop scroll offsets.
        <div
          className="contents"
          inert={showing}
          style={showing ? { visibility: "hidden" } : undefined}
        >
          {children}
        </div>
      )}
    </>
  );
}

/**
 * In `at-launch` builds, warns while the organization session nears its end
 * and lets the person sign in again without leaving the app. If they don't,
 * LaunchSignIn takes over the window when it ends.
 */
export function SignInEnding({ identity }: { identity: FederatedIdentity }) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [renewing, setRenewing] = useState(false);
  // Only this notice's own attempt, for the session it was made in; the
  // snapshot's failure can come from a community refusing access.
  const [attempt, setAttempt] = useState({ revision: "", failure: "" });
  const failure = attempt.revision === state.revision ? attempt.failure : "";
  if (
    !identity.apiAvailable ||
    state.authority?.signIn !== "at-launch" ||
    state.status !== "signed-in" ||
    !state.expiring ||
    !state.expiresAt
  )
    return null;
  const name = state.authority.organization ?? "organization";
  const ends = new Date(state.expiresAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <ToastNotice
      tone="warning"
      title={`Your ${name} sign-in ends ${ends}`}
      description={
        renewing
          ? "Finish signing in in your browser."
          : failure
            ? recoveryMessage(failure)
            : "Sign in again to keep Buzz open."
      }
    >
      {renewing ? (
        <Button size="sm" onClick={() => void identity.cancelSignIn()}>
          Cancel
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            const { revision } = state;
            setRenewing(true);
            setAttempt({ revision, failure: "" });
            void identity
              .signIn()
              .catch((error: unknown) =>
                setAttempt({
                  revision,
                  failure:
                    error instanceof Error ? error.message : "sign-in-failed",
                }),
              )
              .finally(() => setRenewing(false));
          }}
        >
          Sign in again
        </Button>
      )}
    </ToastNotice>
  );
}

/**
 * A modal native dialog sits in the browser's top layer, above anything the
 * app has open, and makes the rest of the window inert until it closes. It
 * mounts beside the app root, so a modal the app already had open does not
 * hide it from assistive technology.
 */
function TopLayer({ children }: { children: ReactNode }) {
  // Content mounts once the dialog is open, so its autofocus can land.
  const [shown, setShown] = useState(false);
  const open = useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog) return;
    // The app's shortcuts listen on the window; keep them from acting behind.
    const contain = (event: KeyboardEvent) => event.stopPropagation();
    dialog.addEventListener("keydown", contain);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    setShown(true);
    return () => dialog.removeEventListener("keydown", contain);
  }, []);
  return createPortal(
    <dialog
      ref={open}
      aria-labelledby="launch-sign-in-title"
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-auto border-0 bg-transparent p-0 backdrop:bg-transparent"
      // Escape can't dismiss it; the screen offers its own way out.
      onCancel={(event) => event.preventDefault()}
      onClose={(event) => event.currentTarget.showModal?.()}
    >
      {shown && children}
    </dialog>,
    document.body,
  );
}

function SignInScreen({
  identity,
  state,
  starting,
  dismiss,
}: {
  identity: FederatedIdentity;
  state: SessionSnapshot;
  starting: boolean;
  dismiss(): void;
}) {
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  // At launch the window is inert under the launch mark, where autofocus
  // can't land; focus the primary action once the mark leaves.
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => subscribeLaunch(() => primary.current?.focus()), []);
  const organization = state.authority?.organization ?? null;
  const name = organization ?? "your organization";
  const communities = organization
    ? `${organization}’s communities`
    : "your organization’s communities";
  const signingIn = starting || state.status === "signing-in";
  const checking = !signingIn && state.status === "restoring";
  const unreachable = state.status === "unavailable";
  const ended = state.status === "reauthentication-required";
  const stored = unreachable && !!state.failure?.startsWith("storage-");
  // Code-only failures; the description already covers expiry and the network.
  const problem =
    failure ||
    (state.failure &&
    !signingIn &&
    !unreachable &&
    state.failure !== "reauthentication-required"
      ? state.failure
      : "");
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    setCopied(false);
    void operation().catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : "sign-in-failed"),
    );
  }
  const title =
    signingIn || checking
      ? `Signing you in to ${name}`
      : stored
        ? "Couldn’t open your saved sign-in"
        : unreachable
          ? `Couldn’t reach ${name} sign-in`
          : ended
            ? `Sign in to ${name} again`
            : `Sign in to ${name}`;
  const description = checking
    ? "Checking your sign-in…"
    : signingIn
      ? "Finish signing in in your browser. Buzz opens as soon as you’re done."
      : stored
        ? recoveryMessage(state.failure ?? "")
        : unreachable
          ? "Check your connection, then try again."
          : ended
            ? `Your sign-in has ended. Sign in again to keep using ${communities}.`
            : `Buzz uses your ${organization ? `${organization} ` : ""}account to open ${communities}.`;
  return (
    <OnboardingScreen
      labelledBy="launch-sign-in-title"
      intro={
        <>
          <h1 id="launch-sign-in-title" className="text-heading">
            {title}
          </h1>
          <p className={styles.tagline}>{description}</p>
        </>
      }
    >
      {problem && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(problem)}
        </p>
      )}
      {copied && signingIn && (
        <p role="status" className="text-body-sm">
          Sign-in link copied. Paste it into your browser.
        </p>
      )}
      {signingIn ? (
        <>
          <p role="status" className="sr-only">
            Waiting for you to finish signing in.
          </p>
          <Button
            ref={primary}
            // Reopening passes through signed out; keep focus on the way back.
            autoFocus
            size="lg"
            variant="subtle"
            onClick={() =>
              run(async () => {
                await identity.cancelSignIn();
                await identity.signIn();
              })
            }
          >
            Open the sign-in page again
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() =>
              run(async () => {
                try {
                  const link = await identity.signInLink();
                  if (!link) throw new Error();
                  await writeClipboardText(link);
                } catch {
                  throw new Error("sign-in-link-unavailable");
                }
                setCopied(true);
              })
            }
          >
            Copy sign-in link
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() => run(() => identity.cancelSignIn())}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button
            ref={primary}
            autoFocus
            size="lg"
            variant="prominent"
            // No way out while it checks: the attempt may go on to open
            // the browser.
            loading={checking}
            onClick={() => run(() => identity.signIn())}
          >
            {unreachable || checking
              ? "Try again"
              : organization
                ? `Sign in with ${organization}`
                : "Sign in"}
          </Button>
          {!checking && (
            <Button size="lg" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          )}
        </>
      )}
    </OnboardingScreen>
  );
}
