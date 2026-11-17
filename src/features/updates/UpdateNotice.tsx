import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Updates } from "./updates";

/** Reports a failed install and its retry outside Settings; the top-bar action offers ready updates. */
export function UpdateNotice({ updates }: { updates: Updates }) {
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const inline = useSyncExternalStore(
    updates.subscribe,
    updates.inlineVisible,
    updates.inlineVisible,
  );
  const recovery = useSyncExternalStore(
    updates.subscribe,
    updates.noticeRecovery,
    updates.noticeRecovery,
  );
  if (!recovery || inline) return null;
  const { state } = status;
  const descriptions = {
    idle: "",
    ready: "",
    installing: "",
    checking: "Checking for updates...",
    available: "Preparing update...",
    downloading: "Downloading update...",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    error: "",
  };
  return (
    <ToastNotice
      title={state === "error" ? "Update failed" : "Software Updates"}
      description={
        status.state === "error" ? status.message : descriptions[state]
      }
      tone={state === "error" ? "error" : "info"}
      onDismiss={updates.dismissNotice}
      closeLabel="Dismiss update notification"
    >
      <Button
        type="button"
        size="sm"
        loading={["checking", "available", "downloading"].includes(state)}
        onClick={() => void updates.checkForUpdate()}
      >
        Retry
      </Button>
    </ToastNotice>
  );
}
