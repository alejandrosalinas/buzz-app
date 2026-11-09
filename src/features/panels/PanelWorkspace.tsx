import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  BrowserIcon,
  TerminalWindowIcon,
} from "../../shared/design-system/icons";
import {
  Tabs,
  TabMenu,
  type TabAction,
} from "../../shared/design-system/ui/Tabs";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Panels.module.css";
import type { TabDragHost } from "./useTabDrag";

type Item = {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
  /** Increment when an opening returns to this existing tab. */
  attentionRequest?: number | undefined;
  /** Stable for one opening, including retained exit content. */
  instance?: object;
  /** Omit for a permanent tab such as a channel's own conversation. Returns
   * false when it keeps the tab, as when asking about unsaved edits first. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Closers that return nothing stay valid; only false keeps the tab.
  close?: (() => boolean | void) | undefined;
  /** Keyboard placement: one position left or right, across panes at an edge. */
  move?: ((delta: -1 | 1) => void) | undefined;
  /** A blank name restores the tab's own title. */
  rename?: ((name: string) => void) | undefined;
  actions?: readonly TabAction[] | undefined;
  /** Header icon actions for this tab's content, shown while it is selected. */
  toolbar?: ReactNode;
};
type Identity = { label: string; icon?: ReactNode };
/** `keepOwner`: the owner stays open; only its detail tabs are cleared. */
type Close = (options?: { keepOwner?: boolean }) => void;
type Local = { id: string; label: string; owner: string; close: Close };
const TabHost = createContext<{
  owner: string;
  register(tab: Local): () => void;
  activate(owner: string, label: string): boolean;
  title(owner: string, identity: Identity | undefined): void;
  slots: ReadonlyMap<string, HTMLDivElement>;
} | null>(null);
export function usePanelTabHost() {
  return useContext(TabHost);
}

export function usePanelTabTitle(label: string, icon?: ReactNode) {
  const host = usePanelTabHost();
  const title = host?.title;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!title || !owner) return;
    title(owner, { label, icon });
    return () => title(owner, undefined);
  }, [title, owner, label, icon]);
}

