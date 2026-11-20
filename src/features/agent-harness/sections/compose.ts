// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
// For each section the first that applies wins: a locked section's default
// text, the owner's choice, the host variant, the default text.
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
type Printed = Readonly<{ section: Section; body: string; source?: "owner" }>;

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
