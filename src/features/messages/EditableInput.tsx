import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
  type HTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  EditorState,
  Plugin,
  Selection,
  AllSelection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import {
  history,
  undo,
  redo,
  closeHistory,
  isHistoryTransaction,
} from "prosemirror-history";
import {
  toggleMark,
  joinBackward,
  joinForward,
  deleteSelection,
  selectAll,
} from "prosemirror-commands";
import { sinkListItem, liftListItem } from "prosemirror-schema-list";
import {
  Fragment,
  Slice,
  type Node as EditorNode,
  type ResolvedPos,
} from "prosemirror-model";
import {
  composerSchema,
  readComposerDocument,
  projectComposerDocument,
  composerMarkdownContext,
  markdownRanges,
  composerResource,
  brokenResources,
  resourceBlockingMarks,
} from "./composer-document";
import { scanMarkdown } from "../relay/message-content";
import type { ComposerResource } from "../conversation/contracts";
import {
  activeBlockFormats,
  apply,
  toggleComposerBlock,
  composerBlockLineBreak,
  composerBlockPrefix,
  composerCodeFence,
  composerFenceDelimiters,
  composerPrefixDelimiters,
} from "./composer-blocks";
import { composerLinkLabel } from "./composer-link-label";
import {
  applyComposerInlineInput,
  composerInlineDelimiters,
} from "./composer-inline-input";
import { composerMarkdown } from "./composer-markdown";
import {
  buzzCopyDocument,
  externalLinkMarkdown,
  composerClipboard,
  identityLink,
} from "./composer-clipboard";
import {
  mentionBoundary,
  mentionDraft,
  type MentionDraft,
  type MentionRecipient,
} from "./mention-draft";
import {
  inlineFormats,
  blockFormats,
  composerFormats,
  formatBindings,
  linkBindings,
  type ComposerFormat,
  type ComposerFormatBinding,
  type ComposerLinkEdit,
  type ComposerInputElement,
} from "./composer-dom";
import { isApplePlatform } from "../shortcuts/format";
import { macWebKit, webKit } from "./mac-webkit";
import { useMessageAutocorrectPreference } from "./autocorrect-preference";
import { composerLinkUrl } from "./composer-link";
import { messageLinkParts } from "./message-link-parts";
import { updatePlainLinks, type PlainLink } from "./composer-link-edit";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import "prosemirror-view/style/prosemirror.css";
import styles from "./EditableInput.module.css";

export type EditorDecoration = {
  start: number;
  end: number;
  content: ReactNode;
  editAsText?: boolean;
};
/** Characters a caret or function key leaves in the document when the host's
 * native text-input path commits the key as if typed. In the desktop build a
 * Right Arrow press can reach WebKit as a key event whose text is the key's raw
 * keyboard-layout translation, U+001D, rather than AppKit's function-key
 * character U+F703: the arrows translate to U+001C through U+001F, Home and End
 * to U+0001 and U+0004, Page Up and Page Down to U+000B and U+000C. WebKit
 * blanks a key event's text only for the private-use block U+F700 through
 * U+F7FF, so such an event types the control character and never moves the
 * caret. The private-use block is refused as well (NSUpArrowFunctionKey U+F700
 * through NSModeSwitchFunctionKey U+F747). No font has a glyph for any of these
 * and no layout types them as prose; the whole Unicode Control category (C0,
 * DEL and C1) is covered, except the tab, newline and carriage return that
 * typed text legitimately holds. */
const CONTROL_CHARACTERS = /[\p{Cc}\uF700-\uF747]/gu;
/** The control characters typed text holds: tab, newline and carriage return. */
const TYPED_CONTROLS = /[\t\n\r]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** True when a native text insertion holds only control characters. Text that
 * mixes them with real characters is not control text and passes untouched. */
function controlCharacterText(text: string | null | undefined) {
  return (
    !!text &&
    !TYPED_CONTROLS.test(text) &&
    !text.replace(CONTROL_CHARACTERS, "")
  );
}
/** Caret keys by physical code and by legacy key code, the two identities WebKit
 * still derives from the hardware key when it reports a layout translation as
 * `key`. Pressing such a key must move the caret, not type the character. */
const CARET_KEYS = new Map<string | number, string>([
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  [33, "PageUp"],
  [34, "PageDown"],
  [35, "End"],
  [36, "Home"],
  [37, "ArrowLeft"],
  [38, "ArrowUp"],
  [39, "ArrowRight"],
  [40, "ArrowDown"],
]);
/** The key a keydown names, restoring a caret key the host reported as a control
 * character (Right Arrow arrives as U+001D) from its code. */
function keyboardKey(
  event: Pick<globalThis.KeyboardEvent, "key" | "code" | "keyCode">,
) {
  if (!controlCharacterText(event.key)) return event.key;
  return (
    CARET_KEYS.get(event.code) ?? CARET_KEYS.get(event.keyCode) ?? event.key
  );
}
/** The source offsets of the line edges, between line breaks, around `offset`. */
function lineBounds(text: string, offset: number) {
  const end = text.indexOf("\n", offset);
  return {
    start: offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1,
    end: end < 0 ? text.length : end,
  };
}
/** Moves the selection head to a document position, keeping the anchor when
 * extending, and scrolls it into view. */
function moveHead(editor: EditorView, head: number, extend: boolean) {
  const { tr, selection, doc } = editor.state;
  editor.dispatch(
    tr
      .setSelection(
        TextSelection.create(doc, extend ? selection.anchor : head, head),
      )
      .scrollIntoView(),
  );
}
/** Moves the head for plain or Shift Up and Down where the browser cannot. A
 * line that holds nothing but a token, or part of a wrapped one, offers no
 * caret position besides the token's edge, so native Up and Down stall there
 * in WebKit and jump to a document edge in Chromium, entering such a line and
 * leaving it alike. Such a line is entered at the token edge it holds, or
 * crossed to the far edge when it holds neither, and left for the position on
 * the neighbouring line nearest the caret's column. The token's client rects
 * give its lines, so a line scrolled out of the composer still counts.
 * A caret at a soft wrap is measured on the line it leaves: a move may go one
 * line too far but never stalls. Every other line move stays native, from a
 * DOM caret the browser can move. The Mac's emacs-style Ctrl+N and Ctrl+P
 * line moves stay native too, and can still stall on such a line: they are
 * rare in a composer and would need a platform key binding here. */
function crossTokenLine(
  editor: EditorView,
  tokens: ReadonlyMap<HTMLElement, { position(): number | undefined }>,
  key: string,
  event: Pick<
    globalThis.KeyboardEvent,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
) {
  const up = key === "ArrowUp";
  const extend = event.shiftKey;
  const { selection, doc } = editor.state;
  if (
    (!up && key !== "ArrowDown") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(selection instanceof TextSelection) ||
    !tokens.size
  )
    return false;
  const origin = extend ? selection.head : up ? selection.from : selection.to;
  // A line break, a hard break or a typed newline, directly before `pos`.
  const broken = (pos: number) =>
    doc.textBetween(Math.max(pos - 1, 0), pos) === "\n";
  // Where a caret at `pos` is drawn. Side -1 measures the character before,
  // which keeps a token's end on the token's line, but past a line break that
  // is the break itself, drawn at the end of the line above. A textblock start
  // has nothing before it, and Chromium draws no rect before a leading newline.
  const at = (pos: number, side: -1 | 1) =>
    editor.coordsAtPos(
      pos,
      broken(pos) || !doc.resolve(pos).parentOffset ? 1 : side,
    );
  const caret = at(origin, up ? -1 : 1);
  const level = (line: { top: number; bottom: number }) =>
    (line.top + line.bottom) / 2;
  const holds = (line?: { top: number; bottom: number }, point = caret) =>
    !!line && line.top <= level(point) && level(point) <= line.bottom;
  // The position beside a token that is drawn on the neighbouring line when
  // the token starts or ends its own: past a line break, into the adjacent
  // textblock, or else the token edge.
  const outside = (pos: number, dir: -1 | 1) => {
    const $pos = doc.resolve(pos);
    if (!(dir < 0 ? $pos.nodeBefore : $pos.nodeAfter))
      return Selection.findFrom(doc.resolve(pos + dir), dir, true)?.head;
    const next = pos + dir;
    return broken(dir < 0 ? pos : next) ? next : pos;
  };
  // Stepping off a token keeps the caret's column, as a browser does between
  // lines: from `edge`, the near end of the neighbouring `line`, the position
  // on that line drawn nearest the caret. Landing at the near end instead adds
  // only the line break to a Shift selection, which looks like no move at all.
  // Positions are measured rather than hit-tested, so a line scrolled out of
  // the composer still counts. Each is measured where a caret there is drawn,
  // so a soft wrap belongs to the line after it. Only grapheme boundaries
  // count: a position inside an emoji is drawn at its glyph, and a Shift
  // selection ending there splits the character. Each inline leaf reads as a
  // newline, one character that nothing after it can join, so the text's
  // offsets are the textblock's positions and the edge after a token counts.
  const column = (
    edge: number | undefined,
    line?: { top: number; bottom: number },
  ) => {
    if (edge === undefined) return edge;
    const $edge = doc.resolve(edge);
    const { parent } = $edge;
    const text = parent.textBetween(0, parent.content.size, undefined, "\n");
    const positions = [...graphemes.segment(text), { index: text.length }]
      .map(({ index }) => $edge.start() + index)
      .filter((pos) => (up ? pos <= edge : pos >= edge));
    let head = edge;
    let gap = Number.POSITIVE_INFINITY;
    for (const pos of up ? positions.reverse() : positions) {
      const point = editor.coordsAtPos(pos, 1);
      if (!holds(line, point)) break;
      const distance = Math.abs(point.left - caret.left);
      if (distance < gap) [head, gap] = [pos, distance];
    }
    return head;
  };
  // A Shift press then settles the head by the selection it leaves. Toward
  // the anchor, it may reach the anchor but never pass it, and it collapses
  // there rather than leave a lone line break selected, which looks collapsed
  // and which typing would replace, joining two lines. Away from the anchor,
  // growing by a lone break onto a token's near edge looks like no move at
  // all, so it takes the token. Collapsing only applies toward the anchor: from
  // a collapsed caret, a lone break onto an empty line is the whole move, as
  // that line holds nothing else.
  const { anchor } = selection;
  const lone = (start: number, end: number) =>
    doc.textBetween(Math.min(start, end), Math.max(start, end), "\n") === "\n";
  const shifted = (head: number) => {
    if (up ? origin > anchor : origin < anchor)
      return (up ? head <= anchor : head >= anchor) || lone(anchor, head)
        ? anchor
        : head;
    const from = up ? head - 1 : head;
    const token = [...tokens.values()].some((host) => host.position() === from);
    return token && lone(origin, head) ? (up ? from : from + 1) : head;
  };
  for (const [element, host] of tokens) {
    const from = host.position();
    if (from === undefined) continue;
    const to = from + 1;
    // Bidi reordering can split a token into several rects on one line, as
    // WebKit reports them, so a rect on its predecessor's line is folded in.
    const rects = [...element.getClientRects()];
    const lines = rects.filter((rect, index) => !holds(rects[index - 1], rect));
    const last = lines.length - 1;
    const before = outside(from, -1);
    const after = outside(to, 1);
    const above = before === undefined ? undefined : at(before, -1);
    const below = after === undefined ? undefined : at(after, 1);
    for (const [index, line] of lines.entries()) {
      const alone =
        (index > 0 || !above || level(above) < line.top) &&
        (index < last || !below || level(below) > line.bottom);
      // WebKit's native move onto a line the token is split across can put
      // the caret inside the token, so such a line is entered here too. It is
      // left natively, which works from either edge. Text beside the token can
      // put `previous` on this very line, so a caret already on it is not
      // entering.
      const split = rects.filter((rect) => holds(line, rect)).length > 1;
      if (!alone && !split) continue;
      const previous = up
        ? (lines[index + 1] ?? below)
        : (lines[index - 1] ?? above);
      let head: number | undefined;
      // Entering: stop at the edge this line holds, or cross a middle line.
      if (holds(previous) && !holds(line))
        head = up ? (index === last ? to : from) : index === 0 ? from : to;
      // Leaving from the edge: cross the rest of the token, or step off it.
      else if (
        alone &&
        holds(line) &&
        ((index === 0 && origin === from) || (index === last && origin === to))
      )
        head = up
          ? index > 0
            ? from
            : column(before, above)
          : index < last
            ? to
            : column(after, below);
      if (head === undefined || (up ? head >= origin : head <= origin))
        continue;
      moveHead(editor, extend ? shifted(head) : head, extend);
      return true;
    }
  }
  // After a token, the DOM caret sits between its element and the text that
  // follows. Once WebKit, on any platform, has drawn the caret there beside a
  // wrapped token, Down stalls; from the text's start, the same position, it
  // moves. The step is harmless beside a token that does not wrap, so it is
  // not limited to wrapped ones. Up and Chromium need no help.
  const native = editor.dom.ownerDocument.getSelection();
  const next = native?.focusNode?.childNodes[native.focusOffset];
  const token = native?.focusNode?.childNodes[native.focusOffset - 1];
  if (
    !up &&
    webKit() &&
    native &&
    next?.nodeType === Node.TEXT_NODE &&
    token instanceof HTMLElement &&
    tokens.has(token)
  ) {
    if (native.isCollapsed) native.collapse(next, 0);
    else native.extend(next, 0);
  }
  return false;
}
type PendingChip = { id: string; name: string };
// Pending chip ids outlive an editor: a host keeps its resolvers across remounts.
let pendingChips = 0;
// Token hosts are keyed so one chip leaving keeps every later chip mounted.
let tokenHosts = 0;
export type EditableInputProps = Omit<
  HTMLAttributes<ComposerInputElement>,
  "onChange" | "onInput"
