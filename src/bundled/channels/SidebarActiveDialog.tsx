import { useState, useRef, type RefObject } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { DEFAULT_ACTIVE_WINDOW_SECONDS } from "../../features/relay/sidebar-preferences";
import styles from "./SidebarActiveDialog.module.css";

export function activeWindowLabel(seconds = DEFAULT_ACTIVE_WINDOW_SECONDS) {
  const days = seconds / 86400;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** A draft stays local until Apply; a failed save keeps the entered values. */
export function SidebarActiveDialog({
  seconds = DEFAULT_ACTIVE_WINDOW_SECONDS,
  apply,
  close,
  finalFocus,
}: {
  seconds?: number | undefined;
  apply: (seconds: number) => unknown;
  close: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const form = useRef<HTMLDivElement>(null);
  const days = seconds / 86400;
  const [preset, setPreset] = useState(
    [1, 7, 30, 90].includes(days) ? String(days) : "30",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const duration = Number(preset) * 86400;
  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await apply(duration);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      open
      title="Active in the last"
      footerGap="compact"
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      finalFocus={finalFocus}
      initialFocus={() =>
        form.current?.querySelector<HTMLElement>(
          '[role="radio"][aria-checked="true"]',
        ) ?? false
      }
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            onClick={() => void submit()}
          >
            Apply
          </Button>
        </>
      }
    >
      <div ref={form} className={styles.form}>
        <Field label="Time frame" labelVisibility="hidden" nativeLabel={false}>
          <RadioGroup
            value={preset}
            onValueChange={setPreset}
            disabled={pending}
            aria-label="Time frame"
          >
            <div className={styles.presets}>
              {[1, 7, 30, 90].map((days) => (
                <Radio
                  key={days}
                  value={String(days)}
                  variant="tile"
                  label={activeWindowLabel(days * 86400)}
                />
              ))}
            </div>
          </RadioGroup>
        </Field>
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="sr-only">
            Saving filter and waiting for confirmation…
          </p>
        )}
      </div>
    </Dialog>
  );
}
