import { memo, type Ref } from "react";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import {
  SafeMarkdown,
  safeMarkdownPlugins,
} from "../../features/messages/SafeMarkdown";
import { LIVE_CANVAS_BYTES } from "../../features/channel-templates/model";
import { scanMarkdown } from "../../features/relay/message-content";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./Canvas.module.css";

/**
 * Rendering budget for the View tab, at the save limit: a UTF-16 length never
 * exceeds the UTF-8 size, so every Canvas a save accepts passes this check.
 */
export const CANVAS_RENDER_CHARS = LIVE_CANVAS_BYTES;

/**
 * GFM pads every table row to its header's width, so a small sparse table can
 * still expand to many cells.
 */
export const CANVAS_RENDER_CELLS = 10_000;

type Node = { type: string; children?: Node[] };

function tableCells(content: string) {
  // Parse as remark-parse does under the renderer's plugins, so every table
  // the renderer will build is counted, before any HAST or React conversion.
  const data: {
    micromarkExtensions?: NonNullable<Options["extensions"]>;
    fromMarkdownExtensions?: NonNullable<Options["mdastExtensions"]>;
  } = {};
  const processor = {
    data: () => data,
  };
  for (const plugin of safeMarkdownPlugins)
    (plugin as (this: typeof processor) => void).call(processor);
  const pending: Node[] = [
    fromMarkdown(content, {
      extensions: data.micromarkExtensions,
      mdastExtensions: data.fromMarkdownExtensions,
    }),
  ];
  let cells = 0;
  for (let node = pending.pop(); node; node = pending.pop())
    if (node.type === "table")
      cells +=
        (node.children?.[0]?.children?.length ?? 0) *
        (node.children?.length ?? 0);
    else for (const child of node.children ?? []) pending.push(child);
  return cells;
}

export function renderable(content: string) {
  return (
    content.length <= CANVAS_RENDER_CHARS &&
    !scanMarkdown(content).tooDeep &&
    tableCells(content) <= CANVAS_RENDER_CELLS
  );
}

/** The saved Canvas as Markdown, without raw HTML, inline images or unsafe links. */
export const CanvasMarkdown = memo(function CanvasMarkdown({
  content,
  openLink,
}: {
  content: string;
  openLink(url: string): boolean;
}) {
  if (!renderable(content))
    return (
      <>
        <p role="status" className="text-secondary">
          This Canvas is too large or too complex to render, so it is shown as
          Markdown source.
        </p>
        <pre>{content}</pre>
      </>
    );
  return <SafeMarkdown content={content} openLink={openLink} />;
});

export function CanvasView({
  content,
  loaded,
  readError,
  busy,
  retry,
  openLink,
  focusRef,
  retryRef,
  active,
}: {
  content: string | undefined;
  loaded: boolean;
  /** The latest read's failure; kept, with its Retry, until a read succeeds. */
  readError: string;
  busy: boolean;
  retry(): void;
  openLink(url: string): boolean;
  focusRef: Ref<HTMLElement>;
  retryRef: Ref<HTMLButtonElement>;
  /** Only the active tab offers the panel host a focus target. */
  active: boolean;
}) {
  return (
    <LoadingRegion
      pending={!loaded && !readError}
      label="Loading Canvas…"
      feedback={
        readError ? (
          <div className={styles.failure}>
            <p role="alert">{readError}</p>
            <Button ref={retryRef} loading={busy} onClick={retry}>
              Retry loading
            </Button>
          </div>
        ) : undefined
      }
    >
      <article
        ref={focusRef}
        tabIndex={-1}
        data-tab-focus={active || undefined}
        aria-label="Saved Canvas"
        className={styles.markdown}
      >
        {!loaded ? null : content ? (
          <CanvasMarkdown content={content} openLink={openLink} />
        ) : (
          <p className="text-secondary">This Canvas is empty.</p>
        )}
      </article>
    </LoadingRegion>
  );
}
