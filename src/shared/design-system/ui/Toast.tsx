import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { XIcon } from "../icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

const ToastHost = createContext("");

/** Space reserved by mounted surfaces at the top window edge. */
const clearances = new Map<object, number>();
/** Each mounted toast host's always-present Sonner section. */
const viewports = new Set<HTMLElement>();
// Scoped to the toast host, not the root: a root custom property restyles the
// whole document, and the next layout read in that commit pays for it.
let publishQueued = false;
const writeClearance = (viewport: HTMLElement) => {
  const value = `${Math.max(0, ...clearances.values())}px`;
  if (viewport.style.getPropertyValue("--buzz-toast-top-clearance") !== value)
    viewport.style.setProperty("--buzz-toast-top-clearance", value);
};
// Publish once a commit's effects settle, so a surface replaced by one of the
// same height (switching channels) writes nothing.
const publishClearance = () => {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => {
    publishQueued = false;
    viewports.forEach(writeClearance);
  });
};
const attachViewport = (viewport: HTMLElement | null) => {
  if (!viewport) return;
  viewports.add(viewport);
  writeClearance(viewport);
  return () => {
    viewports.delete(viewport);
  };
};

/** Keeps the stack below a mounted top-edge surface, such as the shell header.
 * Hidden surfaces take no room. */
export function useToastClearance(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const key = {};
    const measure = () => {
      const { bottom, height } = element.getBoundingClientRect();
      clearances.set(key, height ? bottom : 0);
      publishClearance();
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      clearances.delete(key);
      publishClearance();
    };
  }, [ref]);
}
type Tone = "error" | "warning" | "info" | "success";

/** Mount once in the host. Sonner owns announcements, expiry and swiping. */
export function ToastProvider({
  children,
  portalContainer,
}: {
  children: ReactNode;
  portalContainer?: HTMLElement | undefined;
}) {
  const id = useId();
  // WebKitGTK can crash while compositing an animated blur on a toast.
  const skipBlur =
    globalThis.navigator?.platform?.startsWith("Linux") &&
    navigator.vendor === "Apple Computer, Inc.";
  useEffect(() => {
    // Sonner's global hotkey must not bypass the host's modal focus boundary.
    const guardModal = (event: KeyboardEvent) => {
      if (
        event.code === "F6" &&
        document.querySelector('[aria-modal="true"]:not([data-ending-style])')
      ) {
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", guardModal, true);
    return () => window.removeEventListener("keydown", guardModal, true);
  }, []);
  useEffect(
    () => () => {
      for (const notice of toast.getToasts()) {
        if ("toasterId" in notice && notice.toasterId === id)
          toast.dismiss(notice.id);
      }
    },
    [id],
  );
  return (
    <ToastHost value={id}>
      {createPortal(
        <Toaster
          ref={attachViewport}
          id={id}
          position="top-right"
          swipeDirections={["left", "right"]}
          expand={false}
          visibleToasts={Infinity}
          hotkey={["F6"]}
          customAriaLabel="App notifications"
          className={
            skipBlur
              ? "buzz-toast-viewport buzz-toast-no-blur"
              : "buzz-toast-viewport"
          }
        />,
        portalContainer ?? document.body,
      )}
      {children}
    </ToastHost>
  );
}

type ToastCardProps = {
  exiting?: boolean;
  title: string;
  description?: string | undefined;
  /** Optional supporting detail between the message and its actions. */
  details?: ReactNode;
  children?: ReactNode;
  tone: Tone;
  closeLabel?: string;
  onClose?: (() => void) | undefined;
  navigation?: { label: string; open(): void } | undefined;
};

function ToastCard({
  exiting,
  title,
  description,
  details,
  children,
  tone,
  closeLabel = "Dismiss notification",
  onClose,
  navigation,
}: ToastCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div
      inert={exiting}
      aria-hidden={exiting}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-buzz-ui=""
      data-type={tone}
      className="buzz-toast floating-surface"
    >
      {navigation && (
        <button
          type="button"
          className="buzz-toast-open"
          aria-label={navigation.label}
          title={navigation.label}
          // WebKit Tabs past a button without an explicit tabindex unless the
          // OS enables full keyboard access; the body action is keyboard-first.
          tabIndex={0}
          onClick={navigation.open}
        />
      )}
      <div className="buzz-toast-heading">
        <div className="buzz-toast-message">
          <div id={titleId} className="buzz-toast-title text-label-sm">
            {title}
          </div>
          {description && (
            <p id={descriptionId} className="text-body-sm">
              {description}
            </p>
          )}
        </div>
        {onClose && (
          <div className="buzz-toast-dismiss">
            <IconButton
              size="xs"
              shape="round"
              variant="outline-subtle"
              aria-label={closeLabel}
              icon={<XIcon size={12} strokeWidth={1.5} aria-hidden="true" />}
              onClick={onClose}
            />
          </div>
        )}
      </div>
      {details && <div className="buzz-toast-details">{details}</div>}
      {children && <div className="buzz-toast-actions">{children}</div>}
    </div>
  );
}

// Updating Sonner's toast object restarts its timer. Keep live notice content
// in a small React store instead, rendered inside Sonner so swipe/focus events
// use its tree and cannot bubble into the originating composer or menu.
function noticeContent(initial: ToastCardProps) {
  let content: ToastCardProps = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => content,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: ToastCardProps | null) => {
      content = next ?? { ...content, exiting: true };
      for (const listener of listeners) listener();
    },
  };
}

