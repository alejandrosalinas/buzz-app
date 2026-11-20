import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  clearView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./Panels.module.css";

// The revision records which saved value an in-memory width replaced or
// became, so a failed save survives notifications about other keys.
function loadSplit(scope: string | undefined, key: string) {
  const revision = scope ? viewRevision(scope, key) : undefined;
  let saved: unknown;
  try {
    saved = JSON.parse(revision ?? "null");
  } catch {
    // An unreadable record falls back to the default width.
  }
  const preferred =
    typeof saved === "number" && Number.isFinite(saved) && saved > 0
      ? saved
      : undefined;
  return { scope, key, revision, preferred };
}

/**
 * Each page owns its split. The preferred width is saved per community and
 * viewer workspace (`scope`) under the page's `name`, so it survives the dock
 * closing, page switches and restarts; without a scope it stays in memory.
 */
export function usePanelSplit(
  scope: string | undefined,
  name: string,
  defaultWidth?: number,
  min = 316,
  primary?: { defaultWidth: number; maxRatio: number },
) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `panel-split:${name}`;
  const [view, setView] = useState(() => loadSplit(scope, key));
  // A workspace change reads that workspace's width without remounting the page.
  if (view.scope !== scope || view.key !== key) setView(loadSplit(scope, key));
  const { preferred } = view;
  // Follow newer saves from another frame or window sharing this page's width.
  useLayoutEffect(() => {
    if (!scope) return;
    return subscribeView(scope, () => {
      const revision = viewRevision(scope, key);
      setView((current) =>
        revision === undefined ||
        (current.scope === scope &&
          current.key === key &&
          current.revision === revision)
          ? current
          : loadSplit(scope, key),
      );
    });
  }, [scope, key]);
  const setPreferred = (width: number | undefined) => {
    if (scope && width !== undefined) writeView(scope, key, width);
    else if (scope)
      try {
        clearView(scope, key);
      } catch {
        // The default still applies until the page next mounts.
      }
    const revision = scope ? viewRevision(scope, key) : undefined;
    setView({ scope, key, preferred: width, revision });
  };
  return {
    ref,
    style: undefined,
    handle: (
      <PanelSplitHandle
        target={ref}
        preferred={preferred}
        setPreferred={setPreferred}
        defaultWidth={defaultWidth}
        min={min}
        primary={primary}
      />
    ),
  };
}

// Container reflow updates the grip and CSS width, not the page and its messages.
function PanelSplitHandle({
  target: ref,
  preferred,
  setPreferred,
  defaultWidth,
  min,
  primary,
}: {
  target: RefObject<HTMLDivElement | null>;
  preferred: number | undefined;
  setPreferred(width: number | undefined): void;
  defaultWidth: number | undefined;
  min: number;
  primary: { defaultWidth: number; maxRatio: number } | undefined;
}) {
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const minimum = Math.max(min, available * (1 - (primary?.maxRatio ?? 1)));
  const max = Math.max(minimum, available - 320);
  const clamp = (width: number) => Math.min(max, Math.max(minimum, width));
  const width = clamp(
    preferred ??
      defaultWidth ??
      (primary ? available - primary.defaultWidth : available / 2.1),
  );
  const automatic = preferred === undefined && primary === undefined;
  useLayoutEffect(() => {
    if (!available) return;
    const style = ref.current?.style;
    if (automatic) style?.removeProperty("--secondary-panel-width");
    else style?.setProperty("--secondary-panel-width", `${width}px`);
  }, [ref, available, width, automatic]);
  return (
    <ResizeHandle
      label="Resize main and secondary panels"
      direction={-1}
      target={ref}
      property="--secondary-panel-width"
      width={width}
      min={minimum}
      max={max}
      setWidth={(next) => setPreferred(clamp(next))}
      reset={() => setPreferred(undefined)}
      className={styles.resize}
    />
  );
}

/** Attach ref to the layout container and render handle beside the secondary pane. */
export type PanelSplit = ReturnType<typeof usePanelSplit>;

/** Plugin layouts never share persistence keys with built-in page layouts. */
export const usePluginPanelSplit: typeof usePanelSplit = (
  scope,
  name,
  ...options
) => usePanelSplit(scope, `plugin:${name}`, ...options);
