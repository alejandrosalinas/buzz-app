import { useId, useRef, useState, type RefObject } from "react";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { ComposerInputElement, ComposerLinkEdit } from "./composer-dom";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { composerLinkUrl } from "./composer-link";

export function ComposerLinkDialog({
  edit,
  input,
  finalFocus = input,
  disabled,
  close,
  destinations,
  limitLabel = "message",
}: {
  destinations?: readonly { label: string; href: string }[] | undefined;
  limitLabel?: string;
  edit: ComposerLinkEdit;
  input: RefObject<ComposerInputElement | null>;
  finalFocus?: DialogProps["finalFocus"];
  disabled: boolean;
  close(): void;
}) {
  const formId = useId();
  const textInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(edit.text);
  const [url, setUrl] = useState(edit.href);
  const [error, setError] = useState("");
  const save = () => {
    if (disabled) return;
    const href = composerLinkUrl(url);
    if (!href) {
      setError("Use an HTTP(S) URL or a valid buzz:// link.");
      return;
    }
    if (/[\r\n]/.test(text)) {
      setError("Link text must stay on one line.");
      return;
    }
    if (!edit.save(text, href)) {
      setError(
        `The draft changed or this link exceeds the ${limitLabel} limit. Close and try again.`,
      );
      return;
    }
    close();
  };
  return (
    <Dialog
      size="compact"
      open
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={edit.existing ? "Edit link" : "Add link"}
      initialFocus={edit.text ? urlInput : textInput}
      finalFocus={finalFocus}
      actions={
        <>
          {edit.existing && (
            <Button
              disabled={disabled}
              onClick={() => {
                if (edit.remove()) close();
                else setError("The draft changed. Close and try again.");
              }}
            >
              Remove link
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="prominent"
            type="submit"
            form={formId}
            disabled={disabled || !url.trim()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          save();
        }}
      >
        {destinations && (
          <Combobox.Root<{ label: string; href: string }>
            items={[...destinations]}
            itemToStringLabel={(item) => item.label}
            itemToStringValue={(item) => item.href}
            onValueChange={(item) => {
              if (!item) return;
              setUrl(item.href);
              if (!text.trim()) setText(item.label);
              setError("");
            }}
          >
            <Combobox.Control
              label="Link destination"
              triggerLabel="Browse destinations"
              placeholder="Search destinations…"
            />
            <Combobox.Popup empty="No destinations match.">
              <Combobox.List>
                {(item) => (
                  <Combobox.Item key={item.href} value={item}>
                    {item.label}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Root>
        )}
        <Field label="Text">
          <Input
            ref={textInput}
            value={text}
            onValueChange={setText}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="URL" error={error || undefined}>
          <Input
            ref={urlInput}
            value={url}
            onValueChange={(value) => {
              setUrl(value);
              setError("");
            }}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
      </form>
    </Dialog>
  );
}
