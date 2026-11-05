import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useId,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { AgentSaveFooter } from "../../../features/agents/AgentSaveButton";
import { Button } from "../../../shared/design-system/ui/Button";
import { Header } from "../../../shared/design-system/ui/Header";
import { oauthTarget } from "../oauth/browser";
import { nativeBuilderlab, type BuilderlabSession } from "../session";

/** Profile edits need an account; messaging uses the owner's relay connection. */
export function createProfileActions(session: BuilderlabSession) {
  return function ProfileActions({
    children,
    onUnavailable,
  }: {
    children: ReactNode;
    onUnavailable?: () => void;
  }) {
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    useLayoutEffect(() => {
      if (login.status !== "signed-in") onUnavailable?.();
    }, [login.status, onUnavailable]);
    return login.status === "signed-in" ? children : null;
  };
}

/** The sign-in and recovery states share one host-owned floating surface. */
function AccountSheet({
  title,
  description,
  children,
  accessRequired = true,
}: {
  accessRequired?: boolean;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  return (
    <motion.div
      data-agent-access-required={accessRequired}
      initial={{ y: instant ? 0 : "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{
        y: instant ? 0 : "100%",
        opacity: 0,
        transition: { duration: instant ? 0 : 0.18 },
      }}
      transition={
        instant
          ? { duration: 0 }
          : {
              type: "spring",
              delay: 0.35,
              duration: 0.6,
              bounce: 0.25,
              opacity: { type: "tween", delay: 0.35, duration: 0.18 },
            }
      }
      inert={!present}
      aria-hidden={!present || undefined}
    >
      <section
        aria-labelledby={id}
        className="floating-surface"
        style={{ "--floating-inset": "var(--space-5)" } as CSSProperties}
      >
        <div className="p-5">
          <Header id={id} title={title} subtitle={description} />
          <div className="grid gap-3">{children}</div>
        </div>
      </section>
    </motion.div>
  );
}

/** The host owns presence so a retry can unmount its editor and still exit. */
export function SettingsErrorSheet({
  active,
  title,
  message,
  action,
  accessRequired = false,
}: {
  active: boolean;
  title: string;
  message: string;
  accessRequired?: boolean;
  action: {
    label: string;
    disabled?: boolean;
    href?: string | undefined;
    run(): void;
  };
}) {
  const report = useContext(AgentSaveFooter)?.setPanelNotice;
  const run = useRef(action.run);
  run.current = action.run;
  const { label, disabled, href } = action;
  const content = useMemo(
    () => (
      <AccountSheet
        key={title}
        title={title}
        accessRequired={accessRequired}
        description={<span role="alert">{message}</span>}
      >
        <Button
          variant="prominent"
          size="lg"
          style={{ width: "100%" }}
          disabled={disabled}
          {...(href
            ? {
                nativeButton: false,
                render: (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {label}
                  </a>
                ),
              }
            : {})}
          onClick={() => run.current()}
        >
          {label}
        </Button>
      </AccountSheet>
    ),
    [title, message, label, disabled, href, accessRequired],
  );
  useLayoutEffect(() => {
    if (!report || !active) return;
    report(content);
    return () => report(null);
  }, [report, active, content]);
  return report ? null : <AnimatePresence>{active && content}</AnimatePresence>;
}

/** Settings supplies the verified account context; the host owns placement. */
export function AccountRecoverySheet({
  session,
  active,
  email,
  mismatch,
  openIdentity,
}: {
  session: BuilderlabSession;
  active: boolean;
  email?: string | undefined;
  mismatch: boolean;
  openIdentity?: (() => void) | undefined;
}) {
  return (
    <SettingsErrorSheet
      active={active}
      accessRequired
      title={
        mismatch ? "Different account needed" : "Builderlab access unavailable"
      }
      message={
        mismatch
          ? email
            ? `Sign in as ${email} to edit this agent.`
            : "Sign in with another Builderlab account to edit this agent."
          : "This account can’t access Builderlab agents."
      }
      action={{
        label: nativeBuilderlab()
          ? "Identity → Organization sign-in"
          : "Use another account",
        disabled: nativeBuilderlab() && !openIdentity,
        href:
          active && !nativeBuilderlab()
            ? new URL("/logout", oauthTarget()).href
            : undefined,
        run: () => (nativeBuilderlab() ? openIdentity?.() : session.signOut()),
      }}
    />
  );
}
