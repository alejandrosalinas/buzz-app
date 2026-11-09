import { useChannelIdentityNames } from "../identity-names/react";
import type { MessageLinkOrigin } from "./MessageRow";
import { ActivityGroupActions } from "./ActivityGroupActions";
import { useActivityTypingReplacement } from "../conversation/typing-presentation";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import { useRef, type ReactNode } from "react";
import { ActivityDisclosure } from "./ActivityDisclosure";
import {
  ActivityOutcome,
  activityOutcomeLabel,
  activityOutcomeReason,
} from "./ActivityOutcome";
import { AgentResponsePreview } from "./AgentResponsePreview";
import { RemoteAgentHint, RemoteWorkIcon } from "./RemoteAgentHint";
import { useActivityIndicator } from "./use-activity-indicator";
import type { RelaySession } from "../relay/session";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import type { ActivityPresentation } from "./activity-presentation";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { avatarMedia } from "../../shared/avatar-source";
import { messagePreviewText } from "../conversation/message-preview-text";

/** One stable disclosure for a run of activity, showing its latest speaker. */
export function ActivityGroupPreview({
  group,
  session,
  profiles,
  media,
  expanded,
  onToggle,
  layout = "timeline",
  renderHistory,
  openActivity,
  canOpenActivity,
}: {
  openActivity?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
  canOpenActivity?: ((target: string) => boolean) | undefined;
  group: ActivityPresentation;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  layout?: "timeline" | "thread";
  renderHistory?: (row: ChannelMessage) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const resolveName = useChannelIdentityNames(session, group.latest.channelId);
  useActivityFocusHandoff(container);
  const {
    latest: row,
    history,
    participants,
    retired,
    working,
    outcomes,
  } = group;
  const live = useActivityIndicator(
    session,
    row,
    !retired && (working || !group.followingMessage),
    group.liveParticipants,
    group.requestId,
  );
  useActivityTypingReplacement(
    session
      ? {
          session,
          channelId: row.channelId,
          threadRootId: row.threadRootId,
          pubkey: row.authorId,
          requestId: group.requestId,
        }
      : undefined,
    !!group.requestId,
    group.presentedParticipants,
  );
  const primary = history[0]?.authorId ?? row.authorId;
  const profile = profiles.get(primary);
  const named = (id: string) =>
    resolveName(id, profiles.get(id)?.name ?? id.slice(0, 10));
  const name = named(primary);
  const previewRow = group.workingUpdate ?? row;
  const speaker = named(previewRow.authorId);
  const text = Array.from(
    messagePreviewText(previewRow.content).replace(/\s+/g, " "),
  );
  const preview =
    text.length > 280 ? `${text.slice(0, 279).join("")}…` : text.join("");
  const outcomeText = outcomes
    .map(
      (entry) => `${named(entry.agent)}: ${activityOutcomeLabel(entry.state)}`,
    )
    .join("; ");
  const namedPreview = `${speaker}: ${preview}`;
  const summaryLabel = [
    outcomeText,
    working
      ? `${speaker}: still working — ${preview}`
      : !outcomeText && namedPreview,
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <AgentResponsePreview
      name={name}
      bylineHint={
        <RemoteAgentHint
          session={session}
          viewer={session?.viewer}
          pubkey={primary}
        />
      }
      participants={participants.map((id) => ({
        id,
        name: named(id),
        picture: avatarMedia(profiles.get(id)?.picture, media),
      }))}
      stackPrevious={!group.standalone}
      picture={avatarMedia(profile?.picture, media)}
      layout={layout}
    >
      <ActivityDisclosure
        container={container}
        trigger={disclosure}
        expanded={expanded}
        onToggle={onToggle}
        label={`${expanded ? "Collapse" : "Show"} activity history: ${summaryLabel}`}
        icon={
          <RemoteWorkIcon
            session={session}
            viewer={session?.viewer}
            pubkey={row.authorId}
            active={working || live}
          />
        }
        summary={
          outcomes.length ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {outcomes.map((entry) => (
                <ActivityOutcome
                  key={entry.agent}
                  state={entry.state}
                  name={
                    participants.length > 1 ? named(entry.agent) : undefined
                  }
                />
              ))}
              {working && <ShimmerText active>{namedPreview}</ShimmerText>}
            </span>
          ) : (
            <ShimmerText active={working || live}>
              {participants.length > 1 ? namedPreview : preview}
            </ShimmerText>
          )
        }
        expandedSummary={outcomes.map((entry) => (
          <ActivityOutcome
            key={entry.agent}
            state={entry.state}
            name={participants.length > 1 ? named(entry.agent) : undefined}
          />
        ))}
        actions={
          session && (
            <ActivityGroupActions
              session={session}
              group={group}
              returnFocus={disclosure}
              active={expanded}
              profiles={profiles}
              open={openActivity}
              canOpen={canOpenActivity}
            />
          )
        }
      >
        {outcomes
          .filter(
            (entry) =>
              !history.some(
                (row) =>
                  row.authorId === entry.agent &&
                  row.notice === "execution-failure" &&
                  !row.edited &&
                  !row.attachments.length,
              ),
          )
          .map((entry) => (
            <p key={entry.agent} className="text-body-sm">
              {participants.length > 1 && `${named(entry.agent)}: `}
              {activityOutcomeReason(entry.state, entry.reason)}
            </p>
          ))}
        {renderHistory &&
          history.map((entry) => (
            <div key={entry.id}>{renderHistory(entry)}</div>
          ))}
      </ActivityDisclosure>
    </AgentResponsePreview>
  );
}
