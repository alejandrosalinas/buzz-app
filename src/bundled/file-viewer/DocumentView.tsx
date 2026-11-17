import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CustomItemComponentProps,
  Virtualizer,
  type VirtualizerHandle,
} from "virtua";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { ListBulletsIcon } from "../../shared/design-system/icons";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { CopyText } from "./CopyText";
import { useDocumentIndex } from "./document-index";
import {
  type DocumentKind,
  type DocumentParts,
  MAX_PART_HEADINGS,
  type PartOutlineItem,
  rehypePartFootnotes,
  remarkPartHeadings,
} from "./document-parts";
import { formatLabel } from "./formats";
import {
  boundedHighlight,
  type highlight,
  languageFor,
  rehypeHighlight,
} from "./highlight";
import { type BufferControl, PartBuffer } from "./part-buffer";
import { type MediaSource, PartMarkdown } from "./PartMarkdown";
import type { FileTarget } from "./target";
import styles from "./FileViewer.module.css";

/** Fewer headings than this need no outline. */
const MIN_OUTLINE_ITEMS = 3;
/** Outline rows each key moves focus by; Home and End go to either end. */
const OUTLINE_STEPS: Partial<Record<string, number>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  PageDown: 10,
  PageUp: -10,
};
/** How far below the top of the view a heading still counts as the current section. */
const SECTION_SLACK = 8;

type Highlighted = ReturnType<typeof highlight>;
type HastNode = Highlighted["children"][number];

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

type DocumentProps = {
  file: FileTarget;
  text: string;
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
};

/** A Markdown, code or text file, read in parts so a long one opens at once.
 * A large Markdown file shows Loading while it indexes. */
export function DocumentView(props: DocumentProps) {
  const { file, text } = props;
  const language = file.format === "text" ? languageFor(file.name) : undefined;
  const kind: DocumentKind =
    file.format === "markdown" ? "markdown" : language ? "code" : "text";
  const index = useDocumentIndex(text, kind);
  if (index.state === "indexing")
    return (
      <LoadingRegion pending label={`Formatting ${file.name}`}>
        {null}
      </LoadingRegion>
    );
  return index.plain ? (
    <IndexedDocument {...props} doc={index.doc} kind="text" plain />
  ) : (
    <IndexedDocument
      {...props}
      doc={index.doc}
      kind={kind}
      language={language}
    />
  );
}

