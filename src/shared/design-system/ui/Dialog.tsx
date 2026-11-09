import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { XIcon } from "../icons";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useModalWindowDrag } from "./ModalWindowDrag";
import { IconButton } from "./IconButton";
import { ScrollEdgeMaterial } from "./ScrollEdgeMaterial";
import { useFinalFocusUnlessMoved } from "./finalFocus";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;
export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenChangeComplete?: ComponentProps<
    typeof BaseDialog.Root
  >["onOpenChangeComplete"];
  title: ReactNode;
  /** Artwork above a centered title lockup, with Close kept at the top right. */
  artwork?: ReactNode;
  /** Search palettes keep an accessible title without visible header chrome. */
  presentation?: "default" | "search";
  /** Introductory copy belongs in the title lockup, not a body paragraph. */
  description?: ReactNode;
  /** Omit for a header-only message; no empty body spacing is rendered. */
  children?: ReactNode;
  /** Integrated sections for an expanded modal; Dialog owns framing and scrollports. */
  navigation?: { label: string; content: ReactNode };
  /** Position within a host; sectioned modals stay bounded. Null waits for its ref. */
  container?: HTMLElement | null;
  actions?: ReactNode;
  /** Tighter heading-to-body spacing for compact forms. */
  headerGap?: "default" | "compact";
  /** Keep spacing beside scrolling content on the fixed header and footer. */
  chromeSpacing?: "default" | "padded";
  /** Compact groups actions; none lets a footerless scrollport reach the bottom edge. */
  footerGap?: "default" | "compact" | "none";
  /** Replace a step inside this modal; scale defines its recessed/raised position. */
  step?: { key: string; scale: number };
  leadingActions?: ReactNode;
  headerActions?: ReactNode;
  /** Return true when an inner editor layer consumed Escape. */
  onEscape?: () => boolean;
  placement?: "center" | "right";
  dismissOnOutsideClick?: boolean;
  closeLabel?: string;
  /** Reserve viewport-capped space for changing content; scroll only the body. */
  height?: "content" | "stable" | "stable-tall";
  /** Let bounded content own its scrolling instead of the shared body. */
  bodyLayout?: "flow" | "flex";
  /** Compact dialogs; standard, wide, and expanded task modals. */
  size?: "compact" | "default" | "wide" | "expanded";
  /** Keep frequent surfaces such as search palettes immediate. */
  motion?: "default" | "none";
  /** An addressable dialog: its own navigation visit, so Back closes it. */
  visit?: boolean;
  /** A pending operation can prevent all user dismissal paths. */
  preventClose?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
};

