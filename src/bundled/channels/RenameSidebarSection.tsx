import { useId, useState, type RefObject } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { SidebarSectionEdit } from "../../features/relay/sidebar-preferences";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { SidebarSectionEmojiInput } from "./SidebarSectionEmojiInput";

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function RenameSidebarSection({
  title,
  icon: initialIcon,
  session,
  scope,
  rename,
  close,
  finalFocus,
}: {
  title: string;
  icon?: string | undefined;
  session: Pick<RelaySession, "emoji" | "media">;
  scope: string;
  rename: (edit: SidebarSectionEdit) => unknown;
  close: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const formId = useId();
  // Live preference updates must not turn untouched draft fields into edits.
  const [original] = useState({ name: title, icon: initialIcon ?? "" });
  const [name, setName] = useState(original.name);
  const [icon, setIcon] = useState(original.icon);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const next = name.trim();
  const submit = async () => {
    if (pending || !next) return;
    const iconChanged = icon !== original.icon;
    if (next === original.name && !iconChanged) return close();
    setPending(true);
    setError("");
    try {
      await rename({
        ...(next === original.name ? {} : { name: next }),
        ...(iconChanged ? { icon: icon || null } : {}),
      });
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
      dismissOnOutsideClick
      open
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      title="Rename section"
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
            loading={pending}
            disabled={!next}
          >
            Rename
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
        <SidebarSectionEmojiInput
          session={session}
          scope={scope}
          icon={icon}
          onIconChange={setIcon}
          disabled={pending}
        >
          <Input
            autoFocus
            aria-label="Section name"
            placeholder="Section name"
            required
            maxLength={256}
            disabled={pending}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </SidebarSectionEmojiInput>
      </form>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <p role="status" className="sr-only">
          Renaming section and waiting for confirmation…
        </p>
      )}
    </Dialog>
  );
}
