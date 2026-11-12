import { invoke } from "@tauri-apps/api/core";
import { OnboardingBack } from "./OnboardingBack";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { launchVisible, setLaunchReady } from "../../app/launch";
import { onboardingTransition } from "./onboarding-transition";
import { npubEncode } from "nostr-tools/nip19";
import {
  createFirstRunLogin,
  firstRunCredential,
  releaseFirstRunSession,
  type FirstRunIdentity,
} from "../../bundled/builderlab/oauth/first-run";
import type { Credential } from "../../bundled/builderlab/session";
import { communityDestination } from "../communities/destination";
import { accountConsents } from "../communities/account-consent";
import { FindCommunity, type JoinConsent } from "../communities/FindCommunity";
import type { FoundCommunity } from "../communities/find-community";
import type { createInviteIntent } from "../communities/invite-intent";
import {
  type Admission,
  admitCommunity,
  CLAIM_REFUSALS,
  completeJoin,
  type Current,
} from "../communities/join";
import { createJoinJournal, JournalError } from "../communities/join-journal";
import type { Communities, PersonalProfile } from "../communities/service";
import { SIGN_IN_TIMED_OUT } from "../federated-identity/CommunitySignIn";
import type { SignInOptions } from "../federated-identity/service";
import { readErrorKind } from "../relay/errors";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { BackupError } from "./backup";
import { BackupConsent } from "./BackupConsent";
import {
  atPublicBuilderlab,
  hostedByThisBuilderlab,
} from "./builderlab-hosted";
import {
  signInServers,
  type SessionSnapshot,
} from "../federated-identity/service";
import {
  type CommunityList,
  federatedBuilderlabAccount,
  type FirstRunAccount,
  type OwnedCommunity,
  seededAccount,
} from "./builderlab-account";
import { CommunityUrlField } from "./CommunityUrlField";
import { ConnectChoice } from "./ConnectChoice";
import { CreateCommunityStep } from "./CreateCommunityStep";
import { InviteCodeField } from "./InviteCodeField";
import styles from "./IdentitySetup.module.css";
import { parseFirstRunAccountSeed } from "./first-run-seed";
import { JoinCommunity } from "./JoinCommunity";
import { KeyImport } from "./KeyImport";
import { KeyLost } from "./KeyLost";
import { KeyRestore } from "./KeyRestore";
import { LinkedKeyCheck, useSession } from "./LinkedKeyCheck";
import { useLegacyIdentityOffer } from "./LegacyIdentityOffer";
import { OnboardingScreen } from "./OnboardingScreen";
import { OnboardingWordmark } from "./OnboardingWordmark";
import { ProfileStep } from "./ProfileStep";
import { PublicKeyPanel } from "./PublicKeyPanel";
import type { Restored } from "./restore-communities";
import {
  type Identity,
  MALFORMED_IDENTITY,
  nativeIdentityEnabled,
} from "./service";
import {
  adoptLinkedLegacy,
  backUp,
  boundElsewhere,
  checkAccount,
  checkBackup,
  checkCreation,
  createKey,
  createSetup,
  findCommunities,
  importKey,
  keepBackup,
  keyForAccount,
  linkKey,
  type Resting,
  restoreCommunities,
  type SetupPause,
  type SetupStep,
  unlinkKey,
} from "./setup";
import { SetupProgress } from "./SetupProgress";
import { PrivateKey } from "./PrivateKey";
import { signOutFailure } from "./SignOut";
import {
  onSignInRequest,
  requestSignInAfterRestart,
  takeExpectedKey,
  takeSignInRequest,
} from "./sign-in-requests";
import { WelcomeBack } from "./WelcomeBack";
import { WireframeScreen } from "./Wireframe";

/** How long a replaced key's sign-out may take to restart Buzz before setup says so. */
const RESTART_WAIT_MS = 30_000;
/** The sign-in after Replace's restart reached an account other than the one it replaced the key for. */
const WRONG_ACCOUNT =
  "You signed in to a different Builderlab account than the one whose key Buzz restarted to restore. Use a different account to sign in to that one.";

/**
 * The signed-in account: the development seed when a dev server set one
 * (production builds define it empty), else kgoose through the same NIP-FI
 * forwarder the sign-in used, and the identity's native uploader.
 */
const firstRunAccount = (
  credential: Credential,
  identity: Identity,
  federated: FirstRunIdentity,
) => {
  const seed = parseFirstRunAccountSeed(
    import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT,
  );
  return seed
    ? seededAccount(seed, identity)
    : federatedBuilderlabAccount(credential, federated, identity);
};

/**
 * First-launch gate: renders children once a human key exists on this device,
 * except while first-run setup is in progress, which creates that key midway.
 */
