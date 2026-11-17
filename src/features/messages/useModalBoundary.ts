import { useEffect, useRef, type RefObject } from "react";
import { behindActiveOverlay } from "../../shared/design-system/overlayLayer";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

const available = (target: HTMLElement | undefined) =>
  !!target?.isConnected &&
  !target.closest('[hidden], [inert], [aria-hidden="true"]');

/** Makes a portalled viewer a real modal and restores its available opener. */
export function useModalBoundary(
  backdrop: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  close: () => void,
  restoreFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  const openerRef = useRef<HTMLElement | undefined>(undefined);
  closeRef.current = close;
  useEffect(() => {
    const container = backdrop.current;
    if (!container) return;
    const active = document.activeElement;
    // Effect replay must not replace the actual opener with the modal's focus.
    if (!container.contains(active))
      openerRef.current = active instanceof HTMLElement ? active : undefined;
    const opener = openerRef.current;
    const siblings = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== container,
    );
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of siblings) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    initialFocus.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      // A nested popup owns Escape and Tab even before its autofocus settles.
      // Its document listener can run after this viewer's listener.
      if (
        event.defaultPrevented ||
        behindActiveOverlay(initialFocus.current ?? container)
      )
        return;
      // Portalled dialogs, including non-modal controls, own their focus through Base UI.
      const popup =
        event.target instanceof Element
          ? event.target.closest('[role="alertdialog"], [role="dialog"]')
          : null;
      if (popup && !container.contains(popup)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter(
        (element) =>
          !element.hidden &&
          !element.closest("[inert]") &&
          element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        initialFocus.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      const outsideTabStops =
        !container.contains(active) ||
        (active === initialFocus.current &&
          !focusable.some((element) => element === active));
      if (
        outsideTabStops ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null)
          state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      const target = restoreFocus?.current ?? opener;
      let handoffFocus: Element | null = null;
      const mayRestore = () =>
        available(target) &&
        (document.activeElement === document.body ||
          container.contains(document.activeElement) ||
          document.activeElement === handoffFocus);
      if (mayRestore()) {
        // An explicit handoff wins over mount effects (e.g. ThreadHeader focus)
        // in this commit, but not a later focus move before the queued frame.
        if (restoreFocus?.current)
          queueMicrotask(() => {
            handoffFocus = document.activeElement;
          });
        requestAnimationFrame(() => {
          if (mayRestore()) target?.focus({ preventScroll: true });
        });
      }
    };
  }, [backdrop, initialFocus, restoreFocus]);
}