function NoticeContent({
  source,
}: {
  source: ReturnType<typeof noticeContent>;
}) {
  const content = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return <ToastCard {...content} />;
}

/** A notice lives with its source; removing it clears its floating presentation. */
export function ToastNotice({
  title,
  description,
  details,
  children,
  onDismiss,
  closeLabel = "Dismiss notification",
  timeout = 0,
  tone = "error",
  navigation,
}: {
  title: string;
  description?: string;
  details?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  closeLabel?: string;
  /** Zero keeps recovery visible until its source resolves or explicitly dismisses. */
  timeout?: number;
  tone?: Tone;
  navigation?: ToastCardProps["navigation"];
}) {
  const id = useId();
  const toasterId = useContext(ToastHost);
  const [source] = useState(() =>
    noticeContent({ title, description, details, tone, children }),
  );
  const dismissed = useEffectEvent(() => onDismiss?.());
  const dismissible = timeout > 0 || !!onDismiss;
  const closeNotice = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let closed = false;
    const onClose = () => {
      if (!active || closed) return;
      closed = true;
      source.update(null);
      dismissed();
    };
    closeNotice.current = onClose;
    toast.custom(() => <NoticeContent source={source} />, {
      id,
      toasterId,
      duration: Infinity,
      onDismiss: onClose,
      onAutoClose: onClose,
    });
    return () => {
      active = false;
      closeNotice.current = undefined;
      source.update(null);
      toast.dismiss(id);
    };
  }, [id, toasterId, source]);
  useEffect(() => {
    toast.custom(() => <NoticeContent source={source} />, {
      id,
      toasterId,
      duration: timeout > 0 ? timeout : Infinity,
      dismissible,
    });
  }, [id, toasterId, timeout, dismissible, source]);
  useEffect(() => {
    source.update({
      title,
      description,
      details,
      tone,
      children,
      closeLabel,
      navigation,
      onClose: dismissible
        ? () => {
            toast.dismiss(id);
            closeNotice.current?.();
          }
        : undefined,
    });
  }, [
    source,
    id,
    title,
    description,
    details,
    tone,
    children,
    closeLabel,
    dismissible,
    navigation,
  ]);
  return null;
}

/** Close host-owned feedback when its action is no longer valid. */
export function useToastDismiss() {
  return toast.dismiss;
}

/** Completed actions outlive their originating row. */
export function useToastNotification() {
  const toasterId = useContext(ToastHost);
  return (
    title: string,
    tone: "success" | "error" | "info",
    action?: { label: string; onClick(): void; timeout?: number },
  ) => {
    // The card stays focusable while Sonner animates it out; act once.
    let acted = false;
    return String(
      toast.custom(
        (id) => (
          <ToastCard
            title={title}
            tone={tone}
            onClose={() => {
              toast.dismiss(id);
            }}
          >
            {action && (
              <Button
                size="compact"
                onClick={() => {
                  if (acted) return;
                  acted = true;
                  toast.dismiss(id);
                  action.onClick();
                }}
              >
                {action.label}
              </Button>
            )}
          </ToastCard>
        ),
        {
          id: crypto.randomUUID(),
          toasterId,
          duration: action ? (action.timeout ?? 8000) : 4000,
        },
      ),
    );
  };
}