/** Base UI owns the modal, portal, focus trap, Escape and focus restoration. */
export function Dialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  artwork,
  presentation = "default",
  description,
  children,
  navigation,
  container,
  actions,
  headerGap = "default",
  chromeSpacing = "default",
  footerGap = "default",
  step,
  leadingActions,
  headerActions,
  onEscape,
  placement = "center",
  dismissOnOutsideClick = true,
  closeLabel = "Close",
  size = "default",
  visit = false,
  preventClose = false,
  motion = "default",
  height = "content",
  bodyLayout = "flow",
  initialFocus,
  finalFocus,
}: DialogProps) {
  const [instantClose, setInstantClose] = useState(false);
  const windowDrag = useModalWindowDrag();
  const detail = useRef<HTMLDivElement>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const transition =
    motion === "none" || (!open && instantClose) ? "none" : "default";
  const contents = (
    <>
      {presentation === "search" ? (
        <>
          {!step && (
            <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>
          )}
          {description && !step && (
            <BaseDialog.Description className="sr-only">
              {description}
            </BaseDialog.Description>
          )}
        </>
      ) : (
        <header
          className="buzz-dialog-header"
          data-chrome-spacing={chromeSpacing}
          data-artwork={artwork != null || undefined}
        >
          <ScrollEdgeMaterial edge="top" className="buzz-dialog-bar-material" />
          <div className="buzz-dialog-heading">
            {artwork != null && (
              <div className="buzz-dialog-artwork">{artwork}</div>
            )}
            {step ? (
              <div className="text-label" aria-hidden="true">
                {title}
              </div>
            ) : (
              <BaseDialog.Title className="text-label">
                {title}
              </BaseDialog.Title>
            )}
            {description &&
              (step ? (
                <p className="buzz-dialog-description" aria-hidden="true">
                  {description}
                </p>
              ) : (
                <BaseDialog.Description className="buzz-dialog-description">
                  {description}
                </BaseDialog.Description>
              ))}
          </div>
          <div className="buzz-dialog-header-actions">
            {headerActions}
            <BaseDialog.Close
              disabled={preventClose}
              render={
                <IconButton
                  aria-label={closeLabel}
                  variant="subtle"
                  disabled={preventClose}
                  size="compact"
                  icon={<XIcon size={16} aria-hidden="true" />}
                />
              }
            />
          </div>
        </header>
      )}
      {((children != null && children !== false) || navigation) && (
        <div
          className="buzz-dialog-body buzz-dialog-content"
          data-chrome-spacing={chromeSpacing}
          data-header-gap={headerGap}
          data-footer-gap={footerGap}
        >
          {navigation ? (
            <div className="buzz-dialog-navigation-layout">
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: Delegated buttons emit click for both keyboard and pointer activation. */}
              <nav
                aria-label={navigation.label}
                className="buzz-dialog-navigation"
                onClick={() => {
                  const content = detail.current;
                  if (!content) return;
                  const nav = content.previousElementSibling;
                  if (
                    nav &&
                    nav.getBoundingClientRect().width > 0 &&
                    nav.getBoundingClientRect().bottom <=
                      content.getBoundingClientRect().top
                  ) {
                    content.focus();
                    content.scrollIntoView({ block: "start" });
                  }
                }}
              >
                {navigation.content}
              </nav>
              <div
                className="buzz-dialog-navigation-detail"
                ref={detail}
                tabIndex={-1}
              >
                {children}
              </div>
            </div>
          ) : (
            children
          )}
        </div>
      )}
      {(actions || leadingActions) && (
        <footer
          className="buzz-dialog-actions"
          data-chrome-spacing={chromeSpacing}
        >
          <ScrollEdgeMaterial
            edge="bottom"
            className="buzz-dialog-bar-material"
          />
          <div className="buzz-dialog-action-row">
            {leadingActions && (
              <div className="buzz-dialog-leading-actions">
                {leadingActions}
              </div>
            )}
            {actions}
          </div>
        </footer>
      )}
    </>
  );
  return (
    <BaseDialog.Root
      open={open}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal={!dismissOnOutsideClick}
      onOpenChange={(next, details) => {
        if (
          !next &&
          (preventClose ||
            (details.reason === "outside-press" && windowDrag.wasWindowDrag()))
        ) {
          details.cancel();
          return;
        }
        if (!next && details.reason === "escape-key" && onEscape?.()) {
          details.cancel();
          return;
        }
        setInstantClose(details.reason === "escape-key");
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal container={container}>
        <BaseDialog.Backdrop
          forceRender
          onPointerDown={windowDrag.onPointerDown}
          onPointerMove={windowDrag.onPointerMove}
          onPointerUp={windowDrag.onPointerUp}
          onPointerCancel={windowDrag.onPointerCancel}
          onLostPointerCapture={windowDrag.onLostPointerCapture}
          data-outside-dismissal={dismissOnOutsideClick || undefined}
          data-placement={placement}
          data-buzz-ui=""
          data-motion={transition}
          className="buzz-dialog-backdrop"
        />
        <BaseDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog gap-0"
          data-placement={placement}
          data-presentation={presentation}
          data-height={height}
          data-body-layout={bodyLayout}
          data-stepped={step ? "" : undefined}
          data-size={navigation ? "expanded" : size}
          data-navigation={navigation ? "" : undefined}
          data-navigation-visit={visit ? "" : undefined}
          data-contained={container ? "" : undefined}
          data-motion={transition}
          aria-modal="true"
          initialFocus={initialFocus}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
        >
          {step ? (
            <>
              {/* One stable accessible label, even while two visual steps crossfade. */}
              <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="sr-only">
                  {description}
                </BaseDialog.Description>
              )}
              <AnimatePresence initial={false}>
                <DialogStep
                  key={step.key}
                  scale={step.scale}
                  height={height}
                  bodyLayout={bodyLayout}
                  instant={motion === "none"}
                >
                  {contents}
                </DialogStep>
              </AnimatePresence>
            </>
          ) : (
            contents
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Exiting content is visual only; Base UI still owns the single focus trap. */
function DialogStep({
  scale,
  height,
  bodyLayout,
  instant: noMotion,
  children,
}: {
  scale: number;
  height: DialogProps["height"];
  bodyLayout: DialogProps["bodyLayout"];
  instant: boolean;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  const instant =
    noMotion ||
    reduceMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  const away = {
    opacity: 0,
    scale: instant ? 1 : scale,
    filter: instant ? "blur(0px)" : "blur(4px)",
  };
  return (
    <motion.div
      className="buzz-dialog-step"
      data-height={height}
      data-body-layout={bodyLayout}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={away}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={away}
      transition={{ duration: instant ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