function IndexedDocument({
  file,
  text,
  session,
  openLink,
  media,
  doc,
  kind,
  language,
  plain = false,
}: DocumentProps & {
  doc: DocumentParts;
  kind: DocumentKind;
  language?: string | undefined;
  /** The file took too long to format, so it shows as text. */
  plain?: boolean;
}) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    scrollRef.current = node;
    setScroller(node);
  }, []);
  const control = useRef<BufferControl | null>(null);

  /** Goes to a heading or footnote by its id, with or without the
   * `user-content-` prefix, showing its part first when it isn't on screen.
   * A part shown as plain text has no headings, so its top stands in. Focus
   * moves to the file, as a native `#` jump moves it, since the link or
   * outline row that started the jump may be gone. */
  const scrollTo = useCallback(
    (id: string) => {
      const root = scrollRef.current;
      if (!root) return;
      const find = () =>
        root.querySelector(`[id="${CSS.escape(`user-content-${id}`)}"]`) ??
        root.querySelector(`[id="${CSS.escape(id)}"]`);
      const part = doc.partOf(id);
      const reveal = () => {
        const target =
          find() ??
          (part === undefined
            ? null
            : root.querySelector(`[data-part="${part}"]`));
        target?.scrollIntoView({ block: "start" });
        root.focus({ preventScroll: true });
      };
      const shown = find()?.closest<HTMLElement>("[data-part]")?.dataset.part;
      if (shown !== undefined && (part === undefined || shown === String(part)))
        return reveal();
      if (part !== undefined) control.current?.seek(part, reveal);
    },
    [doc],
  );

  const slice = useCallback(
    (index: number) => {
      const part = doc.parts[index];
      return part ? text.slice(part.start, part.end) : "";
    },
    [doc, text],
  );
  /** One per document: once a part takes too long, the rest stay plain. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new document gets a new time limit.
  const highlighter = useMemo(() => boundedHighlight(), [doc]);
  const prepare = useCallback(
    (index: number): string | Highlighted =>
      kind === "markdown"
        ? doc.partSource(index)
        : kind === "code"
          ? highlighter(slice(index), language)
          : slice(index),
    [doc, kind, language, slice, highlighter],
  );
  const render = useCallback(
    (index: number, prepared: string | Highlighted): ReactNode => {
      if (typeof prepared !== "string")
        return (
          <div className={styles.source}>
            <pre className={styles.gutter} aria-hidden="true">
              {lineNumbers(doc.parts[index]?.line ?? 1, slice(index))}
            </pre>
            <pre className={styles.code}>
              <code>{renderHast(prepared.children)}</code>
            </pre>
          </div>
        );
      if (kind === "text") return <pre className={styles.text}>{prepared}</pre>;
      const fallback = doc.partFallback(index);
      if (fallback)
        return (
          <>
            <p className={styles.note} role="note">
              {FALLBACK_REASONS[fallback]}, so it shows as plain text.
            </p>
            <pre className={styles.text}>{slice(index)}</pre>
          </>
        );
      return (
        <PartMarkdown
          content={prepared}
          openLink={openLink}
          session={session}
          transforms={[remarkPartHeadings(doc, index)]}
          rehype={[
            rehypePartFootnotes(doc, index),
            [rehypeHighlight, { highlight: highlighter }],
          ]}
          media={media}
          onAnchor={scrollTo}
        />
      );
    },
    [doc, kind, slice, openLink, session, media, scrollTo, highlighter],
  );

  const meta = useMemo(() => {
    const size =
      kind === "markdown"
        ? [
            `${doc.readingMinutes.toLocaleString()} min read`,
            plural(doc.words, "word"),
          ]
        : [plural(totalLines(doc, text), "line")];
    return [
      formatLabel(file.format),
      ...(file.time
        ? [formatItemTimestamp(file.time, { withTime: true })]
        : []),
      ...size,
    ].join(" · ");
  }, [doc, kind, text, file.format, file.time]);

  const items = doc.outline.length >= MIN_OUTLINE_ITEMS ? doc.outline : [];
  const buffer = (
    <PartBuffer
      count={doc.parts.length}
      scroller={scroller}
      prepare={prepare}
      render={render}
      control={control}
    />
  );
  return (
    <>
      <InlineHeader
        title={file.name}
        subtitle={meta}
        actions={
          <>
            {items.length > 0 && (
              <Outline items={items} scroller={scroller} jump={scrollTo} />
            )}
            <CopyText read={() => text} />
          </>
        }
      />
      {plain && (
        <p className={styles.note} role="note">
          This file took too long to format, so it shows as plain text.
        </p>
      )}
      {doc.unclosedFence !== undefined && (
        <p className={styles.note} role="note">
          From line {doc.unclosedFence.toLocaleString()} on, the file shows as
          code: a code block starts there and never closes.
        </p>
      )}
      {doc.headingsTruncated && (
        <p className={styles.note} role="note">
          The outline lists only the first {MAX_PART_HEADINGS.toLocaleString()}{" "}
          headings.
        </p>
      )}
      <section
        ref={attach}
        className={styles.scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the file.
        tabIndex={0}
        aria-label={file.name}
      >
        {kind === "markdown" ? (
          <article className={styles.markdown}>{buffer}</article>
        ) : (
          buffer
        )}
      </section>
    </>
  );
}

const FALLBACK_REASONS = {
  "too-large": "This part is too large to format",
  "too-deep": "This part is too deeply nested to format",
  context: "This part can't be formatted apart from the rest of the file",
} as const;

function totalLines(doc: DocumentParts, text: string): number {
  const last = doc.parts.at(-1);
  if (!last) return 0;
  return last.line - 1 + lineCount(text.slice(last.start, last.end));
}

function lineNumbers(first: number, text: string): string {
  return Array.from(
    { length: Math.max(1, lineCount(text)) },
    (_, i) => first + i,
  ).join("\n");
}

/** A highlighted part: spans with `hljs-*` classes, and text. */
function renderHast(nodes: readonly HastNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const names = node.properties.className;
    const className = Array.isArray(names)
      ? names
          .filter((name) => /^hljs-[a-z0-9_-]+$/.test(String(name)))
          .join(" ")
      : undefined;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: A part's tree never reorders.
      <span key={index} className={className || undefined}>
        {renderHast(node.children)}
      </span>
    );
  });
}

/** A community image, drawn through the session's media source; any other
 * image, or one that fails to load, is its alt text. */
/** The outline's button and list. The list opens at the current section: the
 * last heading at or above the top of the view. */
