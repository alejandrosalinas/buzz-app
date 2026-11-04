import type { RelaySession } from "../relay/session";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import { useDraftCount } from "./draft-presence";

export function DraftIndicator({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const count = useDraftCount(session, channelId);
  if (!count) return null;
  const label = count === 1 ? "1 draft" : `${count} drafts`;
  return (
    <span
      className="inline-flex shrink-0 text-subtle"
      data-draft-indicator=""
      role="img"
      aria-label={label}
      title={label}
    >
      <PencilSimpleIcon size={14} aria-hidden="true" />
    </span>
  );
}
