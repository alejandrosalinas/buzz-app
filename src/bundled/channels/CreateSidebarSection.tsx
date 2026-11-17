import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * Removing the focused Retry button leaves focus on the page or the dialog
 * itself. Return it to the field then, but keep a user's move to Cancel or
 * Close so Enter still does what they focused.
 */
function restoreLostFocus(field: HTMLInputElement | null) {
  const dialog = field?.closest('[role="dialog"]');
  const active = field?.ownerDocument.activeElement;
  if (!active || active === dialog || !dialog?.contains(active)) {
    field?.focus();
  }
}

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function CreateSidebarSection({
  channelName,
  create,
  close,
  writable,
  refreshing,
  retry,
  finalFocus = false,
}: {
  channelName?: string | undefined;
  /** True only after the session accepts the move or confirms empty creation. */
  create: (section: { id: string; name: string }) => boolean | Promise<boolean>;
  close: () => void;
  writable: boolean;
  refreshing: boolean;
  retry: () => Promise<void>;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const submitted = useRef(false);
  const section = useRef<{ id: string; name: string } | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  useLayoutEffect(() => {
    // The preference update may remove the focused Retry button. Hand focus
    // back only after React commits that removal, including on fast reads.
    if (focusRequest) restoreLostFocus(input.current);
  }, [focusRequest]);
  const needsRecovery = !pending && !writable;
  const recovering = useRef(needsRecovery);
  useLayoutEffect(() => {
    // Background recovery can also remove the Retry button, even while a
    // click on it is landing.
    if (recovering.current && writable) restoreLostFocus(input.current);
    recovering.current = needsRecovery;
  }, [needsRecovery, writable]);
  const errorId = `${formId}-error`;
  const submit = async () => {
    if (submitted.current || pending || !writable || !name.trim()) return;
    submitted.current = true;
    // A failed confirmation may follow a successful write. Retry the same
    // identity and name rather than trying to rename an unknown publication.
    const attempt = section.current ?? {
      id: crypto.randomUUID(),
      name: name.trim(),
    };
    setPending(true);
    setError("");
    try {
      const accepted = await create(attempt);
      section.current = accepted ? attempt : undefined;
      submitted.current = accepted;
    } catch {
      section.current = attempt;
      submitted.current = false;
      setError("Couldn't confirm the section was saved. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      footerGap="compact"
      dismissOnOutsideClick
      preventClose={pending}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={channelName ? "Move to new section" : "Create new section"}
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            variant="prominent"
            disabled={!writable || !name.trim()}
            loading={pending}
          >
            {channelName ? "Create and move" : "Create"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={input}
          aria-label="Section name"
          aria-describedby={error || needsRecovery ? errorId : undefined}
          placeholder="Section name"
          required
          readOnly={pending || !!section.current}
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
      {(error || needsRecovery) && (
        <div id={errorId} role="alert">
          {error && <p>{error}</p>}
          {needsRecovery && (
            <>
              <p>
                Saved preferences are unavailable. Retry preferences before
                trying again.
              </p>
              <Button
                disabled={refreshing}
                onClick={async () => {
                  await retry();
                  setFocusRequest((request) => request + 1);
                }}
              >
                Retry preferences
              </Button>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
