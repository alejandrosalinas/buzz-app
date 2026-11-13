import { memo, type Ref } from "react";
import type {
  CodeBlockRenderer,
  ContributionReader,
} from "../../features/conversation/contracts";
import {
  DOCUMENT_PROFILE,
  DOCUMENT_RENDER_CELLS,
} from "../../features/markdown/document-profile";
import { guardDocument } from "../../features/markdown/guard";
import {
  MarkdownDocument,
  MarkdownSource,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import { LIVE_CANVAS_BYTES } from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./Canvas.module.css";

/**
 * Rendering budget for the View tab, at the save limit: a UTF-16 length never
 * exceeds the UTF-8 size, so every Canvas a save accepts passes this check.
 */
export const CANVAS_RENDER_CHARS = LIVE_CANVAS_BYTES;

export const CANVAS_RENDER_CELLS = DOCUMENT_RENDER_CELLS;

export function renderable(content: string) {
  return guardDocument(content, DOCUMENT_PROFILE, {
    chars: CANVAS_RENDER_CHARS,
    cells: CANVAS_RENDER_CELLS,
  });
}

/** The saved Canvas as Markdown, without raw HTML, inline images or unsafe links. */
export const CanvasMarkdown = memo(function CanvasMarkdown({
  content,
  openLink,
  codeBlocks,
}: {
  content: string;
  openLink(url: string): boolean;
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
}) {
  if (!renderable(content))
    return (
      <>
        <p role="status" className="text-secondary">
          This Canvas is too large or too complex to render, so it is shown as
          Markdown source.
        </p>
        <MarkdownSource content={content} />
      </>
    );
  return (
    <MarkdownDocument
      content={content}
      profile={DOCUMENT_PROFILE}
      components={sharedComponents}
      capabilities={{ openLink, codeBlocks, copy: true }}
      scale="document"
    />
  );
});

export function CanvasView({
  content,
  loaded,
  readError,
  busy,
  retry,
  openLink,
  codeBlocks,
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
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
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
          <CanvasMarkdown
            content={content}
            openLink={openLink}
            codeBlocks={codeBlocks}
          />
        ) : (
          <p className="text-secondary">This Canvas is empty.</p>
        )}
      </article>
    </LoadingRegion>
  );
}
