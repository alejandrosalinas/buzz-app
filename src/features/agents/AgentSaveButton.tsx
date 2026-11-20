import {
  createContext,
  useCallback,
  useId,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { ScrollEdgeMaterial } from "../../shared/design-system/ui/ScrollEdgeMaterial";
import styles from "./AgentSaveButton.module.css";

/** Native textareas do not expose their caret's rectangle. Mirror only text layout. */
function editingLineBottom(input: HTMLInputElement | HTMLTextAreaElement) {
  const box = input.getBoundingClientRect();
  if (input instanceof HTMLInputElement) return box.bottom;
  const style = getComputedStyle(input);
  const mirror = document.createElement("div");
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-transform",
    "text-indent",
    "tab-size",
    "direction",
    "text-align",
    "white-space",
    "word-break",
    "overflow-wrap",
    "padding",
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${input.clientWidth}px`,
    boxSizing: "border-box",
  });
  const position =
    input.selectionDirection === "backward"
      ? input.selectionStart
      : input.selectionEnd;
  const marker = document.createElement("span");
  marker.textContent = input.value.slice(position) || "\u200b";
  mirror.append(
    document.createTextNode(input.value.slice(0, position)),
    marker,
  );
  document.body.append(mirror);
  try {
    const line = marker.getClientRects()[0];
    if (!line) return box.bottom;
    return (
      box.top +
      parseFloat(style.borderTopWidth) +
      line.top -
      mirror.getBoundingClientRect().top -
      input.scrollTop +
      (parseFloat(style.lineHeight) || line.height)
    );
  } finally {
    mirror.remove();
  }
}

/** The agent sidebar supplies a footer; other hosts retain their inline action. */
export const AgentSaveFooter = createContext<{
  target: HTMLElement | null;
  /** The dialog already supplies sticky action chrome. */
  dialog?: true;
  /** Submitting from a field outside the settings form uses the same action. */
  submitButton?: Ref<HTMLButtonElement>;
  /** Retain recovery content through exit; data-agent-access-required="false"
   * reserves space without treating a read/save failure as signed out. */
  setPanelNotice?: (content: ReactNode) => void;
  notice?: ReactNode;
} | null>(null);

/** The active section reports the same state that controls its save action. */
export const AgentSaveState = createContext<
  | ((state: { dirty: boolean; saving: boolean } | null, id: string) => void)
  | null
>(null);

/** Provider-owned save controls participate in the same section guard. */
export function useAgentSaveState(
  dirty: boolean,
  saving: boolean,
  active = true,
) {
  const report = useContext(AgentSaveState);
  const id = useId();
  useLayoutEffect(() => {
    if (!active) return;
    report?.({ dirty, saving }, id);
    return () => report?.(null, id);
  }, [report, id, dirty, saving, active]);
}

/** Combines the reports of everything below one AgentSaveState provider. */
export function useAgentSaveReports() {
  const [draft, setDraft] = useState({ dirty: false, saving: false });
  const drafts = useRef(new Map<string, { dirty: boolean; saving: boolean }>());
  const report = useCallback(
    (state: { dirty: boolean; saving: boolean } | null, id: string) => {
      if (state) drafts.current.set(id, state);
      else drafts.current.delete(id);
      const states = [...drafts.current.values()];
      setDraft({
        dirty: states.some((state) => state.dirty),
        saving: states.some((state) => state.saving),
      });
    },
    [],
  );
  return [draft, report] as const;
}

/** Asks before leaving would unmount reported unsaved edits. */
export function DiscardChanges({
  description,
  onKeep,
  onDiscard,
}: {
  description: string;
  onKeep(): void;
  onDiscard(): void;
}) {
  return (
    <AlertDialog
      title="Discard changes?"
      description={description}
      onClose={onKeep}
      actions={
        <>
          <Button onClick={onKeep}>Keep editing</Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard changes
          </Button>
        </>
      }
    />
  );
}

export function AgentSaveButton({
  form,
  saving,
  disabled,
  dirty = !disabled,
}: {
  form: string;
  saving: boolean;
  disabled: boolean;
  /** Validation can disable Save while the form still contains unsaved edits. */
  dirty?: boolean;
}) {
  const footer = useContext(AgentSaveFooter);
  useAgentSaveState(dirty, saving);
  const reducedMotion = useReducedMotion();
  const visible = !disabled || saving;
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = frame.current;
    const scroll = footer?.target?.parentElement;
    if (
      footer?.dialog ||
      !visible ||
      !bar ||
      !scroll ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const reveal = () => {
      const input = document.activeElement;
      if (
        !(
          input instanceof HTMLInputElement ||
          input instanceof HTMLTextAreaElement
        ) ||
        !scroll.contains(input)
      )
        return;
      const covered =
        editingLineBottom(input) - bar.getBoundingClientRect().top;
      if (covered > 0) scroll.scrollTop += Math.ceil(covered);
    };
    reveal();
    // Follow the real opening height, including immediate/reduced-motion changes.
    const size = new ResizeObserver(reveal);
    size.observe(bar);
    scroll.addEventListener("input", reveal);
    document.addEventListener("selectionchange", reveal);
    return () => {
      size.disconnect();
      scroll.removeEventListener("input", reveal);
      document.removeEventListener("selectionchange", reveal);
    };
  }, [footer?.dialog, footer?.target, visible]);
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  const transition = {
    duration: instant ? 0 : 0.22,
    ease: [0.23, 1, 0.32, 1] as const,
  };
  const button = (
    <Button
      ref={footer?.submitButton}
      type="submit"
      form={form}
      variant={footer?.dialog ? "primary" : "prominent"}
      loading={saving}
      disabled={disabled}
      focusableWhenDisabled
      style={footer?.target && !footer.dialog ? { width: "100%" } : undefined}
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
  if (footer?.dialog)
    return footer.target && visible
      ? createPortal(button, footer.target)
      : null;
  return footer?.target
    ? createPortal(
        <motion.div
          ref={frame}
          className={styles.frame}
          initial={false}
          animate={{
            height: visible ? "auto" : 0,
            opacity: visible ? 1 : 0,
          }}
          transition={transition}
          inert={!visible}
          aria-hidden={!visible || undefined}
        >
          <ScrollEdgeMaterial edge="bottom" />
          <motion.div
            className={styles.footer}
            initial={false}
            animate={{ y: visible ? "0rem" : "0.5rem" }}
            transition={transition}
          >
            {button}
            {footer.notice && (
              <motion.div
                className="grid empty:hidden"
                initial={false}
                animate={{
                  opacity: visible ? 1 : 0,
                  y: visible ? "0rem" : "0.25rem",
                }}
                transition={{
                  ...transition,
                  delay: visible && !instant ? 0.08 : 0,
                }}
              >
                {footer.notice}
              </motion.div>
            )}
          </motion.div>
        </motion.div>,
        footer.target,
      )
    : visible && <div>{button}</div>;
}

export function ClearModelOverrides({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <div>
      <Button
        type="button"
        variant="subtle"
        disabled={disabled}
        onClick={onClick}
      >
        Clear model and thinking overrides
      </Button>
    </div>
  );
}
