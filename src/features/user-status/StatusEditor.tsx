import {
  statusDurations,
  statusDeadline,
  statusDuration,
} from "./status-duration";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { EmojiPicker } from "../../bundled/emoji/EmojiPicker";
import { SmileyIcon } from "../../shared/design-system/icons";
import { Input } from "../../shared/design-system/ui/Input";
import { FieldButton } from "../../shared/design-system/ui/FieldButton";
import { StatusExpiration } from "./StatusExpiration";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import type { RelaySession } from "../relay/session";
import { STATUS_TEXT_LIMIT, type UserStatus } from "../relay/user-status";
import { StatusEmoji, useEmojiName } from "./StatusEmoji";
import styles from "./Status.module.css";

const choices = [
  ["🗣️", "In a meeting"],
  ["🚌", "Commuting"],
  ["🤒", "Out sick"],
  ["🏖️", "Vacationing"],
  ["🏠", "Working remotely"],
] as const;
function draftFrom(status: UserStatus | undefined) {
  return {
    text: status?.text ?? "",
    emoji: status?.emoji ?? "",
    duration: status
      ? statusDuration(status.expiresAt, status.updatedAt)
      : "today",
    date: new Date(
      (status?.expiresAt ?? statusDeadline("today", Date.now() / 1000)) * 1000,
    ),
  };
}

