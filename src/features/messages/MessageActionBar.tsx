import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import {
  HashArrowInIcon,
  MessageReplyIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
  ForwardIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";
import {
  useFloatingActionBar,
  useMessageActionBarReady,
} from "./useFloatingActionBar";
import { writeClipboardText } from "../../shared/clipboard";

const AfterMenuClose = createContext<
  ((action: () => void) => void) | undefined
>(undefined);
export const useAfterMessageMenuClose = () => useContext(AfterMenuClose);

type Props = {
  /** A coordination row is the context-menu target instead of a toolbar. */
  children?: ReactElement | undefined;
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

export function MessageActionBar(props: Props) {
  const active = useConversationPresentation();
  return active ? (
    props.children ? (
      <MessageActionBarControls {...props} />
    ) : (
      <ActiveMessageActionBar {...props} />
    )
  ) : (
    (props.children ?? null)
  );
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
}: Props) {
  const [open, setOpen] = useState(false);
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
  const [contextAnchor, setContextAnchor] = useState<HTMLElement>();
  const contextFocus = useRef<HTMLElement | null>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = menuTriggerRef ?? ownTrigger;
  const copy = async (text: () => string, label: string) => {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await writeClipboardText(text());
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
              <MessageReplyIcon />
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
          Copy link
        </MenuItem>
        {onForward && (
          <MenuItem
            disabled={!link}
            title={!link ? "Message link unavailable" : undefined}
            onClick={() => {
              setHandingOffFocus(true);
              // Forward returns focus to what is focused when it opens. So
              // focus this menu's target first (⋯, however it opened, or the
              // context menu's target), as the toolbar Forward button focuses
              // itself; a press need not have focused ⋯.
              afterClose.current = () => {
                const target = children
                  ? contextFocus.current
                  : trigger.current;
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
          onOpenChange={(next) => {
            if (next) setHandingOffFocus(false);
            setOpen(next);
          }}
          onOpenChangeComplete={closed}
        >
          <ContextMenuTrigger
            render={children}
            onContextMenu={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) {
                event.preventBaseUIHandler();
                return;
              }
              setContextAnchor(undefined);
              contextFocus.current =
                event.currentTarget.querySelector("button");
            }}
            onTouchStart={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) {
                event.preventBaseUIHandler();
                return;
              }
              setContextAnchor(undefined);
              contextFocus.current =
                event.currentTarget.querySelector("button");
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                !event.currentTarget.contains(event.target as Node)
              )
                return;
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                contextFocus.current = event.target as HTMLElement;
                setContextAnchor(event.currentTarget);
                setHandingOffFocus(false);
                setOpen(true);
              }
            }}
          />
          {popup}
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
                icon={<MessageReplyIcon />}
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
            {onForward && (
              <IconButton
                hint={link ? "familiar" : "helpful"}
                aria-label="Forward message"
                title={link ? "Forward message" : "Message link unavailable"}
                size="sm"
                disabled={!link}
                icon={<ForwardIcon />}
                onClick={(event) => {
                  event.currentTarget.focus();
                  onForward();
                }}
              />
            )}
            <MenuRoot
              open={open}
              onOpenChange={(next, details) => {
                if (next) {
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
