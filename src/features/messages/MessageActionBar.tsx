import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import {
  HashArrowInIcon,
  ThreadIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
  ForwardIcon,
  QuotesIcon,
} from "../../shared/design-system/icons";
import { behindActiveOverlay } from "../../shared/design-system/overlayLayer";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuSeparator,
  type MenuPosition,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";
import {
  useFloatingActionBar,
  useMessageActionBarReady,
} from "./useFloatingActionBar";
import {
  writeClipboardRichText,
  writeClipboardText,
} from "../../shared/clipboard";
import { captureSelectedQuote, quoteSelection } from "./selection-quote";

const AfterMenuClose = createContext<
  ((action: () => void) => void) | undefined
>(undefined);
export const useAfterMessageMenuClose = () => useContext(AfterMenuClose);

// Links, media, editable content and selections that cannot be quoted keep
// their own menus. A quotable selection takes precedence in the capture phase.
const nativeMenuTarget =
  "a[href], img, video, audio, input, textarea, select, [contenteditable]:not([contenteditable='false'])";
// Read at the press: macOS selects the word under a secondary click before
// its contextmenu event.
const selectionHolds = ({ target, clientX: x, clientY: y }: MouseEvent) => {
  const selection = (target as Node).ownerDocument?.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++)
    for (const box of selection.getRangeAt(index).getClientRects())
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
        return true;
  return false;
};
const keepsNativeMenu = (target: EventTarget, selected?: boolean) =>
  selected || (target instanceof Element && !!target.closest(nativeMenuTarget));

type Props = {
  /** A coordination row is the context-menu target instead of a toolbar. */
  children?: ReactElement | undefined;
  /** The target also shows the toolbar. A pointer open then leaves focus in
   * place, as ⋯ does, and Forward returns to ⋯. */
  withToolbar?: boolean | undefined;
  rowRef?: RefObject<HTMLDivElement | null>;
  messageId?: string;
  menuTriggerRef?: RefObject<HTMLButtonElement | null>;
  onSendToChannel?: (() => void) | undefined;
  onReply?: (() => void) | undefined;
  onForward?: (() => void) | undefined;
  replyDisabled?: boolean | undefined;
  link?: string | undefined;
  copyText(): string;
  quickControls?: ReactNode;
  toolbarItems?: ReactNode;
  /** Menu items rendered above the built-in actions. */
  leadingItems?: ReactNode;
  overflowItems?: ReactNode;
};

// A Base UI context menu on every message row made list renders and scrolling
// measurably slower, so a list hosts one for its toolbar rows. Each registers
// its actions by message ID, unique within the list; the menu opens with the
// row under the press.
type RowMenus = { rows: Map<string, Props>; changed: (id: string) => void };
const RowMenus = createContext<RowMenus | undefined>(undefined);
const SELECTION_HIGHLIGHT = "buzz-message-highlight";

/** The context menu of the toolbar message rows rendered inside `children`. */
export function MessageContextMenus({ children }: { children: ReactElement }) {
  const [target, setTarget] = useState<string>();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const shown = useRef(target);
  useLayoutEffect(() => {
    shown.current = target;
  });
  // The open menu follows its row's actions and closes when the row goes.
  const [menus] = useState<RowMenus>(() => ({
    rows: new Map(),
    changed: (id) => {
      if (id === shown.current) refresh();
    },
  }));
  const { rows } = menus;
  const rowAt = (element: Element) => {
    for (
      let row = element.closest<HTMLElement>("[data-message-id]");
      row;
      row = row.parentElement?.closest<HTMLElement>("[data-message-id]") ?? null
    ) {
      const id = row.dataset.messageId;
      if (id && rows.has(id)) return id;
    }
  };
  return (
    <RowMenus value={menus}>
      <MessageActionBarControls
        copyText={() => ""}
        {...(target && rows.get(target))}
        withToolbar
        host={{
          select: (element) => {
            const id = rowAt(element);
            if (id) setTarget(id);
            return id;
          },
          release: () => setTarget(undefined),
        }}
      >
        {children}
      </MessageActionBarControls>
    </RowMenus>
  );
}

export function MessageActionBar(props: Props) {
  const active = useConversationPresentation();
  const menus = useContext(RowMenus);
  const hosted =
    menus && props.children && props.withToolbar ? props.messageId : undefined;
  useEffect(() => {
    if (!menus || !hosted) return;
    menus.rows.set(hosted, props);
    menus.changed(hosted);
    return () => {
      if (menus.rows.get(hosted) !== props) return;
      menus.rows.delete(hosted);
      menus.changed(hosted);
    };
  }, [menus, hosted, props]);
  if (hosted) return props.children;
  // A target keeps its tree while hidden, so its content is not remounted.
  return props.children ? (
    <MessageActionBarControls {...props} />
  ) : active ? (
    <ActiveMessageActionBar {...props} />
  ) : null;
}

