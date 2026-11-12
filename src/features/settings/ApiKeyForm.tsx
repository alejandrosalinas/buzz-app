import type { ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";

/** Shared entry controls; each credential owner keeps its draft and save lifecycle. */
export function ApiKeyForm({
  label,
  description,
  value,
  onValueChange,
  onSave,
  disabled = false,
  saving = false,
  variant = "prominent",
  feedback,
}: {
  label: string;
  description?: ReactNode;
  value: string;
  onValueChange(value: string): void;
  onSave(): void;
  disabled?: boolean;
  saving?: boolean;
  variant?: "prominent" | "subtle";
  feedback?: ReactNode;
}) {
  return (
    // Not a form: agent creation and Settings can supply their own.
    <div className="grid gap-2" aria-busy={saving ? true : undefined}>
      <Field label={label} description={description}>
        <InputGroup
          trailing={
            <Button
              type="button"
              variant={variant}
              size="sm"
              disabled={disabled || !value.trim()}
              focusableWhenDisabled
              loading={saving}
              onClick={onSave}
            >
              Save
            </Button>
          }
        >
          <Input
            type="password"
            autoComplete="off"
            value={value}
            readOnly={saving}
            aria-disabled={saving || disabled ? true : undefined}
            onValueChange={onValueChange}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              onSave();
            }}
          />
        </InputGroup>
      </Field>
      {feedback}
    </div>
  );
}
