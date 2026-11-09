import { useEffect, useRef, useSyncExternalStore } from "react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { isSignInRefusal, type RelayRecovery } from "./recovery";
import type { RelaySession } from "./session";

const NONE = Object.freeze({
  recovering: false,
  attempt: 0,
  shown: false,
  reauthorized: 0,
});
const subscribeNone = () => () => {};
const snapshotNone = () => NONE;

/** Recovery state for one surface. `shown` is true while the notice is
 * visible; `recovering` is true from the first failure, including the
 * quiet RECOVERY_NOTICE_DELAY_MS before the notice appears. */
export function useRecovery(recovery: RelayRecovery | undefined) {
  const state = useSyncExternalStore(
    recovery?.subscribe ?? subscribeNone,
    recovery?.snapshot ?? snapshotNone,
    recovery?.snapshot ?? snapshotNone,
  );
  return {
    recovering: !!recovery && state.recovering,
    // Stay hidden for a failure that recovery fixes before the notice delay.
    shown: !!recovery && state.shown,
  };
}

/** Retries a finite read that recovery does not own once credentials change
 * (federated sign-in). Call `begin()` as each read starts and pass its failure
 * to the function it returns. Only a missing-sign-in refusal of a read sent
 * before the change retries, once; any other failure, or a read begun after
 * the change, stays put. Reads only: never a mutation or a user's action. */
export function useReauthorizedRetry(
  recovery: RelayRecovery | undefined,
  retry: () => void,
) {
  const latest = useRef({ recovery, retry });
  latest.current = { recovery, retry };
  /** The credential generation of the read now refused for missing sign-in. */
  const refused = useRef<number>(undefined);
  const generation = () =>
    latest.current.recovery?.snapshot().reauthorized ?? 0;
  const settle = useRef(() => {});
  settle.current = () => {
    if (refused.current === undefined || refused.current >= generation())
      return;
    refused.current = undefined;
    latest.current.retry();
  };
  useEffect(() => {
    if (!recovery) return;
    let live = true;
    const stop = recovery.subscribe(() => {
      if (live) settle.current();
    });
    return () => {
      live = false;
      refused.current = undefined;
      stop();
    };
  }, [recovery]);
  return useRef({
    begin() {
      refused.current = undefined;
      const sent = generation();
      return (error: unknown) => {
        if (!isSignInRefusal(error)) return;
        refused.current = sent;
        settle.current();
      };
    },
  }).current;
}

/** True while recovery retries this surface's own read, from its first
 * failure and through the quiet delay before the notice. The surface then
 * hides its own copy of the failure; the notice is the one report. `owns`
 * picks the read from the live view (rosterRecovering, headRecovering). A
 * failure recovery does not retry, such as a denial, stays visible even while
 * another source recovers. */
export function useRecoveryOwns(
  session: Pick<RelaySession, "recovery" | "live">,
  owns: (live: ReturnType<RelaySession["live"]["snapshot"]>) => boolean,
) {
  const { recovering } = useRecovery(session.recovery);
  const read = () => owns(session.live.snapshot());
  const owned = useSyncExternalStore(session.live.subscribe, read, read);
  return recovering && owned;
}

export const RECOVERY_TITLE = "Buzz is having trouble connecting";

/** The one relay recovery notice, on every page. Recovery retries on its own,
 * so it offers no button. */
export function RecoveryNotice({
  recovery,
}: {
  recovery: RelayRecovery | undefined;
}) {
  const { shown } = useRecovery(recovery);
  if (!shown) return null;
  return (
    <ToastNotice
      title={RECOVERY_TITLE}
      description="Retrying automatically."
      tone="info"
    />
  );
}