function ActiveMessageActionBar(props: Props) {
  const ready = useMessageActionBarReady(props.rowRef);
  return ready ? (
    <MessageActionBarControls {...props} />
  ) : (
    <div className={styles.messageActionsSlot}>
      {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
      <div
        className={styles.messageActions}
        role="group"
        aria-label="Message actions"
      />
    </div>
  );
}

function MessageActionBarControls({
  children,
  withToolbar,
  onSendToChannel,
  onReply,
  onForward,
  replyDisabled,
  link,
  copyText,
  quickControls,
  toolbarItems,
  leadingItems,
  overflowItems,
  messageId,
  menuTriggerRef,
  rowRef,
  host,
}: Props & {
  /** A list's menu: selects the row under a press and releases it on close. */
  host?: {
    select: (element: Element) => string | undefined;
    release: () => void;
  };
}) {
  const active = useConversationPresentation();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] =
    useState<ReturnType<typeof captureSelectedQuote>>();
  const [contextLink, setContextLink] = useState<string>();
  // A hidden conversation, or a list's removed row, retires its open menu.
  if (open && (!active || (host && !messageId))) setOpen(false);
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const floating = useFloatingActionBar(
    children ? undefined : rowRef,
    barRef,
    slotRef,
    open,
  );
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busy = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const removed = !!host && !messageId;
  useLayoutEffect(() => {
    const highlights = globalThis.CSS?.highlights;
    if (!open || !selection || !active || removed || !highlights) return;
    // Paint the saved ranges while the menu owns focus. Fresh range objects
    // also avoid WebKit sharing paint state with Find on screen.
    const highlight = new Highlight(
      ...selection.ranges.map((range) => range.cloneRange()),
    );
    highlights.set(SELECTION_HIGHLIGHT, highlight);
    document.documentElement.dataset.messageHighlight = "";
    return () => {
      if (highlights.get(SELECTION_HIGHLIGHT) !== highlight) return;
      highlight.clear();
      highlights.delete(SELECTION_HIGHLIGHT);
      delete document.documentElement.dataset.messageHighlight;
    };
  }, [open, selection, active, removed]);
  // Retiring the conversation or source row cancels any queued handoff.
  useLayoutEffect(() => {
    if (removed || !active) afterClose.current = undefined;
  }, [removed, active]);
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      afterClose.current = undefined;
    };
  }, []);
  const [handingOffFocus, setHandingOffFocus] = useState(false);
  const [openedByPointer, setOpenedByPointer] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<MenuPosition["anchor"]>();
  const contextFocus = useRef<HTMLElement | null>(null);
  const selectedAtPress = useRef<boolean | "touch">(undefined);
  const overflowSelection =
    useRef<ReturnType<typeof captureSelectedQuote>>(undefined);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = menuTriggerRef ?? ownTrigger;
  const copy = async (text: () => string, label: string, html?: string) => {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await (html === undefined
        ? writeClipboardText(text())
        : writeClipboardRichText(text(), html, { fallbackToPlainText: true }));
      setNotice({ text: `${label} copied`, error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy. Try again from the message menu.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  };
  const popup = (
    <MenuPopup
      align={children ? "start" : "end"}
      anchor={contextAnchor}
      data-message-id={messageId}
      // The shared popup preserves moved focus; retirement also revokes
      // return-focus ownership, including a retained hidden source row.
      finalFocus={() =>
        live.current && !handingOffFocus
          ? children
            ? contextFocus.current?.isConnected
              ? contextFocus.current
              : false
            : !openedByPointer
          : false
      }
    >
      <AfterMenuClose.Provider
        value={(action) => {
          setHandingOffFocus(true);
          afterClose.current = action;
        }}
      >
        {selection && (
          <>
            <MenuItem
              disabled={copying}
              onClick={() =>
                void copy(() => selection.text, "Text", selection.html)
              }
            >
              <MenuIcon>
                <CopyIcon />
              </MenuIcon>
              Copy highlight
            </MenuItem>
            <MenuItem
              onClick={() => {
                setHandingOffFocus(true);
                afterClose.current = () => {
                  if (!quoteSelection(selection)) {
                    const target = contextFocus.current;
                    if (target?.isConnected)
                      target.focus({ preventScroll: true });
                    setNotice({
                      text: "Couldn’t quote. Select the text and try again.",
                      error: true,
                    });
                  }
                };
              }}
            >
              <MenuIcon>
                <QuotesIcon />
              </MenuIcon>
              Quote highlight
            </MenuItem>
            {contextLink && (
              <MenuItem
                disabled={copying}
                onClick={() => void copy(() => contextLink, "Link URL")}
              >
                <MenuIcon>
                  <LinkIcon />
                </MenuIcon>
                Copy link URL
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}
        {leadingItems}
        <MenuItem
          disabled={copying}
          onClick={() => void copy(copyText, "Message")}
        >
          <MenuIcon>
            <CopyIcon />
          </MenuIcon>
          Copy message
        </MenuItem>
        {onSendToChannel && (
          <MenuItem
            onClick={() => {
              try {
                onSendToChannel();
                setNotice({ text: "Sending to channel", error: false });
              } catch (error) {
                setNotice({
                  text:
                    error instanceof Error
                      ? error.message
                      : "Couldn’t send to channel",
                  error: true,
                });
              }
            }}
          >
            <MenuIcon>
              <HashArrowInIcon />
            </MenuIcon>
            Send to channel
          </MenuItem>
        )}
        {children && onReply && (
          <MenuItem
            disabled={replyDisabled}
            onClick={() => {
              setHandingOffFocus(true);
              afterClose.current = onReply;
            }}
          >
            <MenuIcon>
              <ThreadIcon />
            </MenuIcon>
            Reply
          </MenuItem>
        )}
        <MenuItem
          disabled={!link || copying}
          onClick={() => {
            if (link) void copy(() => link, "Link");
          }}
        >
          <MenuIcon>
            <LinkIcon />
          </MenuIcon>
          {contextLink ? "Copy message link" : "Copy link"}
        </MenuItem>
        {onForward && (
          <MenuItem
            disabled={!link}
            title={!link ? "Message link unavailable" : undefined}
            onClick={() => {
              setHandingOffFocus(true);
              // Forward returns focus to what is focused when it opens. So
              // focus this menu's target first (⋯, however it opened, or the
              // context menu's target); a press need not have focused ⋯.
              afterClose.current = () => {
                const target =
                  (children && contextFocus.current) || trigger.current;
                if (target?.isConnected) target.focus({ preventScroll: true });
                onForward();
              };
            }}
          >
            <MenuIcon>
              <ForwardIcon />
            </MenuIcon>
            Forward message
          </MenuItem>
        )}
        {overflowItems}
      </AfterMenuClose.Provider>
    </MenuPopup>
  );
  const closed = (opened: boolean) => {
    if (!opened) {
      host?.release();
      setSelection(undefined);
      setContextLink(undefined);
      const action = afterClose.current;
      afterClose.current = undefined;
      action?.();
    }
  };
  return (
    <>
      {children ? (
        <ContextMenuRoot
          open={open}
          disabled={!active}
          onOpenChange={(next) => {
            if (next) {
              setHandingOffFocus(false);
              // A reopen cancels the closing menu's completion, and its item.
              afterClose.current = undefined;
            }
            setOpen(next);
          }}
          onOpenChangeComplete={closed}
        >
          <ContextMenuTrigger
            render={
              // A list's popup stays in the list's tree, so its focus and key
              // events reach the list as a row's did.
              host
                ? cloneElement(
                    children as ReactElement<{ children?: ReactNode }>,
                    undefined,
                    (children.props as { children?: ReactNode }).children,
                    popup,
                  )
                : children
            }
            onPointerDown={(event) => {
              selectedAtPress.current =
                event.pointerType === "touch"
                  ? withToolbar
                    ? "touch"
                    : false
                  : selectionHolds(event.nativeEvent);
            }}
            onContextMenuCapture={(event) => {
              if (
                !active ||
                !event.currentTarget.contains(event.target as Node) ||
                (event.target as Element).closest?.(
                  "[data-message-actions], input, textarea, select, [contenteditable]:not([contenteditable='false'])",
                ) ||
                selectedAtPress.current === "touch" ||
                !(selectedAtPress.current ?? selectionHolds(event.nativeEvent))
              )
                return;
              const quote = captureSelectedQuote();
              if (
                !quote?.element.contains(event.target as Node) ||
                behindActiveOverlay(event.currentTarget)
              )
                return;
              const id = host
                ? host.select(event.target as Element)
                : messageId;
              if (!id || !quote.messageIds.has(id)) return;
              // Own a selected link's event before its separate menu can open.
              event.preventDefault();
              event.stopPropagation();
              selectedAtPress.current = undefined;
              setSelection(quote);
              setContextLink(
                (event.target as Element)
                  .closest<HTMLAnchorElement>("a[data-link-label]")
                  ?.getAttribute("href") ?? undefined,
              );
              setHandingOffFocus(false);
              afterClose.current = undefined;
              const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
              setContextAnchor({ getBoundingClientRect: () => rect });
              contextFocus.current = quote.element;
              setOpen(true);
            }}
            onContextMenu={(event) => {
              const selected = selectedAtPress.current;
              selectedAtPress.current = undefined;
              if (
                !event.currentTarget.contains(event.target as Node) ||
                // The toolbar's ⋯ owns its own menu.
                (event.target as Element).closest?.("[data-message-actions]")
              ) {
                event.preventBaseUIHandler();
                return;
              }
              if (
                selected === "touch" ||
                keepsNativeMenu(event.target, selected) ||
                (host && !host.select(event.target as Element))
              ) {
                event.preventBaseUIHandler();
                // Base UI's document listener would cancel the native menu.
                event.stopPropagation();
                return;
              }
              setSelection(undefined);
              setContextAnchor(undefined);
              contextFocus.current = withToolbar
                ? null
                : event.currentTarget.querySelector("button");
            }}
            // A message's long press stays the browser's: text selection and
            // link and image callouts. Touch reaches its actions through ⋯.
            style={withToolbar ? { WebkitTouchCallout: "default" } : undefined}
            onTouchStart={(event) => {
              if (
                withToolbar ||
                !event.currentTarget.contains(event.target as Node)
              ) {
                event.preventBaseUIHandler();
                return;
              }
              setSelection(undefined);
              setContextAnchor(undefined);
              contextFocus.current =
                event.currentTarget.querySelector("button");
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                !event.currentTarget.contains(event.target as Node) ||
                keepsNativeMenu(event.target)
              )
                return;
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                if (host && !host.select(event.target as Element)) return;
                event.preventDefault();
                setSelection(undefined);
                contextFocus.current = event.target as HTMLElement;
                setContextAnchor(contextFocus.current);
                setHandingOffFocus(false);
                setOpen(true);
              }
            }}
          />
          {!host && popup}
        </ContextMenuRoot>
      ) : (
        <div ref={slotRef} className={styles.messageActionsSlot}>
          {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
          <div
            className={styles.messageActions}
            data-message-actions=""
            ref={barRef}
            popover={floating ? "manual" : undefined}
            role="group"
            aria-label="Message actions"
          >
            {quickControls}
            {toolbarItems}
            {onReply && (
              <IconButton
                hint={replyDisabled ? "helpful" : "familiar"}
                aria-label="Reply"
                title={
                  replyDisabled ? "Reply unavailable for this message" : "Reply"
                }
                size="sm"
                disabled={replyDisabled}
                icon={<ThreadIcon />}
                onClick={(event) => {
                  event.currentTarget.focus();
                  onReply();
                }}
              />
            )}
            <IconButton
              hint="familiar"
              aria-label="Copy link"
              title="Copy link"
              size="sm"
              disabled={!link || copying}
              icon={<LinkIcon />}
              onClick={() => {
                if (link) void copy(() => link, "Link");
              }}
            />
            <MenuRoot
              open={open}
              onOpenChange={(next, details) => {
                if (next) {
                  const quote = overflowSelection.current;
                  overflowSelection.current = undefined;
                  setSelection(quote);
                  setContextLink(undefined);
                  if (quote) contextFocus.current = quote.element;
                  setHandingOffFocus(false);
                  // Base UI opens on mousedown, so a real pointer press carries a
                  // click count; keyboard and assistive presses arrive as a click
                  // with 0.
                  setOpenedByPointer(
                    details.event instanceof MouseEvent &&
                      details.event.detail > 0,
                  );
                } else if (
                  details.event.type.startsWith("key") ||
                  (details.event.type === "click" &&
                    "detail" in details.event &&
                    details.event.detail === 0)
                ) {
                  setOpenedByPointer(false);
                }
                setOpen(next);
              }}
              onOpenChangeComplete={closed}
            >
              <MenuTrigger
                onPointerDownCapture={(event) => {
                  // Save the same conversation's highlight before ⋯ takes focus.
                  const quote = captureSelectedQuote();
                  overflowSelection.current =
                    messageId &&
                    quote?.messageIds.has(messageId) &&
                    quote.element.contains(event.currentTarget)
                      ? quote
                      : undefined;
                }}
                onKeyDownCapture={() => {
                  overflowSelection.current = undefined;
                }}
                render={
                  <IconButton
                    hint="familiar"
                    ref={trigger}
                    aria-label="More message actions"
                    title="More message actions"
                    size="sm"
                    icon={<DotsThreeIcon />}
                  />
                }
              />
              {popup}
            </MenuRoot>
          </div>
        </div>
      )}
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </>
  );
}