function Outline({
  items,
  scroller,
  jump,
}: {
  items: readonly PartOutlineItem[];
  scroller: HTMLElement | null;
  jump(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (next)
          setCurrent(scroller ? currentSection(items, scroller) : undefined);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            aria-label="Outline"
            title="Outline"
            icon={<ListBulletsIcon />}
          />
        }
      />
      <PopoverPopup padding="list" aria-label="Outline">
        <OutlineList
          items={items}
          current={current}
          jump={(id) => {
            setOpen(false);
            jump(id);
          }}
        />
      </PopoverPopup>
    </PopoverRoot>
  );
}

function currentSection(
  items: readonly PartOutlineItem[],
  root: HTMLElement,
): string | undefined {
  const shown = [...root.querySelectorAll<HTMLElement>("[data-part]")].map(
    (node) => Number(node.dataset.part),
  );
  const first = shown[0] ?? 0;
  const last = shown.at(-1) ?? 0;
  const line = root.getBoundingClientRect().top + SECTION_SLACK;
  let found: string | undefined;
  for (const item of items) {
    if (item.part > last) break;
    if (item.part >= first) {
      const node = root.querySelector(
        `[id="${CSS.escape(`user-content-${item.id}`)}"]`,
      );
      // A part shown as plain text has no heading to measure.
      if (!node) continue;
      if (node.getBoundingClientRect().top > line) break;
    }
    found = item.id;
  }
  return found;
}

/** Only the rows around what the list shows are drawn: a long file lists up
 * to MAX_PART_HEADINGS headings, and drawing them all takes seconds. Arrow
 * keys, Page Up/Down, Home and End move focus through every row, drawing the
 * row they reach. */
function OutlineList({
  items,
  current,
  jump,
}: {
  items: readonly PartOutlineItem[];
  current: string | undefined;
  jump(id: string): void;
}) {
  const nav = useRef<HTMLElement>(null);
  const list = useRef<VirtualizerHandle>(null);
  const [focused, setFocused] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.id === current),
    ),
  );
  // The row a key moved to. It takes focus once drawn and measured: the list
  // draws a row hidden first, and a hidden row can't take focus.
  const target = useRef<number | undefined>(undefined);
  // Opened at the current section, two rows below the top.
  const opened = useRef(focused);
  useLayoutEffect(() => {
    if (opened.current > 2) list.current?.scrollToIndex(opened.current - 2);
  }, []);
  const Row = useMemo(
    () =>
      outlineRow(items.length, (index) => {
        if (target.current !== index) return;
        target.current = undefined;
        nav.current
          ?.querySelector<HTMLElement>(`[aria-posinset="${index + 1}"] button`)
          ?.focus();
      }),
    [items.length],
  );
  return (
    <nav
      ref={nav}
      aria-label="Outline"
      className={styles.outline}
      onFocus={(event) => {
        const at = event.target.closest("li")?.getAttribute("aria-posinset");
        if (at) setFocused(Number(at) - 1);
      }}
      onKeyDown={(event) => {
        const step = OUTLINE_STEPS[event.key];
        const to =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : step === undefined
                ? undefined
                : focused + step;
        if (to === undefined) return;
        event.preventDefault();
        const next = Math.min(items.length - 1, Math.max(0, to));
        target.current = next;
        list.current?.scrollToIndex(next, { align: "nearest" });
        setFocused(next);
      }}
    >
      <Virtualizer
        ref={list}
        scrollRef={nav}
        data={items}
        as="ul"
        item={Row}
        keepMounted={[focused]}
      >
        {(item) => (
          <NavigationItem
            key={item.id}
            label={item.text}
            inset={item.depth > 1}
            selected={item.id === current}
            aria-current={item.id === current ? "location" : undefined}
            onClick={() => jump(item.id)}
          />
        )}
      </Virtualizer>
    </nav>
  );
}

/** An outline row, telling assistive technology where it sits in the whole
 * list though most rows aren't drawn, and saying when it is shown. */
function outlineRow(size: number, shown: (index: number) => void) {
  return function OutlineRow({
    style,
    index,
    children,
    ref,
  }: CustomItemComponentProps) {
    const hidden = style.visibility === "hidden";
    useLayoutEffect(() => {
      if (!hidden) shown(index);
    });
    return (
      <li ref={ref} style={style} aria-setsize={size} aria-posinset={index + 1}>
        {children}
      </li>
    );
  };
}
