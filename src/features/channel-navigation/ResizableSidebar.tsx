import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { ResizeHandle } from "../panels/ResizeHandle";
import styles from "./ResizableSidebar.module.css";

/** Pixel bounds coupled to `.shell-sidebar` in globals.css. */
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;

export function clampSidebarWidth(width: number) {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

// The width shares the sidebar's saved view record with the channel list's
// scroll and collapse state; each owner merges only its own fields.
const VIEW = "channel-sidebar";
// Failed saves survive route remounts, but never mask a newer saved revision.
const widths = new Map<
  string,
  { width: number; revision: string | null | undefined }
>();

/** One width per community/viewer workspace, shared by every primary sidebar. */
export function readSidebarWidth(scope: string): number {
  const memory = widths.get(scope);
  const revision = viewRevision(scope, VIEW);
  if (memory && (revision === undefined || revision === memory.revision))
    return memory.width;
  widths.delete(scope);
  const saved = readView<{ width?: unknown } | null>(scope, VIEW, null);
  return typeof saved?.width === "number" && Number.isFinite(saved.width)
    ? clampSidebarWidth(saved.width)
    : SIDEBAR_DEFAULT_WIDTH;
}

function saveSidebarWidth(scope: string, width: number) {
  const revision = viewRevision(scope, VIEW);
  // writeView notifies synchronously: readers must not see an old fallback.
  widths.delete(scope);
  // Merge the captured record, not a second read that could fail or change.
  if (revision !== undefined) {
    try {
      const saved: object | null = JSON.parse(revision ?? "null");
      if (writeView(scope, VIEW, { ...(saved ?? {}), width })) return;
    } catch {
      // Leave an unreadable record intact; resizing still works in memory.
    }
  }
  widths.set(scope, { width, revision });
}

/**
 * The primary sidebar column and its resize handle. Pages supply the sidebar
 * contents; width, bounds, persistence and the handle live only here.
 */
export function ResizableSidebar({
  scope,
  className = "shell-sidebar-default",
  children,
}: {
  scope: string;
  className?: string;
  children: ReactNode;
}) {
  // A workspace change reads that workspace's width without remounting the
  // sidebar contents (which would detach focus and in-flight interactions).
  const [view, setView] = useState(() => ({
    scope,
    width: readSidebarWidth(scope),
  }));
  if (view.scope !== scope) setView({ scope, width: readSidebarWidth(scope) });
  const width = view.scope === scope ? view.width : readSidebarWidth(scope);
  useLayoutEffect(() => {
    const update = () => {
      const width = readSidebarWidth(scope);
      setView((current) =>
        current.scope === scope && current.width === width
          ? current
          : { scope, width },
      );
    };
    const stop = subscribeView(scope, update, VIEW);
    update();
    return stop;
  }, [scope]);
  const resize = (next: number) => {
    const clamped = clampSidebarWidth(next);
    if (clamped === width) return;
    saveSidebarWidth(scope, clamped);
    setView({ scope, width: readSidebarWidth(scope) });
  };
  return (
    <>
      <div className={`${className} ${styles.sidebar}`} style={{ width }}>
        {children}
      </div>
      <ResizeHandle
        key={scope}
        width={width}
        setWidth={resize}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        reset={() => resize(SIDEBAR_DEFAULT_WIDTH)}
        label="Resize sidebar"
        className={styles.handle}
      />
    </>
  );
}
