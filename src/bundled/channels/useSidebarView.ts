import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { focusWithKeyboard } from "../../shared/design-system/useKeyboardFocusVisibility";
import { readView, subscribeView, writeView } from "../../shared/view-state";
import { contributedSidebarSectionKey } from "./sidebar-sections";

type SidebarView = {
  collapsed: string[];
  importedWorkspaceCollapse?: true;
  contributionOrder: string[];
  scrollTop: number;
  /** The destination whose sidebar entry the saved position shows. */
  location?: string | undefined;
};

function restore(scope: string): SidebarView {
  const raw = readView<unknown>(scope, "channel-sidebar", null);
  const saved =
    raw && typeof raw === "object" ? (raw as Partial<SidebarView>) : {};
  const collapsed = Array.isArray(saved.collapsed)
    ? saved.collapsed.filter((key): key is string => typeof key === "string")
    : [];
  const legacy = saved.importedWorkspaceCollapse
    ? []
    : readView<unknown>(scope, "solo:collapsed-projects", []);
  if (Array.isArray(legacy))
    for (const id of legacy)
      if (typeof id === "string") collapsed.push(id ? `group:${id}` : "solo");
  return {
    collapsed: [...new Set(collapsed)],
    importedWorkspaceCollapse: true,
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
    importedWorkspaceCollapse: true,
    collapsed: restore(scope).collapsed.filter((id) => id !== key),
  });
}

/**
 * Show the current destination (`aria-current="page"`) in the sidebar
 * viewport. Rows hidden by a collapsed section or session list are shown
 * through the header or parent row that represents them. Wait for a current
 * entry with layout before choosing the target and its scroll offset.
 */
function revealCurrent(viewport: HTMLElement, sectionKey?: string) {
  const section = sectionKey
    ? viewport.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(sectionKey)}"]`,
      )
    : viewport;
  if (!section) return;
  const owners = [
    ...section.querySelectorAll<HTMLElement>('[aria-current="page"]'),
  ].map((entry) => {
    let owner = entry;
    for (let node: HTMLElement | null = entry; node && node !== viewport; ) {
      if (node.hidden) {
        // A card can wrap its disclosure and panel in separate containers.
        const heading = node.id
          ? (
              node.closest("[data-sidebar-section]") ?? section
            ).querySelector<HTMLElement>(
              `:is(summary,button)[aria-controls="${CSS.escape(node.id)}"]`,
            )
          : undefined;
        const proxy = heading ?? node.previousElementSibling;
        if (proxy instanceof HTMLElement) owner = proxy;
      }
      node = node.parentElement;
    }
    return { target: owner, rect: owner.getBoundingClientRect() };
  });
  const laidOut = owners.filter(({ rect }) => rect.height);
  if (!laidOut.length && sectionKey) {
    const target = section.querySelector<HTMLElement>("summary");
    const rect = target?.getBoundingClientRect();
    if (target && rect?.height) laidOut.push({ target, rect });
  }
  const first = laidOut[0];
  if (!first) return;
  const top = viewport.getBoundingClientRect().top;
  const bottom = top + viewport.clientHeight;
  // A visible copy (for example, a starred channel) already shows it.
  const visible = laidOut.find(
    ({ rect }) => rect.top >= top && rect.bottom <= bottom,
  );
  if (visible) return { target: visible.target, top: viewport.scrollTop };
  const { target, rect } = first;
  // Center an offscreen entry clear of the unread edge cues; nudge a clipped
  // one only as far as needed so the row under the pointer does not jump.
  return {
    target,
    top:
      viewport.scrollTop +
      (rect.bottom <= top || rect.top >= bottom
        ? rect.top - top - (viewport.clientHeight - rect.height) / 2
        : rect.top < top
          ? rect.top - top
          : rect.bottom - bottom),
  };
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
  const savedLocation = useRef(view.location).current;
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
      }, ["channel-sidebar", "solo:collapsed-projects"]),
    [scope],
  );
  // The destination waiting for its entry to render.
  const reveal = useRef<
    | {
        location: string;
        explicit?: true;
        sectionKey?: string | undefined;
      }
    | undefined
  >(undefined);
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
  // Only an explicit reveal of the current destination may reclaim the viewport.
  const revealAgain = useCallback((sectionKey?: string) => {
    if (latestLocation.current === undefined) return;
    reveal.current = {
      location: latestLocation.current,
      explicit: true,
      sectionKey,
    };
    attempt.current();
  }, []);
  const retryReveal = useCallback(() => {
    // Children can retry before this hook's layout effects clear an old reveal.
    const pending = reveal.current;
    if (pending?.explicit ? pending.location === location : !preserve)
      attempt.current();
  }, [preserve, location]);
  useLayoutEffect(() => {
    attempt.current = () => {
      if (!ready || !reveal.current || !list.current) return;
      const destination = revealCurrent(
        list.current,
        reveal.current.sectionKey,
      );
      if (!destination) return;
      const { target, top } = destination;
      const { explicit, location } = reveal.current;
      moved.current = scroll(list.current, top) ?? moved.current;
      intent.current = { ...intent.current, location };
      reveal.current = undefined;
      restored.current = undefined;
      if (explicit) focusWithKeyboard(target);
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
  return useMemo(
    () => ({
      list,
      savedLocation,
      collapsed: view.collapsed,
      contributionOrder: view.contributionOrder,
      setContributionOrder,
      toggle,
      retryReveal,
      revealAgain,
    }),
    [
      savedLocation,
      view.collapsed,
      view.contributionOrder,
      setContributionOrder,
      toggle,
      retryReveal,
      revealAgain,
    ],
  );
}
