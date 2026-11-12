import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { readView, subscribeView, writeView } from "../../shared/view-state";
import { contributedSidebarSectionKey } from "./sidebar-sections";

type SidebarView = {
  collapsed: string[];
  contributionOrder: string[];
  scrollTop: number;
  /** The destination whose sidebar entry the saved position shows. */
  location?: string | undefined;
};

function restore(scope: string): SidebarView {
  const raw = readView<unknown>(scope, "channel-sidebar", null);
  const saved =
    raw && typeof raw === "object" ? (raw as Partial<SidebarView>) : {};
  return {
    collapsed: Array.isArray(saved.collapsed)
      ? saved.collapsed.filter((key): key is string => typeof key === "string")
      : [],
    contributionOrder: Array.isArray(saved.contributionOrder)
      ? saved.contributionOrder
          .filter((key): key is string => typeof key === "string")
          // Earlier orders saved raw `<plugin>/<id>` keys; section keys are prefixed.
          .map((key) =>
            key.includes(":") ? key : contributedSidebarSectionKey(key),
          )
      : [],
    scrollTop:
      typeof saved.scrollTop === "number" &&
      Number.isFinite(saved.scrollTop) &&
      saved.scrollTop >= 0
        ? saved.scrollTop
        : 0,
    location: typeof saved.location === "string" ? saved.location : undefined,
  };
}

/** Header creation shares the sidebar's durable section expansion. */
export function expandSidebarSection(scope: string, key: string) {
  const saved = readView<object>(scope, "channel-sidebar", {});
  writeView(scope, "channel-sidebar", {
    ...saved,
    collapsed: restore(scope).collapsed.filter((id) => id !== key),
  });
}

/**
 * Show the current destination (`aria-current="page"`) in the sidebar
 * viewport. Rows hidden by a collapsed section or session list are shown
 * through the header or parent row that represents them. Returns false while
 * no current entry is laid out yet; otherwise returns the offset that shows it.
 */
function revealCurrent(viewport: HTMLElement): number | false {
  const owners = [
    ...viewport.querySelectorAll<HTMLElement>('[aria-current="page"]'),
  ].map((entry) => {
    let owner = entry;
    for (let node: HTMLElement | null = entry; node && node !== viewport; ) {
      if (node.hidden && node.previousElementSibling instanceof HTMLElement)
        owner = node.previousElementSibling;
      node = node.parentElement;
    }
    return owner.getBoundingClientRect();
  });
  const rects = owners.filter((rect) => rect.height);
  const rect = rects[0];
  if (!rect) return false;
  const top = viewport.getBoundingClientRect().top;
  const bottom = top + viewport.clientHeight;
  // A visible copy (for example, a starred channel) already shows it.
  if (rects.some((rect) => rect.top >= top && rect.bottom <= bottom))
    return viewport.scrollTop;
  // Center an offscreen entry clear of the unread edge cues; nudge a clipped
  // one only as far as needed so the row under the pointer does not jump.
  return (
    viewport.scrollTop +
    (rect.bottom <= top || rect.top >= bottom
      ? rect.top - top - (viewport.clientHeight - rect.height) / 2
      : rect.top < top
        ? rect.top - top
        : rect.bottom - bottom)
  );
}

/** Scrolls to `top`; returns the new offset if the viewport moved. */
function scroll(viewport: HTMLElement, top: number) {
  const before = viewport.scrollTop;
  viewport.scrollTop = top;
  return viewport.scrollTop === before ? undefined : viewport.scrollTop;
}

/**
 * `location` keys the main pane's destination. A new destination reveals its
 * sidebar entry once, when that entry first renders, unless the user scrolls
 * first. Remounting at the saved destination keeps the saved position.
 */
