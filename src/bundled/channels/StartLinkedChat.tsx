import { ChatCircleIcon } from "../../shared/design-system/icons";
import { useState } from "react";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { messageCopyLink } from "../../features/messages/message-copy";
import {
  linkedDraftId,
  linkedDraftKey,
  type LinkedChat,
} from "../../features/solo/linked-chat";
import { writeView } from "../../shared/view-state";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { soloDraftTarget } from "../../features/channel-navigation/routes";

export function canStartLinkedChat(
  session: RelaySession,
  source: string | ChannelSummary,
) {
  const channel =
    typeof source === "string"
      ? session.channels.list().channels.find((item) => item.id === source)
      : source;
  return !!(
    session.viewer &&
    channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    ["stream", "forum"].includes(channel.channelType ?? "") &&
    channel.members?.includes(session.viewer) &&
    session.channelWrites.available
  );
}

/** Existing menu tree owns anchoring/dismissal. Nothing is published until first send. */
export function StartLinkedChat({
  session,
  navigation,
  channelId,
  message,
}: {
  session: RelaySession;
  navigation: Navigation;
  channelId: string;
  message?: ChannelMessage;
}) {
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  async function start() {
    if (busy || !canStartLinkedChat(session, channelId)) return;
    setBusy(true);
    // The digest is async. If another navigation wins meanwhile, this visit is
    // over: don't save its draft, open it, or report its errors.
    let owned = navigation.snapshot().attempt.id;
    const current = () => navigation.snapshot().attempt.id === owned;
    try {
      const link = message
        ? messageCopyLink(message, session.scope)
        : `buzz://channel/${encodeURIComponent(channelId)}`;
      if (!link || (message && message.channelId !== channelId))
        throw new Error("This source is unavailable. Reopen it and try again.");
      const source: LinkedChat = { channelId, link };
      const id = await linkedDraftId(source);
      if (!current()) {
        setBusy(false);
        return;
      }
      if (!writeView(session.scope, linkedDraftKey(id), source))
        throw new Error(
          "Your new chat draft couldn’t be saved. Nothing was created.",
        );
      const opening = navigation.open(
        soloDraftTarget(session.scope, { linked: id }),
      );
      owned = navigation.snapshot().attempt.id;
      const result = await opening;
      if (result.status === "failed")
        throw new Error("The Solo chat couldn’t open. Try again.");
    } catch (error) {
      if (current())
        notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }
  return (
    <MenuItem
      disabled={busy || !canStartLinkedChat(session, channelId)}
      onClick={() => void start()}
    >
      <MenuIcon>
        <ChatCircleIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Start Solo chat
    </MenuItem>
  );
}
