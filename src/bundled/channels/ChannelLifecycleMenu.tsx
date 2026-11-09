import type { ReactNode } from "react";
import {
  ArchiveIcon,
  EyeSlashIcon,
  SignOutIcon,
  TrashIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { LifecycleNoun } from "./ChannelLifecycleDialog";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { useLifecycleOffer, type LifecycleSession } from "./useLifecycleOffer";

export function ChannelLifecycleMenu({
  channel,
  session,
  choose,
  disabled,
  separator,
  noun = "channel",
  render = (items) => items,
}: {
  channel: ChannelSummary;
  session: LifecycleSession;
  choose(action: ChannelLifecycleAction): void;
  disabled: boolean;
  separator: boolean;
  noun?: LifecycleNoun;
  render?(items: ReactNode): ReactNode;
}) {
  const state = useLifecycleOffer(session, channel);
  if (!session.channelLifecycle.available)
    return render(
      <>
        {separator && <MenuSeparator />}
        <MenuItem disabled>
          <MenuIcon>
            <WarningCircleIcon size={14} />
          </MenuIcon>
          Channel actions unavailable on this connection
        </MenuItem>
      </>,
    );
  if (
    !state ||
    !(
      state.canHide ||
      state.canArchive ||
      state.canUnarchive ||
      state.canDelete ||
      state.canLeave
    )
  )
    return render(null);
  return render(
    <>
      {separator && <MenuSeparator />}
      {state.canHide ? (
        <MenuItem disabled={disabled} onClick={() => choose("hide")}>
          <MenuIcon>
            <EyeSlashIcon size={14} />
          </MenuIcon>
          Hide conversation
        </MenuItem>
      ) : (
        <>
          {state.canLeave && (
            <MenuItem disabled={disabled} onClick={() => choose("leave")}>
              <MenuIcon>
                <SignOutIcon size={14} />
              </MenuIcon>
              Leave {noun}
            </MenuItem>
          )}
          {(state.canArchive || state.canUnarchive) && (
            <MenuItem
              disabled={disabled}
              onClick={() =>
                choose(state.canUnarchive ? "unarchive" : "archive")
              }
            >
              <MenuIcon>
                <ArchiveIcon size={14} />
              </MenuIcon>
              {state.canUnarchive ? `Unarchive ${noun}` : `Archive ${noun}`}
            </MenuItem>
          )}
          {state.canDelete && (
            <MenuItem
              tone="danger"
              disabled={disabled}
              onClick={() => choose("delete")}
            >
              <MenuIcon>
                <TrashIcon size={14} />
              </MenuIcon>
              Delete {noun}
            </MenuItem>
          )}
        </>
      )}
    </>,
  );
}
