import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CaretLeftIcon,
  CaretRightIcon,
  FileTextIcon,
  MinusIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { CopyText } from "./CopyText";
import { useNear, useSize } from "./layout";
import {
  MAX_PDF_TEXT_CHARS,
  openPdf,
  PdfError,
  type PageSize,
  type PdfDocument,
} from "./pdf";
import styles from "./FileViewer.module.css";

export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const MAX_ZOOM = 3;
/** A page this near view is drawn, in pixels, however short the panel. */
const MIN_DRAW_REACH = 400;

export function fitScale(size: PageSize, width: number) {
  return Math.max(0.25, Math.min(4, width / size.width));
}

export function nextZoom(current: number, direction: 1 | -1) {
  const steps = direction > 0 ? ZOOMS : [...ZOOMS].reverse();
  return (
    steps.find((zoom) =>
      direction > 0 ? zoom > current + 0.001 : zoom < current - 0.001,
    ) ?? current
  );
}

type Opened =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; pdf: PdfDocument };

export default function PdfView({
  bytes,
  name,
}: {
  bytes: Uint8Array;
  name: string;
}) {
  const [opened, setOpened] = useState<Opened>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let pdf: PdfDocument | undefined;
    setOpened({ state: "loading" });
    // pdf.js transfers the buffer it is given to its worker.
    openPdf(bytes.slice(), controller.signal).then(
      (document) => {
        pdf = document;
        if (controller.signal.aborted) void document.destroy();
        else setOpened({ state: "ready", pdf: document });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setOpened({
          state: "failed",
          message:
            error instanceof PdfError && error.reason === "password"
              ? "This PDF is protected with a password. Download it to open it in another app."
              : "This file isn't a PDF that can be shown. Download it to open it in another app.",
        });
      },
    );
    return () => {
      controller.abort();
      void pdf?.destroy();
    };
  }, [bytes]);
  if (opened.state === "failed")
    return (
      <div className={styles.status}>
        <EmptyState
          icon={<FileTextIcon />}
          title="Can't open this PDF"
          description={opened.message}
        />
      </div>
    );
  if (opened.state === "loading")
    return (
      <LoadingRegion pending label={`Opening ${name}`}>
        {null}
      </LoadingRegion>
    );
  return <Pages pdf={opened.pdf} name={name} />;
}

function Drawing({
  pdf,
  page,
  scale,
}: {
  pdf: PdfDocument;
  page: number;
  scale: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    setFailed(false);
    const rendering = pdf.render(page, node, scale);
    let live = true;
    rendering.promise.catch(() => live && setFailed(true));
    return () => {
      live = false;
      rendering.cancel();
    };
  }, [pdf, page, scale]);
  return (
    <>
      <canvas ref={canvas} hidden={failed} />
      {failed && (
        <p className={styles.note} role="alert">
          This page couldn't be drawn.
        </p>
      )}
    </>
  );
}

