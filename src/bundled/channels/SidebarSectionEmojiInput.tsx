import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { CUSTOM_REACTION } from "../../features/relay/emoji";
import { EmojiPicker } from "../emoji/EmojiPicker";
import { SmileyIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import styles from "./SidebarSectionEmojiInput.module.css";

type Session = Pick<RelaySession, "emoji" | "media">;

/** The section forms share one emoji trigger, picker, and independent clear action. */
export function SidebarSectionEmojiInput({
  children,
  session,
  scope,
  icon,
  onIconChange,
  disabled = false,
}: {
  children: ReactNode;
  session: Session;
  scope: string;
  icon: string;
  onIconChange: (icon: string) => void;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const pickerId = `section-emoji-${useId()}`;
  const close = useCallback(() => setPickerOpen(false), []);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  const selection = CUSTOM_REACTION.exec(icon)?.[1] ?? icon;
  const label = icon
    ? `Change section emoji, currently ${selection}`
    : "Choose section emoji";
  return (
    <>
      <InputGroup
        ref={field}
        leading={
          <IconButton
            ref={trigger}
            type="button"
            size="sm"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen && !disabled}
            aria-controls={pickerOpen && !disabled ? pickerId : undefined}
            disabled={disabled}
            onClick={() => {
              if (pickerOpen) return close();
              void session.emoji.ensure("foreground");
              setPickerOpen(true);
            }}
            icon={
              icon ? (
                <span
                  className={styles.icon}
                  data-unicode={
                    !(icon.startsWith(":") && icon.endsWith(":")) || undefined
                  }
                >
                  <SidebarGroupIcon icon={icon} session={session} />
                </span>
              ) : (
                <SmileyIcon size={18} aria-hidden="true" />
              )
            }
          />
        }
      >
        {children}
      </InputGroup>
      {pickerOpen && !disabled && (
        <EmojiPicker
          session={session}
          scope={scope}
          disabled={disabled}
          insert={onIconChange}
          reaction
          externalTrigger={{
            ref: trigger,
            anchor: field,
            side: "bottom",
            remove: icon ? () => onIconChange("") : undefined,
            id: pickerId,
            close,
            finalFocus: () =>
              trigger.current?.isConnected && !trigger.current.disabled
                ? trigger.current
                : false,
          }}
        />
      )}
    </>
  );
}
