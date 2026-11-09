import { useState, useSyncExternalStore } from "react";
import type { FederatedIdentity, SessionSnapshot } from "./service";
import type { Membership } from "../communities/service";
import { communityDestination } from "../communities/destination";
import { coveredCommunities, serverName } from "./community-servers";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { CommunityRefusal } from "../relay/http-admission";

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
  relay,
  memberships = [],
}: {
  identity?: FederatedIdentity | undefined;
  error?: string | undefined;
  retry: () => void;
  /** The refusing community, so a switch names the others it affects. */
  relay?: string | undefined;
  memberships?: readonly Membership[] | undefined;
}) {
  if (!identity) return null;
  return (
    <Action
      identity={identity}
      error={error}
      retry={retry}
      relay={relay}
      memberships={memberships}
    />
  );
}
function Action({
  identity,
  error,
  retry,
  relay,
  memberships,
}: {
  identity: FederatedIdentity;
  error?: string | undefined;
  retry: () => void;
  relay?: string | undefined;
  memberships: readonly Membership[];
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  // A switch outlives the signed-in state that offered it: sign-out ends
  // that state, so its progress and recovery are kept here.
  const [switching, setSwitching] = useState<Switching | null>(null);
  if (switching)
    return (
      <SwitchProgress
        identity={identity}
        state={state}
        switching={switching}
        onChange={setSwitching}
        retry={retry}
      />
    );
  const refusal = error || state.failure || "";
  const mismatch = /binding[-_]mismatch/.test(refusal);
  if (mismatch || /authorization[-_]denied/.test(refusal)) {
    // Without a server session to switch, only the refusal can be explained.
    if (state.status !== "signed-in" || !state.authority)
      return (
        <p role="alert" className="text-body-sm text-danger">
          {mismatch
            ? "This account is linked to a different Buzz identity. Keep this key until you have reviewed the identity link."
            : "Your account does not have access to this community. Contact its administrator."}
        </p>
      );
    return (
      <SwitchAccount
        state={state}
        authority={state.authority}
        mismatch={mismatch}
        others={othersAffected(state.authority, relay, memberships)}
        onSwitch={(authority) =>
          setSwitching(
            runSwitch(identity, authority, "sign-out", setSwitching, retry),
          )
        }
      />
    );
  }
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
      <p className="text-body-sm">
        This community requires {serverName(state.authority)} sign-in.
      </p>
      <SignInButton identity={identity} state={state} retry={retry} />
    </>
  );
}

/** Sign in (or cancel one in progress), then retry what was refused. Its
 * own failure, or the session's, shows beneath it. */
function SignInButton({
  identity,
  state,
  retry,
}: {
  identity: FederatedIdentity;
  state: SessionSnapshot;
  retry: () => void;
}) {
  const [failure, setFailure] = useState("");
  if (!state.authority) return null;
  const server = serverName(state.authority);
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
        {state.status === "signing-in"
          ? "Cancel sign-in"
          : `Sign in with ${server}`}
      </Button>
      {(failure || state.failure) && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(failure || state.failure || "")}
        </p>
      )}
    </>
  );
}

/** The other joined communities a switch on this server also signs out of. */
function othersAffected(
  authority: NonNullable<SessionSnapshot["authority"]>,
  relay: string | undefined,
  memberships: readonly Membership[],
) {
  const self = relay && communityDestination(relay).url;
  return coveredCommunities(
    authority.communityHosts,
    memberships.filter(
      (membership) => communityDestination(membership.id).url !== self,
    ),
  );
}

/** A community refused the signed-in account: sign out of its server only
 * and sign in again, then retry. Other servers' sessions are untouched. */
