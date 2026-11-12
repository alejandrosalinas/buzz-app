import { useSoloNavigation } from "../channel-navigation/solo-navigation-react";
import { prepareSoloMove } from "../channel-navigation/solo-navigation";
import { useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  CaretDownIcon,
  Cube3dSphereIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import styles from "./WorkspaceControl.module.css";
import { useRegionWorkspace } from "./chat-workspace";

export function WorkspaceControl({
  session,
  value,
  onChange,
  channelId,
  disabled = false,
}: {
  session: RelaySession;
  value?: string | undefined;
  onChange?: ((projectId: string) => void) | undefined;
  channelId?: string | undefined;
  disabled?: boolean;
}) {
  const regions = useSoloNavigation(session);
  // A region's chat is filed by its region, when the region offers that.
  const filed = useRegionWorkspace(session, channelId);
  const [snapshot, setSnapshot] = useState(() =>
    session.soloPreferences.snapshot(),
  );
  useEffect(() => {
    const subscribe = session.soloPreferences.subscribe;
    if (typeof subscribe !== "function") return;
    return subscribe(() => setSnapshot(session.soloPreferences.snapshot()));
  }, [session]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId =
    value ??
    (filed
      ? filed.id
      : channelId
        ? snapshot.data?.assignments[channelId]
        : undefined) ??
    "";
  const project = snapshot.data?.sections.find((item) => item.id === projectId);
  const choose = (next: string) => {
    setError("");
    if (onChange) {
      onChange(next);
      return;
    }
    if (!channelId) return;
    const blocked = filed ? undefined : prepareSoloMove(session, channelId);
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    void (
      filed
        ? filed.file(next || undefined)
        : session.soloPreferences.assign(channelId, next || undefined)
    )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };
  const name = project ? `Workspace: ${project.name}` : "Add workspace";
  if (channelId && regions.excluded.has(channelId) && !filed) return null;
  return (
    <span className={styles.control}>
      {/* Saving keeps the trigger focusable, so the choice returns focus to it. */}
      <MenuRoot
        onOpenChange={(open, details) => {
          if (open && busy) details.cancel();
        }}
      >
        <MenuTrigger
          disabled={
            disabled ||
            snapshot.status === "idle" ||
            snapshot.status === "loading"
          }
          render={(props) => (
            <Button
              {...props}
              aria-disabled={busy || undefined}
              variant="ghost"
              size="sm"
              shape={project ? "capsule" : "icon"}
              style={{ maxWidth: "100%" }}
              aria-label={name}
              title={name}
            >
              <Cube3dSphereIcon size={16} aria-hidden="true" />
              {project && (
                <>
                  <span className={styles.name}>{project.name}</span>
                  <CaretDownIcon
                    size={12}
                    className="buzz-dropdown-chevron"
                    aria-hidden="true"
                  />
                </>
              )}
            </Button>
          )}
        />
        <MenuPopup side="top" align="end" aria-label="Choose workspace">
          <MenuRadioGroup value={projectId} onValueChange={choose}>
            <MenuRadioItem value="" closeOnClick>
              No workspace
            </MenuRadioItem>
            {(snapshot.data?.sections ?? []).map((item) => (
              <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                {item.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {snapshot.status === "error" && (
            <MenuItem onClick={() => void session.soloPreferences.refresh()}>
              Retry workspaces
            </MenuItem>
          )}
        </MenuPopup>
      </MenuRoot>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
