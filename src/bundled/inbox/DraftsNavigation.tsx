import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import { useDraftCount } from "../../features/messages/draft-presence";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import { inboxRouteTarget } from "./route";

/** A second entry to Inbox, not a second page or draft editor. */
export function DraftsNavigation({
  relay,
  navigation,
}: {
  relay: RelayData;
  navigation: Navigation;
}) {
  const connection = useRelayConnection(relay);
  return (
    <NavigationItem
      label="Drafts"
      icon={
        <span className="shell-page-icon">
          <PencilSimpleIcon size={16} strokeWidth={2.5} />
        </span>
      }
      trailing={
        connection.status === "ready" ? (
          <DraftCount session={connection.session} />
        ) : undefined
      }
      onClick={() => {
        void navigation.open(inboxRouteTarget({ drafts: true }));
        document.getElementById("main-content")?.focus({ preventScroll: true });
      }}
    />
  );
}

function DraftCount({ session }: { session: RelaySession }) {
  const count = useDraftCount(session);
  return count ? (
    <span className="text-caption text-subtle">
      {count}
      <span className="sr-only">{count === 1 ? " draft" : " drafts"}</span>
    </span>
  ) : null;
}
