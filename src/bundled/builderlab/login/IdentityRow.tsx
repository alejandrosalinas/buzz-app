import { useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BuilderlabLogoIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import type { BuilderlabSession } from "../session";

/** Observe the existing session; Identity never starts a second account read. */
export function BuilderlabIdentityRow({
  session,
  active,
  openSettings,
}: {
  session: BuilderlabSession;
  active(): boolean;
  openSettings(): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const reducedMotion = useReducedMotion();
  if (state.status === "pending") return null;
  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      // Match duration-settle / easing-settle, as in the shared Accordion.
      transition={{
        duration: reducedMotion ? 0 : 0.22,
        ease: [0.645, 0.045, 0.355, 1],
      }}
    >
      <span className="inline-flex max-w-full flex-wrap items-center gap-2">
        <Button
          size="inline"
          variant="link"
          style={{ maxWidth: "100%" }}
          aria-label="Open Builderlab settings"
          title={`Builderlab uses your ${session.providerName ?? "Builderlab"} sign-in. Manage remote agents and hosted communities in its settings.`}
          onClick={() => {
            if (active()) openSettings();
          }}
        >
          <span className="whitespace-normal">
            {state.status === "signed-in" ? "Connected to" : "Connect to"}{" "}
            <BuilderlabLogoIcon
              className="inline-block size-3 align-middle"
              aria-hidden="true"
            />{" "}
            Builderlab
          </span>
        </Button>
        {state.error && (
          <span role="status" className="text-caption text-subtle">
            Needs attention
          </span>
        )}
      </span>
    </motion.div>
  );
}
