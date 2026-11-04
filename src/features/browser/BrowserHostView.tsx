import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { usePanelTabHost } from "../panels/PanelWorkspace";
import {
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import type { BrowserViewProps } from "./api";
import {
  addressInputUrl,
  type BrowserAction,
  type BrowserBounds,
  type BrowserPlatform,
  type BrowserStatus,
} from "./platform";
import type { BrowserSessions } from "./sessions";
import styles from "./BrowserHostView.module.css";

const EMPTY_STATUS: BrowserStatus = {
  url: "",
  title: "",
  loading: false,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundsFor(element: HTMLElement): BrowserBounds {
  const rectangle = element.getBoundingClientRect();
  const x = Math.max(0, rectangle.left);
  const y = Math.max(0, rectangle.top);
  const right = Math.min(window.innerWidth, rectangle.right);
  const bottom = Math.min(window.innerHeight, rectangle.bottom);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

/** Retained tabs stay laid out while hidden, and sliding panes move by CSS
 * transform. The native guest follows neither, so it shows only on a settled
 * pane the user can see. */
function covered(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      '[inert], [hidden], [aria-hidden="true"], [data-covered], [data-entering], [data-leaving]',
    ) || getComputedStyle(element).visibility !== "visible",
  );
}

/** The website yields to modal and interactive popups. Passive hover hints
 * must not blank a neighboring page just because they reach over its edge. */
function hostOverlayOpen(viewport: BrowserBounds): boolean {
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return true;
  for (const popup of document.querySelectorAll<HTMLElement>(
    '[data-open][data-side], [role="menu"], [role="listbox"]',
  )) {
    if (
      popup.matches('[role="tooltip"]') ||
      (popup.matches('[role="presentation"]') &&
        popup.querySelector(':scope > [role="tooltip"]'))
    )
      continue;
    const box = popup.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      box.left < viewport.x + viewport.width &&
      box.right > viewport.x &&
      box.top < viewport.y + viewport.height &&
      box.bottom > viewport.y
    )
      return true;
  }
  return false;
}

