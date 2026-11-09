import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArchiveIcon,
  SignOutIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import type { LifecycleNoun } from "./ChannelLifecycleDialog";
import { useLifecycleOffer, type LifecycleSession } from "./useLifecycleOffer";

/** Settings offers live-state actions; the sidebar owns confirmation. */
export function ChannelLifecycleActions({
  channel,
  session,
  choose,
  noun = "channel",
}: {
  channel: ChannelSummary;
  session: LifecycleSession;
  choose(action: ChannelLifecycleAction, trigger: HTMLElement): void;
  noun?: LifecycleNoun;
}) {
  const permissions = useLifecycleOffer(session, channel);
  if (!session.channelLifecycle.available)
    return <p>Channel actions unavailable on this connection</p>;
  return (
    <>
      {permissions?.canLeave && (
        <Button onClick={(event) => choose("leave", event.currentTarget)}>
          <SignOutIcon size={16} aria-hidden="true" />
          Leave {noun}
        </Button>
      )}
      {(permissions?.canArchive || permissions?.canUnarchive) && (
        <Button
          onClick={(event) =>
            choose(
              permissions.canUnarchive ? "unarchive" : "archive",
              event.currentTarget,
            )
          }
        >
          <ArchiveIcon size={16} aria-hidden="true" />
          {permissions.canUnarchive ? "Unarchive" : "Archive"} {noun}
        </Button>
      )}
      {permissions?.canDelete && (
        <Button
          variant="destructive"
          onClick={(event) => choose("delete", event.currentTarget)}
        >
          <TrashIcon size={16} aria-hidden="true" />
          Delete {noun}
        </Button>
      )}
    </>
  );
}