function SwitchAccount({
  state,
  authority,
  mismatch,
  others,
  onSwitch,
}: {
  state: SessionSnapshot;
  authority: Authority;
  mismatch: boolean;
  others: readonly string[];
  onSwitch: (authority: Authority) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const server = serverName(authority);
  const account = state.email ?? "your organization account";
  return (
    <>
      <p role="alert" className="text-body-sm text-danger">
        {mismatch
          ? `Your ${server} account (signed in as ${account}) is linked to a different Buzz identity. Keep this key until you have reviewed the link at ${new URL(authority.identityOrigin).host}, or switch to another ${server} account.`
          : `This community didn’t accept your ${server} account (signed in as ${account}).`}
      </p>
      {others.length > 0 && (
        <p className="text-body-sm">
          Switching accounts also affects: {others.join(", ")}.
        </p>
      )}
      <Button onClick={() => onSwitch(authority)}>Switch account</Button>
      {/* Closes the prompt; the session and the refusal stay as they are. */}
      <Button onClick={() => setDismissed(true)}>Not now</Button>
    </>
  );
}

type Authority = NonNullable<SessionSnapshot["authority"]>;
/** A switch on one server: the step it is on, and whether that step
 * finished without succeeding (with its recovery code, possibly empty). */
type Switching = Readonly<{
  authority: Authority;
  step: "sign-out" | "sign-in";
  failed: boolean;
  failure: string;
}>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Sign-in unavailable";

/** Runs the switch from `step`: signs out of this server only, then in
 * again. Sign-in starts only after a sign-out native finished, so a retry
 * never renews the old account; only a signed-in result retries admission.
 * Any other outcome, thrown or not, fails the step it happened in. */
function runSwitch(
  identity: FederatedIdentity,
  authority: Authority,
  step: Switching["step"],
  report: (next: Switching | null) => void,
  retry: () => void,
): Switching {
  const fail = (at: Switching["step"], failure: string) =>
    report({ authority, step: at, failed: true, failure });
  const signIn = () => {
    report({ authority, step: "sign-in", failed: false, failure: "" });
    void identity
      .signIn()
      .then((next) => {
        // Native ends a canceled sign-in signed out with no failure code.
        if (next.status !== "signed-in")
          return fail(
            "sign-in",
            next.failure ??
              (next.status === "signed-out" ? "sign-in-canceled" : ""),
          );
        report(null);
        retry();
      })
      .catch((error: unknown) => fail("sign-in", message(error)));
  };
  if (step === "sign-in") signIn();
  else
    void identity
      .signOut()
      .then((after) => {
        if (after.status === "unavailable" || after.status === "signed-in")
          return fail("sign-out", after.failure ?? "");
        signIn();
      })
      .catch((error: unknown) => fail("sign-out", message(error)));
  return { authority, step, failed: false, failure: "" };
}

function SwitchProgress({
  identity,
  state,
  switching: { authority, step, failed, failure },
  onChange,
  retry,
}: {
  identity: FederatedIdentity;
  state: SessionSnapshot;
  switching: Switching;
  onChange: (next: Switching | null) => void;
  retry: () => void;
}) {
  const server = serverName(authority);
  if (failed) {
    // Canceling is not a failure: the account is signed out, so offer Sign in.
    const canceled = failure === "sign-in-canceled";
    return (
      <>
        {canceled ? (
          <p role="status" className="text-body-sm">
            {recoveryMessage(failure)}
          </p>
        ) : (
          <p role="alert" className="text-body-sm text-danger">
            {`Couldn’t switch your ${server} account. ${recoveryMessage(failure)}`}
          </p>
        )}
        <Button
          onClick={() =>
            onChange(runSwitch(identity, authority, step, onChange, retry))
          }
        >
          {canceled ? "Sign in" : "Try again"}
        </Button>
      </>
    );
  }
  return (
    <>
      <p role="status" className="text-body-sm">
        {`Switching your ${server} account…`}
      </p>
      {state.status === "signing-in" && (
        <Button
          onClick={() =>
            void identity.cancelSignIn().catch((error: unknown) =>
              onChange({
                authority,
                step,
                failed: true,
                failure: message(error),
              }),
            )
          }
        >
          Cancel sign-in
        </Button>
      )}
    </>
  );
}

const noSubscription = () => () => {};
const NO_ACCESS = "You don’t have access to this community";
const SIGN_IN = "Sign in to open this community";
/** What a page that the refusal left empty says; its notice says what fixes it. */
export const communityRefusalTitle = (refusal?: CommunityRefusal) =>
  refusal === "sign-in" ? SIGN_IN : NO_ACCESS;

/** The one report of a community's refusal, in the toast stack on every page.
 * The relay's reason and this device's sign-in for the community decide what
 * it offers; Check again only where someone else (an admin) can fix it. */
export function CommunityRefusalNotice({
  refusal,
  identity,
  retry,
  relay,
  memberships = [],
}: {
  refusal: CommunityRefusal;
  /** The sign-in session of the refusing community's own server. */
  identity?: FederatedIdentity | undefined;
  retry: () => void;
  relay?: string | undefined;
  memberships?: readonly Membership[] | undefined;
}) {
  const state = useSyncExternalStore(
    identity?.subscribe ?? noSubscription,
    () => identity?.snapshot(),
    () => identity?.snapshot(),
  );
  // As in `Action`: sign-out ends the state that offered the switch.
  const [switching, setSwitching] = useState<Switching | null>(null);
  const authority = state?.authority;
  const checkAgain = <Button onClick={retry}>Check again</Button>;
  if (!identity || !state || !authority)
    return refusal === "sign-in" ? (
      <ToastNotice
        title="This community needs a sign-in Buzz doesn’t support yet"
        description="Ask the community’s admin which Buzz version or server to use."
      />
    ) : (
      <ToastNotice
        title={NO_ACCESS}
        description="Ask the community’s admin to add you."
      >
        {checkAgain}
      </ToastNotice>
    );
  const server = serverName(authority);
  const signedIn = state.status === "signed-in";
  // A switch signs out first, so its progress and recovery come before the
  // signed-out answer.
  if (refusal === "access" && !signedIn && !switching)
    return (
      <ToastNotice
        title={NO_ACCESS}
        description="Ask the community’s admin to add you."
      >
        {checkAgain}
      </ToastNotice>
    );
  // Signing in again where Buzz still holds the refused session, or as
  // another account, both sign out of this server first.
  const others = othersAffected(authority, relay, memberships);
  const action = switching ? (
    <SwitchProgress
      identity={identity}
      state={state}
      switching={switching}
      onChange={setSwitching}
      retry={retry}
    />
  ) : refusal === "sign-in" && !signedIn ? (
    <SignInButton identity={identity} state={state} retry={retry} />
  ) : (
    <>
      {others.length > 0 && (
        <p className="text-body-sm">
          {`This also signs you out of: ${others.join(", ")}.`}
        </p>
      )}
      <Button
        onClick={() =>
          setSwitching(
            runSwitch(identity, authority, "sign-out", setSwitching, retry),
          )
        }
      >
        {refusal === "sign-in" ? "Sign in again" : "Switch account"}
      </Button>
      {refusal === "access" && checkAgain}
    </>
  );
  return refusal === "sign-in" ? (
    <ToastNotice
      title={SIGN_IN}
      description={`This community needs your ${server} sign-in.`}
    >
      {action}
    </ToastNotice>
  ) : (
    <ToastNotice
      title={NO_ACCESS}
      description={`This community didn’t accept ${state.email ?? `your ${server} account`}.`}
    >
      {action}
    </ToastNotice>
  );
}
