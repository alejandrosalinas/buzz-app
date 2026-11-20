// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
// For each section the first that applies wins: a locked section's default
// text, the owner's choice, the text of the plugin that manages the
// conversation, the host variant, the default text.
import { attribute } from "../plugin-instructions";
import {
  hash,
  type OwnerChoice,
  type SectionChoices,
  textProblem,
  wrapped,
} from "./choices";
import { type Facts, LAYOUT, locked, SECTIONS, type Section } from "./index";

/** A section as printed: `source` names who replaced its text, and an empty
 * body is a section the owner turned off. */
type Printed = Readonly<{
  section: Section;
  body: string;
  source?: "owner" | "plugin";
}>;

/** The owner's choice for `section`, when it may have one and the choice is
 * well formed. Anything else is as if there were none. */
function ownerChoice(
  section: Section,
  choices: SectionChoices | undefined,
): OwnerChoice | undefined {
  const choice = section.owner && choices?.owner?.[section.id];
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.mode === "off") return { mode: "off" };
  return choice.mode === "custom" &&
    typeof choice.text === "string" &&
    !textProblem(choice.text)
    ? choice
    : undefined;
}

/** The managing plugin's text for `section`, when a plugin may replace it
 * and the text is well formed. */
function pluginText(section: Section, choices: SectionChoices | undefined) {
  const text = section.plugin && choices?.plugin?.sections?.[section.id];
  return typeof text === "string" && !textProblem(text) ? text : undefined;
}

/** Who replaces the text of section `id` in a prompt built with `choices`,
 * if anyone. */
export function replacedBy(id: string, choices: SectionChoices | undefined) {
  const section = SECTIONS.find((section) => section.id === id);
  if (!section) return undefined;
  if (ownerChoice(section, choices)) return "owner";
  return pluginText(section, choices) === undefined ? undefined : "plugin";
}

const bodies = (facts: Facts, choices?: SectionChoices): Printed[] =>
  SECTIONS.map((section) => {
    const owner = ownerChoice(section, choices);
    if (owner)
      return {
        section,
        source: "owner",
        body:
          owner.mode === "off"
            ? ""
            : `<owner-section id="${section.id}">\n${wrapped(owner.text)}\n</owner-section>`,
      };
    const plugin = pluginText(section, choices);
    if (plugin !== undefined)
      return {
        section,
        source: "plugin",
        body: `<plugin-section id="${section.id}" plugin="${attribute(choices?.plugin?.id ?? "")}">\n${wrapped(plugin)}\n</plugin-section>`,
      };
    return {
      section,
      body: (typeof section.text === "string"
        ? section.text
        : section.text(facts)
      ).trim(),
    };
  });
/** A default text follows its heading as Markdown does; a replacement's
 * wrapper comes straight after the heading it belongs to. */
const print = ({ section, body, source }: Printed) =>
  section.title
    ? `## ${section.title}${source ? "\n" : "\n\n"}${body}`.trimEnd()
    : body;

/** The choices the base prompt of the conversation session `key` is built
 * with; a session outside any conversation has only the owner's. */
export const sectionsOf = (
  handle:
    | { promptSections?(channelId?: string, root?: string): SectionChoices }
    | undefined,
  key: string | undefined,
) => {
  const [channelId, root] = key?.split("/") ?? [];
  return handle?.promptSections?.(channelId, root);
};

/** What `choices` change in a base prompt: the text of each section they
 * replace, or none for one turned off. Choices that change no section, such
 * as a plugin's text under the owner's own, give the same value. */
export const replacedSections = (choices?: SectionChoices) =>
  JSON.stringify(
    SECTIONS.flatMap((section) => {
      const owner = ownerChoice(section, choices);
      if (owner)
        return [[section.id, owner.mode === "off" ? null : owner.text]];
      const plugin = pluginText(section, choices);
      return plugin === undefined
        ? []
        : [[section.id, plugin, choices?.plugin?.id ?? ""]];
    }),
  );

/** What the session for conversation `key` is, as `sectionsOf` reads the
 * key: one thread, one whole conversation, or a run that joins none. */
export const placeOf = (
  key: string | undefined,
): NonNullable<Facts["place"]> =>
  !key ? "standalone" : key.includes("/") ? "thread" : "conversation";

/** One hash for a prompt's `parts`. */
export const sectionsKey = (parts: Readonly<Record<string, string>>) =>
  hash(JSON.stringify(parts));

export function composeBase(facts: Facts, choices?: SectionChoices) {
  const sections = bodies(facts, choices);
  /** Section id → a hash of its text, to see later which sections changed. */
  const parts = Object.fromEntries(
    sections.map(({ section, body }) => [section.id, hash(body)]),
  );
  return {
    // A section that is off prints nothing, not even its heading.
    text: sections
      .filter(({ body }) => body)
      .map(print)
      .join("\n\n"),
    parts,
    /** Changes when any section's text does. */
    key: sectionsKey(parts),
    /** Whether any section has other than its default text. */
    custom: sections.some(({ source }) => source),
    /** Whether any section has a plugin's text. */
    plugin: sections.some(({ source }) => source === "plugin"),
  };
}

/** The sections a session started with, kept by a harness that cannot give a
 * running session a new prompt. */
export type StartedSections = Readonly<{
  layout: number;
  parts: Readonly<Record<string, string>>;
}>;
export const startedSections = (
  parts: StartedSections["parts"],
): StartedSections => ({ layout: LAYOUT, parts });

/** The current text of each section that differs from what a session
 * `started` with, for a turn of that session; empty when none does. It is
 * the complete current set each time. A locked section is never in it: a
 * session keeps the locked text it started with. Nor can it name what to
 * replace in a prompt with another layout, or one whose sections were not
 * kept. */
export function sectionUpdates(
  started: StartedSections | undefined,
  facts: Facts,
  choices?: SectionChoices,
) {
  if (started?.layout !== LAYOUT || !started.parts) return "";
  const changed = bodies(facts, choices).filter(
    ({ section, body }) =>
      !locked(section) && started.parts[section.id] !== hash(body),
  );
  return changed.length
    ? `<base-section-updates>\nThese sections replace the sections with the same titles in your base instructions. An empty section is off now.\n\n${changed.map(print).join("\n\n")}\n</base-section-updates>`
    : "";
}
