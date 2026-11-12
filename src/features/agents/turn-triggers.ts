/** Admission of the messages a turn runs for. A turn's start and each steer name
 * the messages they bring; the live lifecycle, request selection and the
 * transcript all admit them by these rules, so no projection associates a
 * message with a turn that another rejected. */
export const TURN_TRIGGER_LIMIT = 64;

/** A start's or steer's message list, admitted whole or not at all. */
export function turnTriggerIds(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length <= TURN_TRIGGER_LIMIT &&
    value.every((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))
    ? (value as string[])
    : undefined;
}

/** The messages a start or steer adds to a turn's known ones, in arrival
 * order. A list that would take the turn past the limit adds none. */
export function freshTurnTriggers(
  known: readonly string[],
  added: readonly string[] | undefined,
): string[] {
  const fresh = (added ?? []).filter(
    (id, index, ids) => !known.includes(id) && ids.indexOf(id) === index,
  );
  return known.length + fresh.length > TURN_TRIGGER_LIMIT ? [] : fresh;
}
