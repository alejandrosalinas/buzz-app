import { useEffect, useEffectEvent, useState, type RefObject } from "react";

/** An unclaimed file or link drop would navigate the webview to it, so the app rejects it. */
export function useRejectUnclaimedDrops() {
  useEffect(() => {
    const reject = (event: DragEvent) => {
      const { target, dataTransfer } = event;
      if (!dataTransfer) return;
      const files = dataTransfer.types.includes("Files");
      if (!files && !dataTransfer.types.includes("text/uri-list")) return;
      // The browser itself accepts files into a file input and links into editable text.
      if (
        target instanceof HTMLElement &&
        (files
          ? target instanceof HTMLInputElement && target.type === "file"
          : target.isContentEditable || target.matches(":read-write"))
      )
        return;
      if (!event.defaultPrevented) dataTransfer.dropEffect = "none";
      event.preventDefault();
    };
    window.addEventListener("dragover", reject);
    window.addEventListener("drop", reject);
    return () => {
      window.removeEventListener("dragover", reject);
      window.removeEventListener("drop", reject);
    };
  }, []);
}

/** Route a file drop to this pane's composer, never another open conversation. */
export function useFileDrop(
  composer: RefObject<HTMLFormElement | null>,
  enabled: boolean,
  attach: (files: readonly File[]) => void,
) {
  const [dragging, setDragging] = useState(false);
  const accept = useEffectEvent((files: readonly File[]) => {
    if (enabled) attach(files);
  });
  useEffect(() => {
    setDragging(false);
    const form = composer.current;
    const zone =
      form?.closest<HTMLElement>("[data-attachment-drop-zone]") ?? form;
    if (!zone) return;
    // The node under the drag tells a real leave from a child boundary. A zone
    // that mounts under a drag already in progress never sees it enter, so
    // dragover records the node too.
    let under: EventTarget | null = null;
    const files = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files");
    const owns = (event: DragEvent) =>
      event.target instanceof Element &&
      (event.target.closest("[data-attachment-drop-zone]") ?? form) === zone;
    const reset = () => {
      under = null;
      setDragging(false);
    };
    const enter = (event: DragEvent) => {
      if (!files(event)) return;
      // Entering a nested zone hands the drag to that zone.
      if (!owns(event)) {
        under = null;
        return;
      }
      event.preventDefault();
      under = event.target;
      setDragging(enabled);
    };
    const leave = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      // Entering a child reports the child first, then this leave of its parent.
      // No node here means the drag has just entered a nested zone, which
      // cleared it: this leave of our own node hands the drag to that zone.
      if (!under || under === event.target) reset();
    };
    const over = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      under = event.target;
      setDragging(enabled);
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      accept(Array.from(event.dataTransfer?.files ?? []));
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("dragover", over);
    zone.addEventListener("drop", drop);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("drop", drop);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [composer, enabled]);
  return enabled && dragging;
}
