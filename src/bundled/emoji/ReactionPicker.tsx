import { useLayoutEffect, useId, useRef, useState } from "react";
import type { ReactionToolProps } from "../../features/conversation/contracts";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SmileyPlusIcon } from "../../shared/design-system/icons";
import { EmojiPicker } from "./EmojiPicker";
import type { AddEmoji } from "./add-emoji";

/** Plugin-owned coordination; inactive rows keep only their accessible trigger. */
export function createReactionPicker(addEmoji?: AddEmoji) {
  let active: (() => void) | undefined;
  return function ReactionPicker({
    session,
    scope,
    disabled,
    select,
  }: ReactionToolProps) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const close = useRef(() => {
      setOpen(false);
      if (active === close) active = undefined;
    }).current;
    const id = useId();
    useLayoutEffect(
      () => () => {
        if (active === close) active = undefined;
      },
      [close],
    );
    useLayoutEffect(() => {
      if (disabled) {
        close();
        if (active === close) active = undefined;
      }
    }, [disabled, close]);
    return (
      <>
        <IconButton
          hint="familiar"
          ref={trigger}
          size="toolbar"
          shape="round"
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          aria-haspopup="dialog"
          aria-expanded={open && !disabled}
          aria-controls={open && !disabled ? id : undefined}
          disabled={disabled}
          icon={<SmileyPlusIcon size={16} aria-hidden="true" />}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            active?.();
            active = close;
            void session.emoji.ensure("foreground");
            setOpen(true);
          }}
        />
        {open && !disabled && (
          <EmojiPicker
            session={session}
            scope={scope}
            disabled={disabled}
            insert={select}
            addEmoji={addEmoji}
            reaction
            externalTrigger={{
              ref: trigger,
              id,
              close,
              finalFocus: () =>
                active === close &&
                trigger.current?.isConnected &&
                !trigger.current.disabled
                  ? trigger.current
                  : false,
            }}
          />
        )}
      </>
    );
  };
}