export function BrowserHostView({
  url,
  storage: requestedStorage,
  builderlab,
  canResumeUrl,
  label,
  platform,
  sessions,
  pollInterval = 300,
}: BrowserViewProps & {
  platform: BrowserPlatform;
  sessions: BrowserSessions;
  pollInterval?: number;
}) {
  const storage = builderlab?.storage ?? requestedStorage;
  const viewport = useRef<HTMLDivElement>(null);
  const session = useRef<string | undefined>(undefined);
  const retryAttach = useRef<(() => void) | undefined>(undefined);
  // Where the guest last was, so a view whose guest was closed to make room
  // reopens there instead of at its starting URL.
  const resumeUrl = useRef(url);
  const editing = useRef(false);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [draft, setDraft] = useState(url);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing.current && status.url) setDraft(status.url);
  }, [status.url]);

  // macOS mouse back/forward, sent here while this page has focus.
  const historyAction = useEffectEvent((event: Event, value: BrowserAction) => {
    event.preventDefault();
    action(value);
  });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const back = (event: Event) => historyAction(event, "back");
    const forward = (event: Event) => historyAction(event, "forward");
    element.addEventListener("buzz:history-back", back);
    element.addEventListener("buzz:history-forward", forward);
    return () => {
      element.removeEventListener("buzz:history-back", back);
      element.removeEventListener("buzz:history-forward", forward);
    };
  }, []);

  // In a tab, the page's title names it, so several websites tell apart.
  const tabHost = usePanelTabHost();
  const nameTab = tabHost?.title;
  const tabOwner = tabHost?.owner;
  // The last title the page had names it until it reports another.
  const titleKey = `${storage ?? ""}\n${url}`;
  const tabLabel = status.title || sessions.title(titleKey) || label;
  useLayoutEffect(() => {
    if (!nameTab || !tabOwner || !tabLabel) return;
    nameTab(tabOwner, { label: tabLabel });
    return () => nameTab(tabOwner, undefined);
  }, [nameTab, tabOwner, tabLabel]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let disposed = false;
    let attachStarted = false;
    let attachFailed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRequested: { bounds: BrowserBounds; visible: boolean } | undefined;
    let desiredPresentation:
      | { bounds: BrowserBounds; visible: boolean }
      | undefined;
    let writingBounds = false;
    const park = storage === undefined ? undefined : `${storage}\n${url}`;

    const visible = (bounds: BrowserBounds) =>
      document.visibilityState === "visible" &&
      !hostOverlayOpen(bounds) &&
      !covered(element) &&
      bounds.width > 0 &&
      bounds.height > 0;

    const syncBounds = (force = false) => {
      const sessionId = session.current;
      if (!sessionId || disposed) return;
      const measuredBounds = boundsFor(element);
      const nextVisible = visible(measuredBounds);
      if (!sessions.owns(sessionId)) {
        // Its guest was closed to make room for others. Open it again when
        // shown.
        if (!nextVisible) return;
        setLocalError(null);
        session.current = undefined;
        delete element.dataset.browserSession;
        attachStarted = false;
        lastRequested = undefined;
        if (pollTimer) clearTimeout(pollTimer);
        begin();
        return;
      }
      const bounds =
        measuredBounds.width > 0 && measuredBounds.height > 0
          ? measuredBounds
          : lastRequested?.bounds;
      sessions.present(sessionId, nextVisible);
      if (!bounds) return;
      if (
        !force &&
        lastRequested?.visible === nextVisible &&
        Object.entries(bounds).every(
          ([key, value]) =>
            lastRequested?.bounds[key as keyof BrowserBounds] === value,
        )
      )
        return;
      lastRequested = { bounds, visible: nextVisible };
      desiredPresentation = lastRequested;
      if (writingBounds) return;
      writingBounds = true;
      void (async () => {
        while (
          !disposed &&
          session.current === sessionId &&
          desiredPresentation
        ) {
          const next = desiredPresentation;
          desiredPresentation = undefined;
          try {
            await platform.setBounds(sessionId, next.bounds, next.visible);
          } catch (error) {
            if (
              !disposed &&
              session.current === sessionId &&
              sessions.owns(sessionId)
            )
              setLocalError(message(error));
          }
        }
        writingBounds = false;
      })();
    };

    const poll = async () => {
      const sessionId = session.current;
      if (!sessionId || disposed || !sessions.owns(sessionId)) return;
      try {
        const next = await platform.status(sessionId);
        if (!disposed && session.current === sessionId) {
          // Restore app destinations, not temporary auth/consent pages or their one-use tickets.
          if (
            next.url &&
            (canResumeUrl
              ? canResumeUrl(next.url)
              : !builderlab || new URL(next.url).origin === new URL(url).origin)
          )
            resumeUrl.current = next.url;
          sessions.rememberTitle(titleKey, next.title);
          setStatus(next);
        }
      } catch (error) {
        // A replacement may have taken the guest while this status was asked.
        if (
          !disposed &&
          session.current === sessionId &&
          sessions.owns(sessionId)
        )
          setLocalError(message(error));
      } finally {
        if (!disposed && session.current === sessionId)
          pollTimer = setTimeout(poll, pollInterval);
      }
    };

    const begin = () => {
      if (attachStarted || disposed || builderlab?.signal.aborted) return;
      const initialBounds = boundsFor(element);
      if (!visible(initialBounds)) return;
      attachStarted = true;
      setStatus((previous) => ({ ...previous, loading: true }));
      sessions
        .attach(
          resumeUrl.current,
          initialBounds,
          () => !disposed,
          storage,
          park,
          builderlab,
        )
        .then((sessionId) => {
          if (!sessionId || disposed) return;
          session.current = sessionId;
          element.dataset.browserSession = sessionId;
          syncBounds(true);
          void poll();
        })
        .catch((error) => {
          if (!disposed) {
            attachFailed = true;
            setStatus({ ...EMPTY_STATUS, url: resumeUrl.current });
            setLocalError(message(error));
          }
        });
    };

    retryAttach.current = () => {
      if (!attachFailed) return;
      attachFailed = false;
      attachStarted = false;
      setLocalError(null);
      begin();
    };

    const updatePresentation = () => {
      begin();
      syncBounds();
    };

    const resizeObserver = new ResizeObserver(updatePresentation);
    resizeObserver.observe(element);
    // A popup is placed a frame or two after it mounts.
    let placing: number | undefined;
    const mutationObserver = new MutationObserver(() => {
      updatePresentation();
      if (placing !== undefined) cancelAnimationFrame(placing);
      placing = requestAnimationFrame(() => {
        placing = requestAnimationFrame(() => {
          placing = undefined;
          updatePresentation();
        });
      });
    });
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "open",
        "aria-modal",
        "data-open",
        "role",
        "inert",
        "hidden",
        "aria-hidden",
        "data-covered",
        "data-entering",
        "data-leaving",
      ],
    });
    const forceBounds = () => syncBounds(true);
    window.addEventListener("resize", forceBounds);
    window.addEventListener("scroll", updatePresentation, true);
    document.addEventListener("visibilitychange", updatePresentation);
    window.visualViewport?.addEventListener("resize", forceBounds);
    window.visualViewport?.addEventListener("scroll", updatePresentation);
    // A pane that slid or faded into place has moved without resizing.
    document.addEventListener("animationend", updatePresentation, true);
    document.addEventListener("transitionend", updatePresentation, true);

    resumeUrl.current = url;
    setDraft(url);
    setStatus({ ...EMPTY_STATUS, url, loading: true });
    setLocalError(null);
    begin();

    return () => {
      disposed = true;
      retryAttach.current = undefined;
      if (pollTimer) clearTimeout(pollTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (placing !== undefined) cancelAnimationFrame(placing);
      window.removeEventListener("resize", forceBounds);
      window.removeEventListener("scroll", updatePresentation, true);
      document.removeEventListener("visibilitychange", updatePresentation);
      window.visualViewport?.removeEventListener("resize", forceBounds);
      window.visualViewport?.removeEventListener("scroll", updatePresentation);
      document.removeEventListener("animationend", updatePresentation, true);
      document.removeEventListener("transitionend", updatePresentation, true);
      const sessionId = session.current;
      session.current = undefined;
      delete element.dataset.browserSession;
      // A guest with kept storage waits a while for this page to come back,
      // say from another channel, so work in progress there survives.
      if (sessionId) void sessions.detach(sessionId, park);
    };
  }, [
    builderlab,
    canResumeUrl,
    platform,
    pollInterval,
    sessions,
    storage,
    titleKey,
    url,
  ]);

  async function run(operation: (sessionId: string) => Promise<void>) {
    const sessionId = session.current;
    if (!sessionId) return;
    setLocalError(null);
    try {
      await operation(sessionId);
    } catch (error) {
      if (session.current === sessionId) setLocalError(message(error));
    }
  }

  function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    editing.current = false;
    const target = addressInputUrl(draft);
    void run((sessionId) =>
      platform.navigate(sessionId, target.url, target.fallbackToHttp),
    );
  }

  function action(value: BrowserAction) {
    if (value === "reload" && !session.current) {
      retryAttach.current?.();
      return;
    }
    void run((sessionId) => platform.action(sessionId, value));
  }

  const error = localError ?? status.error;
  return (
    <section className={styles.browser} aria-label="Browser">
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="Browser controls"
      >
        <IconButton
          size="toolbar"
          variant="quiet"
          aria-label="Back"
          onClick={() => action("back")}
          icon={<CaretLeftIcon size={16} />}
        />
        <IconButton
          size="toolbar"
          variant="quiet"
          aria-label="Forward"
          onClick={() => action("forward")}
          icon={<CaretRightIcon size={16} />}
        />
        <IconButton
          size="toolbar"
          variant="quiet"
          aria-label="Reload"
          onClick={() => action("reload")}
          icon={
            status.loading ? (
              <DotsThreeIcon size={16} />
            ) : (
              <ArrowsClockwiseIcon size={16} />
            )
          }
        />
        <form onSubmit={navigate}>
          <Input
            aria-label="Address"
            value={draft}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
              setDraft(status.url || url);
            }}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        {status.title ? (
          <span className={styles.status} title={status.title}>
            {status.title}
          </span>
        ) : null}
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.viewport} ref={viewport} />
    </section>
  );
}
