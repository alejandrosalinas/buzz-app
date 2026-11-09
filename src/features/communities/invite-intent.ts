import type { InviteLink } from "./invite-link";

/**
 * A request to open the join dialog on a community. `submitted` marks an
 * address the person already chose in the app, such as a community they just
 * created, so the dialog connects at once instead of waiting for Continue.
 */
export type JoinRequest = InviteLink & { submitted?: boolean };

/** Opens the join dialog on a community address the person chose in the app;
 * false when the address is not a community origin or no identity is ready to
 * join with, so the caller can hand the address off another way. */
export type CommunityJoin = {
  open(address: string): boolean;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional: older hosts do not provide it. */
    communityJoin?: CommunityJoin;
  }
}

/** An OS invitation is an intent, never a membership or an authorization. */
export function createInviteIntent() {
  let current:
    | (JoinRequest & { viewer: string; requestId: number })
    | undefined;
  let requestId = 0;
  const listeners = new Set<() => void>();
  const snapshot = () => current;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot,
    subscribe,
    open(invite: JoinRequest, viewer: string) {
      current = { ...invite, viewer, requestId: ++requestId };
      emit();
    },
    clear(requestId?: number) {
      if (
        !current ||
        (requestId !== undefined && current.requestId !== requestId)
      )
        return;
      current = undefined;
      emit();
    },
  };
}
