const ORIGIN = "https://changeset.buzz.changesets.invalid";

/** A panel link to one checkout of a recorded turn, optionally at a file.
 * It looks like a link so the host can open it beside the chat. */
export const targetFor = (turn: string, checkout: number, file?: string) =>
  `${ORIGIN}/?turn=${turn}&checkout=${checkout}${file === undefined ? "" : `&file=${encodeURIComponent(file)}`}`;

export function parseTarget(
  target: string,
): { turn: string; checkout: number; file?: string } | undefined {
  if (!target.startsWith(`${ORIGIN}/?`)) return undefined;
  const query = new URL(target).searchParams;
  const turn = query.get("turn") ?? "";
  const checkout = query.get("checkout") ?? "";
  if (!/^[0-9a-z]{1,40}$/.test(turn) || !/^\d{1,2}$/.test(checkout))
    return undefined;
  const file = query.get("file");
  return {
    turn,
    checkout: Number(checkout),
    ...(file === null ? {} : { file }),
  };
}
