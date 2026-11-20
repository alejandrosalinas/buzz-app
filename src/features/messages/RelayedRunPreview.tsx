import { useRef, type ReactNode } from "react";
import { MessageLink } from "../conversation/MessageLink";
import { messagePreviewText } from "../conversation/message-preview-text";
import type { ConversationExtensions } from "../conversation/contracts";
import { useChannelIdentityNames } from "../identity-names/react";
import type { Profile } from "../relay/contracts";
import { withoutRelayNotice } from "../relay/relayed-from";
import type { RelaySession } from "../relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { Badge } from "../../shared/design-system/ui/Badge";
import { formatFullTimestamp } from "../../shared/datetime";
import { useLocalDay } from "../../shared/use-local-day";
import { CaretRightIcon } from "../../shared/design-system/icons";
import type { RelayedRun } from "./activity-groups";
import { MessageTimestamp, useMessageTimeVisible } from "./MessageTimestamp";
import { useReferenceDirectory } from "./ReferenceText";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import styles from "./Messages.module.css";

/** One line for a run of relayed messages, in the shape of each relayed line:
 * the latest one, where they came from and how many more. Opening it lists
 * each relayed line below it. */
export function RelayedRunPreview({
  run,
  session,
  profiles,
  agentPubkeys,
  media,
  expanded,
  onToggle,
  renderHistory,
  extensions,
  scope,
  onOpenLink,
  layout = "timeline",
}: {
  run: RelayedRun;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  agentPubkeys?: ReadonlySet<string> | undefined;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  renderHistory: (row: RelayedRun["relayed"][number]) => ReactNode;
  extensions?: ConversationExtensions | undefined;
  scope?: string | undefined;
  onOpenLink: (url: string) => boolean;
  layout?: "timeline" | "thread";
}) {
  const container = useRef<HTMLDivElement>(null);
  const first = run.relayed[0];
  const last = run.relayed.at(-1);
  const resolveName = useChannelIdentityNames(session, first?.channelId);
  const directory = useReferenceDirectory(session);
  const showTime = useMessageTimeVisible(session?.channels, first?.channelId);
  // The button's name carries the full date, so it follows time zone changes.
  useLocalDay();
  useActivityFocusHandoff(container);
  if (!first || !last) return null;
  // The latest sender leads the stack, as it leads the line.
  const agents = [
    ...new Set(
      [...run.relayed].reverse().flatMap((row) => row.relayedFrom?.agent ?? []),
    ),
  ];
  const named = agents.map((id) => ({
    id,
    name: resolveName(id, profiles.get(id)?.name ?? id.slice(0, 10)),
    src: avatarMedia(profiles.get(id)?.picture, media),
    shape:
      agentPubkeys?.has(id) || profiles.get(id)?.isAgent
        ? ("squircle" as const)
        : ("circle" as const),
  }));
  const latest = named[0];
  const sources = new Set(run.relayed.map((row) => row.relayedFrom?.channelId));
  const sameSource = sources.size === 1;
  // Only the reader's own chats are named, as on each relayed line.
  const chat = sameSource
    ? directory.channels.find((item) => item.id === last.relayedFrom?.channelId)
    : undefined;
  const chatLabel =
    chat && `${chat.channelType === "dm" ? "" : "#"}${chat.name}`;
  const excerpt = Array.from(
    messagePreviewText(
      withoutRelayNotice(last.content, last.relayedFrom?.notice),
    ).replace(/\s+/g, " "),
  );
  const preview =
    excerpt.length > 280
      ? `${excerpt.slice(0, 279).join("")}…`
      : excerpt.join("");
  const more = run.relayed.length - 1;
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
    named.map((agent) => agent.name),
  );
  const from = chatLabel
    ? ` from ${chatLabel}`
    : sameSource
      ? ""
      : " from other chats";
  const label = `${expanded ? "Collapse" : "Show"} ${run.relayed.length} messages${from} by ${names}. Latest, ${latest?.name}: ${preview}, ${formatFullTimestamp(last.createdAt)}`;
  return (
    <div ref={container} className={styles.relayedRun} data-layout={layout}>
      <div
        className={styles.relayedHeader}
        data-open={expanded || undefined}
        // Closed, this line shows the latest message, so it lets a reader at
        // the bottom catch up; opened, that message's own row does.
        data-preview-message-id={expanded ? undefined : last.id}
        data-senders={Math.min(named.length, 3)}
      >
        <button
          type="button"
          data-buzz-ui=""
          className={styles.relayedTrigger}
          aria-expanded={expanded}
          aria-label={label}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onToggle();
          }}
        />
        <span className={styles.relayedAvatar} aria-hidden="true">
          <AvatarStack size="mini" items={named.slice(0, 3)} />
        </span>
        {/* Opened, each line below names its sender, so only the source stays. */}
        {!expanded && (
          <span className={styles.relayedName} aria-hidden="true">
            {latest?.name}
          </span>
        )}
        {(chat || !sameSource) && (
          <span
            className={styles.relayedSubtle}
            data-relayed-from={chat?.channelType === "dm" ? "dm" : ""}
            aria-hidden="true"
          >
            {expanded ? "From" : "from"}
          </span>
        )}
        {!chat && !sameSource && (
          <span className={styles.relayedSubtle} aria-hidden="true">
            {/* The space reads in the text; the span's line start drops it. */}
            {" other chats"}
          </span>
        )}
        {chat && (
          <span className={styles.relayedChat}>
            <MessageLink
              url={`buzz://channel/${encodeURIComponent(chat.id)}`}
              label={chatLabel}
              registry={extensions?.links}
              onOpenLink={onOpenLink}
              session={session}
              scope={scope}
              channelPrivate={!!chat.private}
            />
          </span>
        )}
        <span className={styles.relayedPreview} aria-hidden="true">
          {!expanded && preview}
        </span>
        {!expanded && (
          <span aria-hidden="true">
            <Badge>+{more}</Badge>
          </span>
        )}
        <span className={styles.relayedTime} aria-hidden="true">
          <MessageTimestamp createdAt={last.createdAt} visible={showTime} />
        </span>
        <CaretRightIcon className={styles.relayedCaret} aria-hidden="true" />
      </div>
      {expanded && (
        // One chat for all of them is named once, on this line.
        <div
          className={styles.relayedRunItems}
          data-same-source={(sameSource && !!chat) || undefined}
        >
          {run.relayed.map((row) => (
            <div key={row.id}>{renderHistory(row)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
