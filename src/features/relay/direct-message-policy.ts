/** Participant-set policy shared by the app and the existing browser broker.
 * An addition is bounded only for size: the relay counts its people. */
export function validDirectMessageParticipants(
  pubkeys: readonly string[],
  viewer: string,
  adding = false,
): boolean {
  return (
    pubkeys.length >= 1 &&
    pubkeys.length <= (adding ? MAX_DIRECT_MESSAGE_ADDITIONS : 8) &&
    new Set(pubkeys).size === pubkeys.length &&
    pubkeys.every((key) => /^[0-9a-f]{64}$/.test(key) && key !== viewer)
  );
}

/** The most people and agents one addition to a DM names. */
export const MAX_DIRECT_MESSAGE_ADDITIONS = 100;

/** The relay's refusal of an addition tagged `["history", "ask"]`: people
 * would join this DM, so the adder chooses whether they see its history. */
export const NEEDS_HISTORY_CHOICE = "needs-choice: history";

/** What to show for the relay's refusal of a DM command, from its exact
 * reason. A relay from before `ask` refuses the tag itself, which asks too. */
export function directMessageRefusal(adding: boolean, reason: unknown): string {
  const full = `${adding ? "Couldn’t add them. " : ""}A DM holds up to 9 people, not counting agents.`;
  if (
    adding &&
    (reason === NEEDS_HISTORY_CHOICE ||
      reason === 'invalid: history must be "include", got "ask"')
  )
    return NEEDS_HISTORY_CHOICE;
  // The browser host maps a refusal at admission and again on its way out.
  if (
    reason === full ||
    (typeof reason === "string" && reason.includes("at most 9 people"))
  )
    return full;
  return adding
    ? "Couldn’t add them. Try again."
    : "Could not open the direct message. Try again.";
}

/** Whether a DM of `members` is the DM of `expected`, as the relay decides:
 * by its people when it has two or more, so agents never change which DM it
 * is; otherwise by every member. */
export function sameDirectMessage(
  members: readonly string[],
  expected: ReadonlySet<string>,
  isAgent: (pubkey: string) => boolean,
): boolean {
  const people = [...expected].filter((key) => !isAgent(key));
  const shared =
    people.length >= 2 ? members.filter((key) => !isAgent(key)) : [...members];
  const required = people.length >= 2 ? new Set(people) : expected;
  return (
    shared.length === required.size && shared.every((key) => required.has(key))
  );
}