export function StatusEditor({
  session,
  scope,
  current: initialCurrent,
  viewer,
  close,
  finalFocus,
}: {
  session: RelaySession;
  scope: string;
  current: UserStatus | undefined;
  /** Present for the viewer’s editor; refreshes its cached status in the background. */
  viewer?: string;
  close(): void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [current, setCurrent] = useState(initialCurrent);
  const edited = useRef(false);
  const submitted = useRef(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [initialDraft] = useState(() => draftFrom(initialCurrent));
  const [text, setText] = useState(initialDraft.text);
  const [emoji, setEmoji] = useState(initialDraft.emoji);
  const [duration, setDuration] = useState(initialDraft.duration);
  const [durationChanged, setDurationChanged] = useState(false);
  const [date, setDate] = useState(initialDraft.date);
  const effectiveEmoji = emoji || (text.trim() ? "💬" : "");
  const emojiName = useEmojiName(effectiveEmoji);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const message = useRef<HTMLInputElement>(null);
  const emojiTrigger = useRef<HTMLButtonElement>(null);
  const pickerId = `status-emoji-${useId()}`;
  const formId = useId();
  const working = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a new background check.
  useEffect(() => {
    if (!viewer || edited.current || submitted.current) return;
    let active = true;
    setChecking(false);
    setCheckError(false);
    const timer = setTimeout(() => {
      if (active && !edited.current && !submitted.current) setChecking(true);
    }, 1000);
    void session.statuses
      .current(viewer)
      .then(
        (fresh) => {
          if (!active || edited.current || submitted.current) return;
          const draft = draftFrom(fresh);
          setCurrent(fresh);
          setText(draft.text);
          setEmoji(draft.emoji);
          setDuration(draft.duration);
          setDate(draft.date);
        },
        () => {
          if (active && !edited.current && !submitted.current)
            setCheckError(true);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (active) setChecking(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session, viewer, checkAttempt]);
  function markEdited() {
    edited.current = true;
    setChecking(false);
    setCheckError(false);
  }
  const durationLabel =
    duration === "custom"
      ? "Custom date and time"
      : statusDurations.find(([value]) => value === duration)?.[1];
  async function submit(clear = false) {
    if (working.current) return;
    const expiresAt =
      clear || duration === "never"
        ? undefined
        : current &&
            !durationChanged &&
            (current.expiresAt === undefined ||
              current.expiresAt > Date.now() / 1000)
          ? current?.expiresAt
          : duration === "custom"
            ? Math.floor(date.getTime() / 1000)
            : statusDeadline(duration, Math.floor(Date.now() / 1000));
    if (
      !clear &&
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000)
    ) {
      setError("Choose a date and time in the future.");
      return;
    }
    markEdited();
    submitted.current = true;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await session.statuses.save({
        text: clear ? "" : text,
        emoji: clear ? "" : effectiveEmoji,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      if (mounted.current) close();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      size="compact"
      open
      title="Set a status"
      dismissOnOutsideClick={false}
      closeLabel="Close status editor"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      initialFocus={message}
      finalFocus={finalFocus}
      actions={
        <div className={styles.footer}>
          {current ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              <span className="text-danger">Clear status</span>
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            form={formId}
            variant="prominent"
            loading={busy}
            disabled={busy || (!text.trim() && !emoji)}
          >
            Save status
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() || emoji) void submit();
        }}
      >
        <fieldset className={styles.fields} disabled={busy}>
          <InputGroup
            leading={
              // Name the emoji it will save, including an unresolved code shown as 💬.
              // The hint stays mounted so a refresh cannot remount the focused trigger.
              <Tooltip
                content={emojiName}
                {...(emojiName ? {} : { open: false })}
                disableHoverablePopup
              >
                <IconButton
                  ref={emojiTrigger}
                  size="sm"
                  aria-label="Choose a status emoji"
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  aria-controls={pickerOpen ? pickerId : undefined}
                  onClick={() => {
                    void session.emoji.ensure();
                    setPickerOpen(true);
                  }}
                  icon={
                    effectiveEmoji ? (
                      <StatusEmoji
                        value={effectiveEmoji}
                        url={
                          effectiveEmoji === current?.emoji
                            ? current.emojiUrl
                            : undefined
                        }
                        fallback="💬"
                        session={session}
                      />
                    ) : (
                      <SmileyIcon size={22} />
                    )
                  }
                />
              </Tooltip>
            }
          >
            <Input
              ref={message}
              aria-label="Status message"
              autoComplete="off"
              maxLength={STATUS_TEXT_LIMIT}
              placeholder="What's your status?"
              value={text}
              onChange={(event) => {
                markEdited();
                setText(event.target.value);
              }}
            />
          </InputGroup>
          <div className={styles.section}>
            <span className="text-label-sm text-subtle">Duration</span>
            <MenuRoot>
              <MenuTrigger
                disabled={busy}
                aria-label={`Duration: ${durationLabel}`}
                render={<FieldButton />}
              >
                {durationLabel}
              </MenuTrigger>
              <MenuPopup align="end" data-status-menu>
                <MenuRadioGroup
                  value={duration}
                  onValueChange={(value) => {
                    markEdited();
                    setDuration(value);
                    setDurationChanged(true);
                  }}
                  aria-label="Duration"
                >
                  {statusDurations
                    .filter(
                      ([value]) =>
                        value !== "never" ||
                        (current && current.expiresAt === undefined),
                    )
                    .map(([value, label]) => (
                      <MenuRadioItem key={value} value={value} closeOnClick>
                        {label}
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
              </MenuPopup>
            </MenuRoot>
            {duration === "custom" && (
              <StatusExpiration
                value={date}
                disabled={busy}
                onChange={(next) => {
                  markEdited();
                  setDate(next);
                  setDurationChanged(true);
                  setError("");
                }}
              />
            )}
          </div>
          {!current && (
            <div className={styles.section}>
              <span className="text-label-sm text-subtle">Quick statuses</span>
              <div className={styles.choices}>
                {choices.map(([icon, label]) => (
                  <NavigationItem
                    variant="option"
                    key={label}
                    type="button"
                    onClick={() => {
                      markEdited();
                      setEmoji(icon);
                      setText(label);
                      message.current?.focus();
                    }}
                    icon={
                      <span aria-hidden="true" className="text-body-lg">
                        {icon}
                      </span>
                    }
                    label={label}
                  />
                ))}
              </div>
            </div>
          )}
        </fieldset>
        {pickerOpen && (
          <EmojiPicker
            session={session}
            scope={scope}
            disabled={busy}
            reaction
            insert={(value) => {
              markEdited();
              setEmoji(value);
            }}
            externalTrigger={{
              ref: emojiTrigger,
              id: pickerId,
              close: () => setPickerOpen(false),
              finalFocus: () => emojiTrigger.current ?? false,
            }}
          />
        )}
        {checking && (
          <p role="status" className="text-body-sm text-muted">
            Checking your current status…
          </p>
        )}
        {checkError && (
          <div role="alert" className="text-body-sm text-muted">
            Couldn’t check your latest status. Your draft is unchanged.
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                message.current?.focus();
                setCheckAttempt((value) => value + 1);
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
