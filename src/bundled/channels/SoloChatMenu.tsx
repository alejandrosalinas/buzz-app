import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { conversionLabel } from "../../features/solo/conversion";
import { canConvertToChannel } from "../../features/solo/ConvertToChannel";
import { canShareConversation } from "../../features/solo/share";
import { canEditLifetime } from "../../features/solo/Lifetime";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  FolderSimpleIcon,
  HashArrowInIcon,
  GearIcon,
  PencilSimpleIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { ChannelCopyLinkMenuItem } from "./ChannelCopyLinkMenuItem";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelReadMenuItem } from "./ChannelReadMenuItem";

/** The one action list for a Solo chat. Its hosts own the dialogs it opens. */
export function SoloChatMenuItems({
  session,
  channel,
  onShare,
  onConvert,
  onMove,
  onNewWorkspace,
  onSettings,
  onRename,
  onLifecycle,
  onReadResult,
  includeChannelControls = true,
  children,
}: {
  /** Additional actions at the end of the first menu group. */
  children?: ReactNode;
  session: RelaySession;
  channel: ChannelSummary;
  onShare(): void;
  /** Absent where no host can finish a conversion. */
  onConvert?: (() => void) | undefined;
  onMove?(projectId?: string): void;
  onNewWorkspace?(): void;
  onSettings(): void;
  /** Absent where the chat can't be renamed in place. */
  onRename?: (() => void) | undefined;
  /** Absent where no owner can confirm lifecycle actions. */
  onLifecycle?: ((action: ChannelLifecycleAction) => void) | undefined;
  /** The menu closes at once; its host reports a failed read change. */
  onReadResult?(error?: string): void;
  includeChannelControls?: boolean;
}) {
  const handoff = useChannelNavigation();
  const regions = useSoloNavigation(session);
  const preferences = session.sidebarPreferences;
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments?.[channel.id];
  const grouped = groups.some((group) => group.id === assigned);
  // Archived chats keep only what still applies, including Unarchive.
  const active = !channel.archived;
  return (
    <>
      {includeChannelControls &&
        session.unread.sync().capability === "frontier-sync" && (
          <ChannelReadMenuItem
            unread={session.unread}
            channelId={channel.id}
            pending={false}
            closeOnClick
            run={(action) =>
              action().then(
                () => onReadResult?.(),
                (error: unknown) =>
                  onReadResult?.(
                    error instanceof Error
                      ? error.message
                      : "Read state couldn’t be saved. Try again.",
                  ),
              )
            }
          />
        )}
      {onRename && (
        <MenuItem onClick={onRename}>
          <MenuIcon>
            <PencilSimpleIcon size={14} />
          </MenuIcon>
          Rename
        </MenuItem>
      )}
      <MenuItem
        disabled={
          !!channel.readOnly ||
          (!session.canvas.available && !canEditLifetime(session, channel))
        }
        onClick={onSettings}
      >
        <MenuIcon>
          <GearIcon size={14} />
        </MenuIcon>
        Chat settings
      </MenuItem>
      {active &&
        !regions.managed.has(channel.id) &&
        onMove &&
        onNewWorkspace && (
          <MenuSubmenu>
            <MenuSubmenuTrigger disabled={!preferences.writable}>
              <MenuIcon>
                <FolderSimpleIcon size={14} />
              </MenuIcon>
              Move to
            </MenuSubmenuTrigger>
            <MenuSubmenuPopup aria-label="Workspace">
              {grouped && <MenuItem onClick={() => onMove()}>Chats</MenuItem>}
              {groups.map((group) => (
                <MenuItem key={group.id} onClick={() => onMove(group.id)}>
                  {group.name}
                </MenuItem>
              ))}
              <MenuItem onClick={onNewWorkspace}>New workspace</MenuItem>
            </MenuSubmenuPopup>
          </MenuSubmenu>
        )}
      {active && children}
      <MenuSeparator />
      {active && (
        <MenuItem
          disabled={!canShareConversation(session, channel)}
          onClick={onShare}
        >
          <MenuIcon>
            <ShareIcon size={14} />
          </MenuIcon>
          Share access
        </MenuItem>
      )}
      {includeChannelControls && (
        <ChannelCopyLinkMenuItem channelId={channel.id} />
      )}
      {active &&
        !regions.managed.has(channel.id) &&
        onConvert &&
        canConvertToChannel(session, channel) && (
          <MenuItem onClick={onConvert}>
            <MenuIcon>
              <HashArrowInIcon size={14} />
            </MenuIcon>
            {conversionLabel(session, channel.id)}
          </MenuItem>
        )}
      {onLifecycle &&
        (!channel.readOnly || channel.viewerRole === "guest") &&
        !channel.cached && (
          <ChannelLifecycleMenu
            channel={channel}
            session={session}
            disabled={!!handoff?.lifecycleDialog}
            separator
            noun="chat"
            choose={onLifecycle}
          />
        )}
    </>
  );
}
