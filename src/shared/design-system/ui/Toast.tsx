import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { XIcon } from "../icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

const ToastHost = createContext("");
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
          id={id}
          position="bottom-right"
          swipeDirections={["left", "right"]}
          expand
          visibleToasts={Infinity}
          hotkey={["F6"]}
          customAriaLabel="App notifications"
          className="buzz-toast-viewport"
          offset="max(var(--space-6), env(safe-area-inset-bottom))"
          mobileOffset="var(--space-4)"
        />,
        portalContainer ?? document.body,
      )}
      {children}
    </ToastHost>
  );
}

type ToastCardProps = {
  title: string;
  description?: string | undefined;
  children?: ReactNode;
  tone: Tone;
  closeLabel?: string;
  onClose?: (() => void) | undefined;
  navigation?: { label: string; open(): void } | undefined;
};

function ToastCard({
  title,
  description,
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
              size="sm"
              aria-label={closeLabel}
              icon={<XIcon size={16} aria-hidden="true" />}
              onClick={onClose}
            />
          </div>
        )}
      </div>
      {children && <div className="buzz-toast-actions">{children}</div>}
    </div>
  );
}

// Updating Sonner's toast object restarts its timer. Keep live notice content
// in a small React store instead, rendered inside Sonner so swipe/focus events
// use its tree and cannot bubble into the originating composer or menu.
function noticeContent(initial: ToastCardProps) {
  let content: ToastCardProps | null = initial;
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
      content = next;
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
  return content && <ToastCard {...content} />;
}

/** A notice lives with its source; removing it clears its floating presentation. */
export function ToastNotice({
  title,
  description,
  children,
  onDismiss,
  closeLabel = "Dismiss notification",
  timeout = 0,
  tone = "error",
  navigation,
}: {
  title: string;
  description?: string;
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
    noticeContent({ title, description, tone, children }),
  );
  const dismissed = useEffectEvent(() => onDismiss?.());
  const dismissible = timeout > 0 || !!onDismiss;
  useEffect(() => {
    let active = true;
    let closed = false;
    const onClose = () => {
      if (!active || closed) return;
      closed = true;
      source.update(null);
      dismissed();
    };
    toast.custom(() => <NoticeContent source={source} />, {
      id,
      toasterId,
      duration: Infinity,
      onDismiss: onClose,
      onAutoClose: onClose,
    });
    return () => {
      active = false;
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
      tone,
      children,
      closeLabel,
      navigation,
      onClose: dismissible
        ? () => {
            toast.dismiss(id);
          }
        : undefined,
    });
  }, [
    source,
    id,
    title,
    description,
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
  ) =>
    String(
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
}
