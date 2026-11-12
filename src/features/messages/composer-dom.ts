import type { MentionDraft, MentionRecipient } from "./mention-draft";
import type { ComposerResource } from "../conversation/contracts";
import type { ComposerToken } from "./composer-token";
import type { AnnotationMark } from "./composer-annotations";
import type { AnnotationObservation } from "../conversation/contracts";

export const inlineFormats = [
  {
    mark: "bold",
    label: "Bold",
    inputType: "formatBold",
    binding: { key: "b", mod: true, shift: false },
  },
  {
    mark: "italic",
    label: "Italic",
    inputType: "formatItalic",
    binding: { key: "i", mod: true, shift: false },
  },
  {
    mark: "strike",
    label: "Strikethrough",
    inputType: "formatStrikeThrough",
    binding: { key: "x", mod: true, shift: true },
  },
  {
    mark: "spoiler",
    label: "Spoiler",
    inputType: "formatSpoiler",
    binding: { key: "p", mod: true, shift: true },
  },
  {
    mark: "code",
    label: "Code",
    inputType: "formatInlineCode",
    binding: { key: "e", mod: true, shift: false },
    // Slack's chord, for people moving over.
    aliases: [{ key: "c", mod: true, shift: true }],
  },
] as const;
export type InlineFormat = (typeof inlineFormats)[number]["mark"];
export const blockFormats = [
  {
    mark: "code_block",
    label: "Code block",
    binding: { key: "c", mod: true, alt: true, shift: false },
    aliases: [{ key: "c", mod: true, alt: true, shift: true }],
  },
  {
    mark: "bullet_list",
    label: "Bullet list",
    binding: { key: "8", mod: true, shift: true },
  },
  {
    mark: "ordered_list",
    label: "Ordered list",
    binding: { key: "7", mod: true, shift: true },
  },
  {
    mark: "blockquote",
    label: "Quote",
    binding: { key: "b", mod: true, shift: true },
    aliases: [{ key: "9", mod: true, shift: true }],
  },
] as const;
export type BlockFormat = (typeof blockFormats)[number]["mark"];
export type ComposerFormat = InlineFormat | BlockFormat;
export const composerFormats = [...inlineFormats, ...blockFormats];
export type ComposerFormatBinding = Readonly<{
  key: string;
  mod: true;
  shift: boolean;
  alt?: boolean;
}>;
/** Every chord a format answers to; the first is the one hints show. */
export function formatBindings(
  format: (typeof composerFormats)[number],
): readonly ComposerFormatBinding[] {
  return [format.binding, ...("aliases" in format ? format.aliases : [])];
}
/** Add or edit a link around the selection: Buzz's ⌘K, then Slack's ⌘⇧U. */
export const linkBindings: readonly ComposerFormatBinding[] = [
  { key: "k", mod: true, shift: false },
  { key: "u", mod: true, shift: true },
];

export type ComposerLinkEdit = {
  text: string;
  href: string;
  existing: boolean;
  save(text: string, href: string): boolean;
  remove(): boolean;
};

/** Public commands remain in authored-source offsets. Only the editor adapter
 * translates them into document positions; callers never manipulate its DOM. */
export type ComposerInputElement = HTMLDivElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  disabled: boolean;
  readOnly: boolean;
  setSelectionRange(start: number, end: number, direction?: string): void;
  insertText(
    text: string,
    recipient?: MentionRecipient | readonly MentionRecipient[],
    range?: { start: number; end: number },
    /** The key typed to end the query. A closing colon is recorded before
     * conversion for one-step undo; after recipients, it takes the place of
     * the space that follows each one. */
    terminator?: string,
    /** Automatic edits preserve focus and the current selection. */
    focus?: boolean,
  ): boolean;
  replaceRecipients(recipients: readonly MentionRecipient[]): boolean;
  /** Replace the typed `@name` with a chip the host is still resolving,
   * followed by the key that ended it (a space by default); the returned id
   * names it until `settlePendingMention`. One undo step. */
  insertPendingMention(
    name: string,
    range: { start: number; end: number },
    terminator?: string,
  ): string | false;
  /** Turn a pending chip into its recipient, or back into its typed text.
   * Outside undo history and allowed while sending; false once the chip is
   * gone. Under an IME composition the settle is held until it ends, and the
   * promise is the replay's outcome. */
  settlePendingMention(
    id: string,
    recipient: MentionRecipient | null,
  ): boolean | Promise<boolean>;
  /** Extend a pending chip over `remainder`, the text right after it, into one
   * chip named by both: the host matched the words typed after the chip to a
   * longer known name. Outside undo history and allowed while sending, held
   * under an IME composition like a settle; false once the chip is gone or the
   * text after it no longer begins with `remainder`. */
  extendPendingMention(
    id: string,
    remainder: string,
  ): boolean | Promise<boolean>;
  /** Host-owned inline link atom at the caret; a string is the rejection reason. */
  insertResource(resource: ComposerResource): true | string;
  /** A semantic chip over the open query, one undo step. */
  insertToken(
    token: ComposerToken,
    range: { start: number; end: number },
  ): boolean;
  toggleFormat(format: ComposerFormat): void;
  insertLineBreak(): boolean;
  editLink(): ComposerLinkEdit | null;
  removeRecipient(pubkey: string): void;
  undo(redo: boolean): void;
  reset(draft: MentionDraft): void;
  /** Retain this editor's document, selection and undo state across a temporary edit. */
  checkpoint(): () => void;
  /** The shown annotations that are actionable: none after an edit, and none
   * of a publication once it is withdrawn or replaced. */
  readonly shownAnnotations: readonly AnnotationMark[];
  /** The draft annotators may mark now, or null while the editor is unfocused,
   * not editable or composing. */
  annotationObservation(): AnnotationObservation | null;
  /** Underline validated marks for `revision`; an empty list clears them. */
  showAnnotations(revision: number, marks: readonly AnnotationMark[]): boolean;
  /** Replace a shown mark's text with one of its replacements, in one undo step. */
  replaceAnnotation(
    revision: number,
    target: Readonly<{ start: number; end: number; text: string }>,
    replacement: string,
  ): boolean;
};
/** The person asked for the actions on a shown annotation. */
export type AnnotationMenuRequest = Readonly<{
  revision: number;
  mark: AnnotationMark;
  anchor: Readonly<{ getBoundingClientRect(): DOMRect }>;
}>;
