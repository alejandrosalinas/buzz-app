import { Button } from "../../shared/design-system/ui/Button";
import { CaretDownIcon } from "../../shared/design-system/icons";
import type {
  SoloDisclosureProps,
  SoloHeaderLeading,
} from "./solo-navigation-contract";
import styles from "./SoloDestination.module.css";

/** The host owns the disclosure icon, button states and disappearing-content focus. */
export function SoloDisclosure(
  props: SoloDisclosureProps & { leading?: SoloHeaderLeading | undefined },
) {
  const disclosure = (
    <Button
      variant="plain"
      size={props.leading ? "text" : "inline"}
      data-solo-disclosure=""
      aria-label={props.label}
      title={props.leading?.wrapControls ? undefined : props.label}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={(event) => {
        if (
          props.expanded &&
          document
            .getElementById(props.controls)
            ?.contains(document.activeElement)
        )
          event.currentTarget.focus({ preventScroll: true });
        props.onToggle();
      }}
    >
      <CaretDownIcon size={14} aria-hidden="true" />
      {props.summary && <span className={styles.summary}>{props.summary}</span>}
    </Button>
  );
  if (!props.leading) return disclosure;
  const { icon, label, onActivate, wrapControls } = props.leading;
  const controls = (
    <span className={styles.leading}>
      <Button
        variant="plain"
        size="text"
        data-solo-leading-action=""
        aria-label={label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onActivate}
      >
        {icon}
      </Button>
      {disclosure}
    </span>
  );
  return wrapControls?.(controls) ?? controls;
}
