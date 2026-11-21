import { hostComposerProvenance } from "../../features/messages/mention-draft";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { clearAttachmentDraft } from "../../features/messages/attachment-draft";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { useEffect, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import {
  createHuddleDiscussion,
  type HuddleDiscussion,
} from "../../features/huddle/discussion";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import { parseHuddleTarget } from "./HuddleCard";

export function HuddlePanel({
  target,
  context,
  openLink,
  channelContext,
  relay,
  extensions,
}: PanelProps & {
  relay: RelayData;
  openLink?: ((url: string) => boolean) | undefined;
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const parsed = parseHuddleTarget(target);
  const room = parsed?.room;
  const parent = parsed?.parent;
  const [owner, setOwner] =
    useState<ReturnType<typeof createHuddleDiscussion>>();
  const [discussion, setDiscussion] = useState<HuddleDiscussion>();
  const valid =
    connection.status === "ready" &&
    !!room &&
    (!channelContext ||
      (channelContext.scope === connection.scope &&
        channelContext.channelId === parsed?.parent));
  useEffect(() => {
    setOwner(undefined);
    setDiscussion(undefined);
    if (!valid || !room || !parent) return;
    const next = createHuddleDiscussion(connection.session, room, parent, () =>
      setDiscussion(next.snapshot()),
    );
    setOwner(next);
    setDiscussion(next.snapshot());
    return () => {
      next.dispose();
      clearAttachmentDraft(
        connection.session,
        `${connection.scope ?? ""}:draft:${room}`,
      );
    };
  }, [valid, room, parent, connection.session, connection.scope]);
  return valid && room && owner && discussion ? (
    <HuddleDiscussionView
      discussion={discussion}
      openLink={(url) => context?.open(url) || openLink?.(url) || false}
      composer={
        <MessageComposer
          evidenceOwner={hostComposerProvenance}
          session={connection.session}
          extensions={extensions}
          scope={connection.scope ?? ""}
          channelId={room}
          channelName="Huddle"
          forwardAudience="Everyone in this Huddle"
          label="Message this Huddle"
          placeholder="Message this Huddle"
          disabled={!discussion.writable}
        />
      }
      older={owner.older}
      retry={owner.retry}
      recover={owner.recover}
    />
  ) : (
    <p className="p-4 text-secondary">
      {valid
        ? "Loading conversation…"
        : "This Huddle conversation is unavailable."}
    </p>
  );
}
