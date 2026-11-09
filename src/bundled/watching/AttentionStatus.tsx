import type { RefObject } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { CircleIcon } from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";

export function AttentionStatus({
  name,
  heading = "Attention",
  active,
  pending,
  onChange,
  onDelete,
  triggerRef,
  returnFocus,
  popupRef,
  deleteConfirms = false,
  label = `Attention status for ${name}`,
}: {
  name: string;
  heading?: string;
  popupRef?: RefObject<HTMLDivElement | null>;
  deleteConfirms?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  returnFocus?: RefObject<HTMLElement | null>;
  label?: string;
  onDelete?(): void;
  active: boolean;
  pending: boolean;
  onChange(active: boolean): void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            ref={triggerRef}
            variant="subtle"
            size="xs"
            aria-label={label}
          >
            <CircleIcon
              data-accent={active ? "citrus" : undefined}
              data-color-mode={active ? "light" : undefined}
              size={12}
              fill="currentColor"
              strokeWidth={0}
              aria-hidden="true"
              style={{
                color: active
                  ? "var(--affordance-accent-prominent)"
                  : "var(--text-subtle)",
              }}
            />
            {active ? "Active" : "Paused"}
          </Button>
        }
      />
      <MenuPopup
        ref={popupRef}
        finalFocus={() =>
          triggerRef?.current?.isConnected
            ? triggerRef.current
            : (returnFocus?.current ?? true)
        }
        size="compact"
        align="end"
        aria-label={label}
      >
        <MenuGroup>
          <MenuGroupLabel>{heading}</MenuGroupLabel>
          <MenuItem
            disabled={pending}
            closeOnClick={false}
            onClick={() => onChange(!active)}
          >
            {active ? "Pause" : "Resume"}
          </MenuItem>
          {onDelete && <MenuSeparator />}
          {onDelete && (
            <MenuItem
              tone="danger"
              disabled={pending}
              closeOnClick={deleteConfirms}
              onClick={onDelete}
            >
              Delete
            </MenuItem>
          )}
        </MenuGroup>
      </MenuPopup>
    </MenuRoot>
  );
}
