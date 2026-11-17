import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { DownloadIcon } from "../../shared/design-system/icons";
import type { Updates } from "./updates";

/** Top-bar restart action, shown while a downloaded update is ready or installing. */
export function UpdateAction({ updates }: { updates: Updates }) {
  const { state } = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  if (state !== "ready" && state !== "installing") return null;
  const label =
    state === "ready"
      ? "Update ready. Restart Buzz to install"
      : "Updating Buzz";
  return (
    <Button
      type="button"
      size="sm"
      variant="prominent"
      aria-label={label}
      title={label}
      loading={state === "installing"}
      onClick={() => void updates.installAndRelaunch()}
    >
      <DownloadIcon size={16} />
      Update
    </Button>
  );
}
