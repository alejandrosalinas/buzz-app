import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

const Announce = createContext<((text: string) => void) | null>(null);

export function MediaActionAnnouncements({
  children,
}: {
  children: ReactNode;
}) {
  const [notice, setNotice] = useState({ text: "", sequence: 0 });
  const announce = useCallback((text: string) => {
    setNotice((previous) => ({ text, sequence: previous.sequence + 1 }));
  }, []);
  return (
    <Announce value={announce}>
      {children}
      {/* The modal hides the toast host from assistive technology. Keep the
          live region mounted and explicit so nested menus leave it exposed. */}
      <span
        className="sr-only"
        role="status"
        aria-label="Media actions"
        aria-live="polite"
      >
        {notice.text && <span key={notice.sequence}>{notice.text}</span>}
      </span>
    </Announce>
  );
}

export function useMediaActionNotification() {
  const notify = useToastNotification();
  const announce = useContext(Announce);
  return (title: string, tone: Parameters<typeof notify>[1]) => {
    announce?.(title);
    return notify(title, tone);
  };
}