export function Welcome({
  identity,
  communities,
  invites,
  children,
  federatedIdentity,
  connect = federatedIdentity &&
    ((signal, options) =>
      firstRunCredential(signal, federatedIdentity, options)),
  // Only the default `connect`, which needs `federatedIdentity`, signs in
  // without an `account`.
  account = (credential, identity) =>
    firstRunAccount(
      credential,
      identity,
      federatedIdentity as FirstRunIdentity,
    ),
  servers = signInServers,
}: {
  identity: Identity;
  /**
   * The live startup service: joining through it is what selects the
   * community, and once the gate lifts its memberships decide a missing
   * backup choice.
   */
  communities: Pick<
    Communities,
    "snapshot" | "subscribe" | "joined" | "select"
  >;
  /**
   * The app's invite intent: a typed address the restore did not admit is
   * handed to the rail's Add-a-community dialog as the gate lifts.
   */
  invites: Pick<ReturnType<typeof createInviteIntent>, "open">;
  children: ReactNode;
  /**
   * The NIP-FI session as the bundled Builderlab plugin calls it
   * (`bundledFederatedIdentity`): sign-in and the account's calls go through
   * it. A build without a Builderlab sign-in server has none, and first run
   * offers no Builderlab sign-in.
   */
  federatedIdentity?: FirstRunIdentity | undefined;
  /** Builderlab sign-in; without it, first run offers none. */
  connect?:
    | ((signal: AbortSignal, options: SignInOptions) => Promise<Credential>)
    | undefined;
  /** The account for a credential `connect` returned. */
  account?:
    | ((credential: Credential, identity: Identity) => FirstRunAccount)
    | undefined;
  /** The build's sign-in servers, for whether its Builderlab hosts a URL. */
  servers?: () => Promise<readonly SessionSnapshot[]>;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  // Whether the next sign-in opens the sign-up screen: set by the landing's
  // Create account and taken by the sign-in it starts. A restart or a later
  // sign-in usually follows the sign-up, so it signs in.
  const signup = useRef(false);
  // Whether sign-ins ask the browser for credentials over its session, which
  // would finish them as the account just left: armed by Use a different
  // account, kept by every restart, cleared once one completes.
  const switching = useRef(false);
  const [login] = useState(() =>
    createFirstRunLogin(
      (signal) => {
        const create = signup.current;
        signup.current = false;
        return connect
          ? connect(signal, { signup: create, forceLogin: switching.current })
          : Promise.reject(
              new Error("This Buzz build has no Builderlab sign-in."),
            );
      },
      federatedIdentity &&
        ((held) => releaseFirstRunSession(federatedIdentity, held.revision)),
    ),
  );
  // Counts canceled sign-ins: a sign-in continues only if none was canceled
  // since it started, since the session may by then hold a later sign-in.
  const cancels = useRef(0);
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  const [setup] = useState(createSetup);
  // A key on this device opens the app; LinkedKeyCheck checks it against the
  // account from there. Only a failed setup's Use a different account, with a
  // key already saved, returns to the landing instead, for this session.
  const [leftSetup, setLeftSetup] = useState(false);
  const session = useSession(federatedIdentity);
  // Whether the key Replace would sign out has a confirmed backup.
  const [replacingBackedUp, setReplacingBackedUp] = useState(false);
  // Whether that key, with no confirmed backup, was revealed or copied and the
  // user says they have it, as Settings' Remove from device asks: until then
  // Replace would lose it, so it waits.
  const [replacingKeyKept, setReplacingKeyKept] = useState(false);
  const [replacingHaveKey, setReplacingHaveKey] = useState(false);
  // The unreadable saved key's removal: asking, then its native refusal.
  const [removingKey, setRemovingKey] = useState<{
    pending: boolean;
    error?: string;
  }>();
  const progress = useSyncExternalStore(setup.subscribe, setup.snapshot);
  // The signed-in account's reads, from sign-in until the landing is shown again.
  const reads = useRef<FirstRunAccount | undefined>(undefined);
  // The hex key the account check found bound to the account: the returning-
  // user lane. Cleared by Start over and on the landing.
  const [linked, setLinked] = useState<string>();
  const [switchError, setSwitchError] = useState<string>();
  // The communities that key owns; `undefined` until found, or when the list failed.
  const [owned, setOwned] = useState<readonly OwnedCommunity[]>();
  // The destinations saved to the account, read with the account check and
  // restored as every lane ends; `undefined` until read, or when the list
  // failed. The account's, not a key's, so it lives as long as `reads`: Start
  // over keeps it and the landing clears it.
  const known = useRef<readonly string[] | undefined>(undefined);
  // Backup status belongs to this signed-in account and is cleared on the landing.
  const [backups, setBackups] = useState<readonly string[]>();
  // The backup lookup failed, so a backup may hold the linked key.
  const [backupUnknown, setBackupUnknown] = useState(false);
  // The community list that lets Join a community offer Create a community
  // (`checkCreation`), and whether its page is shown; both cleared on the landing.
  const [creatable, setCreatable] = useState<CommunityList>();
  const [creating, setCreating] = useState(false);

  // The typed address survives a round trip to the find page and back.
  const [entered, setEntered] = useState("");
  const [otherOptions, setOtherOptions] = useState(false);
  const returningFromOptions = useRef(false);
  // The canonical origin the user asked to join: before sign-in it drives the
  // discovery lookup; after setup, the Join Community page. Cleared on every
  // return to the landing or choices page.
  const [finding, setFinding] = useState<string>();
  // Counts hosted-server lookups for a found community; a lookup's answer
  // applies only while it is the latest (see FindCommunity's onFound).
  const lookups = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new address, or unmount, retires the lookup.
  useEffect(
    () => () => {
      lookups.current++;
    },
    [finding],
  );
  // The code of the invite link `finding` came from, claimed on Join; "" for
  // a bare address. Every submit sets it with `finding`.
  const [inviteCode, setInviteCode] = useState("");
  // Whether `finding` joins without Join Community: the community just
  // created, or one the signed-in account already consented to
  // (`accountConsents`). Every submit sets it with `finding`; Back from a
  // failed join clears it.
  const [joinAtOnce, setJoinAtOnce] = useState(false);
  const [joinError, setJoinError] = useState<{
    title: string;
    error: string;
    /** Set when the relay refused the key: the page takes a code and offers Try again. */
    denied?: Denied;
    /** Why the relay refused the code the join claimed. */
    codeError?: string | undefined;
    /** Admission already succeeded; retry only local completion. */
    admitted?: ProfileStepState;
  }>();
  const [retrying, setRetrying] = useState<"read" | "code">();
  // Set for a user with no profile yet once the relay admits the key; the
  // gate lifts when it exits.
  const [profileStep, setProfileStep] = useState<ProfileStepState>();
  const viewer = state.status === "ready" ? state.viewer : undefined;
  // A key on this device on the landing a failed setup left to.
  const keyLanding = !!viewer && leftSetup;
  const inApp =
    state.status === "ready" && progress.status === "idle" && !keyLanding;
  // The launch mark covers the window until something is ready to show. The
  // app clears it once it loads; a page here has to clear it itself.
  useEffect(() => {
    if (state.status !== "loading" && !inApp && launchVisible())
      setLaunchReady(true);
  }, [state.status, inApp]);
  // The join owner's recovery record, as the Add-a-community dialog keeps it:
  // a relaunch resumes an unfinished join from there, through that dialog.
  const journal = useMemo(
    () =>
      nativeIdentityEnabled() && viewer ? createJoinJournal(viewer) : undefined,
    [viewer],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** The owner's fence: still shown, and `entry` still the journal's record. */
  const current: Current = (entry) =>
    mounted.current && (!entry || !journal || journal.current(entry));
  // The typed address the restore entered the app without; opened in the
  // join dialog, with its invite code, once the gate lifts.
  const handoff = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (login.snapshot().status === "pending") login.cancel();
    },
    [login],
  );
  // "Open Buzz" after email verification (`sign-in-requests.ts`). Each render
  // sets what a request does now; while it can't act yet, it stays queued.
  const requestedSignIn = useRef<(() => void) | undefined>(undefined);
  // The linked key a restart for Replace promised to restore: a sign-in to an
  // account linked to any other key, or to none, stops before setup acts on
  // it. Cleared on the landing and by Create account.
  const expectedKey = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the landing appearing lets a queued request act.
  useEffect(() => {
    const handle = () => {
      const run = requestedSignIn.current;
      if (!run || !takeSignInRequest()) return;
      // A plain Open Buzz names no key: resuming the restart's sign-in keeps
      // the one it expects.
      const key = takeExpectedKey();
      if (key) expectedKey.current = key;
      run();
    };
    handle();
    return onSignInRequest(handle);
  }, [state.status]);
  const discovering = finding && auth.status === "signed-out";
  /**
   * The page rendered below, keyed in the order the JSX decides it, so a
   * change of key is a page replacing another; `undefined` while nothing of
   * the user's is shown — the gate lifted, or the key still being restored —
   * so launch never moves focus.
   */
  const page =
    state.status === "loading"
      ? undefined
      : state.status === "error"
        ? "error"
        : progress.status === "idle"
          ? state.status === "ready" && !keyLanding
            ? undefined
            : auth.error === SIGN_IN_TIMED_OUT
              ? "auth-timeout"
              : auth.error
                ? "auth-error"
                : discovering
                  ? "discover"
                  : "landing"
          : progress.status === "done"
            ? profileStep
              ? "done:profile"
              : joinError
                ? `done:join-error:${joinError.title}`
                : finding
                  ? "done:find"
                  : creating
                    ? "done:create"
                    : "done:join"
            : progress.status === "paused"
              ? `paused:${progress.at}`
              : progress.status;
  // Existing identities and restore errors bypass first-run presentation.
  // Release the parser's hidden-window hold as soon as that outcome is known.
  useEffect(() => {
    if (
      (state.status === "ready" || state.status === "error") &&
      document.documentElement.dataset.welcomeIntro === "pending"
    ) {
      delete document.documentElement.dataset.welcomeIntro;
      void invoke("plugin:window|show", { label: "main" }).catch(() => {});
    }
  }, [state.status]);
  // A page replacing another takes focus with it: Back returns it to the
  // choice that opened the page it leaves (`data-return-focus`); otherwise
  // the new heading has it — unless the page focused a field itself, which
  // this passive effect runs after, as the app's own fill-in does.
  const shown = useRef<string | undefined>(undefined);
  const returnFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      shown.current !== undefined &&
      page !== undefined &&
      shown.current !== page
    ) {
      const trigger = returnFocus.current
        ? document.querySelector<HTMLElement>(
            `[data-return-focus="${returnFocus.current}"]`,
          )
        : null;
      if (trigger) trigger.focus();
      else if (document.activeElement === document.body)
        document
          .getElementById("welcome-title")
          ?.focus({ preventScroll: true });
    }
    returnFocus.current = undefined;
    shown.current = page;
  }, [page]);
  const legacyOffer = useLegacyIdentityOffer(
    identity,
    // Builderlab setup uses old Buzz's identity by itself, so only the
    // self-hosted route, behind Other options, offers it.
    otherOptions && !keyLanding && auth.status !== "pending",
  );
  /**
   * Signs this device's key out, which restarts Buzz; the next launch signs in
   * again by itself and, with no key here, takes the lane of the account
   * linked to `linked`, or stops if it signs in to another. Setup stays on its
   * progress page until the restart, or fails if none comes.
   */
  const replaceKey = (linked: string | undefined): SetupStep => ({
    label: "Signing in…",
    run: async () => {
      const withdraw = requestSignInAfterRestart(linked);
      try {
        await identity.signOut({ wipe: false, removeAgents: false });
      } catch (reason) {
        withdraw();
        throw new Error(signOutFailure(reason));
      }
      await new Promise((settle) => setTimeout(settle, RESTART_WAIT_MS));
      throw new Error("Buzz didn’t restart. Quit and reopen Buzz to finish.");
    },
  });
  if (inApp && viewer) {
    // Already in the app: a request has nothing to finish, so drop it.
    requestedSignIn.current = () => {};
    return (
      <>
        {children}
        <LinkedKeyCheck
          federated={federatedIdentity}
          identity={identity}
          viewer={viewer}
          onReplace={(key) => void setup.start([replaceKey(key)])}
        >
          {(asking) => (
            <BackupConsent
              identity={identity}
              communities={communities}
              servers={servers}
              paused={asking}
            />
          )}
        </LinkedKeyCheck>
      </>
    );
  }
  // The linked key is backed up: Welcome back offers a restore, and an
  // import of it skips another backup.
  const backedUp = !!linked && !!backups?.includes(linked);
  const restorable = backedUp || (!!linked && backupUnknown);
  /**
   * Sign-in leads to the account check, which picks the lane: a linked key
   * pauses on Welcome back, otherwise setup goes on by itself. The backed-up-key
   * lookup runs on both. Each choice below resumes setup with its own steps.
   */
  const signIn = async (create = false) => {
    signup.current = create;
    // A new account can't be the one Replace restarted for.
    if (create) expectedKey.current = undefined;
    const attempt = cancels.current;
    // A canceled attempt still settles here, possibly after a later sign-in
    // succeeded; it must not read that one's credential.
    await login.signIn();
    if (attempt !== cancels.current || login.snapshot().status !== "signed-in")
      return;
    switching.current = false;
    const current = account(login.credential(), identity);
    reads.current = current;
    let checkedKey: string | undefined;
    let checkedBackups: readonly string[] | undefined;
    const signedIn = identity.snapshot();
    const expected = expectedKey.current;
    void setup.start([
      checkAccount(
        current,
        (key) => {
          checkedKey = key;
          setLinked(key);
        },
        (list) => {
          known.current = list;
        },
        signedIn.status === "ready" ? signedIn.viewer : undefined,
      ),
      // Replace restarted for the account linked to `expected`: another
      // account, or one with no key, is neither bound, given a new key nor
      // restored.
      ...(expected
        ? [
            {
              label: "Checking your account…",
              run: async () => {
                if (checkedKey !== expected) throw new Error(WRONG_ACCOUNT);
              },
            },
          ]
        : []),
      checkBackup(current, (keys, failed) => {
        checkedBackups = keys;
        setBackups(keys);
        setBackupUnknown(!!failed);
      }),
      {
        label: "Preparing your identity…",
        run: async () => {
          // The account's key, with no backup and not on this device, may be
          // old Buzz's: a first run linked it, then stopped before saving it.
          const adopted =
            !!checkedKey &&
            !checkedBackups?.includes(checkedKey) &&
            (await adoptLinkedLegacy(identity, checkedKey));
          const here = identity.snapshot();
          const onDevice = here.status === "ready" ? here.viewer : undefined;
          // A device that already keeps communities opens on them once the
          // account's are restored, rather than on Join a community. One that
          // had no key until now keeps none.
          const open: SetupStep[] =
            onDevice &&
            !adopted &&
            communities.snapshot().memberships.length > 0
              ? [
                  {
                    label: "Opening Buzz…",
                    run: async () => {
                      enterApp();
                      return { status: "idle" };
                    },
                  },
                ]
              : [];
          const afterLink = [backupKey(current), ...finish(undefined)];
          // No key on the account: this device's key becomes the account's,
          // then old Buzz's from this device, or a new one, with no choice to
          // make. kgoose refusing this device's key as another account's, or
          // finding the account linked to another key meanwhile, asks before
          // replacing it, as the account check would for an account whose key
          // is not this device's.
          if (!checkedKey) {
            if (!onDevice)
              return {
                next: [
                  keyForAccount(identity, current),
                  linkKey(identity, current),
                  ...afterLink,
                ],
              };
            const linkHere: SetupStep = {
              ...linkKey(identity, current),
              run: async () => {
                // The key here now: Try again links what is on the device.
                const here = identity.snapshot();
                if (here.status !== "ready")
                  throw new Error(
                    "Your key could not be saved on this device.",
                  );
                try {
                  await current.bind(here.viewer);
                } catch (error) {
                  if (boundElsewhere(error)) return askToReplace(here.viewer);
                  throw error;
                }
                return { next: afterLink };
              },
            };
            return { next: [linkHere] };
          }
          // The account's key is already here: bring back its communities.
          // Adopted just now, it replaces the Welcome back the check chose
          // and is backed up, as that first run would have done next.
          if (onDevice === checkedKey)
            return {
              next: [
                ...(adopted ? [settled, backupKey(current)] : []),
                ...finish(checkedKey),
                ...open,
              ],
            };
          if (onDevice) return askToReplace(onDevice);
          if (!checkedBackups?.includes(checkedKey)) return;
          void current.recovery.beginRecovery();
          return { status: "paused", at: "key-restore" };
        },
      },
    ]);
  };
  /** Rests where setup ends, as when the account check found its key here. */
  const settled: SetupStep = {
    label: "Preparing your identity…",
    run: async () => ({ status: "done" }),
  };
  /**
   * Another account's key is here, and replacing it is always the user's
   * call. With a confirmed backup, that key can be restored by signing in to
   * its account. Without one, Replace waits until the key is revealed or
   * copied, as Settings' Remove from device does.
   */
  const askToReplace = async (onDevice: string): Promise<Resting> => {
    setReplacingKeyKept(false);
    setReplacingHaveKey(false);
    setReplacingBackedUp(await identity.backedUp(onDevice).catch(() => false));
    return { status: "paused", at: "replace-key" };
  };
  /** Starts sign-in in a fresh browser tab, replacing one still waiting. */
  const start = (create: boolean) => {
    if (login.snapshot().status === "pending") {
      cancels.current++;
      login.cancel();
    }
    void signIn(create);
  };
  /**
   * Picks up a sign-in the browser hasn't finished, as Sign in even after
   * Create account: the browser remembers the account, so a verified one
   * finishes without a password, and an unverified one returns to Verify
   * your email.
   */
  const resumeSignIn = () => start(false);
  /** Between pauses nothing runs: no key exists until a choice resumes setup. */
  const pause = (at: SetupPause) =>
    void setup.start([], { status: "paused", at });
  /** A page's Back: the choice that opened it, marked `data-return-focus`, takes focus again. */
  const back = (to: SetupPause, trigger: "import" | "restore" | "lost") => {
    returnFocus.current = trigger;
    pause(to);
  };
  /**
   * The lifted gate takes over: a pending handoff opens the join dialog for
   * the typed address, and nothing kept here can show discovery for it again.
   * The reset is ignored while the restore runs; it rests idle instead.
   */
  const enterApp = () => {
    const current = identity.snapshot();
    setLeftSetup(false);
    if (handoff.current && current.status === "ready")
      invites.open(
        { community: handoff.current, code: inviteCode },
        current.viewer,
      );
    handoff.current = undefined;
    setFinding(undefined);
    setInviteCode("");
    setEntered("");
    setCreatable(undefined);
    setCreating(false);
    setup.reset();
  };
  /**
   * Where the restore rests. With nothing admitted, setup ends on the Join
   * page as before. Otherwise it selects the typed address when that was
   * admitted, else the first admitted, and enters the app (after the profile
   * step when no profile exists yet), handing a typed address it did not
   * admit to the join dialog.
   */
  const decide = (outcomes: readonly Restored[]): Resting | undefined => {
    const admitted = outcomes.filter((outcome) => outcome.kind === "admitted");
    const typed = finding ? communityDestination(finding).id : undefined;
    const chosen =
      admitted.find((outcome) => outcome.id === typed) ??
      admitted.find((outcome) => outcome.read?.exists) ??
      admitted[0];
    if (!chosen?.read) return undefined;
    communities.select(chosen.id);
    handoff.current = chosen.id === typed ? undefined : finding;
    // `joined` adopts a relay profile only into an empty local default, so
    // with no relay profile read the local one is unchanged by the restore.
    if (!chosen.read.exists) {
      setProfileStep({ found: chosen, read: chosen.read });
      return undefined;
    }
    enterApp();
    return { status: "idle" };
  };
  /** Restores the account's saved destinations, when it has any. */
  const restore = () =>
    known.current?.length
      ? [restoreCommunities(known.current, communities, decide)]
      : [];
  /**
   * Whether Join a community may offer Create a community: only for an
   * account at the public Builderlab, which the check then asks.
   */
  const offerCreation = () =>
    reads.current && atPublicBuilderlab()
      ? [checkCreation(identity, reads.current, setCreatable)]
      : [];
  /**
   * How every lane ends: a linked account's owned communities feed Join a
   * community, beside whether it offers Create a community. Every lane that
   * finishes with `linked` holds that key, so its one list read answers both.
   */
  const finish = (key = linked) => [
    ...(key && reads.current
      ? [
          findCommunities(
            reads.current,
            setOwned,
            atPublicBuilderlab() ? setCreatable : undefined,
          ),
        ]
      : offerCreation()),
    ...restore(),
  ];
  /** A retry after expiration reacquires the same account before uploading. */
  const backupKey = (initial: FirstRunAccount) => {
    const original = login.credential().account;
    let currentAccount = initial;
    let expired = false;
    return backUp(identity, {
      ...initial,
      backUp: async (pubkey) => {
        if (expired) {
          await login.signIn();
          if (login.snapshot().status !== "signed-in")
            throw new Error("Sign in again to finish backing up your key.");
          const credential = login.credential();
          if (credential.account.subject !== original.subject) {
            login.cancel();
            throw new Error(
              `Sign in as ${original.email} to back up this key.`,
            );
          }
          currentAccount = account(credential, identity);
          reads.current = currentAccount;
          expired = false;
        }
        try {
          await currentAccount.backUp(pubkey);
        } catch (error) {
          if (error instanceof BackupError && error.kind === "signed_out") {
            expired = true;
            // Try again signs in first, so it can help here.
            throw new BackupError("signed_out", true);
          }
          throw error;
        }
      },
    });
  };
  /** A submitted address or invite link: what to look up, and the code to claim. */
  const find = (origin: string, code = "", justCreated = false) => {
    setFinding(origin);
    setInviteCode(code);
    setJoinAtOnce(justCreated || accountConsents(federatedIdentity, origin));
  };
  /** Every way back to the landing, so a kept `finding` cannot re-enter discovery. */
  const backToLanding = () => {
    lookups.current++;
    expectedKey.current = undefined;
    setOtherOptions(false);
    setFinding(undefined);
    setInviteCode("");
    setSwitchError(undefined);
    setLinked(undefined);
    setOwned(undefined);
    setBackups(undefined);
    setBackupUnknown(false);
    setCreatable(undefined);
    setCreating(false);
    reads.current = undefined;
    known.current = undefined;
    setup.reset();
    cancels.current++;
    login.cancel();
  };
  /**
   * "Use a different account": the landing, signed out of the rejected one.
   * Every sign-in from here asks the browser for credentials until one
   * completes, so the browser's session can't finish it as that account.
   */
  const switchAccount = () => {
    switching.current = true;
    void login.signOut();
    backToLanding();
  };
  /**
   * The failed page's way out after a Builderlab sign-in: signs out of it and
   * returns to the landing, keeping any key saved here, so the next sign-in
   * can pick another account or Continue without signing in can open the app.
   */
  const leaveFailedSetup = () => {
    setLeftSetup(true);
    switchAccount();
  };
  /**
   * The Add-a-community dialog's completion for the community the step
   * holds (`src/features/communities/join.ts`): with `publish`, the draft is
   * journaled, the profile read afresh, published when it differs and read
   * back; then the membership is saved through the live Communities service —
   * after the profile step, when there was one — which selects it, and the
   * journal's record for the destination is cleared. A restored community is
   * already saved: `joined` takes the same id again and adopts the profile
   * into the empty local default. `false` means the fence stopped it.
   */
  const complete = (step: ProfileStepState, publish?: PersonalProfile) =>
    completeJoin({
      community: step.found.url,
      membership: {
        id: step.found.url,
        name: step.found.host,
        ...(step.found.icon ? { icon: step.found.icon } : {}),
      },
      found: step.read,
      journal,
      // The journal's current record, whichever step wrote it last: a failed
      // publish replaced the admission's.
      entry: journal?.get(step.found.url),
      publish,
      communities,
      current,
    });
  const leave = () => {
    setProfileStep(undefined);
    enterApp();
  };
  /**
   * How a join ends: completed, then — for a join, not a restore — saved to
   * the account, so another device restores it (`joined` queued the same
   * idempotent add for the next Settings sign-in; best effort: `call` warns
   * of a refused answer in development, and a failure never stops entry), and
   * the gate lifts into the app on that community.
   */
  const finishJoin = async (
    step: ProfileStepState,
    publish?: PersonalProfile,
  ) => {
    if (!(await complete(step, publish))) return;
    if (step.admission)
      await reads.current?.saveCommunity(step.found.url).catch(() => {});
    leave();
  };
  const finishAdmitted = async (step: ProfileStepState) => {
    setRetrying("read");
    try {
      await finishJoin(step);
    } catch (error) {
      setJoinError({
        title: "Couldn’t finish joining",
        error: error instanceof Error ? error.message : String(error),
        admitted: step,
      });
    } finally {
      setRetrying(undefined);
    }
  };
  /**
   * The same join the Add-a-community dialog performs, through its owner:
   * the join is journaled before any remote effect (so a relaunch resumes it
   * through the dialog, and a lost claim reply is never claimed again), an
   * invite code, when there is one, is claimed first, and a signed profile
   * read proves admission. The membership is saved by `finishJoin`: at once,
   * or after the profile step a user with no profile yet continues to. The
   * join itself publishes nothing.
   */
  const join = async (
    found: FoundCommunity,
    consent: JoinConsent,
    code: string,
  ) => {
    const fail = (error: string, title = "Couldn’t join community") =>
      setJoinError({ title, error });
    const unreachable = () =>
      fail("Could not reach the relay. Check your connection and try again.");
    const client = communities.snapshot();
    if (client.status !== "ready")
      return fail(client.error ?? "Your saved communities aren’t ready yet.");
    const needsInvite = (codeError?: string) =>
      setJoinError({
        title: "This community needs an invite",
        error: `${found.host} admits members by invite, and this key has none yet. Enter an invite code, or send your public key to a community administrator so they can add you, then try again.`,
        denied: { found, consent },
        codeError,
      });
    let admission: Admission | undefined;
    try {
      admission = await admitCommunity({
        community: found.url,
        journal,
        code,
        policy: found.policy,
        consent,
        current,
      });
    } catch (error) {
      // A refused code (already its copy, from the owner; "Invalid invite
      // code" is the native route's for one it will not send) is the user's
      // to replace on the invite page; a relay that refuses the key needs one;
      // the journal's own storage message is shown as is. Everything else is
      // classified, not echoed.
      const refusal =
        error instanceof Error
          ? (Object.values(CLAIM_REFUSALS).find(
              (copy) => copy === error.message,
            ) ??
            (error.message === "Invalid invite code"
              ? CLAIM_REFUSALS.invite_invalid
              : undefined))
          : undefined;
      if (refusal) return needsInvite(refusal);
      if (readErrorKind(error) === "denied") return needsInvite();
      return error instanceof JournalError
        ? fail(error.message)
        : unreachable();
    }
    if (!admission) return;
    const step = { found, read: admission.found, admission };
    // Existing relay profiles are preserved; only a missing profile needs setup.
    if (!admission.found.exists) return setProfileStep(step);
    await finishAdmitted(step);
  };
  /** Try again repeats the read; a typed code is claimed first. */
  const retry = async ({ found, consent }: Denied, code = "") => {
    setRetrying(code ? "code" : "read");
    try {
      await join(found, consent, code);
    } finally {
      setRetrying(undefined);
    }
  };
  const denied = joinError?.denied;
  const admitted = joinError?.admitted;
  // Once a key exists, failures stay in setup until the remaining steps succeed.
  const failedAfterKey =
    progress.status === "failed" && state.status === "ready";
  const blocked = failedAfterKey && progress.skipsLink;
  /**
   * The pages setup rests on. The first two may be reached before any sign-in,
   * for a found community; the rest only after one. A pause this
   * component did not reach has nothing to render.
   */
  const paused = (at: SetupPause) => {
    const current = reads.current;
    switch (at) {
      case "connect-choice":
        // Connect is the landing's own sign-in: resetting first lets the
        // landing stay visible while the browser completes sign-in.
        return finding ? (
          <ConnectChoice
            host={new URL(finding).host}
            onConnect={() => {
              setup.reset();
              void signIn();
            }}
            onImport={() => pause("key-import")}
            onBack={backToLanding}
          />
        ) : null;
      case "key-import":
        // With no account this run (the connect choice), the key is nobody's
        // to link or back up, so the import is the whole setup. On the linked
        // lane only the linked key is accepted, so there is nothing to link.
        // A Builderlab import is linked and backed up automatically, or, when
        // the account already holds its backup, only saved as consented
        // unless a choice is saved; both disclose it. An independent
        // community import saves no backup choice: once Builderlab has a
        // session for it, `BackupConsent` decides.
        return (
          <KeyImport
            expectedPubkey={linked}
            automaticBackup={!!current && (backedUp ? "kept" : true)}
            onLost={
              linked && current
                ? () =>
                    void setup.start([findCommunities(current, setOwned)], {
                      status: "paused",
                      at: "key-lost",
                    })
                : undefined
            }
            onBack={() => {
              // Without a Builderlab sign-in, the found community led straight
              // here, so there is no connect choice to return to.
              if (!current && !connect) return backToLanding();
              back(!current ? "connect-choice" : "welcome-back", "import");
            }}
            onImport={async (nsec) => {
              await importKey(identity, nsec);
              // A key brought without an account is the self-hosted route.
              if (!current) void setup.start([]);
              else
                void setup.start([
                  ...(!linked ? [linkKey(identity, current)] : []),
                  backedUp ? keepBackup(identity) : backupKey(current),
                  ...finish(),
                ]);
            }}
          />
        );
    }
    if (!current) return null;
    // A new key becomes the account's before it is backed up.
    const link = linkKey(identity, current);
    const backUpKey = backupKey(current);
    switch (at) {
      case "replace-key":
        // Cancel leaves this device as it was, signed out of the new account.
        return (
          <>
            <SetupProgress label="Signing in…" />
            <AlertDialog
              title="A different account is saved on this computer"
              description={
                replacingBackedUp
                  ? "Replacing it removes that account from this computer to continue with the one you just signed in to. Its key was backed up in Builderlab: sign in to that account again to restore it."
                  : "Replacing it removes that account from this computer to continue with the one you just signed in to. Its key may not be backed up: copy its private key first, or you could lose that account."
              }
              onClose={switchAccount}
              actions={
                <>
                  <Button onClick={switchAccount}>Cancel</Button>
                  <Button
                    variant="destructive"
                    disabled={
                      !replacingBackedUp &&
                      !(replacingKeyKept && replacingHaveKey)
                    }
                    onClick={() => void setup.start([replaceKey(linked)])}
                  >
                    Replace
                  </Button>
                </>
              }
            >
              {!replacingBackedUp && (
                <>
                  <PrivateKey
                    identity={identity}
                    onInteraction={() => setReplacingKeyKept(true)}
                  />
                  <div className="mt-6">
                    <Checkbox
                      label="I have my key"
                      checked={replacingHaveKey}
                      disabled={!replacingKeyKept}
                      onCheckedChange={setReplacingHaveKey}
                    />
                  </div>
                </>
              )}
            </AlertDialog>
          </>
        );
      case "welcome-back":
        return linked ? (
          <>
            <WelcomeBack
              email={auth.account?.email}
              npub={npubEncode(linked)}
              onDevice={viewer === linked}
              onRestore={
                viewer === linked
                  ? () => void setup.start(finish())
                  : restorable
                    ? () => {
                        void current.recovery.beginRecovery();
                        pause("key-restore");
                      }
                    : undefined
              }
              onImport={() => pause("key-import")}
              onSwitchAccount={() => {
                if (viewer !== linked) return switchAccount();
                void identity
                  .signOut({ wipe: false, removeAgents: false })
                  .catch(() =>
                    setSwitchError("Couldn’t switch accounts. Try again."),
                  );
              }}
            />
            {switchError && <p role="alert">{switchError}</p>}
          </>
        ) : null;
      case "key-restore":
        // A restored key is already backed up, so no backup step follows.
        return linked ? (
          <KeyRestore
            recovery={current.recovery}
            email={auth.account?.email}
            expectedPubkey={linked}
            onBack={() => back("welcome-back", "restore")}
            onImport={() => pause("key-import")}
            onLost={() =>
              void setup.start([findCommunities(current, setOwned)], {
                status: "paused",
                at: "key-lost",
              })
            }
            onInstalled={() => {
              const restored = identity.snapshot();
              if (restored.status !== "ready" || restored.viewer !== linked)
                return;
              void setup.start(finish());
            }}
          />
        ) : null;
      case "key-lost":
        // Starting over creates a new key, as first-run setup does, and the old
        // key's communities are not offered to it (so the lane ends with the
        // restore alone, not `finish`). The old key stays linked
        // until the new one exists, so the account is never left without a
        // key; binding never overwrites, so the old one is unlinked before the
        // new one is linked.
        return linked ? (
          <KeyLost
            owned={owned}
            onBack={() =>
              back("welcome-back", restorable ? "restore" : "import")
            }
            onStartOver={() => {
              setLinked(undefined);
              setOwned(undefined);
              void setup.start([
                createKey(identity),
                unlinkKey(identity, current, linked),
                link,
                backUpKey,
                ...offerCreation(),
                ...restore(),
              ]);
            }}
          />
        ) : null;
    }
  };
  // Restart sign-in in place of one waiting on an earlier browser tab: the
  // browser's account session finishes it. Setup already under way, or a
  // community-link lookup, has no sign-in to restart; one that timed out does.
  requestedSignIn.current =
    state.status === "loading" || state.status === "error"
      ? undefined
      : () => {
          if (progress.status !== "idle" || (discovering && !auth.error))
            return;
          setOtherOptions(false);
          resumeSignIn();
        };
  if (state.status === "loading" || state.status === "error")
    return (
      <OnboardingScreen
        labelledBy="welcome-title"
        intro={
          // The frame already centres and pads this column: no `.setup` wrapper.
          <div className={`${styles.setupContent} w-full max-w-md`}>
            <h1
              id="welcome-title"
              tabIndex={-1}
              className="text-heading text-standard"
            >
              Your Buzz identity
            </h1>
            {state.status === "loading" ? (
              <p role="status">Opening your saved identity…</p>
            ) : state.error === MALFORMED_IDENTITY ? (
              // Reading it again gets the same bytes: only removing it, which
              // restarts into first run's restore or import, gets past it.
              <>
                <p role="alert">
                  Buzz can’t read the key saved on this computer, so it can’t
                  open with it or copy it. Trying again won’t change that.
                </p>
                <Button onClick={() => setRemovingKey({ pending: false })}>
                  Remove from device
                </Button>
                {removingKey && (
                  <AlertDialog
                    title="Remove the unreadable key?"
                    description="This deletes it from this computer’s secure storage, signs you out of your organizations and restarts Buzz. Then sign in to restore your account’s key from its backup, or enter your private key. Without a backup or a copy, that identity can’t be recovered."
                    pending={removingKey.pending}
                    onClose={() => setRemovingKey(undefined)}
                    actions={
                      <>
                        <Button
                          disabled={removingKey.pending}
                          onClick={() => setRemovingKey(undefined)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={removingKey.pending}
                          onClick={() => {
                            setRemovingKey({ pending: true });
                            identity
                              .signOut({ wipe: false, removeAgents: false })
                              .catch((reason: unknown) =>
                                setRemovingKey({
                                  pending: false,
                                  error: signOutFailure(reason),
                                }),
                              );
                          }}
                        >
                          Remove from device
                        </Button>
                      </>
                    }
                  >
                    {removingKey.error && (
                      <p role="alert">{removingKey.error}</p>
                    )}
                  </AlertDialog>
                )}
              </>
            ) : (
              <>
                <p role="alert">{state.error}</p>
                <Button onClick={() => void identity.retry()}>
                  Retry secure storage access
                </Button>
              </>
            )}
          </div>
        }
      >
        {null}
      </OnboardingScreen>
    );
  // Discovery: the same unauthenticated lookup Join Community runs after
  // setup, so a bad address fails here, before sign-in and before a key
  // exists. A community hosted by this build's Builderlab signs in at once;
  // any other asks the user whether to connect at the build portal or bring
  // a key.
  if (
    progress.status === "idle" &&
    auth.status !== "pending" &&
    !auth.error &&
    !discovering &&
    otherOptions
  )
    return (
      <OnboardingScreen
        key="community-entry"
        labelledBy="welcome-title"
        intro={
          <>
            <h1
              id="welcome-title"
              tabIndex={-1}
              ref={focusCommunityHeading}
              className="text-heading text-standard"
            >
              Join a community
            </h1>
            <p className="text-body-sm text-subtle">
              Enter a community address or an invite link to continue.
            </p>
          </>
        }
      >
        <CommunityUrlField
          url={entered}
          onUrlChange={setEntered}
          onSubmit={find}
          onBack={() =>
            onboardingTransition(() => {
              returningFromOptions.current = true;
              setOtherOptions(false);
            }, true)
          }
        />
        {legacyOffer}
      </OnboardingScreen>
    );
  // A device with a Builderlab session saved leads with Sign in; a new one
  // with Create account, which opens the account page's sign-up form. Until
  // the saved session is restored neither is known, so neither can start.
  const returning =
    keyLanding ||
    session?.status === "signed-in" ||
    session?.status === "reauthentication-required";
  const restoring = session?.status === "restoring";
  if (progress.status === "idle" && !auth.error && !discovering)
    return (
      <OnboardingScreen
        key="welcome"
        welcome
        labelledBy="welcome-title"
        intro={
          <>
            <h1 id="welcome-title" tabIndex={-1} className={styles.wordmark}>
              <OnboardingWordmark />
            </h1>
            <p className={styles.tagline}>
              Your people, your agents, one place.
            </p>
          </>
        }
      >
        {connect && (
          <Button
            variant="prominent"
            size="lg"
            disabled={restoring}
            onClick={() => start(!returning)}
          >
            {returning ? "Sign in" : "Create account"}
          </Button>
        )}
        {keyLanding ? (
          // A key is already here, so the app opens on what this device
          // keeps, and checks it against any account signed in there.
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              cancels.current++;
              login.cancel();
              enterApp();
            }}
          >
            Continue without signing in
          </Button>
        ) : (
          <>
            {connect && (
              <Button
                size="lg"
                variant="glass-clear"
                disabled={restoring}
                onClick={() => start(returning)}
              >
                {returning ? "Create account" : "Sign in"}
              </Button>
            )}
            <Button
              size="lg"
              variant="ghost"
              ref={(button) => {
                if (button && returningFromOptions.current) {
                  returningFromOptions.current = false;
                  button.focus();
                }
              }}
              onClick={() =>
                onboardingTransition(() => {
                  cancels.current++;
                  login.cancel();
                  setFinding(undefined);
                  setOtherOptions(true);
                })
              }
            >
              Other options
            </Button>
          </>
        )}
      </OnboardingScreen>
    );
  // The key pages and Join a community bring their own onboarding layouts;
  // the rest are wireframes. A pause with nothing to render keeps the frame,
  // so the title bar and window controls stay.
  if (
    progress.status === "paused" &&
    ["key-import", "key-restore"].includes(progress.at)
  )
    return paused(progress.at) ?? <WireframeScreen>{null}</WireframeScreen>;
  if (
    progress.status === "done" &&
    !profileStep &&
    !joinError &&
    !finding &&
    !creating
  )
    return (
      <JoinCommunity
        url={entered}
        onUrlChange={setEntered}
        onFind={find}
        owned={owned}
        onCreate={creatable ? () => setCreating(true) : undefined}
      />
    );
  return (
    <WireframeScreen>
      {progress.status === "done" ? (
        profileStep ? (
          <ProfileStep
            found={profileStep.found}
            read={profileStep.read}
            defaultName={auth.account?.email.split("@")[0] ?? ""}
            onContinue={(next) => finishJoin(profileStep, next)}
          />
        ) : joinError ? (
          // Back returns to the find page, which looks the community up again,
          // through Join Community: another automatic join would leave no way
          // out of a join that keeps failing.
          <Failure
            title={joinError.title}
            error={joinError.error}
            onBack={
              admitted
                ? undefined
                : () => {
                    setJoinAtOnce(false);
                    setJoinError(undefined);
                  }
            }
            publicKey={denied ? npubOf(state) : undefined}
            invite={
              denied && {
                error: joinError.codeError,
                onSubmit: (code) => void retry(denied, code),
              }
            }
            onRetry={
              admitted
                ? () => void finishAdmitted(admitted)
                : denied && (() => void retry(denied))
            }
            busy={retrying}
          />
        ) : finding ? (
          <FindCommunity
            onboarding
            url={finding}
            onCancel={() => setFinding(undefined)}
            onJoin={(found, consent) => join(found, consent, inviteCode)}
            autoJoin={joinAtOnce}
            consentGiven={(found) =>
              accountConsents(federatedIdentity, found.url)
            }
            titleId="welcome-title"
          />
        ) : creating && reads.current ? (
          // The created community is looked up and joined as an entered
          // address is, without Join Community.
          <CreateCommunityStep
            account={reads.current}
            quotaLimit={creatable?.quotaLimit}
            onCreated={(origin) => {
              setCreating(false);
              // Kept in the field, as a typed address is, so after Cancel its
              // Continue finds the new community again.
              setEntered(new URL(origin).host);
              find(origin, "", true);
            }}
            onBack={() => {
              returnFocus.current = "create";
              setCreating(false);
            }}
          />
        ) : null
      ) : progress.status === "running" ? (
        <SetupProgress label={progress.label} />
      ) : progress.status === "paused" ? (
        paused(progress.at)
      ) : progress.status === "failed" ? (
        <Failure
          title="Couldn’t finish setup"
          error={progress.error}
          note={
            blocked
              ? UNLINKED_NOTE
              : failedAfterKey
                ? "Your key is saved on this device."
                : undefined
          }
          // After a Builderlab sign-in the way out signs out of it, so the
          // next sign-in can pick another account; Back would sign in to the
          // same one again. The landing it returns to can still open the app
          // with a key from an earlier launch.
          onBack={reads.current ? undefined : backToLanding}
          onSwitchAccount={reads.current ? leaveFailedSetup : undefined}
          onRetry={
            !progress.retryable ||
            progress.unsupportedBackup ||
            progress.bound ||
            progress.error === WRONG_ACCOUNT
              ? undefined
              : () => void setup.retry()
          }
          onContinue={
            progress.unsupportedBackup
              ? () => void setup.continueWithoutBackup()
              : undefined
          }
        />
      ) : auth.error === SIGN_IN_TIMED_OUT ? (
        <FinishInBrowser onContinue={resumeSignIn} onBack={backToLanding} />
      ) : auth.error ? (
        <Failure
          title={auth.retrySignOut ? "Couldn’t sign out" : "Couldn’t sign in"}
          error={auth.error}
          onBack={backToLanding}
          onRetry={
            auth.retrySignOut ? () => void login.retrySignOut() : undefined
          }
        />
      ) : finding ? (
        <FindCommunity
          onboarding
          url={finding}
          onCancel={backToLanding}
          onFound={(found) => {
            // Fenced to this lookup: Cancel, another destination or unmount
            // starts a new one, and a late answer then does nothing.
            const lookup = ++lookups.current;
            void hostedByThisBuilderlab(found, servers).then((hosted) => {
              if (lookup !== lookups.current) return;
              if (hosted) void signIn();
              // Without a Builderlab sign-in, a key is the only way in.
              else pause(connect ? "connect-choice" : "key-import");
            });
          }}
          titleId="welcome-title"
        />
      ) : null}
    </WireframeScreen>
  );
}