export function useSidebarView(
  scope: string,
  ready: boolean,
  location?: string,
  preserve = false,
) {
  const [view, setView] = useState(() => restore(scope));
  const intent = useRef(view);
  const list = useRef<HTMLElement>(null);
  const pending = useRef(true);
  const latestLocation = useRef(location);
  useLayoutEffect(
    () =>
      subscribeView(scope, () => {
        const saved = restore(scope);
        if (
          JSON.stringify(saved.collapsed) ===
            JSON.stringify(intent.current.collapsed) &&
          JSON.stringify(saved.contributionOrder) ===
            JSON.stringify(intent.current.contributionOrder)
        )
          return;
        intent.current = {
          ...intent.current,
          collapsed: saved.collapsed,
          contributionOrder: saved.contributionOrder,
        };
        setView(intent.current);
      }),
    [scope],
  );
  // The destination waiting for its entry to render.
  const reveal = useRef<{ location: string; explicit?: true } | undefined>(
    undefined,
  );
  // Until the first reveal or scroll, the saved destination keeps the
  // restored position.
  const restored = useRef(view.location);

  // The offset this hook last scrolled to, until its scroll event arrives.
  const moved = useRef<number | undefined>(undefined);

  // Once the user moves the viewport, they own it even if they return to the
  // top. A scroll event at the offset this hook set is its own restoration or
  // reveal; any other offset includes user input.
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!viewport) return;
    const scrolled = () => {
      const own = moved.current === viewport.scrollTop;
      moved.current = undefined;
      if (own) return;
      pending.current = false;
      // The user's position now belongs to the destination they navigated
      // to, so returning there keeps it instead of revealing again.
      if (reveal.current)
        intent.current = {
          ...intent.current,
          location: reveal.current.location,
        };
      reveal.current = undefined;
      restored.current = undefined;
    };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    return () => viewport.removeEventListener("scroll", scrolled);
  }, []);

  // Wait for roster/group layout, not optional profile enrichment or messages.
  useLayoutEffect(() => {
    if (!ready || !pending.current || !list.current) return;
    // Compositor scrolling may update the position before its scroll event.
    if (list.current.scrollTop === 0)
      moved.current =
        scroll(list.current, intent.current.scrollTop) ?? moved.current;
    pending.current = false;
  }, [ready]);
  // A destination without an entry (the Messages landing page before it
  // resolves to a conversation) stays pending. It owns the saved position
  // only if the user scrolls there.
  useLayoutEffect(() => {
    latestLocation.current = location;
    reveal.current =
      preserve || location === undefined || location === restored.current
        ? undefined
        : { location };
  }, [location, preserve]);
  // The entry can render after navigation (roster startup, a new DM), so
  // retry after each commit until it exists. Runs after the restore above.
  const attempt = useRef(() => {});
  const preparations = useRef(new Set<(location: string) => boolean>());
  const beforeReveal = useCallback((prepare: (location: string) => boolean) => {
    preparations.current.add(prepare);
    return () => {
      preparations.current.delete(prepare);
    };
  }, []);
  // Only an explicit reveal of the current destination may reclaim the viewport.
  const revealAgain = useCallback(() => {
    if (latestLocation.current === undefined) return;
    reveal.current = { location: latestLocation.current, explicit: true };
    attempt.current();
  }, []);
  const retryReveal = useCallback(() => {
    // Children can retry before this hook's layout effects clear an old reveal.
    if (
      !preserve ||
      (reveal.current?.explicit && reveal.current.location === location)
    )
      attempt.current();
  }, [preserve, location]);
  useLayoutEffect(() => {
    attempt.current = () => {
      if (!ready || !reveal.current || !list.current) return;
      for (const prepare of preparations.current)
        if (!prepare(reveal.current.location)) return;
      const top = revealCurrent(list.current);
      if (top === false) return;
      moved.current = scroll(list.current, top) ?? moved.current;
      intent.current = { ...intent.current, location: reveal.current.location };
      reveal.current = undefined;
      restored.current = undefined;
    };
    attempt.current();
  });
  // A hidden sidebar (the closed narrow drawer) has no layout, and showing it
  // does not rerender this list, so also retry when the viewport gets a size.
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => attempt.current());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const save = () => {
      if (!pending.current && list.current)
        intent.current = {
          ...intent.current,
          scrollTop: list.current.scrollTop,
        };
      // ResizableSidebar owns the record's width; keep its latest value.
      writeView(scope, "channel-sidebar", {
        ...readView<object | null>(scope, "channel-sidebar", null),
        ...intent.current,
      });
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [scope]);

  const update = useCallback(
    (next: SidebarView) => {
      intent.current = next;
      setView(next);
      writeView(scope, "channel-sidebar", {
        ...readView<object>(scope, "channel-sidebar", {}),
        ...next,
      });
    },
    [scope],
  );
  const toggle = useCallback(
    (key: string, open: boolean) => {
      const collapsed = intent.current.collapsed;
      if (collapsed.includes(key) === !open) return;
      pending.current = false;
      update({
        ...intent.current,
        collapsed: open
          ? collapsed.filter((id) => id !== key)
          : [...collapsed, key],
      });
    },
    [update],
  );
  const setContributionOrder = useCallback(
    (contributionOrder: readonly string[]) => {
      update({ ...intent.current, contributionOrder: [...contributionOrder] });
    },
    [update],
  );
  return {
    list,
    collapsed: view.collapsed,
    contributionOrder: view.contributionOrder,
    setContributionOrder,
    toggle,
    retryReveal,
    revealAgain,
    beforeReveal,
  };
}
