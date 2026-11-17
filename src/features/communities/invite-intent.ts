import { communityDestination } from "./destination";
import { parsePastedInvite, type InviteLink } from "./invite-link";
import type { PersonalProfile } from "./service";

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

/** The join dialog's form as last edited in one opening, restored without
 * submitting. The profile is kept only once edited, for its destination;
 * `after` names the join journal entry it was edited after, so a profile the
 * journal recorded later (a publish attempt) wins on restore. */
export type JoinForm = Readonly<{
  address: string;
  code: string;
  profile?: Readonly<{
    destination: string;
    profile: PersonalProfile;
    after?: string;
  }>;
}>;

/**
 * What one join opening holds beyond its address, in memory only: the invite
 * code to claim, a one-use instruction to connect at once, and the dialog's
 * form once edited. Navigation history, session storage and URLs carry the
 * address and an opaque visit token alone, so reload restores the dialog
 * without a code or form and without connecting by itself.
 */
export type JoinVisitState = Readonly<{
  viewer: string;
  community?: string;
  code: string;
  connect: boolean;
  form?: JoinForm;
}>;

/** What the opening's dialog shows: its edited form, else what it opened with. */
export function joinOpening(
  state: JoinVisitState | undefined,
  community?: string,
) {
  if (state?.form)
    return {
      community: state.form.address,
      code: state.form.code,
      ...(state.form.profile ? { profile: state.form.profile } : {}),
    };
  const address = state?.community ?? community;
  return address === undefined
    ? undefined
    : { community: address, code: state?.code ?? "" };
}

/** The community an opening offers now, canonical; none while unparsable. */
export function offeredCommunity(
  state: JoinVisitState | undefined,
  community?: string,
) {
  const address = joinOpening(state, community)?.community;
  if (!address) return undefined;
  // Read as the dialog reads its address: an invite link or a bare host too.
  const entered = parsePastedInvite(address);
  if (!entered) return undefined;
  try {
    return communityDestination(entered.community).url;
  } catch {
    return undefined;
  }
}

/** An OS invitation is an intent, never a membership or an authorization. */
export function createInviteIntent() {
  // Keyed by the join presentation's visit token.
  const visits = new Map<string, JoinVisitState>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (visit: string) => visits.get(visit),
    set(visit: string, state: JoinVisitState) {
      visits.set(visit, Object.freeze({ ...state }));
      emit();
    },
    /** The dialog connected once; Forward and later presentations wait for Continue. */
    consume(visit: string) {
      const state = visits.get(visit);
      if (!state?.connect) return;
      visits.set(visit, Object.freeze({ ...state, connect: false }));
      emit();
    },
    /** Not a presentation change: nothing re-renders for a keystroke. An
     * opening restored without state (after reload) starts from `base`. */
    edit(visit: string, base: JoinVisitState, form: JoinForm) {
      visits.set(
        visit,
        Object.freeze({ ...(visits.get(visit) ?? base), form }),
      );
    },
    delete(matches: (visit: string, state: JoinVisitState) => boolean) {
      let changed = false;
      for (const [visit, state] of visits)
        if (matches(visit, state)) changed = visits.delete(visit) || changed;
      if (changed) emit();
    },
  };
}
