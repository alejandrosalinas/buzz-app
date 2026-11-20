import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  CodeBlockIcon,
  CodeIcon,
  DetectiveIcon,
  LinkIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextAaIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { formatBinding, isApplePlatform } from "../shortcuts/format";
import {
  composerFormats,
  linkBindings,
  type ComposerFormat,
} from "./composer-dom";
import type { ComposerMarkdownMode } from "./composer-markdown";
import styles from "./ComposerFormattingTools.module.css";

// A short ease-out gives immediate feedback without an entrance delay.
const reveal = { duration: 0.14, ease: [0.23, 1, 0.32, 1] } as const;
const options = [
  ["Bold", TextBIcon],
  ["Italic", TextItalicIcon],
  ["Strikethrough", TextStrikethroughIcon],
  ["Code", CodeIcon],
  ["Code block", CodeBlockIcon],
  ["Link", LinkIcon],
  ["Bullet list", ListBulletsIcon],
  ["Ordered list", ListNumbersIcon],
  ["Quote", QuotesIcon],
  ["Spoiler", DetectiveIcon],
] as const;

// An exiting group is paint-only, never a second set of focusable controls.
const ToolGroup = forwardRef<HTMLDivElement, ComponentProps<typeof motion.div>>(
  function ToolGroup(props, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        {...props}
        ref={ref}
        inert={!present}
        aria-hidden={!present || undefined}
      />
    );
  },
);

/** Toolbar controls share the editor commands and active state. */
export function ComposerFormattingTools({
  children,
  disabled,
  singleRow,
  activeFormats,
  toggleFormat,
  editLink,
  trailing,
  persistent = false,
  markdownMode = "chat",
}: {
  children: ReactNode;
  /** Document surfaces expose the formatting list without a toggle. */
  persistent?: boolean;
  markdownMode?: ComposerMarkdownMode;
  /** Conversation controls that follow the tools on the same row. */
  trailing?: ReactNode;
  disabled: boolean;
  singleRow?: boolean;
  activeFormats: readonly ComposerFormat[];
  toggleFormat(format: ComposerFormat): void;
  editLink(): void;
}) {
  const supportedOptions =
    markdownMode === "document"
      ? options.filter(([label]) => label !== "Spoiler")
      : options;
  const [toggled, setOpen] = useState(false);
  const open = persistent || toggled;
  const reduceMotion = useReducedMotion();
  const [keyboardToggle, setKeyboardToggle] = useState(false);
  const instant = reduceMotion || keyboardToggle;
  const openToggle = useRef<HTMLButtonElement>(null);
  const closedToggle = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      (open ? openToggle : closedToggle).current?.focus();
      restoreFocus.current = false;
    }
  }, [open]);
  const change = (next: boolean, keyboard: boolean) => {
    restoreFocus.current = keyboard;
    setKeyboardToggle(keyboard);
    setOpen(next);
  };
  const transition = instant ? { duration: 0 } : reveal;
  const faded = { opacity: 0, scale: instant ? 1 : 0.95 };
  const formatToggle = (
    <IconButton
      hint="familiar"
      ref={closedToggle}
      size="sm"
      variant="ghost"
      aria-label="Toggle formatting"
      aria-pressed={open}
      title="Formatting"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => change(!open, event.detail === 0)}
      icon={<TextAaIcon size={16} />}
    />
  );
  return (
    <div
      className={styles.tools}
      data-formatting-open={open || undefined}
      data-single-row={singleRow || undefined}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <ToolGroup
            key="formatting"
            className={styles.expanded}
            initial={false}
            animate={{}}
            exit={{ opacity: 0 }}
            transition={transition}
          >
            {!persistent && (
              <motion.div
                className={styles.close}
                initial={instant ? false : faded}
                animate={{ opacity: 1, scale: 1 }}
                exit={faded}
                transition={transition}
              >
                <IconButton
                  hint="familiar"
                  ref={openToggle}
                  size="sm"
                  variant="subtle"
                  aria-label="Close formatting"
                  title="Close formatting"
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => change(false, event.detail === 0)}
                  icon={<XIcon size={16} />}
                />
                <div className={styles.divider} aria-hidden="true" />
              </motion.div>
            )}
            <motion.div
              className={styles.scroll}
              initial={instant ? false : faded}
              animate={{ opacity: 1, scale: 1 }}
              exit={faded}
              transition={transition}
            >
              <fieldset
                className={styles.options}
                aria-label="Formatting options"
              >
                {supportedOptions.map(([label, Icon]) => {
                  const format = composerFormats.find(
                    (item) => item.label === label,
                  );
                  const isLink = label === "Link";
                  const binding =
                    format?.binding ?? (isLink ? linkBindings[0] : undefined);
                  const active = format && activeFormats.includes(format.mark);
                  const apple = isApplePlatform(navigator.platform);
                  return (
                    <IconButton
                      hint={binding ? "familiar" : "helpful"}
                      key={label}
                      size="sm"
                      aria-label={label}
                      title={
                        binding
                          ? `${label} (${formatBinding(binding, apple).text})`
                          : `${label} (preview only)`
                      }
                      aria-disabled={binding ? undefined : true}
                      aria-pressed={active}
                      aria-keyshortcuts={
                        binding
                          ? `${apple ? "Meta" : "Control"}+${"alt" in binding && binding.alt ? "Alt+" : ""}${binding.shift ? "Shift+" : ""}${binding.key}`
                          : undefined
                      }
                      variant={active ? "subtle" : "ghost"}
                      onClick={
                        format
                          ? () => toggleFormat(format.mark)
                          : isLink
                            ? editLink
                            : undefined
                      }
                      disabled={disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      icon={<Icon size={16} />}
                    />
                  );
                })}
              </fieldset>
            </motion.div>
          </ToolGroup>
        ) : (
          <ToolGroup
            key="ingress"
            className={styles.ingress}
            initial={instant ? false : { opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: instant ? 0 : -12 }}
            transition={transition}
          >
            {children}
            <motion.div
              className={styles.fixed}
              initial={instant ? false : { x: -8, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: instant ? 0 : -8, opacity: 0 }}
              transition={transition}
            >
              {formatToggle}
            </motion.div>
            {trailing}
          </ToolGroup>
        )}
      </AnimatePresence>
    </div>
  );
}
