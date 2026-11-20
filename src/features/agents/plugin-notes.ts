// A bundled plugin's small note on an agent, kept in its synced settings
// beside `preset` (`pluginNotes`, by plugin id), so it follows the agent to
// every device. An optional tag goes on each settings revision as
// ["note", pluginId, tag], so notes can be counted without reading content.
import type { JsonValue } from "../navigation/targets";

export type PluginNote = Readonly<{ data: JsonValue; tag?: string }>;
export type PluginNotes = Readonly<Record<string, PluginNote>>;

/** Largest `data`, as JSON. */
export const NOTE_BYTES = 1024;
const TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Whether a plugin id can hold a note. */
export const noteId = (id: string) => ID.test(id);
/** Plugin `id`'s note in a config or settings body. */
export const noteOf = (value: unknown, id: string) => {
  const notes = notesOf(value);
  return notes && Object.hasOwn(notes, id) ? notes[id] : undefined;
};

const size = (data: unknown) => {
  try {
    const text = JSON.stringify(data);
    return text === undefined
      ? Infinity
      : new TextEncoder().encode(text).length;
  } catch {
    return Infinity;
  }
};
const valid = (note: unknown): note is PluginNote => {
  if (!note || typeof note !== "object" || Array.isArray(note)) return false;
  const { data, tag, ...rest } = note as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    data !== undefined &&
    size(data) <= NOTE_BYTES &&
    (tag === undefined || (typeof tag === "string" && TAG.test(tag)))
  );
};

/** The valid notes a config or settings body holds; others are dropped. */
export function notesOf(value: unknown): PluginNotes | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notes = (value as { pluginNotes?: unknown }).pluginNotes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes))
    return undefined;
  return Object.fromEntries(
    Object.entries(notes).filter(([id, note]) => ID.test(id) && valid(note)),
  );
}

/** Throws unless `note` fits: JSON `data` of at most NOTE_BYTES, and a short
 * lowercase `tag`. */
export function checkNote(note: PluginNote | null) {
  if (note !== null && !valid(note))
    throw new Error(
      `A plugin note needs JSON data of at most ${NOTE_BYTES} bytes and an optional tag like "a-z0-9._:-"`,
    );
}

/** `config` with plugin `id`'s note set, or removed with `null`. */
export function withNote<C extends object>(
  config: C,
  id: string,
  note: PluginNote | null,
): C {
  const { [id]: _, ...rest } = notesOf(config) ?? {};
  return {
    ...config,
    pluginNotes: note ? { ...rest, [id]: note } : rest,
  } as C;
}

/** A settings revision's note tags, from its content. */
export const noteTags = (notes: PluginNotes | undefined) =>
  Object.entries(notes ?? {}).flatMap(([id, note]) =>
    note.tag ? [["note", id, note.tag]] : [],
  );