/**
 * The app stopped waiting on the browser, though the person may still be
 * signing up or verifying their email there: not a failure.
 */
function FinishInBrowser({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <h1
        id="welcome-title"
        tabIndex={-1}
        className="text-heading text-standard"
      >
        Finish in your browser
      </h1>
      <p className="text-body text-subtle">
        Finish signing in there, then come back and choose Continue.
      </p>
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        <OnboardingBack onClick={onBack} aria-label="Back" />
        <Button variant="prominent" size="lg" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </>
  );
}

/** The refused key and the consent its Join carried, for a retry or a code. */
type Denied = { found: FoundCommunity; consent: JoinConsent };

/** The community the profile step is for, and the read that admitted the key. */
type ProfileStepState = {
  found: Pick<FoundCommunity, "url" | "host" | "icon">;
  read: Admission["found"];
  /** The join's admission; absent for a restored community, whose membership is saved already. */
  admission?: Admission;
};

/**
 * Admins admit people by npub, so the denied page shows the key to send them.
 * Full npub only: the service validates the viewer as 64-hex, so encoding fails
 * only on a snapshot that is not ready, and no key block is shown then.
 */
function npubOf(state: ReturnType<Identity["snapshot"]>) {
  if (state.status !== "ready") return undefined;
  try {
    return npubEncode(state.viewer);
  } catch {
    return undefined;
  }
}

