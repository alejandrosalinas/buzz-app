import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import { motion, useReducedMotion } from "motion/react";
import type { ButtonProps } from "../../shared/design-system/ui/Button";
import { accentButtonStyle } from "../../shared/theme/accent";
import { AgentsContext, useSessionState } from "../agents/react";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowUpIcon,
  XIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { followUpQueue } from "./follow-up-queue";
import styles from "./QueuedFollowUps.module.css";

export function QueuedFollowUps({
  session,
  channelId,
  disabled,
  focusComposer,
  onEdit,
}: {
  session: RelaySession;
  channelId: string;
  disabled: boolean;
  focusComposer(): void;
  onEdit?(id: string): void;
}) {
  const queue = followUpQueue(session);
  const entries = useSyncExternalStore(queue.subscribe, queue.snapshot).filter(
    (entry) => entry.channelId === channelId,
  );
  const storageError = useSyncExternalStore(
    queue.subscribe,
    queue.storageError,
  );
  const section = useRef<HTMLElement>(null);
  const focused = useRef<
    { id: string; action: "send" | "remove" | "preview" | "edit" } | undefined
  >(undefined);
  useLayoutEffect(() => {
    if (
      !focused.current ||
      entries.some((entry) => entry.id === focused.current?.id)
    )
      return;
    const { action } = focused.current;
    focused.current = undefined;
    // Removal may unmount the entire section. Do not steal focus moved elsewhere
    // while asynchronous send validation was pending.
    if (document.activeElement !== document.body) return;
    const next = section.current?.querySelector<HTMLButtonElement>(
      `button[data-queue-action="${action}"]:not(:disabled)${action === "preview" ? ":not([aria-disabled=true])" : ""}`,
    );
    if (next) next.focus();
    else focusComposer();
  }, [entries, focusComposer]);
  if (!entries.length && !storageError) return null;
  return (
    <section
      ref={section}
      className={styles.queue}
      aria-label="Queued follow-ups"
    >
      {storageError && (
        <p role="alert" className="text-body-sm text-danger">
          {storageError}
        </p>
      )}
      <ol className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.row}>
            <div className={styles.content}>
              <QueuePreview
                text={entry.text || "Attachment"}
                onFocus={() => {
                  focused.current = { id: entry.id, action: "preview" };
                }}
              />
              {entry.sending && !entry.error && (
                <p className="text-caption">Sending…</p>
              )}
              {entry.restored && !entry.sending && !entry.error && (
                <p className="text-caption">
                  {entry.predecessorRemoved
                    ? "Paused because an earlier message was handled in another window. Send when ready."
                    : "Saved before restart. Send when ready."}
                </p>
              )}
              {entry.error && (
                <p role="alert" className="text-body-sm text-danger">
                  {entry.error}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <IconButton
                data-queue-action="remove"
                onFocus={() => {
                  focused.current = { id: entry.id, action: "remove" };
                }}
                disabled={disabled || entry.sending}
                variant="subtle"
                shape="round"
                size="xs"
                aria-label="Remove queued message"
                icon={<XIcon size={12} strokeWidth={2} />}
                onClick={() => {
                  queue.remove(entry.id);
                }}
              />
              <IconButton
                data-queue-action="edit"
                onFocus={() => {
                  focused.current = { id: entry.id, action: "edit" };
                }}
                aria-label="Edit queued message"
                variant="subtle"
                size="xs"
                shape="round"
                disabled={
                  disabled || entry.sending || !entry.message || !onEdit
                }
                icon={<PencilSimpleIcon size={12} strokeWidth={2.5} />}
                onClick={() => onEdit?.(entry.id)}
              />
              <QueuedSend
                channelId={channelId}
                recipients={entry.recipients}
                onFocus={() => {
                  focused.current = { id: entry.id, action: "send" };
                }}
                disabled={disabled}
                send={(check) => queue.sendNow(entry.id, check)}
              />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QueuePreview({ text, onFocus }: { text: string; onFocus(): void }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const collapsed = useRef<HTMLSpanElement>(null);
  const full = useRef<HTMLSpanElement>(null);
  const [heights, setHeights] = useState({ collapsed: 0, expanded: 0 });
  useLayoutEffect(() => {
    const element = collapsed.current;
    const fullElement = full.current;
    if (!element || !fullElement) return;
    const measure = () => {
      const truncated =
        element.scrollWidth > element.clientWidth || text.includes("\n");
      setHeights({
        collapsed: element.getBoundingClientRect().height,
        expanded: fullElement.getBoundingClientRect().height,
      });
      setCanExpand(truncated);
      if (!truncated) setExpanded(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(fullElement);
    return () => observer.disconnect();
  }, [text]);
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  return (
    <motion.button
      initial={false}
      animate={{
        height: (expanded ? heights.expanded : heights.collapsed) || "1lh",
      }}
      transition={{
        duration: instant || !canExpand ? 0 : 0.18,
        ease: [0.4, 0, 0.2, 1],
      }}
      type="button"
      data-queue-action="preview"
      className={`text-message ${styles.preview}`}
      aria-label={text}
      aria-expanded={canExpand ? expanded : undefined}
      aria-disabled={!canExpand || undefined}
      tabIndex={canExpand ? 0 : -1}
      onPointerDown={(event) => {
        if (!canExpand) event.preventDefault();
      }}
      onFocus={(event) => {
        if (!canExpand) event.currentTarget.blur();
        else onFocus();
      }}
      onClick={() => {
        if (canExpand) setExpanded((value) => !value);
      }}
    >
      <motion.span
        initial={false}
        animate={{ opacity: expanded ? 0 : 1 }}
        transition={{ duration: instant || !canExpand ? 0 : 0.12 }}
        ref={collapsed}
        className={styles.collapsedPreview}
        aria-hidden="true"
      >
        {text}
      </motion.span>
      <motion.span
        ref={full}
        className={styles.expandedPreview}
        initial={false}
        animate={{ opacity: expanded ? 1 : 0 }}
        transition={{
          duration: instant || !canExpand ? 0 : 0.18,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        {text}
      </motion.span>
    </motion.button>
  );
}

/** A queued message can target different agents from the current draft. */
function QueuedSend({
  recipients,
  channelId,
  send,
  ...props
}: Pick<ButtonProps, "disabled" | "onFocus"> & {
  send(check: () => void): void;
  recipients: readonly string[];
  channelId: string;
}) {
  const agents = useContext(AgentsContext);
  const state = useSessionState(agents, recipients, {
    channelId,
  });
  const compacting = state === "compacting";
  return (
    <Tooltip
      content="Wait for compaction to finish, or interrupt it."
      {...(!compacting ? { open: false } : {})}
      disableHoverablePopup
    >
      <IconButton
        {...props}
        data-queue-action="send"
        onClick={() =>
          send(() => {
            if (
              recipients.some((pubkey) => {
                const key = agents?.find(pubkey)?.key;
                return (
                  key &&
                  agents?.sessionState(key, { channelId }) === "compacting"
                );
              })
            )
              throw new Error(
                "Wait for compaction to finish, or interrupt it.",
              );
          })
        }
        variant="prominent"
        size="xs"
        shape="round"
        style={accentButtonStyle}
        aria-label="Send"
        icon={<ArrowUpIcon size={12} strokeWidth={2.5} />}
        disabled={props.disabled || compacting}
        focusableWhenDisabled={compacting || undefined}
      />
    </Tooltip>
  );
}
