// The owner's choices for the base prompt's sections: for each
// owner-configurable one, the default text, off, or the owner's own text.
// They apply to all the owner's agents on this device and are kept in agent
// storage, which the standalone agent host shares. They are not a device
// setting: an agent must not change its own base instructions.
import {
  hash,
  type OwnerChoice,
  textProblem,
} from "../agent-harness/sections/choices";
import { SECTIONS, type Section } from "../agent-harness/sections";
import type { AgentStore } from "./store";

export const PROMPT_SECTIONS_KEY = "buzz.agents.prompt-sections.v1";

/** A saved choice. `basedOn` is the hash of the section's default text when
 * the owner made it, so Settings can say when that default has changed. */
export type SavedChoice = OwnerChoice & Readonly<{ basedOn: string }>;
type Saved = Readonly<Record<string, SavedChoice>>;
export type OwnerSections = Readonly<{
  /** Each choice in force, by its section's current id. */
  choices: Saved;
  /** Choices for sections that no longer exist: kept, so the owner can copy
   * their text, and not used. */
  unused: Saved;
  /** The saved value could not be read, so every section has its default. */
  unreadable?: true;
}>;

const configurable = (section: Section | undefined): section is Section =>
  !!section?.owner;
/** The section `id` names now, also by an id it had before. */
const sectionOf = (id: string, sections: readonly Section[]) =>
  sections.find((section) => section.id === id) ??
  sections.find((section) => section.aliases?.includes(id));

/** The hash of a section's default text. */
export const defaultHash = (section: Section) =>
  hash(typeof section.text === "string" ? section.text.trim() : "");

function savedChoice(value: unknown): SavedChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { mode, text, basedOn } = value as Record<string, unknown>;
  if (typeof basedOn !== "string") return undefined;
  if (mode === "off") return { mode, basedOn };
  return mode === "custom" && typeof text === "string" && !textProblem(text)
    ? { mode, text, basedOn }
    : undefined;
}

/** The owner's saved choices. One for a section the owner cannot configure,
 * or one that is malformed, is dropped. */
export function ownerSections(
  store: Pick<AgentStore, "get">,
  sections: readonly Section[] = SECTIONS,
  text = store.get(PROMPT_SECTIONS_KEY),
): OwnerSections {
  if (!text) return { choices: {}, unused: {} };
  let global: unknown;
  try {
    const value = JSON.parse(text) as { version?: unknown; global?: unknown };
    if (value?.version === 1) global = value.global;
  } catch {}
  if (!global || typeof global !== "object" || Array.isArray(global))
    return { choices: {}, unused: {}, unreadable: true };
  const choices: Record<string, SavedChoice> = {};
  const unused: Record<string, SavedChoice> = {};
  for (const [id, value] of Object.entries(global)) {
    const choice = savedChoice(value);
    if (!choice) continue;
    const section = sectionOf(id, sections);
    if (!section) unused[id] = choice;
    // A choice under the current id wins over one under an earlier id.
    else if (
      configurable(section) &&
      (section.id === id || !choices[section.id])
    )
      choices[section.id] = choice;
  }
  return { choices, unused };
}

/** Each store's saved value while a save to it is still being written, and
 * how many are. A store shows a value as soon as it is written, and puts the
 * saved one back if the write fails. */
const saving = new WeakMap<
  Pick<AgentStore, "get">,
  { saved: string | null; count: number }
>();

/** The owner's choices as the prompt builder takes them. A turn reads the
 * saved ones: a choice whose save then fails must not have reached it, for
 * an older thread restarts on a first choice. */
export function ownerChoices(store: Pick<AgentStore, "get">) {
  const pending = saving.get(store);
  const text = pending ? pending.saved : store.get(PROMPT_SECTIONS_KEY);
  return Object.fromEntries(
    Object.entries(ownerSections(store, SECTIONS, text).choices).map(
      ([id, { basedOn: _, ...choice }]): [string, OwnerChoice] => [id, choice],
    ),
  );
}

/** Replaces the owner's choices with `choices`: section id → choice, a
 * missing id meaning the default. A choice with no `basedOn` is stamped with
 * the current default's. Rejects a section the owner cannot configure and a
 * text that cannot be used; choices no longer used are kept as they are. */
export async function saveOwnerSections(
  store: AgentStore,
  choices: Readonly<
    Record<string, OwnerChoice & Readonly<{ basedOn?: string }>>
  >,
  sections: readonly Section[] = SECTIONS,
) {
  const global: Record<string, SavedChoice> = {
    ...ownerSections(store, sections).unused,
  };
  for (const [id, choice] of Object.entries(choices)) {
    const section = sections.find((section) => section.id === id);
    if (!configurable(section))
      throw new Error(
        `The base instructions have no section "${id}" to change`,
      );
    const basedOn = choice.basedOn ?? defaultHash(section);
    if (choice.mode === "off") global[id] = { mode: "off", basedOn };
    else {
      const problem = textProblem(choice.text);
      if (problem) throw new Error(`${section.title}: ${problem}`);
      global[id] = { mode: "custom", text: choice.text.trim(), basedOn };
    }
  }
  const value = Object.keys(global).length
    ? JSON.stringify({ version: 1, global })
    : null;
  const pending = saving.get(store) ?? {
    saved: store.get(PROMPT_SECTIONS_KEY),
    count: 0,
  };
  pending.count += 1;
  saving.set(store, pending);
  try {
    await store.set(PROMPT_SECTIONS_KEY, value);
    // Writes are saved in order, so this is now the saved value.
    pending.saved = value;
  } finally {
    if (!--pending.count) saving.delete(store);
  }
}
