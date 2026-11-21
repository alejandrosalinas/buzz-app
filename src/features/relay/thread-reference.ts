/** Message kinds that may appear as a thread root or reply. */
export const isThreadContent = (event: { kind: number }) =>
  [9, 40002, 40008].includes(event.kind);

/** NIP-10 matches relay ingest: last valid marked root/reply wins; a lone root is not a reply. */
export function threadReference(event: {
  readonly tags: readonly (readonly string[])[];
}) {
  let root: string | undefined;
  let reply: string | undefined;
  for (const [name, value, , marker] of event.tags) {
    if (name !== "e" || !value || !/^[0-9a-f]{64}$/i.test(value)) continue;
    if (marker === "root") root = value.toLowerCase();
    if (marker === "reply") reply = value.toLowerCase();
  }
  return reply ? { rootId: root ?? reply, parentId: reply } : undefined;
}