// Keyboard opens and reduced motion skip the push. Deciding here, rather than
// in CSS, keeps a suppressed animation from leaving the pane marked as
// entering, which would replay the push once those conditions change.
function suppressPush() {
  return (
    document.documentElement.dataset.keyboardInput !== undefined ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

const contentTarget = '[data-tab-focus]:not([aria-disabled="true"])';

/** Moves focus from a chosen tab to its content once mounted, unless it left. */
function focusWhenReady(panel: HTMLElement, tab: HTMLElement) {
  const stop = () => {
    observer.disconnect();
    tab.removeEventListener("blur", stop);
  };
  const observer = new MutationObserver(() => {
    const content = panel.querySelector<HTMLElement>(contentTarget);
    if (!content) return;
    stop();
    content.focus({ preventScroll: true });
  });
  observer.observe(panel, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-disabled"],
  });
  tab.addEventListener("blur", stop);
  return stop;
}

/** The channel owns target tabs; private details retain their feature's lifetime. */
export function PanelWorkspace({
  items,
  value,
  select,
  actions,
  identity,
  main = false,
  label = "Panel tabs",
  focusOnMount = true,
  adoptSelection,
  tabMenu,
  drag,
}: {
  /** The channel owner closes tabs across both panes, including hidden tabs. */
  tabMenu?:
    | {
        key: string;
        closeAll(): boolean;
        closeOthers?: ((id: string) => boolean) | undefined;
      }
    | undefined;
  drag?: TabDragHost | undefined;
  items: Item[];
  value: string;
  select(id: string): void;
  /** Header icon actions owned by the hosting page. */
  actions?: ReactNode;
  /** Interactive conversation identity; a lone permanent tab needs no tab strip. */
  identity?: ReactNode;
  /**
   * The page's main pane: a lone permanent tab reads as a title, and native
   * Close acts here only while focus is inside (the side pane is the default).
   */
  main?: boolean;
  label?: string;
  /** Restoring a channel visit leaves focus with its main conversation. */
  focusOnMount?: boolean;
  /** A new value adopts the current selection without moving focus. */
  adoptSelection?: unknown;
}) {
  const prefix = useId();
  const panelId = (id: string) => `${prefix}-${id}`;
  const [titles, setTitles] = useState<Record<string, Identity | undefined>>(
    {},
  );
  const title = useCallback((owner: string, identity: Identity | undefined) => {
    setTitles((current) =>
      current[owner] === identity ? current : { ...current, [owner]: identity },
    );
  }, []);
  const [locals, setLocals] = useState<Local[]>([]);
  const [localSelection, setLocalSelection] = useState<string>();
  const [slots, setSlots] = useState(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  const closingTab = useRef<string | undefined>(undefined);
  // Choosing a tab with the pointer resumes its content's typing target;
  // keyboard selection keeps focus in the tab list.
  const pointerTab = useRef(false);
  const focusContent = useRef(false);
  // Content that mounts after its tab is chosen takes that focus once ready.
  const awaitContent = useRef<() => void>(undefined);
  useLayoutEffect(() => () => awaitContent.current?.(), []);
  const register = useCallback((tab: Local) => {
    setLocals((current) => [
      ...current.filter((item) => item.id !== tab.id),
      tab,
    ]);
    setLocalSelection(tab.id);
    focusTab.current = true;
    return () => {
      setLocals((current) => current.filter((item) => item.id !== tab.id));
      setLocalSelection((current) =>
        current === tab.id ? undefined : current,
      );
    };
  }, []);
  const setSlot = useCallback((id: string, element: HTMLDivElement | null) => {
    setSlots((current) => {
      if (current.get(id) === element || (!element && !current.has(id)))
        return current;
      const next = new Map(current);
      if (element) next.set(id, element);
      else next.delete(id);
      return next;
    });
  }, []);
  const owned = locals.filter((tab) =>
    items.some((item) => item.id === tab.owner),
  );
  const activate = useCallback(
    (owner: string, label: string) => {
      const tab = locals.find(
        (tab) => tab.owner === owner && tab.label === label,
      );
      if (!tab) return false;
      setLocalSelection(tab.id);
      return true;
    },
    [locals],
  );
  const selectedLocal = owned.find(
    (tab) => tab.id === localSelection && tab.owner === value,
  );
  const selected = selectedLocal?.id ?? value;
  const tabs = items.flatMap((item) => [
    {
      ...item,
      ...titles[item.id],
      icon: titles[item.id]?.icon ?? item.icon ?? <BrowserIcon size="1rem" />,
    },
    ...owned
      .filter((tab) => tab.owner === item.id)
      .map((tab) => ({ ...tab, icon: <TerminalWindowIcon size="1rem" /> })),
  ]);
  const active = tabs.find((tab) => tab.id === selected);
  const choose = (id: string) => {
    const local = owned.find((tab) => tab.id === id);
    setLocalSelection(local?.id);
    select(local?.owner ?? id);
  };
  useLayoutEffect(() => {
    const visible = () => {
      const element = root.current;
      return (
        !!element?.isConnected &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
        !!element.getClientRects().length
      );
    };
    // Tab switching stays focus-owned; Close can fall back from the permanent
    // main conversation to the selected visible side tab.
    const source = (event: Event) =>
      event.target instanceof Element ? event.target : document.activeElement;
    const owns = (event: Event) => {
      const element = root.current;
      return (
        visible() &&
        (source(event)?.closest(
          "[data-panel-workspace], [data-main-workspace]",
        ) ?? (main || event.target instanceof Element ? null : element)) ===
          element
      );
    };
    const close = (event: Event) => {
      const focusedMain = source(event)?.closest("[data-main-workspace]");
      const fallback =
        !main &&
        visible() &&
        focusedMain &&
        !focusedMain.hasAttribute("data-active-tab-closable");
      if (
        event.defaultPrevented ||
        !active?.close ||
        (!owns(event) && !fallback)
      )
        return;
      event.preventDefault();
      const keptFocus = fallback ? document.activeElement : null;
      // Match the X button, including local detail tabs and focus recovery.
      // Commit before another native menu request can reuse this selection.
      const declined = flushSync(() => {
        closingTab.current = active.id;
        if (active.close?.() !== false) return false;
        closingTab.current = undefined;
        return true;
      });
      // Fallback closes another pane, not the editor the person is still using.
      // A declined close may be asking first; its prompt keeps focus.
      if (
        !declined &&
        keptFocus instanceof HTMLElement &&
        keptFocus.isConnected
      )
        keptFocus.focus({ preventScroll: true });
    };
    // Ctrl+Tab and Ctrl+Shift+Tab, from the native menu or desktop shortcut.
    const step = (delta: -1 | 1) => (event: Event) => {
      if (event.defaultPrevented || tabs.length < 2 || !owns(event)) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.id === selected);
      const target = tabs[(index + delta + tabs.length) % tabs.length];
      if (!target) return;
      // Like a browser, land in the next tab's content rather than the strip.
      focusContent.current = true;
      // Commit before a held accelerator's next request reads the selection.
      flushSync(() => choose(target.id));
    };
    const showNext = step(1);
    const showPrevious = step(-1);
    window.addEventListener("buzz:close-active-tab", close);
    window.addEventListener("buzz:next-tab", showNext);
    window.addEventListener("buzz:previous-tab", showPrevious);
    return () => {
      window.removeEventListener("buzz:close-active-tab", close);
      window.removeEventListener("buzz:next-tab", showNext);
      window.removeEventListener("buzz:previous-tab", showPrevious);
    };
  });
  const previous = useRef<string>(focusOnMount ? undefined : selected);
  const instance = items.find((item) => item.id === selected)?.instance;
  const previousInstance = useRef<object>(focusOnMount ? undefined : instance);
  const adopted = useRef(adoptSelection);
  // In the main pane, a newly selected closable tab (a thread) slides in over
  // the tab it replaces; returning to the permanent tab stays immediate.
  const [motion, setMotion] = useState<{ enter: string; leave: string }>();
  useLayoutEffect(() => {
    if (adopted.current !== adoptSelection) {
      adopted.current = adoptSelection;
      previous.current = selected;
      previousInstance.current = instance;
    }
    if (
      previous.current !== selected ||
      previousInstance.current !== instance ||
      focusTab.current ||
      (closingTab.current && !tabs.some((tab) => tab.id === closingTab.current))
    ) {
      const tab =
        root.current?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ??
        root.current?.querySelector<HTMLElement>(
          "[data-workspace-identity] button",
        );
      awaitContent.current?.();
      awaitContent.current = undefined;
      const panel =
        focusContent.current && previous.current !== selected
          ? document.getElementById(panelId(selected))
          : undefined;
      const content = panel?.querySelector<HTMLElement>(contentTarget);
      // A route may mount/select a retained tab behind an open dialog.
      // Its navigation must not take focus from the modal's own handoff.
      const modal = document.querySelector('dialog[open], [aria-modal="true"]');
      if (!modal || modal.contains(root.current)) {
        content?.focus({ preventScroll: true });
        if (!content || document.activeElement !== content)
          tab?.focus({ preventScroll: true });
        if (panel && !content && tab && document.activeElement === tab)
          awaitContent.current = focusWhenReady(panel, tab);
      }
      tab?.parentElement?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
      if (main && previous.current && previous.current !== selected)
        setMotion(
          items.find((item) => item.id === selected)?.close && !suppressPush()
            ? { enter: selected, leave: previous.current }
            : undefined,
        );
      previous.current = selected;
      previousInstance.current = instance;
      focusTab.current = false;
      focusContent.current = false;
      closingTab.current = undefined;
    }
  });
  const identityOnly = !!identity && tabs.length === 1 && !tabs[0]?.close;
  const heading = identity ? (
    <div data-workspace-identity="" className={styles.workspaceIdentity}>
      {identityOnly && tabMenu ? (
        <TabMenu
          key={tabMenu.key}
          label={tabs[0]?.label ?? label}
          actions={undefined}
          onClose={undefined}
          onRename={undefined}
          closeAll={tabMenu.closeAll}
          closeOthers={undefined}
        >
          {identity}
        </TabMenu>
      ) : (
        identity
      )}
    </div>
  ) : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from descendant controls closes their active tab.
    <div
      {...(main
        ? { "data-main-workspace": "" }
        : { "data-panel-workspace": "" })}
      data-active-tab-closable={!!active?.close || undefined}
      data-overlay-boundary=""
      className={styles.workspace}
      ref={(element) => {
        root.current = element;
        drag?.attach(element);
      }}
      onClickCapture={drag?.click}
      onPointerDownCapture={(event) => {
        drag?.begin(event);
        awaitContent.current?.();
        awaitContent.current = undefined;
        pointerTab.current = !!(event.target as Element).closest?.(
          '[role="tab"]',
        );
      }}
      onKeyDownCapture={() => {
        awaitContent.current?.();
        awaitContent.current = undefined;
        pointerTab.current = false;
      }}
      onKeyDown={(event) => {
        // A hovered preview can open while focus stays elsewhere in this pane.
        // Let Base UI's document handler dismiss it before closing its owner.
        if (
          event.key === "Escape" &&
          event.currentTarget.querySelector(
            "[data-preview-card-trigger][data-popup-open]",
          )
        )
          return;
        if (
          event.key === "Escape" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !event.defaultPrevented &&
          active?.close &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          active.close();
        }
      }}
    >
      <PanelHeader
        navigation={!identityOnly ? heading : undefined}
        actions={
          active && "toolbar" in active && active.toolbar ? (
            <>
              {active.toolbar}
              {actions}
            </>
          ) : (
            actions
          )
        }
        title={
          identityOnly ? (
            heading
          ) : (
            <Tabs
              label={label}
              variant="navigation"
              showSelection={!main || tabs.length > 1}
              value={selected}
              items={tabs.map((tab) => ({
                value: tab.id,
                label: tab.label,
                icon: tab.icon,
                panelId: panelId(tab.id),
                attentionRequest:
                  "attentionRequest" in tab ? tab.attentionRequest : undefined,
                onMove: "move" in tab ? tab.move : undefined,
                onRename: "rename" in tab ? tab.rename : undefined,
                actions: "actions" in tab ? tab.actions : undefined,
                draggable: !!drag && "move" in tab && !!tab.move,
                onClose: tab.close
                  ? () => {
                      // Recover focus only when removing its current owner.
                      closingTab.current = document
                        .getElementById(`${panelId(tab.id)}-tab`)
                        ?.parentElement?.contains(document.activeElement)
                        ? tab.id
                        : undefined;
                      if (tab.close?.() === false)
                        closingTab.current = undefined;
                    }
                  : undefined,
              }))}
              tabMenu={
                tabMenu && {
                  ...tabMenu,
                  // A detail tab cannot outlive its owner, so the owner is kept.
                  // Details live only here: close the kept owner's ones too,
                  // even when the channel has no other tab to close.
                  closeOthers:
                    tabMenu.closeOthers &&
                    ((id) => {
                      const local = owned.find((tab) => tab.id === id);
                      const keep = local?.owner ?? id;
                      const details = owned.filter((tab) => tab.owner === keep);
                      const closed = tabMenu.closeOthers?.(keep) ?? false;
                      if (!closed && !details.length) return false;
                      // Focus follows the chosen detail's removal to its owner.
                      if (local) closingTab.current = local.id;
                      for (const tab of details) tab.close({ keepOwner: true });
                      return true;
                    }),
                }
              }
              onValueChange={(id) => {
                focusContent.current = pointerTab.current;
                pointerTab.current = false;
                choose(id);
              }}
            />
          )
        }
      />
      <div className={styles.workspaceBody}>
        {items.map((item) => (
          <TabScope
            key={item.id}
            owner={item.id}
            activate={activate}
            title={title}
            register={register}
            slots={slots}
          >
            <div
              {...(identityOnly
                ? { role: "region", "aria-label": item.label }
                : {
                    role: "tabpanel",
                    "aria-labelledby": `${panelId(item.id)}-tab`,
                  })}
              id={panelId(item.id)}
              className={styles.workspacePane}
              data-covered={selected !== item.id || undefined}
              data-entering={motion?.enter === item.id || undefined}
              data-leaving={motion?.leave === item.id || undefined}
              onAnimationEnd={(event) => {
                if (
                  event.target === event.currentTarget &&
                  motion?.enter === item.id
                )
                  setMotion(undefined);
              }}
              inert={selected !== item.id}
              aria-hidden={selected !== item.id || undefined}
            >
              {item.content}
            </div>
          </TabScope>
        ))}
        {owned.map((tab) => (
          <LocalSlot
            key={tab.id}
            id={tab.id}
            panelId={panelId(tab.id)}
            selected={selected === tab.id}
            setSlot={setSlot}
          />
        ))}
      </div>
    </div>
  );
}
function TabScope({
  owner,
  activate,
  title,
  register,
  slots,
  children,
}: NonNullable<ReturnType<typeof usePanelTabHost>> & { children: ReactNode }) {
  const value = useMemo(
    () => ({ owner, activate, title, register, slots }),
    [owner, activate, title, register, slots],
  );
  return <TabHost.Provider value={value}>{children}</TabHost.Provider>;
}
function LocalSlot({
  id,
  panelId,
  selected,
  setSlot,
}: {
  id: string;
  panelId: string;
  selected: boolean;
  setSlot(id: string, element: HTMLDivElement | null): void;
}) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => setSlot(id, element),
    [id, setSlot],
  );
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId}
      aria-labelledby={`${panelId}-tab`}
      className={styles.workspacePane}
      data-covered={!selected || undefined}
      inert={!selected}
      aria-hidden={!selected || undefined}
    />
  );
}
export function PanelLocalTab({
  title,
  close,
  children,
}: {
  title: string;
  close: Close;
  children: ReactNode;
}) {
  const host = usePanelTabHost();
  const id = useId();
  const onClose = useRef(close);
  onClose.current = close;
  const register = host?.register;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!register || !owner) return;
    return register({
      id,
      label: title,
      owner,
      close: (options) => onClose.current(options),
    });
  }, [register, owner, id, title]);
  const slot = host?.slots.get(id);
  return slot
    ? createPortal(
        <section className={styles.tabDetail} aria-label={title}>
          {children}
        </section>,
        slot,
      )
    : null;
}