/**
 * What a failed link or unlink leaves undone: the key is not the account's
 * (and, after an unlink, the old key stays bound), and with it the backup,
 * which needs a linked key. The page has no way past it but Try again, where
 * another attempt can help, or leaving through Use a different account.
 */
const UNLINKED_NOTE =
  "Your key is saved on this device, but it isn’t linked to your account or backed up yet.";

function Failure({
  title,
  error,
  note,
  onBack,
  backLabel = "Back",
  publicKey,
  invite,
  onRetry,
  onContinue,
  onSwitchAccount,
  busy,
}: {
  title: string;
  error: string;
  /** Setup failed after the key was saved: say it is not lost, and what is undone. */
  note?: string | undefined;
  /** The way back or on; absent where the failure blocks and only Try again is offered. */
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  /** Shown as the user's shareable identity, with Copy, when set. */
  publicKey?: string | undefined;
  /** Offers an invite code field, with the last code's refusal under it. */
  invite?:
    | { error?: string | undefined; onSubmit: (code: string) => void }
    | undefined;
  /** Offers Try again; no action can start while `busy`. */
  onRetry?: (() => void) | undefined;
  onContinue?: (() => void) | undefined;
  /** Offers Use a different account, keeping the saved key. */
  onSwitchAccount?: (() => void) | undefined;
  /** Which action is in flight: Try again's read, or the code's claim. */
  busy?: "read" | "code" | undefined;
}) {
  return (
    <>
      <h1
        id="welcome-title"
        tabIndex={-1}
        className="text-heading text-standard"
      >
        {title}
      </h1>
      <p role="alert" className="text-body text-danger">
        {note && <span>{note} </span>}
        {error}
      </p>
      {invite && (
        <InviteCodeField
          error={invite.error}
          busy={!!busy}
          pending={busy === "code"}
          onSubmit={invite.onSubmit}
        />
      )}
      {publicKey && <PublicKeyPanel publicKey={publicKey} />}
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        {onBack && (
          <OnboardingBack
            onClick={onBack}
            disabled={!!busy}
            aria-label={backLabel}
          />
        )}
        {onSwitchAccount && (
          <Button
            // The only way on when nothing else is offered.
            variant={onRetry || onContinue ? "ghost" : "prominent"}
            size="lg"
            onClick={onSwitchAccount}
            disabled={!!busy}
          >
            Use a different account
          </Button>
        )}
        {onContinue && (
          <Button variant="prominent" size="lg" onClick={onContinue}>
            Continue without backup
          </Button>
        )}
        {onRetry && (
          // Loading keeps focus here, so a repeated denial, which leaves the
          // page unchanged, does not drop it.
          <Button
            variant="prominent"
            size="lg"
            onClick={onRetry}
            loading={busy === "read"}
            disabled={busy === "code"}
          >
            Try again
          </Button>
        )}
      </div>
    </>
  );
}

function focusCommunityHeading(heading: HTMLHeadingElement | null) {
  heading?.focus();
}