function Page({
  pdf,
  page,
  size,
  scale,
  root,
  screen,
}: {
  pdf: PdfDocument;
  page: number;
  size: PageSize;
  scale: number;
  root: HTMLElement | null;
  screen: number;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const near = useNear(node, root, Math.max(screen, MIN_DRAW_REACH));
  return (
    <div
      ref={setNode}
      className={styles.page}
      data-page={page}
      role="img"
      aria-label={`Page ${page} of ${pdf.sizes.length}`}
      style={{
        width: Math.floor(size.width * scale),
        height: Math.floor(size.height * scale),
      }}
    >
      {near && <Drawing pdf={pdf} page={page} scale={scale} />}
    </div>
  );
}

const boxes = (from: HTMLElement) =>
  Array.from(from.querySelectorAll<HTMLElement>("[data-page]"));

function usePageTracking(
  stage: HTMLElement | null,
  pages: number,
  scale: number,
  setPage: (page: number) => void,
) {
  const anchor = useRef({ page: 1, offset: 0 });
  useEffect(() => {
    if (!stage) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = stage.scrollTop + stage.clientHeight / 3;
      const list = boxes(stage);
      let current = 1;
      for (const [index, box] of list.entries())
        if (box.offsetTop <= line) current = index + 1;
      if (
        stage.scrollTop > 0 &&
        stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1
      )
        current = pages;
      const box = list[current - 1];
      anchor.current = {
        page: current,
        offset: box?.offsetHeight
          ? (stage.scrollTop - box.offsetTop) / box.offsetHeight
          : 0,
      };
      setPage(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [stage, pages, setPage]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new scale re-anchors the page in view.
  useLayoutEffect(() => {
    if (!stage) return;
    const { page, offset } = anchor.current;
    const box = boxes(stage)[page - 1];
    if (box && (page > 1 || offset > 0))
      stage.scrollTop = box.offsetTop + offset * box.offsetHeight;
  }, [stage, scale]);
  return (page: number) => {
    anchor.current = { page, offset: 0 };
    const box = stage && boxes(stage)[page - 1];
    if (box)
      stage.scrollTop = box.offsetTop - (box.parentElement?.offsetTop ?? 0);
    setPage(page);
  };
}

function Pages({ pdf, name }: { pdf: PdfDocument; name: string }) {
  const pages = pdf.sizes.length;
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const { width, height } = useSize(stage);
  const padding = column
    ? Number.parseFloat(getComputedStyle(column).paddingInlineStart) +
      Number.parseFloat(getComputedStyle(column).paddingInlineEnd)
    : 0;
  const widest = useMemo(
    () =>
      pdf.sizes.reduce((wide, size) => (size.width > wide.width ? size : wide)),
    [pdf],
  );
  const scale =
    zoom === "fit" ? fitScale(widest, Math.max(width - padding, 160)) : zoom;
  const scrollTo = usePageTracking(stage, pages, scale, setPage);
  const go = (to: number) => scrollTo(Math.min(Math.max(1, to), pages));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key === "ArrowRight") go(page + 1);
    else if (event.key === "ArrowLeft") go(page - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div className={styles.pdf}>
      <div className={styles.toolbar} role="toolbar" aria-label="PDF controls">
        <span className={styles.group}>
          <IconButton
            aria-label="Previous page"
            icon={<CaretLeftIcon />}
            disabled={page <= 1}
            onClick={() => go(page - 1)}
          />
          <output className={styles.count}>
            Page {page} of {pages}
          </output>
          <IconButton
            aria-label="Next page"
            icon={<CaretRightIcon />}
            disabled={page >= pages}
            onClick={() => go(page + 1)}
          />
        </span>
        <span className={styles.group}>
          <IconButton
            aria-label="Zoom out"
            icon={<MinusIcon />}
            disabled={scale <= ZOOMS[0]}
            onClick={() => setZoom(nextZoom(scale, -1))}
          />
          <output className={styles.count} aria-label="Zoom level">
            {Math.round(scale * 100)}%
          </output>
          <IconButton
            aria-label="Zoom in"
            icon={<PlusIcon />}
            disabled={scale >= MAX_ZOOM}
            onClick={() => setZoom(nextZoom(scale, 1))}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={zoom === "fit"}
            onClick={() => setZoom("fit")}
          >
            Fit to width
          </Button>
        </span>
        <CopyText
          read={(signal) => pdf.text(signal)}
          limit={MAX_PDF_TEXT_CHARS}
        />
      </div>
      <section
        ref={setStage}
        className={styles.stage}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner takes arrow keys to turn pages.
        tabIndex={0}
        aria-label={`${name} pages`}
        onKeyDown={onKeyDown}
      >
        <div ref={setColumn} className={styles.column}>
          {pdf.sizes.map((size, index) => (
            <Page
              // biome-ignore lint/suspicious/noArrayIndexKey: The page number is its identity.
              key={index + 1}
              pdf={pdf}
              page={index + 1}
              size={size}
              scale={scale}
              root={stage}
              screen={height}
            />
          ))}
          {pdf.pages > pages && (
            <p className={styles.note} role="note">
              Showing the first {pages.toLocaleString()} of{" "}
              {pdf.pages.toLocaleString()} pages. Download the PDF to read the
              rest.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