> & {
  ref: RefObject<ComposerInputElement | null>;
  value: string;
  disabled: boolean;
  placeholder: string;
  maxLength: number;
  onDraftChange(draft: MentionDraft): void;
  onFormatsChange(active: readonly ComposerFormat[]): void;
  onEditLink?(edit: ComposerLinkEdit): void;
  /** A paste would exceed the serialized message budget; nothing was inserted. */
  onPasteTooLong?(): void;
  /** Vet a pasted identity link as a notification recipient: the recipient under
   * its current name, or null to keep the display-only chip. */
  acceptRecipient?(pubkey: string): MentionRecipient | null;
};

/** ProseMirror owns native editing, composition, selection and a single history.
 * React owns only the noneditable token artwork and the surrounding composer. */
export function EditableInput({
  ref,
  draft,
  decorationsFor,
  value: _value,
  disabled,
  placeholder,
  maxLength,
  onDraftChange,
  onFormatsChange,
  onEditLink,
  onPasteTooLong,
  acceptRecipient,
  ...events
}: EditableInputProps & {
  draft: MentionDraft;
  decorationsFor(draft: MentionDraft): readonly EditorDecoration[];
}) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const { enabled: autocorrect } = useMessageAutocorrectPreference();
  const current = useRef({
    draft,
    decorationsFor,
    maxLength,
    onDraftChange,
    onFormatsChange,
    onEditLink,
    onPasteTooLong,
    acceptRecipient,
    disabled,
    placeholder,
    autocorrect,
  });
  current.current = {
    draft,
    decorationsFor,
    maxLength,
    onDraftChange,
    onFormatsChange,
    onEditLink,
    onPasteTooLong,
    acceptRecipient,
    disabled,
    placeholder,
    autocorrect,
  };
  const tokenClassName = styles.token ?? "";
  const tokenClass = useRef(tokenClassName);
  tokenClass.current = tokenClassName;
  const hosts = useRef(
    new Map<
      HTMLElement,
      {
        key: string;
        source: string;
        resource: ComposerResource | null;
        pending: PendingChip | null;
        position(): number | undefined;
      }
    >(),
  );
  const [, refresh] = useState(0);
  const scrollAfterTokens = useRef(false);
  const composing = useRef(false);
  /** Pending-chip settles and extensions that landed during an IME
   * composition, applied when it ends. */
  const heldSettles = useRef<
    { apply(): boolean; resolve(applied: boolean): void }[]
  >([]);
  const pointing = useRef(false);
  const nativeEditing = useRef(false);
  const plain = useRef<PlainLink[]>([]);
  const locked = useRef(false);
  const emitted = useRef(draft);
  const api = useRef<{
    sync(draft: MentionDraft, reset?: boolean): void;
    /** Applies the settles held through the composition that has just ended. */
    settleHeld(): void;
  } | null>(null);

  useLayoutEffect(() => {
    const document = mount.current?.ownerDocument;
    if (!document) return;
    const release = () => {
      pointing.current = false;
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    document.defaultView?.addEventListener("blur", release);
    return () => {
      release();
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.defaultView?.removeEventListener("blur", release);
    };
  }, []);

  useLayoutEffect(() => {
    if (!mount.current) return;
    const initial = readComposerDocument(
      current.current.draft,
      current.current.decorationsFor(current.current.draft),
    );
    let editor: EditorView;
    let separateHistory = false;
    // Mod+Shift+V (and Apple's ⌥⇧⌘V) pastes plain text verbatim. The native
    // command fires the paste event; the held chord, or the desktop menu's
    // `buzz:paste-plain` sent just before its command, marks it as raw.
    let plainPaste = false;
    const editable = () => !current.current.disabled && !locked.current;
    // Selection events and completion read value/selection several times per
    // keystroke; projectComposerDocument memoizes per immutable document.
    const projection = () => projectComposerDocument(editor.state.doc);
    const tokenViews = () => refresh((revision) => revision + 1);
    let formats: string | undefined;
    const selected = () => {
      const { from, to, empty, $from } = editor.state.selection;
      const active = inlineFormats
        .filter(({ mark }) => {
          const type = composerSchema.marks[mark];
          let present = empty
            ? !!type.isInSet(editor.state.storedMarks ?? $from.marks())
            : true;
          if (!empty)
            editor.state.doc.nodesBetween(from, to, (node) => {
              if (node.isInline && !type.isInSet(node.marks)) present = false;
            });
          return present;
        })
        .map(({ mark }) => mark);
      const next = [...active, ...activeBlockFormats(editor.state)];
      // Every transaction lands here; an unchanged toolbar state must not
      // re-render the whole composer once more per keystroke.
      if (next.join() !== formats) {
        formats = next.join();
        current.current.onFormatsChange(next);
      }
      editor.dom.dispatchEvent(new Event("select"));
    };
    const normalize = new Plugin({
      filterTransaction(tr) {
        return (
          !tr.docChanged ||
          composerMarkdown(projectComposerDocument(tr.doc).draft).length <=
            current.current.maxLength
        );
      },
      appendTransaction(transactions, old, state) {
        if (
          !transactions.some(
            (tr) => tr.docChanged || tr.getMeta("composer-decorations"),
          ) ||
          transactions.some((tr) => tr.getMeta("composer-normalized"))
        )
          return;
        const before = projectComposerDocument(old.doc);
        const next = projectComposerDocument(state.doc);
        plain.current = updatePlainLinks(
          before.draft.text,
          next.draft.text,
          before.tokens.filter((token) => token.editAsText),
          plain.current,
          transactions
            .find((tr) => tr.getMeta("composer-edit"))
            ?.getMeta("composer-edit"),
        );
        const safe = mentionDraft(next.draft);
        const decorations = current.current
          .decorationsFor(safe)
          .filter((item) => {
            const from = next.position(item.start),
              to = next.position(item.end, -1);
            if (
              next.blocks.some(
                (block) => block.code && from >= block.from && to <= block.to,
              )
            )
              return false;
            return (
              (safe.recipients.some(
                (recipient) =>
                  recipient.start === item.start && recipient.end === item.end,
              ) ||
                !state.doc.rangeHasMark(
                  from,
                  to,
                  composerSchema.marks.literal,
                )) &&
              !state.doc.rangeHasMark(from, to, composerSchema.marks.code) &&
              !state.doc.rangeHasMark(from, to, composerSchema.marks.link) &&
              !plain.current.some(
                (range) => item.start < range.end && item.end > range.start,
              )
            );
          });
        const tr = state.tr;
        // Only adopt newly recognized tokens. Never rebuild editable text from
        // Markdown here: that would discard stored marks/whitespace on each key.
        for (const item of [...decorations].reverse()) {
          if (
            next.tokens.some(
              (token) => token.start === item.start && token.end === item.end,
            )
          )
            continue;
          const from = next.position(item.start),
            to = next.position(item.end, -1);
          if (next.source(from) !== item.start || next.source(to) !== item.end)
            continue;
          tr.replaceWith(
            from,
            to,
            composerSchema.nodes.token.create(
              {
                source: safe.text.slice(item.start, item.end),
                editAsText: !!item.editAsText,
                recipient:
                  safe.recipients.find(
                    (recipient) =>
                      recipient.start === item.start &&
                      recipient.end === item.end,
                  ) ?? null,
              },
              null,
              state.doc.resolve(from).marks(),
            ),
          );
        }
        // Keep semantic recipient/resource/pending-mention atoms, but demote
        // presentation-only tokens when their renderer disappears so the source
        // is editable again. Mention-boundary edits also remove invalidated
        // recipient provenance, and return a pending mention to its typed query.
        for (const token of next.tokens) {
          if (
            token.node.attrs.recipient
              ? safe.recipients.some(
                  (item) =>
                    item.start === token.start && item.end === token.end,
                )
              : token.node.attrs.resource ||
                (token.node.attrs.pending &&
                  mentionBoundary(next.draft.text, token.end)) ||
                decorations.some(
                  // A larger decoration has already adopted any tokens inside it.
                  (item) => item.start <= token.start && item.end >= token.end,
                )
          )
            continue;
          const from = tr.mapping.map(token.from),
            to = tr.mapping.map(token.to);
          tr.replaceWith(
            from,
            to,
            composerSchema.text(token.node.attrs.source, token.node.marks),
          );
        }
        // Adjacent edits (a leading `!`, surrounding backticks) can change what
        // a resource sends. Demote it to that text, in the same history event.
        for (const token of brokenResources(tr.doc).reverse())
          tr.replaceWith(
            token.from,
            token.to,
            composerSchema.text(token.node.attrs.source, token.node.marks),
          );
        if (!tr.docChanged) return;
        if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
        return tr.setMeta("composer-normalized", true);
      },
      props: {
        decorations(state) {
          const { from, to } = state.selection;
          const ranges: Decoration[] = [];
          const first = state.doc.firstChild;
          if (
            state.doc.childCount === 1 &&
            first?.type === composerSchema.nodes.paragraph &&
            first.content.size === 0
          ) {
            ranges.push(
              Decoration.node(0, first.nodeSize, {
                "data-placeholder": current.current.placeholder,
              }),
            );
          }
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === "token" &&
              from < to &&
              from <= pos &&
              to >= pos + node.nodeSize
            )
              ranges.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  "data-editor-selected": "",
                }),
              );
          });
          return DecorationSet.create(state.doc, ranges);
        },
      },
    });
    const state = (doc = initial) =>
      EditorState.create({ doc, plugins: [history(), normalize] });
    const setRange = (start: number, end: number, direction?: string) => {
      openTokens(start, end);
      const source = projection();
      const first = source.position(start),
        last = source.position(end, -1);
      editor.dispatch(
        closeHistory(editor.state.tr).setSelection(
          TextSelection.create(
            editor.state.doc,
            direction === "backward" ? last : first,
            direction === "backward" ? first : last,
          ),
        ),
      );
    };
    const openTokens = (start: number, end: number) => {
      const source = projection();
      const inside = source.tokens.filter(
        (token) =>
          (start > token.start && start < token.end) ||
          (end > token.start && end < token.end),
      );
      if (!inside.length) return;
      const tr = editor.state.tr;
      for (const token of inside.reverse()) {
        plain.current.push({ start: token.start, end: token.end });
        tr.replaceWith(
          token.from,
          token.to,
          composerSchema.text(
            token.node.attrs.source,
            token.node.attrs.recipient
              ? [
                  ...token.node.marks,
                  composerSchema.marks.recipient.create(
                    token.node.attrs.recipient,
                  ),
                ]
              : token.node.marks,
          ),
        );
      }
      editor.dispatch(
        tr.setMeta("composer-normalized", true).setMeta("addToHistory", false),
      );
    };
    const insert = (
      text: string,
      recipient?: MentionRecipient | readonly MentionRecipient[],
      range?: { start: number; end: number },
      terminator?: string,
      focus = true,
      onTooLong?: () => void,
    ) => {
      if (!editable() || composing.current || editor.composing) return false;
      // The key that ended a name follows its mention in place of the space;
      // only text records its terminator before converting.
      const after = (recipient && terminator) || " ";
      if (recipient) terminator = undefined;
      if (terminator) {
        const source = projection();
        if (
          !range ||
          !editor.state.selection.empty ||
          source.source(editor.state.selection.from) !== range.end
        )
          return false;
        // Like inline input rules, keep the typed source as the undo target.
        const typed = editor.state.tr.insertText(terminator);
        if (
          composerMarkdown(projectComposerDocument(typed.doc).draft).length >
          current.current.maxLength
        )
          return false;
        const previous = editor.state;
        editor.dispatch(typed);
        if (editor.state === previous) return false;
        range = { start: range.start, end: range.end + terminator.length };
        openTokens(range.start, range.end);
      } else if (range && focus) setRange(range.start, range.end);
      const source = projection();
      // Do not select the shortcode in a separate transaction: undo must retain
      // the collapsed caret following the colon, not the replacement range.
      const from = range
        ? source.position(range.start)
        : editor.state.selection.from;
      const to = range
        ? source.position(range.end, -1)
        : editor.state.selection.to;
      const $from = editor.state.doc.resolve(from);
      const marks = $from.parent.type
        .allowedMarks(editor.state.storedMarks ?? $from.marks())
        .filter((mark) => mark.type !== composerSchema.marks.recipient);
      text = text.replace(/\r\n?/g, "\n");
      const tr = closeHistory(editor.state.tr);
      if (recipient) {
        const recipients: readonly MentionRecipient[] = Array.isArray(recipient)
          ? recipient
          : [recipient as MentionRecipient];
        tr.replaceWith(
          from,
          to,
          Fragment.fromArray(
            recipients.flatMap((person) => [
              $from.parent.type.spec.code
                ? composerSchema.text(`@${person.name}`, [
                    composerSchema.marks.recipient.create(person),
                  ])
                : composerSchema.nodes.token.create(
                    {
                      source: `@${person.name}`,
                      recipient: person,
                      editAsText: false,
                    },
                    null,
                    marks,
                  ),
              composerSchema.text(after, marks),
            ]),
          ),
        );
      } else if (text)
        tr.replaceWith(from, to, composerSchema.text(text, marks));
      else tr.delete(from, to);
      tr.setSelection(
        focus || !source.draft.text
          ? Selection.near(tr.doc.resolve(tr.mapping.map(to, 1)), -1)
          : editor.state.selection.map(tr.doc, tr.mapping),
      );
      if (
        Array.isArray(recipient) &&
        projectComposerDocument(tr.doc).draft.recipients.length > 32
      )
        return false;
      if (
        text &&
        composerSchema.marks.code.isInSet(editor.state.storedMarks ?? [])
      )
        tr.setStoredMarks(marks);
      if (
        composerMarkdown(projectComposerDocument(tr.doc).draft).length >
        current.current.maxLength
      ) {
        onTooLong?.();
        return !!terminator; // The typed colon landed even if conversion cannot.
      }
      const unconverted = editor.state;
      editor.dispatch(focus ? tr.scrollIntoView() : tr);
      if (terminator && editor.state !== unconverted) separateHistory = true;
      if (focus) editor.focus();
      return true;
    };
    const insertPastedText = (text: string) =>
      insert(
        text,
        undefined,
        undefined,
        undefined,
        true,
        current.current.onPasteTooLong,
      );
    /** Paste this app's own copied blocks and marks as the nodes they are. One
     * paragraph joins the caret's line; anything else lands as sibling blocks,
     * splitting the caret's paragraph rather than merging into its text. The
     * caret then ends inside the last pasted block, as ProseMirror leaves it,
     * so Enter continues a pasted list or quote; that is deliberate. Returns
     * the range the paste occupies, which can start after the caret's text. */
    const insertDocument = (doc: EditorNode) => {
      if (!editable() || composing.current || editor.composing) return null;
      const { nodes } = composerSchema;
      const single = doc.childCount === 1 ? doc.firstChild : null;
      const tr = closeHistory(editor.state.tr);
      let from = tr.selection.from;
      if (single?.type === nodes.paragraph)
        tr.replaceSelection(new Slice(single.content, 0, 0));
      else {
        // Delete first so a selection from an item's start is placed like a
        // caret there, and a fully selected item text like an empty item.
        tr.deleteSelection();
        const { $from } = tr.selection;
        const item = $from.node(-1);
        const list =
          item.type === nodes.list_item && single?.type === $from.node(-2).type
            ? single
            : null;
        const blank = $from.parent.content.size === 0;
        if (
          $from.parentOffset === 0 &&
          $from.index(-1) === 0 &&
          item.type === nodes.list_item &&
          (list || !blank)
        ) {
          // A list item is `paragraph block*`, so no block can precede its
          // first paragraph; ProseMirror would close that paragraph empty,
          // which sends as an empty `- ` item. A pasted list of this list's
          // kind has its items join before the item instead, or take a blank
          // item's place; any other block, including a list of the other kind,
          // which keeps its own numbering, follows the item's paragraph.
          from = list ? $from.before(-1) : $from.after();
          const to =
            list && blank && item.childCount === 1 ? $from.after(-1) : from;
          const content = list ? list.content : doc.content;
          tr.replaceWith(from, to, content);
          tr.setSelection(
            Selection.near(tr.doc.resolve(from + content.size), -1),
          );
        } else {
          // A blank item that no same-kind list replaces leaves its list
          // first, as Enter there does, until its empty paragraph is no item's
          // first; a lift can move the following items under it, and they
          // leave with it. ProseMirror would otherwise keep the empty
          // paragraph beside the paste, which sends as an empty `- `.
          const blankItem = ($pos: ResolvedPos) =>
            $pos.parent.content.size === 0 &&
            $pos.node(-1).type === nodes.list_item &&
            $pos.index(-1) === 0;
          while (blankItem(tr.selection.$from)) {
            if (!apply(tr, liftListItem(nodes.list_item))) break;
          }
          from = tr.selection.from;
          tr.replaceSelection(new Slice(doc.content, 0, 0));
        }
      }
      if (
        composerMarkdown(projectComposerDocument(tr.doc).draft).length >
        current.current.maxLength
      ) {
        current.current.onPasteTooLong?.();
        return null;
      }
      editor.dispatch(tr.scrollIntoView());
      editor.focus();
      return { from, to: editor.state.selection.to };
    };
    const replaceRecipients = (recipients: readonly MentionRecipient[]) => {
      if (!editable() || composing.current || editor.composing) return false;
      const source = projection();
      const existing = new Set(
        source.draft.recipients.map((person) => person.pubkey),
      );
      const requested = new Set(recipients.map((person) => person.pubkey));
      if (
        existing.size === requested.size &&
        [...existing].every((key) => requested.has(key))
      )
        return true;
      const added = recipients.filter((person) => !existing.has(person.pubkey));
      const tr = closeHistory(editor.state.tr);
      for (const person of [...source.draft.recipients].reverse()) {
        if (requested.has(person.pubkey)) continue;
        const end =
          person.end + (source.draft.text[person.end] === " " ? 1 : 0);
        tr.delete(source.position(person.start), source.position(end, -1));
      }
      if (added.length) {
        const at = Selection.atStart(tr.doc).from;
        const code = tr.doc.resolve(at).parent.type.spec.code;
        tr.insert(
          at,
          Fragment.fromArray(
            added.flatMap((person) => [
              code
                ? composerSchema.text(`@${person.name}`, [
                    composerSchema.marks.recipient.create(person),
                  ])
                : composerSchema.nodes.token.create({
                    source: `@${person.name}`,
                    recipient: person,
                    editAsText: false,
                  }),
              composerSchema.text(" "),
            ]),
          ),
        );
      }
      const next = projectComposerDocument(tr.doc).draft;
      if (
        next.recipients.length > 32 ||
        composerMarkdown(next).length > current.current.maxLength
      )
        return false;
      tr.setSelection(editor.state.selection.map(tr.doc, tr.mapping));
      if (editor.state.storedMarks)
        tr.setStoredMarks(
          tr.selection.$from.parent.type.allowedMarks(editor.state.storedMarks),
        );
      const before = editor.state;
      editor.dispatch(tr);
      return editor.state !== before;
    };
    /** The typed `@name` becomes one atom the host resolves later: one undo
     * step, like a selected mention, and the caret moves past the key that
     * ended it. */
    const insertPendingMention = (
      name: string,
      range: { start: number; end: number },
      terminator = " ",
    ): string | false => {
      if (!editable() || composing.current || editor.composing) return false;
      const source = projection();
      const from = source.position(range.start),
        to = source.position(range.end, -1);
      const $from = editor.state.doc.resolve(from);
      if (
        !editor.state.selection.empty ||
        source.source(editor.state.selection.from) !== range.end ||
        source.draft.text.slice(range.start, range.end) !== `@${name}` ||
        $from.parent.type.spec.code
      )
        return false;
      const marks = $from.parent.type
        .allowedMarks(editor.state.storedMarks ?? $from.marks())
        .filter((mark) => mark.type !== composerSchema.marks.recipient);
      const id = `pending-${++pendingChips}`;
      const tr = closeHistory(editor.state.tr).replaceWith(
        from,
        to,
        Fragment.fromArray([
          composerSchema.nodes.token.create(
            { source: `@${name}`, pending: { id, name }, editAsText: false },
            null,
            marks,
          ),
          composerSchema.text(terminator, marks),
        ]),
      );
      tr.setSelection(
        Selection.near(tr.doc.resolve(tr.mapping.map(to, 1)), -1),
      );
      if (
        composerMarkdown(projectComposerDocument(tr.doc).draft).length >
        current.current.maxLength
      )
        return false;
      const before = editor.state;
      editor.dispatch(tr.scrollIntoView());
      if (editor.state === before) return false;
      separateHistory = true;
      editor.focus();
      return id;
    };
    const pendingToken = (id: string) =>
      projection().tokens.find((token) => token.node.attrs.pending?.id === id);
    /** Settling is not an edit: it happens outside history, while sending too,
     * and a later undo still restores the typed text through it. */
    const settlePendingMention = (
      id: string,
      recipient: MentionRecipient | null,
    ): boolean | Promise<boolean> => {
      if (!pendingToken(id)) return false;
      // A document change under a composition can drop or commit it early,
      // and this runs from a promise at any time. Hold it until compositionend
      // and answer with the replay's outcome, so the host does not treat a
      // chip that is still in the draft as settled. Only React's flag decides:
      // the event that clears it is the one that replays, while ProseMirror's
      // `composing` stays set after a composition that ended while the view
      // was not editable (a Send under the IME), and a settle held on it
      // would wait for a compositionend that never comes.
      if (composing.current) return hold(() => applySettle(id, recipient));
      return applySettle(id, recipient);
    };
    const hold = (apply: () => boolean) =>
      new Promise<boolean>((resolve) => {
        heldSettles.current.push({ apply, resolve });
      });
    const applySettle = (id: string, recipient: MentionRecipient | null) => {
      const token = pendingToken(id);
      if (!token) return false;
      const convert = (person: MentionRecipient | null) =>
        editor.state.tr
          .replaceWith(
            token.from,
            token.to,
            person
              ? composerSchema.nodes.token.create(
                  { source: `@${person.name}`, recipient: person },
                  null,
                  token.node.marks,
                )
              : composerSchema.text(token.node.attrs.source, token.node.marks),
          )
          .setMeta("composer-normalized", true)
          .setMeta("addToHistory", false);
      let tr = convert(recipient);
      // A longer current name can overrun the limit; the typed text then stands.
      if (
        recipient &&
        composerMarkdown(projectComposerDocument(tr.doc).draft).length >
          current.current.maxLength
      )
        tr = convert(null);
      editor.dispatch(tr);
      return true;
    };
    /** The words typed after a pending chip that complete a longer known name
     * join the chip, which the host then resolves under the whole name. Like a
     * settle: outside history, while sending too, held under a composition. */
    const extendPendingMention = (
      id: string,
      remainder: string,
    ): boolean | Promise<boolean> => {
      if (!remainder || !pendingToken(id)) return false;
      if (composing.current) return hold(() => applyExtend(id, remainder));
      return applyExtend(id, remainder);
    };
    const applyExtend = (id: string, remainder: string) => {
      const token = pendingToken(id);
      if (!token) return false;
      const pending: PendingChip = token.node.attrs.pending;
      const after = editor.state.doc.resolve(token.to).nodeAfter;
      // The host read the words at a name boundary; they, or what follows
      // them, may have changed since (an IME can commit ` Examples`).
      if (
        !after?.isText ||
        !after.text?.startsWith(remainder) ||
        !mentionBoundary(projection().draft.text, token.end + remainder.length)
      )
        return false;
      const name = pending.name + remainder;
      // Two steps, so the typed text stays the undo target: the chip changes
      // in place (one atom for one atom, as a settle does) and the words after
      // it leave separately.
      editor.dispatch(
        editor.state.tr
          .replaceWith(
            token.from,
            token.to,
            composerSchema.nodes.token.create(
              { source: `@${name}`, pending: { id, name }, editAsText: false },
              null,
              token.node.marks,
            ),
          )
          .delete(token.to, token.to + remainder.length)
          .setMeta("composer-normalized", true)
          .setMeta("addToHistory", false),
      );
      return true;
    };
    /** True, or the reason shown by the host. The link must survive its context. */
    const insertResource = (value: ComposerResource): true | string => {
      if (!editable() || composing.current || editor.composing)
        return "The message can't be edited right now";
      const resource = composerResource(value);
      if (!resource) return "This link can't be added";
      const { from, to, $from } = editor.state.selection;
      const stored = editor.state.storedMarks ?? $from.marks();
      const { code } = composerSchema.marks;
      if (
        $from.parent.type.spec.code ||
        code.isInSet(stored) ||
        editor.state.doc.rangeHasMark(from, to, code)
      )
        return "Links can't be added inside code";
      const marks = $from.parent.type
        .allowedMarks(stored)
        .filter((mark) => !resourceBlockingMarks().includes(mark.type));
      const source = projection();
      // Markdown links cannot nest: never split or break an existing link.
      const { doc } = editor.state;
      const start = source.source(from),
        end = source.source(to);
      if (
        composerSchema.marks.link
          .isInSet(doc.resolve(from).nodeBefore?.marks ?? [])
          ?.isInSet(doc.resolve(to).nodeAfter?.marks ?? []) ||
        scanMarkdown(composerMarkdownContext(doc, source).text).links.some(
          ({ position }) => {
            const first = position?.start.offset ?? 0,
              last = position?.end.offset ?? 0;
            return (
              first < end && last > start && !(start <= first && end >= last)
            );
          },
        )
      )
        return "Links can't be added inside another link";
      // A preceding `!` would make an image; `\` would escape the bracket.
      const gap = /[!\\]$/.test(source.draft.text.slice(0, start));
      const tr = closeHistory(editor.state.tr).replaceWith(
        from,
        to,
        Fragment.fromArray([
          ...(gap ? [composerSchema.text(" ", marks)] : []),
          composerSchema.nodes.token.create(
            { source: resource.source, resource: resource.resource },
            null,
            marks,
          ),
          composerSchema.text(" ", marks),
        ]),
      );
      tr.setSelection(
        Selection.near(tr.doc.resolve(tr.mapping.map(to, 1)), -1),
      );
      const next = projectComposerDocument(tr.doc);
      if (next.tokens.filter((token) => token.node.attrs.resource).length > 32)
        return "Add at most 32 links to one message";
      if (composerMarkdown(next.draft).length > current.current.maxLength)
        return "Message is too long to add this link";
      if (brokenResources(tr.doc, next).length)
        return "Links can't be added inside code or other Markdown here";
      editor.dispatch(tr.scrollIntoView());
      editor.focus();
      return true;
    };
    const toggleFormat = (format: ComposerFormat) => {
      if (!editable() || composing.current || editor.composing) return;
      // Formatting operates on textblock contents, not the document's outer edges.
      if (editor.state.selection instanceof AllSelection) {
        const doc = editor.state.doc;
        editor.dispatch(
          editor.state.tr.setSelection(
            TextSelection.between(
              Selection.atStart(doc).$from,
              Selection.atEnd(doc).$to,
            ),
          ),
        );
      }
      const block = blockFormats.find((item) => item.mark === format);
      if (block) {
        const tr = toggleComposerBlock(editor.state, block.mark);
        if (tr) editor.dispatch(closeHistory(tr).scrollIntoView());
        editor.focus();
        return;
      }
      if (
        format === "spoiler" &&
        editor.state.selection.empty &&
        editor.state.doc.textContent.trim()
      ) {
        const original = editor.state.selection;
        const selection = TextSelection.between(
          Selection.atStart(editor.state.doc).$from,
          Selection.atEnd(editor.state.doc).$to,
        );
        const state = EditorState.create({ doc: editor.state.doc, selection });
        toggleMark(composerSchema.marks.spoiler, null, {
          removeWhenPresent: false,
        })(state, (tr) =>
          editor.dispatch(
            closeHistory(tr.setSelection(original.map(tr.doc, tr.mapping))),
          ),
        );
        editor.focus();
        return;
      }
      if (editor.state.selection.$from.parent.type.spec.code) return;
      const source = projection();
      const { from, to } = editor.state.selection;
      // Existing Markdown code stays literal for other formats. Explicit inline
      // code treats the selected characters literally.
      if (
        format !== "code" &&
        markdownRanges(
          composerMarkdownContext(editor.state.doc, source).text,
        ).literal.some(
          (range) =>
            source.source(from) < range.end && source.source(to) >= range.start,
        )
      )
        return;
      if (format === "code" && !editor.state.selection.empty) {
        // A source token becomes literal editable text inside code. Preserve
        // explicit mention provenance, and put conversion + mark in one undo step.
        const tr = editor.state.tr;
        for (const token of [...source.tokens].reverse()) {
          if (token.from < from || token.to > to) continue;
          const marks = token.node.attrs.recipient
            ? [
                ...token.node.marks,
                composerSchema.marks.recipient.create(
                  token.node.attrs.recipient,
                ),
              ]
            : token.node.marks;
          tr.replaceWith(
            token.from,
            token.to,
            composerSchema.text(token.node.attrs.source, marks),
          );
        }
        if (tr.docChanged) {
          const state = EditorState.create({
            doc: tr.doc,
            selection: tr.selection,
          });
          toggleMark(composerSchema.marks.code, null, {
            removeWhenPresent: false,
          })(state, (mark) => {
            for (const step of mark.steps) tr.step(step);
          });
          editor.dispatch(closeHistory(tr));
          editor.focus();
          return;
        }
      }
      const mark = composerSchema.marks[format];
      if (!mark) return;
      toggleMark(mark, null, {
        removeWhenPresent: false,
      })(editor.state, (tr) => editor.dispatch(closeHistory(tr)));
      editor.focus();
    };
    const editLink = (): ComposerLinkEdit | null => {
      if (!editable() || composing.current || editor.composing) return null;
      const doc = editor.state.doc,
        source = projection();
      const context = composerMarkdownContext(doc, source);
      const literals = markdownRanges(context.text).literal;
      let { from, to } = editor.state.selection;
      if (editor.state.selection instanceof AllSelection) {
        from = Selection.atStart(doc).from;
        to = Selection.atEnd(doc).to;
      }
      if (doc.resolve(from).parent.type.spec.code) return null;
      const link = composerSchema.marks.link;
      let href = "",
        text = "",
        sourceLink = false;
      let labelContent: Fragment | undefined;
      const spans: { from: number; to: number; href: string }[] = [];
      doc.descendants((node, position) => {
        const mark = link.isInSet(node.marks);
        if (!node.isInline || !mark) return;
        const last = spans.at(-1);
        if (last?.to === position && last.href === mark.attrs.href)
          last.to += node.nodeSize;
        else
          spans.push({
            from: position,
            to: position + node.nodeSize,
            href: mark.attrs.href,
          });
      });
      const existing = spans.find((span) => from >= span.from && to <= span.to);
      if (existing) {
        from = existing.from;
        to = existing.to;
        href = existing.href;
      } else {
        // Preserve the current raw/pasted-link representation until it is edited
        // explicitly; the formatting dialog can adopt it without a global migration.
        const start = source.source(from),
          end = source.source(to);
        messageLinkParts(context.text, undefined, (first, last, url) => {
          if (sourceLink || start < first || end > last) return;
          if (
            [...literals, ...context.protected].some(
              (range) => first < range.end && last > range.start,
            )
          )
            return;
          from = source.position(first);
          to = source.position(last, -1);
          href = url;
          const raw = source.draft.text.slice(first, last);
          const label = composerLinkLabel(
            raw,
            doc.nodeAt(from)?.marks ?? doc.resolve(from).marks(),
          );
          labelContent = label;
          text = label.textBetween(0, label.size, "\n");
          sourceLink = true;
        });
      }
      if (!sourceLink)
        text = source.draft.text.slice(source.source(from), source.source(to));
      // Inline code is literal, not a nested hyperlink. Block syntax stays source.
      if (
        source.blocks.some(
          (block) => block.code && from < block.to && to > block.from,
        ) ||
        doc.rangeHasMark(from, to, composerSchema.marks.code) ||
        // Markdown links cannot nest; a resource keeps its own destination.
        source.tokens.some(
          (token) =>
            token.node.attrs.resource && token.from <= to && token.to >= from,
        ) ||
        (from === to &&
          composerSchema.marks.code.isInSet(
            editor.state.storedMarks ?? doc.resolve(from).marks(),
          )) ||
        literals.some(
          (range) =>
            source.source(from) < range.end && source.source(to) >= range.start,
        )
      )
        return null;
      let applied = false;
      const commit = (label: string, destination?: string) => {
        // Dialog callbacks are valid only for the document that supplied the range.
        if (
          applied ||
          !editable() ||
          editor.state.doc !== doc ||
          view.current !== editor ||
          composing.current
        )
          return false;
        const url =
          destination === undefined ? undefined : composerLinkUrl(destination);
        if (destination !== undefined && !url) return false;
        const value = label || url || text;
        if (!value || /[\r\n]/.test(value)) return false;
        const tr = closeHistory(editor.state.tr);
        const replace = sourceLink || value !== text || from === to;
        if (replace) {
          const marks = doc
            .resolve(from)
            .marks()
            .filter(
              (mark) =>
                ![
                  link,
                  composerSchema.marks.code,
                  composerSchema.marks.recipient,
                ].includes(mark.type),
            );
          tr.replaceWith(
            from,
            to,
            sourceLink && value === text && labelContent
              ? labelContent
              : composerSchema.text(value, marks),
          );
        }
        const end = replace ? from + value.length : to;
        tr.removeMark(from, end, link);
        tr.addMark(from, end, composerSchema.marks.literal.create());
        if (url) tr.addMark(from, end, link.create({ href: url }));
        tr.setSelection(TextSelection.create(tr.doc, end));
        tr.setStoredMarks(
          tr.doc
            .resolve(end)
            .marks()
            .filter(
              (mark) =>
                ![
                  link,
                  composerSchema.marks.literal,
                  composerSchema.marks.recipient,
                ].includes(mark.type),
            ),
        );
        if (
          composerMarkdown(projectComposerDocument(tr.doc).draft).length >
          current.current.maxLength
        )
          return false;
        applied = true;
        editor.dispatch(tr.scrollIntoView());
        return true;
      };
      return {
        text,
        href,
        existing: !!href,
        save: (label, url) => commit(label, url),
        remove: () => commit(text),
      };
    };
    const copySelection = (event: ClipboardEvent) => {
      const { from, to } = editor.state.selection;
      const content = editor.state.doc.slice(from, to, true).content;
      const doc = composerSchema.nodes.doc.create(
        null,
        content.firstChild?.isBlock
          ? content
          : composerSchema.nodes.paragraph.create(null, content),
      );
      const { text, html } = composerClipboard(doc, editor.dom.ownerDocument);
      event.clipboardData?.setData("text/plain", text);
      event.clipboardData?.setData("text/html", html);
      event.preventDefault();
    };
    /** Pasted identity links become recipients when the host accepts them; the
     * rest stay display chips. One transaction, so undo removes the paste whole. */
    const promoteRecipients = (start: number, end: number) => {
      const accept = current.current.acceptRecipient;
      if (!accept) return;
      const { tokens, draft } = projection();
      const tr = editor.state.tr;
      let count = draft.recipients.length;
      // Later tokens first: earlier positions stay valid, and each boundary
      // check sees the text that now follows the token.
      for (const token of [...tokens].reverse()) {
        if (
          token.start < start ||
          token.end > end ||
          !token.editAsText ||
          token.node.attrs.recipient
        )
          continue;
        const identity = identityLink(token.node.attrs.source);
        if (
          !identity ||
          count >= 32 ||
          !mentionBoundary(
            projectComposerDocument(tr.doc).draft.text,
            token.end,
          )
        )
          continue;
        const recipient = accept(identity.pubkey);
        if (!recipient) continue;
        tr.replaceWith(
          token.from,
          token.to,
          composerSchema.nodes.token.create(
            { source: `@${recipient.name}`, recipient, editAsText: false },
            null,
            token.node.marks,
          ),
        );
        count++;
      }
      if (tr.docChanged) editor.dispatch(tr);
    };
    const historyCommand = (forward: boolean) => {
      if (!editable() || composing.current || editor.composing) return;
      (forward ? redo : undo)(editor.state, editor.dispatch);
      editor.focus();
    };
    /** Adopts the DOM selection as the editor's. A range spanning the whole
     * document becomes AllSelection, so deleting a DOM select-all also clears
     * block structure, unless `directional`: a Shift move that has just
     * reached both document edges keeps its anchor and head, so reversing it
     * shrinks the range from its head rather than from AllSelection's fixed
     * start. */
    const syncNativeSelection = ({
      scroll = false,
      directional = false,
    } = {}) => {
      const selection = editor.dom.ownerDocument.getSelection();
      if (
        !selection?.anchorNode ||
        !selection.focusNode ||
        !editor.dom.contains(selection.anchorNode) ||
        !editor.dom.contains(selection.focusNode)
      )
        return;
      const position = (node: Node, offset: number) => {
        for (const [element, host] of hosts.current) {
          if (element.contains(node)) {
            const pos = host.position();
            if (pos !== undefined) return pos + 1;
          }
        }
        return editor.posAtDOM(node, offset);
      };
      const anchor = position(selection.anchorNode, selection.anchorOffset);
      const head = position(selection.focusNode, selection.focusOffset);
      const doc = editor.state.doc;
      // DOM select-all may end at text nodes or at the editor's child boundaries.
      // Preserve whole-document intent so deletion also clears block structure.
      const all =
        anchor !== head &&
        Math.min(anchor, head) <= Selection.atStart(doc).from &&
        Math.max(anchor, head) >= Selection.atEnd(doc).to;
      const text = TextSelection.between(
        doc.resolve(anchor),
        doc.resolve(head),
      );
      // A Shift+Arrow range covering all inline content still has a direction.
      // Do not turn an already-synchronized editor range into AllSelection.
      if (text.eq(editor.state.selection)) return;
      const next = all && !directional ? new AllSelection(doc) : text;
      if (next.eq(editor.state.selection)) return;
      const tr = editor.state.tr.setSelection(next);
      editor.dispatch(scroll ? tr.scrollIntoView() : tr);
    };
    /** Moves the caret for a caret key the host reported as a control character.
     * Left unhandled, such a keydown types the character instead of moving, so
     * the move happens here: in document terms across an inline leaf, where
     * WebKit offers extra caret positions around uneditable nodes, or a line
     * that only a token holds, and otherwise through the browser's own caret
     * motion with the platform's modifier meanings (word and line ends
     * sideways, paragraph and document ends vertically). Page keys scroll
     * without moving the caret, and Home and End do so too on Apple platforms
     * unless extending the selection. */
    const moveCaret = (key: string, event: globalThis.KeyboardEvent) => {
      const mac = isApplePlatform(navigator.platform);
      const boundary = mac ? event.metaKey : event.ctrlKey;
      const extend = event.shiftKey;
      const sideways = key === "ArrowLeft" || key === "ArrowRight";
      if (sideways && !event.altKey && !boundary) {
        const { $head, empty } = editor.state.selection;
        const backward = key === "ArrowLeft";
        const leaf = $head.textOffset
          ? null
          : backward
            ? $head.nodeBefore
            : $head.nodeAfter;
        // Only an inline leaf is stepped over in document terms. A block beside
        // the head, as after select-all, is left to the browser's caret motion.
        if ((empty || extend) && leaf?.isInline && !leaf.isText) {
          moveHead(
            editor,
            backward ? $head.pos - leaf.nodeSize : $head.pos + leaf.nodeSize,
            extend,
          );
          return true;
        }
      }
      if (crossTokenLine(editor, hosts.current, key, event)) return true;
      const selection = editor.dom.ownerDocument.getSelection();
      if (!selection || typeof selection.modify !== "function") return true;
      const alter = extend ? "extend" : "move";
      if (sideways)
        selection.modify(
          alter,
          key === "ArrowLeft" ? "left" : "right",
          boundary ? "lineboundary" : event.altKey ? "word" : "character",
        );
      else if (key === "ArrowUp" || key === "ArrowDown")
        selection.modify(
          alter,
          key === "ArrowUp" ? "backward" : "forward",
          boundary
            ? "documentboundary"
            : event.altKey
              ? "paragraphboundary"
              : "line",
        );
      else if ((key === "Home" || key === "End") && (extend || !mac))
        selection.modify(
          alter,
          key === "Home" ? "backward" : "forward",
          mac ? "documentboundary" : "lineboundary",
        );
      syncNativeSelection({ scroll: true, directional: true });
      return true;
    };
    /** Runs an Apple paragraph command in document terms, since native ones
     * stop at a token's uneditable edge. Control-A and Control-E move to the
     * paragraph's edge, and Option-Up and Option-Down first step off an edge
     * they start at, as natively. An empty draft leaves Option-Up and
     * Option-Down to the conversation shortcuts, as in Slack. Paragraphs are
     * lines of the draft text, as
     * for triple click. Control-K deletes to the paragraph's end across a
     * token. Elsewhere it stays native, which keeps Control-Y working there. */
    const paragraphKey = (event: globalThis.KeyboardEvent, named: string) => {
      const { selection } = editor.state;
      const key = named.toLowerCase();
      const control = event.ctrlKey && !event.altKey && !event.metaKey;
      const command =
        control && (key === "a" || key === "e")
          ? "move"
          : control && key === "k" && !event.shiftKey
            ? "kill"
            : event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                (named === "ArrowUp" || named === "ArrowDown")
              ? "step"
              : null;
      if (!command || !(selection instanceof TextSelection)) return false;
      const backward = key === "a" || named === "ArrowUp";
      const side = backward ? "start" : "end";
      const source = projection(),
        text = source.draft.text;
      if (command === "step" && !text) return false;
      const at = event.shiftKey
        ? selection.head
        : backward
          ? selection.from
          : selection.to;
      const offset = source.source(at);
      let line = lineBounds(text, offset);
      if (command === "step" && selection.empty && offset === line[side])
        line = lineBounds(
          text,
          Math.max(0, Math.min(offset + (backward ? -1 : 1), text.length)),
        );
      const edge = source.position(line[side], backward ? 1 : -1);
      if (command !== "kill") {
        moveHead(editor, edge, event.shiftKey);
        return true;
      }
      if (
        !selection.empty ||
        !editable() ||
        !source.tokens.some((token) => token.from < edge && token.to > at)
      )
        return false;
      editor.dispatch(
        closeHistory(editor.state.tr.delete(at, edge)).scrollIntoView(),
      );
      return true;
    };
    const adjacent = (backward: boolean, arrow: boolean, extend: boolean) => {
      const { from, to, head, anchor, empty } = editor.state.selection;
      if (!empty) {
        if (arrow && !extend) {
          editor.dispatch(
            editor.state.tr.setSelection(
              Selection.near(
                editor.state.doc.resolve(backward ? from : to),
                backward ? 1 : -1,
              ),
            ),
          );
          return true;
        }
        if (!arrow || !extend) return false;
      }
      const source = projection();
      const token = source.tokens.find(
        (token) => head === (backward ? token.to : token.from),
      );
      if (!token) return false;
      if (!token.editAsText) {
        editor.dispatch(
          editor.state.tr.setSelection(
            TextSelection.create(
              editor.state.doc,
              arrow && !extend ? (backward ? token.from : token.to) : anchor,
              backward ? token.from : token.to,
            ),
          ),
        );
        return arrow;
      }
      if (!empty) return false;
      plain.current.push({ start: token.start, end: token.end });
      const tr = editor.state.tr.replaceWith(
        token.from,
        token.to,
        composerSchema.text(token.node.attrs.source, token.node.marks),
      );
      const edge = token.from + (backward ? token.node.attrs.source.length : 0);
      const next = arrow ? edge + (backward ? -1 : 1) : edge;
      tr.setSelection(
        TextSelection.create(tr.doc, arrow && extend ? edge : next, next),
      );
      editor.dispatch(
        tr.setMeta("composer-normalized", true).setMeta("addToHistory", false),
      );
      return arrow;
    };
    editor = new EditorView(
      { mount: mount.current },
      {
        state: state(),
        editable,
        attributes: () => ({
          role: "textbox",
          "aria-multiline": "true",
          class: styles.input ?? "",
          // Keep spelling hints, but do not let native suggestions rewrite rich
          // text unless this device opts in. WebKit greys out its Correct
          // Spelling Automatically menu item while the root says "off".
          spellcheck: "true",
          autocorrect: current.current.autocorrect ? "on" : "off",
          autocapitalize: "off",
          autocomplete: "off",
          writingsuggestions: "false",
        }),
        dispatchTransaction(tr: Transaction) {
          if (tr.docChanged && separateHistory) {
            closeHistory(tr);
            separateHistory = false;
          }
          const previous = editor.state;
          // Native Backspace drops noninclusive marks via marksAcross. Keep an
          // explicit Code-on mode only for a pure deletion beside surviving code;
          // clearing the span and undo/redo must retain their own mark semantics.
          const code = composerSchema.marks.code;
          if (
            tr.docChanged &&
            code.isInSet(previous.storedMarks ?? []) &&
            !isHistoryTransaction(tr)
          ) {
            let deleted = false,
              inserted = false;
            for (const map of tr.mapping.maps)
              map.forEach((from, to, nextFrom, nextTo) => {
                deleted ||= to > from;
                inserted ||= nextTo > nextFrom;
              });
            const { empty, $from } = tr.selection;
            if (
              deleted &&
              !inserted &&
              empty &&
              [$from.nodeBefore, $from.nodeAfter].some(
                (node) => node && code.isInSet(node.marks),
              )
            )
              tr.addStoredMark(code.create());
          }
          const next = previous.applyTransaction(tr).state;
          if (previous === next) {
            editor.updateState(previous);
            return;
          }
          editor.updateState(next);
          if (tr.docChanged) {
            scrollAfterTokens.current ||=
              tr.scrolledIntoView && hosts.current.size > 0;
            emitted.current = projection().draft;
            current.current.onDraftChange(emitted.current);
            tokenViews();
          }
          selected();
        },
        nodeViews: {
          // Tokens also come and go in transactions the normalizer appends,
          // which report no change of their own; render each new host's artwork.
          token(node, _view, getPos) {
            const dom = document.createElement("span");
            dom.className = tokenClass.current;
            dom.contentEditable = "false";
            dom.dataset.source = node.attrs.source;
            hosts.current.set(dom, {
              key: `token-${++tokenHosts}`,
              source: node.attrs.source,
              resource: node.attrs.resource,
              pending: node.attrs.pending,
              position: getPos,
            });
            tokenViews();
            return {
              dom,
              ignoreMutation: () => true,
              destroy() {
                hosts.current.delete(dom);
                tokenViews();
              },
            };
          },
        },
        handleTextInput(_view, from, to, text, defaultTransaction) {
          // A caret key committed natively as a control character is refused:
          // with no transaction the document stays as it was, and ProseMirror
          // redraws the changed DOM from that state. Only the beforeinput seam
          // can stop the DOM change itself; this seam covers an insertion that
          // arrived without one, or one that was not cancelable. No key yields
          // such a character beside real text, so mixed text is left alone
          // rather than reshaped under the native selection that describes it.
          if (controlCharacterText(text)) return true;
          // Provenance is not an inheritable formatting mark. Replacing text,
          // including an identical string, revokes the identity it touches.
          const source = projection();
          const tr = (
            from === to ? editor.state.tr : closeHistory(editor.state.tr)
          ).setMeta("composer-edit", {
            text: source.draft.text,
            start: source.source(from),
            end: source.source(to),
          });
          editor.state.doc.descendants((node, pos) => {
            const mark = composerSchema.marks.recipient.isInSet(node.marks);
            if (mark && from < pos + node.nodeSize && to > pos)
              tr.removeMark(pos, pos + node.nodeSize, mark);
          });
          const marks = (
            editor.state.storedMarks ?? editor.state.doc.resolve(from).marks()
          ).filter((mark) => mark.type !== composerSchema.marks.recipient);
          if (text) tr.replaceWith(from, to, composerSchema.text(text, marks));
          else tr.delete(from, to);
          // DOM reconciliation may describe only the changed middle of a native
          // replacement. The browser selection can be after an unchanged suffix.
          tr.setSelection(
            Selection.fromJSON(tr.doc, defaultTransaction().selection.toJSON()),
          );
          // Only an explicit code toggle persists at the edge; merely moving there
          // or deleting a span must not switch the next text back into code.
          if (
            text &&
            composerSchema.marks.code.isInSet(editor.state.storedMarks ?? [])
          )
            tr.setStoredMarks(marks);
          const previous = editor.state;
          editor.dispatch(tr.scrollIntoView());
          // A typed delimiter converts in a second transaction: the third
          // character of a lone ``` or ~~~ line opens a code block at once, the
          // space after a lone list or quote marker opens that block, and a
          // closing delimiter converts its inline span. One undo restores the
          // typed source, that character included, and the next keystroke never
          // merges into the conversion. Near maxLength the typed character
          // itself can be filtered out; then nothing converts. Completions
          // claim Space on keydown when a result has a spaceId, so that Space
          // never reaches this rule; a marker line has no completion trigger.
          if (
            from === to &&
            (composerFenceDelimiters.has(text) ||
              composerPrefixDelimiters.has(text) ||
              composerInlineDelimiters.has(text)) &&
            !composing.current &&
            !editor.composing &&
            editor.state !== previous
          ) {
            const block =
              composerCodeFence(editor.state, text) ??
              composerBlockPrefix(editor.state, text);
            const conversion = block ?? editor.state.tr;
            if (block || applyComposerInlineInput(conversion, text)) {
              const unconverted = editor.state;
              editor.dispatch(closeHistory(conversion).scrollIntoView());
              // Generated delimiters or escapes in the serialized form can
              // carry the conversion past maxLength, and the normalize filter
              // then drops it. Only a conversion that landed is its own undo
              // step; otherwise the next keystroke must not start a new group.
              if (editor.state !== unconverted) separateHistory = true;
            }
          }
          return true;
        },
        handleKeyDown(_view, event) {
          if (composing.current || event.isComposing || event.keyCode === 229)
            return false;
          syncNativeSelection();
          const apple = isApplePlatform(navigator.platform);
          const primary = apple
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey;
          const named = keyboardKey(event);
          const key = named.toLowerCase();
          plainPaste =
            primary &&
            event.shiftKey &&
            (key === "v" || (event.altKey && event.code === "KeyV"));
          if (apple && paragraphKey(event, named)) return true;
          if (primary && !event.altKey && !event.shiftKey && key === "a")
            return selectAll(editor.state, editor.dispatch);
          const pressed = (binding: ComposerFormatBinding) =>
            (key === binding.key ||
              event.code === `Digit${binding.key}` ||
              (event.altKey &&
                event.code === `Key${binding.key.toUpperCase()}`)) &&
            event.shiftKey === binding.shift &&
            event.altKey === !!binding.alt;
          const format =
            primary &&
            composerFormats.find((item) => formatBindings(item).some(pressed));
          if (format) {
            if (!event.repeat) toggleFormat(format.mark);
            return true;
          }
          if (primary && linkBindings.some(pressed)) {
            const edit = editLink();
            if (
              edit &&
              (edit.existing || !editor.state.selection.empty) &&
              current.current.onEditLink
            ) {
              if (!event.repeat) current.current.onEditLink(edit);
              return true;
            }
          }
          if (primary && !event.altKey && (key === "z" || key === "y")) {
            historyCommand(event.shiftKey || key === "y");
            return true;
          }
          if (named === "ArrowLeft" || named === "ArrowRight") {
            if (
              !event.altKey &&
              !primary &&
              adjacent(named === "ArrowLeft", true, event.shiftKey)
            )
              return true;
          }
          // A caret key reported as a control character would be typed as that
          // character by the native path. Move the caret here instead.
          if (named !== event.key) return moveCaret(named, event);
          if (
            event.key === "Tab" &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            editable()
          ) {
            const command = event.shiftKey ? liftListItem : sinkListItem;
            if (
              command(composerSchema.nodes.list_item)(editor.state, (tr) =>
                editor.dispatch(closeHistory(tr)),
              )
            )
              return true;
          }
          if (event.key === "Backspace" || event.key === "Delete") {
            if (!editable()) return false;
            if (
              deleteSelection(editor.state, (tr) =>
                editor.dispatch(closeHistory(tr)),
              )
            )
              return true;
            if (event.altKey || primary) return false;
            adjacent(event.key === "Backspace", false, false);
            const { empty, $from } = editor.state.selection;
            if (
              empty &&
              $from.parent.type.spec.code &&
              !$from.parentOffset &&
              event.key === "Backspace"
            ) {
              toggleFormat("code_block");
              return true;
            }
            if (
              editable() &&
              (event.key === "Backspace" ? joinBackward : joinForward)(
                editor.state,
                (tr) => editor.dispatch(closeHistory(tr)),
              )
            )
              return true;
          }
          return false;
        },
        handleDOMEvents: {
          // A caret key moves the native caret, and ProseMirror adopts it on
          // the next selectionchange or keydown. Focus can leave first, for
          // example to a tab chosen right after the key, and ProseMirror skips
          // a selectionchange that arrives after blur. Adopt the caret now, so
          // a later return to the editor resumes where it was left.
          blur() {
            syncNativeSelection();
            // WebKitGTK can send Home/End back to a blurred editing root if
            // its native caret remains there, even with a scrollport focused.
            // Keep the saved editor caret, but release its native ownership.
            // A selected range stays available to copy or format after blur.
            const selection = editor.dom.ownerDocument.getSelection();
            if (
              webKit() &&
              selection?.isCollapsed &&
              editor.dom.contains(selection.anchorNode)
            )
              selection.removeAllRanges();
            return false;
          },
          keyup() {
            plainPaste = false;
            return false;
          },
          mousedown() {
            plainPaste = false;
            return false;
          },
          "buzz:paste-plain"() {
            plainPaste = true;
            return true;
          },
          click(_view, event) {
            // Composer links are editable text, never navigation targets.
            if (event.target instanceof Element && event.target.closest("a"))
              event.preventDefault();
            return false;
          },
          // Send/completion/cancel policy belongs to the host. ProseMirror's
          // default capture otherwise prevents Escape before React can cancel edits.
          keydown(_view, event) {
            return (
              (event.key === "Enter" || event.key === "Escape") &&
              !event.isComposing &&
              !composing.current
            );
          },
          beforeinput(_view, event) {
            // Native insertion can restore focus before its input/selectionchange
            // events. That focus must not overwrite the just-advanced caret.
            // Hold until the task ends: ProseMirror reads the inserted text in
            // a microtask, and a focus before that read would restore the caret
            // from before the character ("any" typed as "nya").
            nativeEditing.current = true;
            setTimeout(() => {
              nativeEditing.current = false;
            });
            if (!event.isComposing) syncNativeSelection();
            // The host's native text-input path can commit a caret key as a
            // control character (Right Arrow arrives as U+001D, or as AppKit's
            // U+F703) typed as text. Cancel it before the DOM changes;
            // handleTextInput refuses what arrives anyway.
            if (
              event.inputType === "insertText" &&
              event.cancelable &&
              controlCharacterText(event.data)
            ) {
              event.preventDefault();
              return true;
            }
            if (event.inputType.startsWith("delete")) {
              separateHistory = true;
              // Some native deletion commands arrive without a keydown. A selected
              // range still belongs to ProseMirror, especially across block nodes.
              if (
                event.cancelable &&
                !event.isComposing &&
                !composing.current &&
                editable() &&
                deleteSelection(editor.state, (tr) =>
                  editor.dispatch(closeHistory(tr)),
                )
              ) {
                event.preventDefault();
                return true;
              }
              if (editor.dom.ownerDocument.getSelection()?.isCollapsed)
                adjacent(event.inputType.endsWith("Backward"), false, false);
            }
            const format = inlineFormats.find(
              (item) => item.inputType === event.inputType,
            );
            if (format) {
              event.preventDefault();
              toggleFormat(format.mark);
              return true;
            }
            if (event.inputType.startsWith("history")) {
              event.preventDefault();
              historyCommand(event.inputType === "historyRedo");
              return true;
            }
            return false;
          },
          copy(_view, event) {
            copySelection(event);
            return true;
          },
          cut(_view, event) {
            copySelection(event);
            if (editable())
              editor.dispatch(closeHistory(editor.state.tr.deleteSelection()));
            return true;
          },
          paste(_view, event) {
            event.preventDefault();
            const raw = plainPaste;
            plainPaste = false;
            // File paste belongs to the host attachment capture; never replace text.
            if (
              Array.from(event.clipboardData?.items ?? []).some(
                (item) => item.kind === "file",
              )
            )
              return true;
            const plain = event.clipboardData?.getData("text/plain") ?? "";
            // Raw text replaces the selection with the caret's marks: no copied
            // structure, links, selection linking, URL spacing or recipients.
            if (raw) {
              if (plain) insertPastedText(plain);
              return true;
            }
            const code = editor.state.selection.$from.parent.type.spec.code;
            // Code takes visible text verbatim; prose preserves copied web links.
            const html = event.clipboardData?.getData("text/html") ?? "";
            const hasPlain =
              !!plain || event.clipboardData?.types?.includes("text/plain");
            const copy = code ? undefined : buzzCopyDocument(html);
            // Unformatted prose takes the text path: it inherits the caret's
            // marks and the link spacing below. Structure pastes as nodes.
            const paragraph = copy?.childCount === 1 ? copy.firstChild : null;
            const prose =
              paragraph?.type === composerSchema.nodes.paragraph &&
              paragraph.childCount <= 1 &&
              !paragraph.firstChild?.marks.length
                ? paragraph.textContent
                : undefined;
            if (copy && prose === undefined) {
              // Only the pasted content is offered: an item-start paste lands
              // after the item's text, whose display-only links stay so.
              const inserted = insertDocument(copy);
              if (inserted) {
                const after = projection();
                promoteRecipients(
                  after.source(inserted.from),
                  after.source(inserted.to),
                );
              }
              return true;
            }
            const source = projection(),
              start = source.source(editor.state.selection.from),
              end = source.source(editor.state.selection.to);
            let text =
              (!code &&
                (prose ??
                  externalLinkMarkdown(html, hasPlain ? plain : undefined))) ||
              plain ||
              "";
            if (!text) return true;
            // A bare URL pasted over selected text links the selection, as other
            // editors do. editLink() owns the guards (code, resources, unsafe
            // URLs, limits); when it declines, the paste replaces as before.
            // Like the Link dialog, a selection inside a longer link re-targets
            // the whole link, while one crossing its edge splits it.
            const url = text.trim().replace(/^<(.*)>$/, "$1");
            if (!code && !editor.state.selection.empty) {
              const bare = (value: string) => {
                let whole = false;
                messageLinkParts(value, undefined, (start, end, href) => {
                  if (start === 0 && end === value.length && href === value)
                    whole = true;
                });
                return whole;
              };
              const edit = bare(url) ? editLink() : null;
              // A whitespace-only label is not a link the timeline recognises,
              // and pasting over a selected URL swaps it rather than labelling it.
              if (
                edit?.text.trim() &&
                !bare(edit.text.trim()) &&
                edit.save(edit.text, url)
              )
                return true;
            }
            let link = false;
            if (!code)
              messageLinkParts(text, undefined, (start, end) => {
                if (start === 0 && end === text.length) link = true;
              });
            const reuse = link && source.draft.text[end] === " ";
            if (
              link &&
              !reuse &&
              source.draft.text.length - (end - start) + text.length <
                current.current.maxLength
            )
              text += " ";
            if (!insertPastedText(text)) return true;
            const inserted = projection().source(editor.state.selection.to);
            if (reuse) {
              const pos = editor.state.selection.to + 1;
              editor.dispatch(
                editor.state.tr.setSelection(
                  TextSelection.create(editor.state.doc, pos),
                ),
              );
            }
            promoteRecipients(start, inserted);
            return true;
          },
          drop(_view, event) {
            event.preventDefault();
            return true;
          },
        },
        handleClickOn(_view, _pos, node, pos, event, direct) {
          if (!direct || node.type.name !== "token" || event.shiftKey)
            return false;
          editor.dispatch(
            editor.state.tr.setSelection(
              TextSelection.create(editor.state.doc, pos + node.nodeSize),
            ),
          );
          editor.focus();
          return true;
        },
        handleDoubleClickOn(_view, _pos, node, pos, _event, direct) {
          if (!direct || node.type.name !== "token") return false;
          editor.dispatch(
            editor.state.tr.setSelection(
              TextSelection.create(editor.state.doc, pos, pos + node.nodeSize),
            ),
          );
          editor.focus();
          return true;
        },
        handleTripleClick(_view, pos) {
          const source = projection();
          const { start, end } = lineBounds(
            source.draft.text,
            source.source(pos),
          );
          // Include the line's break, as native triple click does.
          setRange(start, Math.min(end + 1, source.draft.text.length));
          return true;
        },
      },
    );
    view.current = editor;
    const root = editor.dom as ComposerInputElement;
    Object.defineProperties(root, {
      value: {
        configurable: true,
        get: () => projection().draft.text,
        set: (text: string) => {
          if (text.length <= current.current.maxLength)
            editor.dispatch(
              editor.state.tr.replaceWith(
                0,
                editor.state.doc.content.size,
                composerSchema.nodes.paragraph.create(
                  null,
                  text ? composerSchema.text(text) : undefined,
                ),
              ),
            );
        },
      },
      selectionStart: {
        configurable: true,
        get: () => projection().source(editor.state.selection.from),
      },
      selectionEnd: {
        configurable: true,
        get: () => projection().source(editor.state.selection.to),
      },
      selectionDirection: {
        configurable: true,
        get: () =>
          editor.state.selection.anchor > editor.state.selection.head
            ? "backward"
            : "forward",
      },
      disabled: { configurable: true, get: () => current.current.disabled },
      readOnly: {
        configurable: true,
        get: () => !editable(),
        set: (next: boolean) => {
          locked.current = next;
          editor.setProps({ editable });
        },
      },
      setSelectionRange: { configurable: true, value: setRange },
      insertText: { configurable: true, value: insert },
      replaceRecipients: { configurable: true, value: replaceRecipients },
      insertPendingMention: {
        configurable: true,
        value: insertPendingMention,
      },
      settlePendingMention: {
        configurable: true,
        value: settlePendingMention,
      },
      extendPendingMention: {
        configurable: true,
        value: extendPendingMention,
      },
      insertResource: { configurable: true, value: insertResource },
      toggleFormat: { configurable: true, value: toggleFormat },
      insertLineBreak: {
        configurable: true,
        value: () => {
          if (!editable() || composing.current || editor.composing)
            return false;
          // Mac WebKit can keep painting a stale caret after a line break:
          // https://discuss.prosemirror.net/t/ghost-cursor-on-safari/9074
          // Clear the focused editor's native caret so ProseMirror re-adds it
          // while rendering the line break (or on focus below if the edit is
          // rejected), as prosemirror-view itself did on Safari before 5daf445
          // (1.41.0). Remove once upstream repaints it.
          if (editor.state.selection.empty && editor.hasFocus() && macWebKit())
            editor.dom.ownerDocument.getSelection()?.removeAllRanges();
          const tr = composerBlockLineBreak(editor.state);
          if (tr) editor.dispatch(closeHistory(tr).scrollIntoView());
          const inserted = !!tr || insert("\n");
          editor.focus();
          return inserted;
        },
      },
      editLink: { configurable: true, value: editLink },
      removeRecipient: {
        configurable: true,
        value: (pubkey: string) => {
          if (!editable()) return;
          const tr = closeHistory(editor.state.tr);
          editor.state.doc.descendants((node, pos) => {
            if (
              node.type.name === "token" &&
              node.attrs.recipient?.pubkey === pubkey
            )
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                recipient: null,
              });
            const mark = composerSchema.marks.recipient.isInSet(node.marks);
            if (mark?.attrs.pubkey === pubkey)
              tr.removeMark(pos, pos + node.nodeSize, mark);
          });
          if (editor.state.storedMarks)
            tr.setStoredMarks(editor.state.storedMarks);
          editor.dispatch(tr);
        },
      },
      undo: { configurable: true, value: historyCommand },
      checkpoint: {
        configurable: true,
        value: () => {
          const saved = editor.state;
          const savedDraft = emitted.current;
          const savedPlain = [...plain.current];
          const savedSeparateHistory = separateHistory;
          return () => {
            if (view.current !== editor) return;
            plain.current = savedPlain;
            separateHistory = savedSeparateHistory;
            emitted.current = savedDraft;
            editor.updateState(saved);
            tokenViews();
            selected();
          };
        },
      },
      reset: {
        configurable: true,
        value: (next: MentionDraft) => api.current?.sync(next, true),
      },
    });
    api.current = {
      settleHeld() {
        // ProseMirror skips its own compositionend handler while the view is
        // not editable, as during a send, and leaves its `composing` set until
        // the next click. The composition has ended all the same, so the
        // replay, like the hold above, does not consult that flag.
        for (const held of heldSettles.current.splice(0))
          held.resolve(held.apply());
      },
      sync(next, reset = false) {
        if (
          !reset &&
          JSON.stringify(next) === JSON.stringify(projection().draft)
        )
          return;
        plain.current = [];
        const doc = readComposerDocument(
          next,
          current.current.decorationsFor(next),
        );
        if (reset) {
          separateHistory = false;
          editor.updateState(state(doc));
        } else
          editor.dispatch(
            closeHistory(
              editor.state.tr.replaceWith(
                0,
                editor.state.doc.content.size,
                doc.content,
              ),
            ),
          );
        emitted.current = next;
        tokenViews();
        selected();
      },
    };
    ref.current = root;
    tokenViews();
    selected();
    return () => {
      ref.current = null;
      view.current = null;
      api.current = null;
      for (const held of heldSettles.current.splice(0)) held.resolve(false);
      editor.destroy();
    };
  }, [ref]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (draft !== emitted.current && !composing.current)
      api.current?.sync(draft);
    // setProps recomputes the decorations and root attributes that read these
    // committed props.
    current.current.placeholder = placeholder;
    current.current.autocorrect = autocorrect;
    editor.setProps({ editable: () => !disabled && !locked.current });
  }, [draft, disabled, placeholder, autocorrect]);

  const projection =
    view.current && projectComposerDocument(view.current.state.doc);
  const decorations = projection ? decorationsFor(projection.draft) : [];
  const decorationRanges = JSON.stringify(
    decorations.map(({ start, end, editAsText }) => [start, end, editAsText]),
  );
  useLayoutEffect(() => {
    // Palette/directory arrivals can make existing prose renderable without a
    // keystroke. Reconcile via the same token normalizer, outside undo history.
    const editor = view.current;
    if (editor)
      editor.dispatch(
        editor.state.tr
          .setMeta("composer-decorations", decorationRanges)
          .setMeta("addToHistory", false),
      );
  }, [decorationRanges]);
  useLayoutEffect(() => {
    // Node views survive CSS-module hot updates; keep their imperative hosts
    // on the current class just like React-owned editor elements.
    for (const host of hosts.current.keys()) host.className = tokenClassName;
  }, [tokenClassName]);
  useLayoutEffect(() => {
    // Token portals acquire their real geometry at React commit, after the
    // transaction's first scroll. Keep the same editor-owned caret visible.
    if (!scrollAfterTokens.current) return;
    scrollAfterTokens.current = false;
    const editor = view.current;
    if (editor?.hasFocus()) editor.dispatch(editor.state.tr.scrollIntoView());
  });
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: ProseMirror owns this native editing surface. */}
      <div
        {...events}
        ref={mount}
        role="textbox"
        aria-multiline="true"
        aria-label={events["aria-label"] ?? placeholder}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        className={`ProseMirror ${styles.input ?? ""}`}
        onPointerDown={(event) => {
          pointing.current = true;
          events.onPointerDown?.(event as never);
        }}
        onPointerUp={(event) => {
          pointing.current = false;
          events.onPointerUp?.(event as never);
        }}
        onFocus={(event) => {
          // Returning by keyboard or a host's focus handoff (such as choosing
          // its tab) resumes the editor's own caret. Mac WebKit can otherwise
          // keep painting the native caret from before the editor was hidden;
          // see insertLineBreak. A pointer places its own caret.
          const editor = view.current;
          if (
            !pointing.current &&
            !nativeEditing.current &&
            editor &&
            event.target === event.currentTarget
          ) {
            if (macWebKit())
              editor.dom.ownerDocument.getSelection()?.removeAllRanges();
            editor.focus();
          }
          events.onFocus?.(event as never);
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          events.onKeyDown?.(event as KeyboardEvent<ComposerInputElement>);
          if (!event.defaultPrevented && event.key === "Enter") {
            event.preventDefault();
            ref.current?.insertLineBreak();
          }
          // After the host, which claims Up and Down for a completion list.
          if (
            !event.defaultPrevented &&
            view.current &&
            crossTokenLine(view.current, hosts.current, event.key, event)
          )
            event.preventDefault();
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          events.onCompositionStart?.(event as never);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          // ProseMirror reads the composition's final DOM records in a
          // microtask queued by its own compositionend handler, which ran
          // first; a settle dispatched before that flush would rewrite the
          // text node those records point at and lose the committed text.
          queueMicrotask(() => api.current?.settleHeld());
          events.onCompositionEnd?.(event as never);
        }}
      />
      {[...hosts.current].map(([element, host]) => {
        const position = host.position();
        const source =
          position === undefined ? undefined : projection?.source(position);
        const decoration = decorations.find(
          (item) =>
            item.start === source &&
            item.end === (source ?? 0) + host.source.length,
        );
        return createPortal(
          // Host-owned artwork: restore never depends on the providing plugin.
          host.pending ? (
            <InlineChip
              address={{ kind: "person", id: host.pending.id }}
              face={{
                label: host.pending.name,
                loading: true,
                resolved: false,
              }}
              interactive={false}
            />
          ) : host.resource ? (
            <>
              <span className="sr-only">Resource: </span>
              <span className={styles.resource}>{host.resource.label}</span>
            </>
          ) : (
            (decoration?.content ?? host.source)
          ),
          element,
          host.key,
        );
      })}
    </>
  );
}
