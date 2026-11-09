import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { channelHasUnread } from "../../bundled/channels/useSidebarFilters";
import { inTerminal } from "../../bundled/channels/conversation-rows";
import { communityDestination } from "../../features/communities/destination";
import { communityName } from "../../features/communities/names";
import { markAllRead } from "../../features/communities/CommunityPickerItem";
import type { Communities } from "../../features/communities/service";
import { communityFromScope } from "../../features/relay/gifs";
import { useRelayConnection } from "../../features/relay/react";
import type { UnreadCapability } from "../../features/relay/unread";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { SearchServices } from "./PageSearch";

/**
 * Shift+Escape asks, then marks every conversation in the selected community
 * read, through the same action and toasts as the community menu's "Mark all as
 * read". Unavailable (the key is left alone) without that community's ready
 * session, without read sync, or when nothing shows unread.
 */
export function MarkAllReadShortcut({
  communities,
  shortcuts,
}: {
  communities: Communities;
  shortcuts: SearchServices["shortcuts"];
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const connection = useRelayConnection(communities.relay);
  const notify = useToastNotification();
  const active = client.memberships.find(({ id }) => id === client.selected);
  // The relay follows selection; confirm it has caught up so a switch in
  // progress cannot mark the previous community.
  const session =
    active &&
    connection.status === "ready" &&
    connection.scope &&
    communityFromScope(connection.scope) === communityDestination(active.id).url
      ? connection.session
      : undefined;
  const name = active ? communityName(active) : undefined;
  const [asking, setAsking] = useState<{
    unread: UnreadCapability;
    name: string;
  }>();
  const [pending, setPending] = useState(false);
  const proceed = useRef<HTMLButtonElement>(null);
  // A different session retires an open question about the old one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only the session retires it.
  useEffect(() => setAsking(undefined), [session]);
  useEffect(() => {
    if (!session || !name) return;
    return shortcuts.registerHost({
      id: "mark-all-read",
      title: "Mark all as read",
      binding: { key: "Escape", shift: true },
      order: 76,
      allowInEditable: true,
      // Escape in a terminal belongs to its shell.
      when: () =>
        !inTerminal() &&
        session.unread.sync().capability === "frontier-sync" &&
        session.channels
          .list()
          .channels.some(({ id }) => channelHasUnread(session.unread, id)),
      run: () => setAsking({ unread: session.unread, name }),
    });
  }, [shortcuts, session, name]);
  if (!asking) return null;
  const close = () => setAsking(undefined);
  return (
    <AlertDialog
      title="Mark everything as read?"
      description={`Every conversation in ${asking.name} will show as read. You can still mark a conversation unread afterward.`}
      pending={pending}
      initialFocus={proceed}
      onClose={close}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            ref={proceed}
            variant="primary"
            loading={pending}
            onClick={() => {
              setPending(true);
              void markAllRead(asking.unread, notify).finally(() => {
                setPending(false);
                close();
              });
            }}
          >
            Mark all as read
          </Button>
        </>
      }
    />
  );
}
