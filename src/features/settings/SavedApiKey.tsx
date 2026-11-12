import {
  type RefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

/** Replaces a saved credential without reading its stored value into the UI. */
export function SavedApiKey({
  credential,
  onSaved,
  active,
  disabled,
  conceal,
  onSavingChange,
  trigger,
  onRemove,
  description = "Saved securely on this computer.",
  label,
  labelVisibility = "hidden",
}: {
  credential: {
    subscribe(listener: () => void): () => void;
    save(key: string): Promise<unknown>;
  };
  onSaved?: () => Promise<unknown>;
  active(): boolean;
  disabled: boolean;
  conceal: boolean;
  onSavingChange(saving: boolean): void;
  trigger: RefObject<HTMLButtonElement | null>;
  onRemove(): void;
  description?: ReactNode;
  label?: string;
  labelVisibility?: "visible" | "hidden";
}) {
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const request = useRef(0);
  const writing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const notify = useToastNotification();
  const editing = !conceal && replacing;
  const reset = useCallback(() => {
    request.current++;
    setReplacing(false);
    setDraft("");
    setError("");
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    reset();
    if (conceal) return;
    const unsubscribe = credential.subscribe(() => {
      if (!writing.current) reset();
    });
    return () => {
      request.current++;
      unsubscribe();
    };
  }, [credential, conceal, reset]);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  // MenuTrigger establishes the popup anchor and keyboard focus.
  const openActions = () => {
    if (!menuOpen && !editing && active() && !disabled && !conceal && !saving)
      trigger.current?.click();
  };
  const replace = () => {
    if (!active() || disabled || conceal || writing.current || editing) return;
    setDraft("");
    setError("");
    setMenuOpen(false);
    setReplacing(true);
  };
  const save = async () => {
    if (
      !active() ||
      disabled ||
      conceal ||
      writing.current ||
      !editing ||
      !draft.trim()
    )
      return;
    const current = request.current;
    const focused = document.activeElement;
    let saved = false;
    writing.current = true;
    setSaving(true);
    onSavingChange(true);
    setError("");
    try {
      await credential.save(draft.trim());
      if (!active() || request.current !== current) return;
      saved = true;
      reset();
      notify("Saved", "success");
      // A runtime refresh cannot undo the completed credential save.
      await onSaved?.().catch(() => undefined);
    } catch (failure) {
      if (active()) setError(String(failure));
    } finally {
      writing.current = false;
      setSaving(false);
      onSavingChange(false);
      if (
        saved &&
        active() &&
        (document.activeElement === focused ||
          document.activeElement === document.body)
      )
        input.current?.focus();
    }
  };
  return (
    <div aria-busy={saving}>
      <Field
        label={label ?? (editing ? "Replacement API key" : "Saved API key")}
        labelVisibility={labelVisibility}
        description={description}
        error={error}
      >
        <MenuRoot
          open={menuOpen && !editing && !conceal}
          onOpenChange={setMenuOpen}
        >
          <InputGroup
            trailing={
              editing ? (
                <span className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      reset();
                      input.current?.focus();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="prominent"
                    disabled={disabled || !draft.trim()}
                    loading={saving}
                    onClick={() => void save()}
                  >
                    Save
                  </Button>
                </span>
              ) : (
                <MenuTrigger
                  render={
                    <IconButton
                      ref={trigger}
                      aria-label="API key actions"
                      title="API key actions"
                      icon={<CaretDownIcon size={16} aria-hidden="true" />}
                      disabled={disabled || conceal || saving}
                    />
                  }
                />
              )
            }
          >
            <Input
              ref={input}
              type="password"
              value={editing ? draft : "•".repeat(96)}
              readOnly={!editing || disabled || saving || conceal}
              placeholder={editing ? "Paste a replacement API key" : undefined}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => {
                const from = event.relatedTarget;
                if (
                  from === trigger.current ||
                  (from instanceof Node && menu.current?.contains(from))
                )
                  return;
                openActions();
              }}
              onClick={openActions}
              onValueChange={(next) => {
                if (!active() || disabled || saving || conceal || !editing)
                  return;
                setDraft(next);
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                void save();
              }}
            />
          </InputGroup>
          <MenuPopup
            ref={menu}
            align="end"
            size="compact"
            finalFocus={() => trigger.current ?? input.current}
          >
            <MenuItem
              disabled={disabled || conceal || saving || editing}
              onClick={replace}
            >
              Replace
            </MenuItem>
            <MenuItem
              tone="danger"
              disabled={disabled || conceal || saving || editing}
              onClick={onRemove}
            >
              Remove
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </Field>
    </div>
  );
}
