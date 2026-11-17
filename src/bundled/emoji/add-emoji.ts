/** Picker light-DOM children with this slot render at the end of the preview. */
export const PREVIEW_ACTION_SLOT = "buzz-preview-action";

/** The picker's "Add emoji" action, present only while its Settings card is. */
export function createAddEmoji() {
  let open: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => open,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    provide(next: () => void) {
      open = next;
      publish();
      return () => {
        if (open !== next) return;
        open = undefined;
        publish();
      };
    },
  };
}
export type AddEmoji = ReturnType<typeof createAddEmoji>;
