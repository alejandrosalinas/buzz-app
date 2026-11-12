import { useEffect, type RefObject } from "react";
import {
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuRoot,
} from "../../shared/design-system/ui/Menu";
import type {
  AnnotationMenuRequest,
  ComposerInputElement,
} from "./composer-dom";

/** One shown annotation's label and replacements. Picking one asks the editor
 * to replace the text, which it refuses if the draft moved on; any edit, the
 * annotation being withdrawn or replaced, or a composition starting closes the
 * menu first. Focus returns to the editor. */
export function AnnotationMenu({
  request,
  input,
  onClose,
}: {
  request: AnnotationMenuRequest;
  input: RefObject<ComposerInputElement | null>;
  onClose(): void;
}) {
  const { mark, revision } = request;
  useEffect(() => {
    const element = input.current;
    if (!element?.shownAnnotations.includes(mark)) {
      onClose();
      return;
    }
    const stale = () => {
      if (!element.shownAnnotations.includes(mark)) onClose();
    };
    element.addEventListener("select", stale);
    element.addEventListener("compositionstart", onClose);
    return () => {
      element.removeEventListener("select", stale);
      element.removeEventListener("compositionstart", onClose);
    };
  }, [input, mark, onClose]);
  return (
    <MenuRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPopup
        anchor={request.anchor}
        size="compact"
        finalFocus={input}
        aria-label={`${mark.label}: “${mark.text}”`}
      >
        <MenuNote>{mark.label}</MenuNote>
        {mark.replacements.map((choice) => (
          <MenuItem
            key={choice.text}
            onClick={() => {
              input.current?.replaceAnnotation(revision, mark, choice.text);
            }}
          >
            {choice.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </MenuRoot>
  );
}
