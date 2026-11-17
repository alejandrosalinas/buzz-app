import {
  historySelection,
  historySelectionKey,
  type HistorySelection,
} from "../agents/history-presentation";
import { npubEncode, decode } from "nostr-tools/nip19";

/** Public identity locator, not a relay hint or an authority claim. */
export function profileTarget(
  pubkey: string,
  hint?: { agent: boolean },
): string | undefined {
  return /^[a-f0-9]{64}$/i.test(pubkey)
    ? hint?.agent
      ? `buzz:agent-profile:${pubkey.toLowerCase()}`
      : `nostr:${npubEncode(pubkey.toLowerCase())}`
    : undefined;
}

/** App-local avatar presentation only; never evidence of ownership or control. */
export function profileAgentHint(target: string): boolean {
  return /^buzz:agent-profile:[a-f0-9]{64}$/.test(target);
}

export function profilePanelKey(target: string): string | undefined {
  if (profileHistoryActive(target)) {
    const base = profileHistoryBase(target);
    return profilePanelKey(base) ?? profileActivityViewKey(base);
  }
  return profileAgentHint(target)
    ? target.slice("buzz:agent-profile:".length)
    : profileKey(target);
}

/** Public message/composer input must never supply an app-local avatar hint. */
export function profileKey(target: string): string | undefined {
  if (!/^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(target))
    return undefined;
  try {
    const decoded = decode(target.slice(6));
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** App-local Activity destination, never a public identity or authority
 * claim. An agent has one, so its Activity tab is reused however it opens; an
 * opener that knows the conversation asks for its transcript with
 * `openProfileTranscript`. */
export function profileActivityViewTarget(pubkey: string): string | undefined {
  return profileTarget(pubkey)
    ? `buzz:profile?agent=${pubkey.toLowerCase()}&tab=activity`
    : undefined;
}
export function profileActivityViewKey(target: string): string | undefined {
  target = profileHistoryBase(target);
  try {
    const agent = new URL(target).searchParams.get("agent");
    return agent && target === profileActivityViewTarget(agent)
      ? agent
      : undefined;
  } catch {
    return undefined;
  }
}
/** Transcript destinations an opener has just opened, not yet claimed by the
 * profile shown for them. Each opening is numbered, so a profile can tell a
 * new one from one it already has. */
const transcriptRequests = new Map<string, number>();
/** The Buzz events an opening asks its transcript to show, by opening. */
const transcriptFocus = new Map<number, readonly string[]>();
const transcriptListeners = new Set<() => void>();
let transcriptOpenings = 0;
const changed = () => {
  for (const listener of transcriptListeners) listener();
};
export function subscribeProfileTranscripts(listener: () => void) {
  transcriptListeners.add(listener);
  return () => void transcriptListeners.delete(listener);
}
/** Opens an Activity `target` through `open`, asking the profile it opens
 * to show its conversation's transcript once. A target that is only shown
 * again, as when its retained tab remounts on returning to the channel, asks
 * for nothing. `focus` names the Buzz events whose turn the transcript shows
 * first: a message, and the message it answers. */
export function openProfileTranscript(
  target: string,
  open: (target: string) => boolean,
  focus?: readonly string[],
): boolean {
  if (!profileActivityViewKey(target)) return open(target);
  const base = profileHistoryBase(target);
  const opening = ++transcriptOpenings;
  transcriptRequests.set(base, opening);
  if (focus?.length) transcriptFocus.set(opening, focus);
  const opened = open(target);
  if (!opened) {
    transcriptRequests.delete(base);
    transcriptFocus.delete(opening);
  }
  changed();
  return opened;
}
/** The reader's presses and key presses so far, so a transcript opened for
 * them can tell whether they have since moved on themselves. */
let inputs = 0;
if (typeof window !== "undefined")
  for (const type of ["pointerdown", "keydown"])
    window.addEventListener(type, () => void inputs++, true);
export const readerInputs = () => inputs;
/** Takes the events `opening` asked its transcript to show. */
export function claimTranscriptFocus(
  opening: number,
): readonly string[] | undefined {
  const focus = transcriptFocus.get(opening);
  transcriptFocus.delete(opening);
  return focus;
}
/** The opening still asking `target`'s profile for its transcript. */
export function profileTranscriptRequest(target: string): number | undefined {
  return transcriptRequests.get(profileHistoryBase(target));
}
/** Takes `target`'s opening for the profile now showing it, so a profile
 * mounted later, as on returning to the channel, finds nothing to act on. */
export function claimProfileTranscript(target: string): number | undefined {
  target = profileHistoryBase(target);
  const opening = transcriptRequests.get(target);
  if (transcriptRequests.delete(target)) changed();
  return opening;
}
/** A config version inspector within the existing owned-agent profile. */
export function profileHistoryRoute(target: string) {
  const [base, fragment, extra] = target.split("#");
  return base && fragment?.startsWith("version=") && extra === undefined
    ? historySelection(fragment.slice("version=".length))
    : undefined;
}
export function profileHistoryTarget(
  target: string,
  selected?: HistorySelection,
) {
  const base = profileHistoryBase(target);
  return selected
    ? `${base}#version=${historySelectionKey(selected)}`
    : `${base}#versions`;
}

export function profileHistoryActive(target: string) {
  return (
    (target.split("#").length === 2 && target.endsWith("#versions")) ||
    !!profileHistoryRoute(target)
  );
}

/** A profile's version addresses share its opening; unknown fragments stay exact. */
export function profileHistoryBase(target: string): string {
  return profileHistoryActive(target)
    ? (target.split("#")[0] as string)
    : target;
}
