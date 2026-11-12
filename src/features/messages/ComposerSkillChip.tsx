import { useRef } from "react";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { composerTokenName, type ComposerToken } from "./composer-token";
import styles from "./EditableInput.module.css";

type SkillToken = Extract<ComposerToken, { kind: "skill" }>;

/** A skill chip opens its details in place: a nested surface, never a visit. */
export function ComposerSkillChip({
  token,
  returnCaret,
}: {
  token: SkillToken;
  /** Puts the editor's caret right after this chip; false if it cannot. */
  returnCaret(): boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const description = text(token.description);
  const location = text(token.location);
  return (
    <PopoverRoot>
      <PopoverTrigger
        ref={trigger}
        data-buzz-ui=""
        className="inline-chip"
        aria-label={composerTokenName(token)}
      >
        <span className="inline-chip-label">{token.label}</span>
      </PopoverTrigger>
      <PopoverPopup
        ref={popup}
        // Focus bound for the chip goes on to the text after it. Focus the
        // user moved elsewhere stays there.
        finalFocus={() => {
          const active = trigger.current?.ownerDocument.activeElement;
          const returning =
            !active ||
            active === trigger.current ||
            active === active.ownerDocument.body ||
            !!popup.current?.contains(active);
          return !(returning && returnCaret());
        }}
      >
        <PopoverTitle>{token.label}</PopoverTitle>
        {description && <PopoverDescription>{description}</PopoverDescription>}
        {location && (
          <p className={`text-body-sm text-secondary ${styles.skillLocation}`}>
            {location}
          </p>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
