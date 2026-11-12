import { eventDto } from "./events";

/** Versioned primary snapshot; a generic #e read cannot resolve mixed-case targets. */
export function effectiveEditFilter(id: string, channel: string) {
  return [
    {
      kinds: [9, 40002, 40008, 45001, 45003],
      ids: [id],
      "#h": [channel],
      effective_edit: 1,
      consistency: "strong",
    },
  ];
}

/** Empty replacement tags are authoritative, never a reason to use the original. */
export function effectiveEditDto(value: unknown, id: string, channel: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("effective_edit" in value) ||
    value.effective_edit !== 1 ||
    !("original" in value) ||
    !("edit" in value)
  )
    throw new Error("Relay must support effective_edit v1 before editing.");
  const original = eventDto(value.original);
  const inChannel = (event: typeof original) =>
    event.tags.find((t) => t[0] === "h")?.[1] === channel;
  if (
    original.id !== id ||
    ![9, 40002, 40008, 45001, 45003].includes(original.kind) ||
    !inChannel(original)
  )
    throw new Error("Effective edit response has the wrong original.");
  if (value.edit === null) return original;
  const edit = eventDto(value.edit);
  const target = edit.tags.find(
    (t) => t[0] === "e" && /^[0-9a-f]{64}$/i.test(t[1] ?? ""),
  )?.[1];
  if (edit.kind !== 40003 || !inChannel(edit) || target?.toLowerCase() !== id)
    throw new Error("Effective edit response has the wrong replacement.");
  return edit;
}
