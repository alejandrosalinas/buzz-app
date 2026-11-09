import { useSyncExternalStore } from "react";
import { parseMessageDensity, type MessageDensity } from "./service";

/** The appearance service and its pre-paint script own the root attribute. */
const ATTRIBUTE = "data-message-density";
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  // One observer serves every conversation row.
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [ATTRIBUTE],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

const applied = (): MessageDensity =>
  parseMessageDensity(document.documentElement.getAttribute(ATTRIBUTE));

/** The applied density, for layout choices CSS cannot make (row order, alignment). */
export function useMessageDensity(): MessageDensity {
  return useSyncExternalStore(subscribe, applied, () => "default");
}
