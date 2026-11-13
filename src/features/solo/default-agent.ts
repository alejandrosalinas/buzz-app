import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { MentionRecipient } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import {
  clearViewValue,
  readView,
  subscribeView,
  writeView,
} from "../../shared/view-state";

// Cached on this device for the account and community (the view scope). A
// choice made in Agents is also saved to the account, which every install
// adopts once per session, as is removing it, which saves none. Automatic
// picks stay on the device and never write the account's.
const KEY = "solo:default-agent";
type Account = NonNullable<RelaySession["mainAgent"]>;
const adopted = new WeakMap<Account, Promise<void>>();
const revisions = new WeakMap<Account, number>();
const revision = (account: Account) => revisions.get(account) ?? 0;
const advance = (account: Account) => {
  const next = revision(account) + 1;
  revisions.set(account, next);
  return next;
};
// The account's saved choice once read: undefined only when a successful read
// found no record. Read failures are tracked separately.
const saved = new WeakMap<Account, string | undefined>();
const readErrors = new WeakMap<Account, string>();
const readValues = new WeakMap<Account, string | undefined>();
const readFailures = new WeakMap<Account, string>();
const failedChoices = new WeakSet<Account>();
// Accounts whose saved choice is known: read before any choice here, or
// confirmed by a save here, and not while a save is pending.
const known = new WeakSet<Account>();
// Accounts known to hold a record: a choice or a saved none, read or saved
// here. A read that found no record leaves an account out.
const recorded = new WeakSet<Account>();
const saving = new WeakMap<Account, number>();
// Accounts with an agent's Bestie change in progress.
const changing = new WeakSet<Account>();
const listeners = new Set<() => void>();
function notifySaved() {
  for (const listener of listeners) listener();
}
function remember(account: Account, agent: string | undefined) {
  saved.set(account, agent);
  readErrors.delete(account);
  notifySaved();
}
/** Saves `agent`, or none, to the account; its choice is known once saved. */
async function save(account: Account, agent: string | null) {
  saving.set(account, (saving.get(account) ?? 0) + 1);
  for (const listener of listeners) listener();
  try {
    await account.write(agent);
    // Known with its value, before it stops counting as pending.
    saved.set(account, agent ?? undefined);
    // A failed choice after this falls back to it, not to an older read.
    readValues.set(account, agent ?? undefined);
    known.add(account);
    recorded.add(account);
  } finally {
    saving.set(account, (saving.get(account) ?? 1) - 1);
  }
}
function subscribeSaved(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Accounts the viewer chose for this session. A choice is newer than any
// read of the account, including one started after it, so adoption stops.
const explicit = new WeakSet<Account>();
// Choices this device couldn't cache, by scope, so they still apply here.
const unsaved = new Map<string, string | null>();
function cache(scope: string, agent: string | null) {
  const saves = writeView(scope, KEY, agent);
  if (saves) unsaved.delete(scope);
  else unsaved.set(scope, agent);
  notifySaved();
  return saves;
}
/** Makes an agent the one new Berd messages are tagged for, on this device. */
export function setDefaultAgent(scope: string, pubkey: string) {
  return cache(scope, /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null);
}

/** Abandon a failed account replacement without overwriting a newer device
 * choice made while its confirmation remained open. */
export function restoreDefaultAgent(
  scope: string,
  replacing: string,
  previous: string,
) {
  if (chosenAgent(scope) !== replacing) return false;
  return setDefaultAgent(scope, previous);
}

/** The viewer's own choice: saved here, then to their account. */
export async function chooseDefaultAgent(
  session: RelaySession,
  scope: string,
  pubkey: string,
) {
  const account = session.mainAgent;
  if (account) {
    explicit.add(account);
  }
  // A choice this device can't cache still applies here, so it is still saved
  // to the account.
  setDefaultAgent(scope, pubkey);
  if (!account) return;
  const attempt = advance(account);
  try {
    await save(account, pubkey);
  } catch {
    // Initial-read recovery must not replace an already settled account choice.
    if (revision(account) === attempt && !saved.has(account)) {
      if (readValues.has(account)) {
        remember(account, readValues.get(account));
      } else if (readFailures.has(account)) {
        adopted.delete(account);
        readErrors.set(
          account,
          readFailures.get(account) ??
            "Your Bestie couldn't be read from your account.",
        );
        saved.set(account, saved.get(account));
        notifySaved();
      } else {
        failedChoices.add(account);
      }
    }
    throw new Error(
      "Your bestie couldn't be saved to your account. Try again.",
    );
  }
  failedChoices.delete(account);
  remember(account, pubkey);
}

/** Saves that the viewer has no main agent. A failed account write restores
 * the prior device choice unless a newer choice superseded this attempt. */
export async function clearDefaultAgent(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  const previous = chosenAgent(scope);
  if (account) explicit.add(account);
  cache(scope, null);
  if (!account) return;
  const attempt = advance(account);
  try {
    await save(account, null);
  } catch {
    if (revision(account) === attempt) {
      if (previous) setDefaultAgent(scope, previous);
      if (readValues.has(account)) {
        remember(account, readValues.get(account));
      } else if (readFailures.has(account)) {
        adopted.delete(account);
        readErrors.set(
          account,
          readFailures.get(account) ??
            "Your Bestie couldn't be read from your account.",
        );
        saved.set(account, saved.get(account));
        notifySaved();
      }
    }
    throw new Error(
      "Removing your Bestie couldn't be saved to your account. Try again.",
    );
  }
  if (revision(account) === attempt) remember(account, undefined);
}

/** The viewer's Bestie as their agents read and change it: what this device
 * and the account saved (null for none), and whether the device's choice is an
 * agent the viewer can tag here, by the choices Make my bestie offers. */
export function defaultAgentControl(session: RelaySession, scope: string) {
  const tagged = async (pubkey: string | undefined) => {
    if (!pubkey) return false;
    session.agentChoices.ensure(false, true);
    await session.agentChoices.refresh();
    const choices = session.agentChoices.snapshot();
    const here = choices.selectable.some((agent) => agent.pubkey === pubkey);
    // An inventory that couldn't be read can't say an agent isn't here.
    if (!here && choices.error) throw new Error(choices.error);
    return here;
  };
  const account = session.mainAgent;
  const pending = () => !!account && !!saving.get(account);
  // A change holds a choice it hasn't confirmed until its save and rollback
  // finish, which a change started meanwhile could restore as if it had been.
  const exclusive = async <T>(change: () => Promise<T>) => {
    if (pending() || (account && changing.has(account)))
      throw new Error(
        "Another change to your owner's Bestie is still saving. Try again.",
      );
    if (!account) return change();
    changing.add(account);
    try {
      return await change();
    } finally {
      changing.delete(account);
    }
  };
  return Object.freeze({
    read: async () => {
      const device = chosenAgent(scope);
      const choice = (await account?.read()) ?? null;
      return {
        device: device ?? null,
        account: choice,
        here: await tagged(device),
      };
    },
    /** `check` runs after the inventory read, before anything is saved. */
    async set(pubkey: string, check?: () => void) {
      const here = await tagged(pubkey);
      check?.();
      if (!here)
        throw new Error(
          "Only an agent your owner owns and can tag in this community can be their Bestie.",
        );
      return exclusive(async () => {
        const previous = chosenAgent(scope);
        try {
          await chooseDefaultAgent(session, scope, pubkey);
        } catch (cause) {
          // Keep the previous choice unless a newer one replaced this attempt
          // or is still saving.
          if (chosenAgent(scope) === pubkey && !pending())
            cache(scope, previous ?? null);
          throw cause;
        }
        return {
          device: pubkey,
          account: account ? pubkey : null,
          here: true,
        };
      });
    },
    async clear() {
      return exclusive(async () => {
        await clearDefaultAgent(session, scope);
        return { device: null, account: null, here: false };
      });
    },
  });
}
export type DefaultAgentControl = ReturnType<typeof defaultAgentControl>;

/** Whether one of the viewer's agents is changing their Bestie, which a change
 * started now could undo. */
export function agentChangingBestie(session: RelaySession) {
  return !!session.mainAgent && changing.has(session.mainAgent);
}

/** Clears a deleted agent from the account only when it is still the saved
 * choice. Another agent chosen on the account is left alone. */
export async function clearDeletedDefaultAgent(
  session: RelaySession,
  scope: string,
  pubkey: string,
) {
  const account = session.mainAgent;
  if (!account) return false;
  if (account.clear) {
    explicit.add(account);
    const attempt = advance(account);
    const next = await account.clear(pubkey);
    if (revision(account) === attempt) {
      const local = chosenAgent(scope);
      if (local === undefined || local === pubkey) cache(scope, next ?? null);
      remember(account, next);
    }
    return next === undefined;
  }
  if ((await account.read()) !== pubkey) return false;
  await clearDefaultAgent(session, scope);
  return true;
}

/** A deleted agent stops being the main agent everywhere it was chosen on this
 * device. Account cleanup is separate because it needs the owning session. */
export function forgetDefaultAgent(pubkey: string) {
  clearViewValue(KEY, pubkey);
  for (const [scope, agent] of unsaved)
    if (agent === pubkey) unsaved.delete(scope);
  notifySaved();
}

/** Adopts the account's saved choice once per session. Settles even when the
 * read fails, so an offline install still gets a main agent. */
function adopt(account: Account, scope: string) {
  let pending = adopted.get(account);
  if (!pending) {
    const started = revision(account);
    pending = account.read().then(
      (record) => {
        const agent = record ?? undefined;
        if (record !== undefined) recorded.add(account);
        readValues.set(account, agent);
        readFailures.delete(account);
        if (started !== revision(account)) {
          if (failedChoices.delete(account)) remember(account, agent);
          return;
        }
        const adopts = !explicit.has(account);
        if (adopts && agent !== undefined) cache(scope, agent);
        // A choice made meanwhile is known only once it is saved.
        if (adopts) known.add(account);
        remember(account, adopts ? agent : (saved.get(account) ?? agent));
      },
      (cause) => {
        adopted.delete(account);
        const error =
          cause instanceof Error
            ? cause.message
            : "Your Bestie couldn't be read from your account.";
        readFailures.set(account, error);
        if (started !== revision(account)) {
          if (failedChoices.delete(account)) {
            readErrors.set(account, error);
            saved.set(account, saved.get(account));
            notifySaved();
          }
          return;
        }
        readErrors.set(account, error);
        // Solo still settles and can choose a device fallback while offline.
        saved.set(account, saved.get(account));
        notifySaved();
      },
    );
    adopted.set(account, pending);
  }
  return pending;
}

/** Whether the account read settled, its saved choice, and recoverable failure. */
function useAdopted(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  useEffect(() => {
    if (account) void adopt(account, scope);
  }, [account, scope]);
  const readSnapshot = () => (account ? saved.has(account) : true);
  const agentSnapshot = () => (account ? saved.get(account) : undefined);
  const errorSnapshot = () => (account ? readErrors.get(account) : undefined);
  const read = useSyncExternalStore(subscribeSaved, readSnapshot, readSnapshot);
  const agent = useSyncExternalStore(
    subscribeSaved,
    agentSnapshot,
    agentSnapshot,
  );
  const error = useSyncExternalStore(
    subscribeSaved,
    errorSnapshot,
    errorSnapshot,
  );
  return {
    read,
    agent,
    error,
    retry: () => {
      if (!account) return;
      readErrors.delete(account);
      advance(account);
      // Keep a newer confirmed choice visible while its account record is reread.
      if (saved.get(account) === undefined) saved.delete(account);
      notifySaved();
      void adopt(account, scope);
    },
  };
}

/** The account-saved choice and its read state. Without an account capability,
 * the local explicit choice is already authoritative. */
export function useSavedAgentState(session: RelaySession, scope: string) {
  const local = useChosenAgent(scope);
  const account = useAdopted(session, scope);
  return session.mainAgent
    ? account
    : { read: true, agent: local, error: undefined, retry: () => {} };
}

/** The agent saved as main on the viewer's account, when it has one; without
 * an account record, the agent saved on this device. */
export function useSavedAgent(session: RelaySession, scope: string) {
  return useSavedAgentState(session, scope).agent;
}

/** `useSavedAgent` outside React. Subscribing starts the account's
 * once-per-session read, as the hook does when it mounts. */
export function savedAgentStore(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  return Object.freeze({
    snapshot: () => (account ? saved.get(account) : chosenAgent(scope)),
    /** Whether the account's choice is known, so an undefined snapshot means
     * none was saved rather than not read yet, or unreadable. */
    known: () => !!account && known.has(account) && !saving.get(account),
    /** Whether the account is known to hold a record, of a choice or of none
     * saved. Known without one, nobody ever chose there, which isn't the same
     * as having removed a choice. */
    recorded: () => !!account && recorded.has(account),
    subscribe(listener: () => void) {
      if (account) void adopt(account, scope);
      // The device's choice is browser storage; without a window there is none
      // to follow.
      const view =
        typeof window === "undefined"
          ? () => {}
          : subscribeView(scope, listener);
      const choices = subscribeSaved(listener);
      return () => {
        view();
        choices();
      };
    },
  });
}

function chosenAgent(scope: string) {
  const value = unsaved.has(scope)
    ? unsaved.get(scope)
    : readView<unknown>(scope, KEY, null);
  return typeof value === "string" ? value : undefined;
}

/** The agent explicitly saved as main, whether or not it can be tagged now. */
export function useChosenAgent(scope: string) {
  const snapshot = useCallback(() => chosenAgent(scope), [scope]);
  return useSyncExternalStore(
    useCallback(
      (notify) => {
        const view = subscribeView(scope, notify);
        const choices = subscribeSaved(notify);
        return () => {
          view();
          choices();
        };
      },
      [scope],
    ),
    snapshot,
    snapshot,
  );
}

/**
 * The agent new Berd messages are tagged for. A chosen main agent stays chosen
 * for as long as it exists, even when its runtime is signed out or broken, so
 * a failure shows on the agent the viewer expects. Without a choice, or once
 * the chosen agent is deleted (archived), and once the account's saved choice
 * has been read, the first agent the viewer runs here, else the first they
 * can tag, becomes the main agent and is saved on this device so it doesn't
 * shift between loads. A chosen agent missing for another reason
 * is stood in for without replacing the choice. Bestie may own this choice
 * later. A requested agent, as when search opens a new chat with it, replaces
 * that choice: it is tagged once it can be, and no other agent stands in for
 * it.
 */
export function useDefaultAgent(
  session: RelaySession,
  scope: string,
  requested?: string,
): MentionRecipient | undefined {
  const adoption = useAdopted(session, scope);
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  // Archives stay known through rereads, failures and reconnects, so once
  // read they keep answering.
  const { status, readAt } = choices.archives;
  const read =
    (status !== "idle" && status !== "loading") || readAt !== undefined;
  // Without a request, nothing is picked until the account's choice is read
  // and, with an account, the archives are known, so a new chat is never
  // tagged for a stale pick.
  const settled = adoption.read && (!session.mainAgent || read);
  const fallbackReady = !requested && adoption.read && read && choices.complete;
  const picked = choices.selectable.find(
    (choice) => choice.pubkey === (requested ?? (settled ? chosen : undefined)),
  );
  const fallback =
    !picked && fallbackReady
      ? (choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined;
  const replaces =
    !!fallback &&
    (chosen === undefined || choices.archives.archived.includes(chosen));
  useEffect(() => {
    if (replaces && fallback) setDefaultAgent(scope, fallback.pubkey);
  }, [replaces, fallback, scope]);
  const agent = picked ?? fallback;
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}
