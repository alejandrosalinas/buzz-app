import { useEffect, useLayoutEffect, useRef } from "react";
import { useIsPresent } from "motion/react";
import type { RelaySession } from "../../features/relay/session";
import { useLifetime } from "../../features/solo/Lifetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ChatCircleIcon, XIcon } from "../../shared/design-system/icons";
import styles from "./SoloWorkspaces.module.css";

/** Sidebar presentation of the same revision-checked name edit as Chat settings. */
export function SoloChatName({
  session,
  id,
  title,
  close,
}: {
  session: RelaySession;
  id: string;
  title: string;
  close(focus: boolean): void;
}) {
  const present = useIsPresent();
  const name = useLifetime({ session, id, enabled: true });
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  const saving = useRef(false);
  const selectedInitialName = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    if (!name.base || selectedInitialName.current) return;
    selectedInitialName.current = true;
    if (document.activeElement === input.current) input.current?.select();
  }, [name.base]);
  const finish = (focus: boolean) => {
    active.current = false;
    close(focus);
  };
  const save = async (focus: boolean) => {
    if (
      !present ||
      !active.current ||
      saving.current ||
      name.busy ||
      !name.base ||
      name.invalid ||
      (name.blocked && !name.checkOnly)
    )
      return;
    saving.current = true;
    // Recovery buttons disappear while busy; leave focus in the stable field.
    if (form.current?.contains(document.activeElement)) input.current?.focus();
    try {
      await name.run(name.checkOnly ? "check" : "save");
      if (active.current)
        finish(
          focus &&
            (document.activeElement === document.body ||
              !!form.current?.contains(document.activeElement)),
        );
    } catch {
      // The existing details owner keeps the draft and any uncertain receipt.
    } finally {
      saving.current = false;
    }
  };
  return (
    <form
      ref={form}
      className={styles.nameEditor}
      aria-label={`Rename ${title}`}
      aria-busy={(!name.base && !name.error) || name.busy}
      onSubmit={(event) => {
        event.preventDefault();
        void save(true);
      }}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !name.error &&
          !name.checkOnly
        ) {
          if (!name.busy && !saving.current && (!name.base || name.blocked))
            finish(false);
          else void save(false);
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          !saving.current
        ) {
          event.preventDefault();
          finish(true);
        }
      }}
    >
      <div className={styles.nameEditorRow}>
        <span className={styles.conversationIcon} aria-hidden="true">
          <ChatCircleIcon size={16} />
        </span>
        <div className={styles.nameEditorField}>
          <Field
            label="Chat name"
            labelVisibility="hidden"
            error={
              name.invalid ||
              name.error ||
              (name.base && !name.eligible
                ? "This chat can’t be renamed."
                : name.unrelatedAttempt
                  ? "Finish the pending change in Chat settings first."
                  : undefined)
            }
          >
            <Input
              ref={input}
              controlSize="sm"
              value={name.base ? name.name : title}
              readOnly={!name.base || name.busy || name.blocked}
              aria-disabled={!name.base || name.busy || name.blocked}
              onChange={(event) => name.changeName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing)
                  event.preventDefault();
              }}
            />
          </Field>
          {!name.busy &&
            (name.checkOnly ? (
              <Button type="submit" size="sm">
                Check save status
              </Button>
            ) : (
              name.error && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    input.current?.focus();
                    void name.run("reload").catch(() => {});
                  }}
                >
                  Reload chat details
                </Button>
              )
            ))}
        </div>
        <IconButton
          type="button"
          aria-label="Cancel rename"
          icon={<XIcon size={16} />}
          disabled={name.busy}
          onClick={() => finish(true)}
        />
      </div>
    </form>
  );
}
