// What the owner chose for the base prompt's sections, as the builder takes
// it. The builder checks each choice again when it reads it, so a bad saved
// value cannot unlock a section or break the prompt's framing.

/** The owner's choice for one owner-configurable section; none is the
 * default text. */
export type OwnerChoice = Readonly<
  { mode: "off" } | { mode: "custom"; text: string }
>;
/** Section id → choice. Resolved by the host; a harness only passes it on. */
export type SectionChoices = Readonly<{
  owner?: Readonly<Record<string, OwnerChoice>>;
}>;

/** The most UTF-8 bytes a section's replacement text has, after trimming:
 * what one plugin's instructions for a turn may have. */
export const SECTION_TEXT_BYTES = 4096;

/** Tells two texts apart; not for security. 64-bit FNV-1a, so composing stays
 * synchronous. */
export function hash(text: string) {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text))
    value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, "0");
}

/** Why `text` cannot replace a section's text; undefined when it can. */
export function textProblem(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "Enter the instructions, or choose Default or Off.";
  if (new TextEncoder().encode(trimmed).length > SECTION_TEXT_BYTES)
    return "Keep the instructions within 4 KiB.";
  // Tab and line feed are the only control characters a text may have.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it rejects.
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(trimmed))
    return "Remove the control characters from the instructions.";
  return undefined;
}

/** The tags Buzz prints around parts of a prompt or a turn. */
const HOST_TAGS =
  /<(\/?)(owner-section|plugin-section|base-section-updates|base|identity|workspace|agent-instructions|team-instructions|team|core-memory|recent-notes|community-repositories|plugin-instructions|owner-instructions|workspace-canvas|referenced-folders|referenced-skills|thread-context|conversation-context|context|mention|interest|self-handoff|plugin-wake|app-wake|buzz-events?|new-message-arrived-while-you-were-working)(?![\w-])/gi;
/** The tags that frame a section's text, which no replacement may print. */
const FRAMES = /^(owner-section|plugin-section|base-section-updates|base)$/i;
/** Inline code, as a default text names a tag in it: `<mention>`. */
const CODE = /(`[^`\n]*`)/;
/** Replacement `text` as it is printed in its wrapper: it cannot close the
 * wrapper or open or close another of Buzz's tags. A tag in inline code is a
 * reference, so it stays as written unless it frames a section. */
export const wrapped = (text: string) =>
  text
    .trim()
    .split(CODE)
    .map((part, index) =>
      part.replace(HOST_TAGS, (tag, close: string, name: string) =>
        index % 2 && !FRAMES.test(name) ? tag : `<\\${close}${name}`,
      ),
    )
    .join("");
