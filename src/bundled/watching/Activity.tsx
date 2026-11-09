import * as React from "react";
import type { Context } from "../../plugins/author";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  ChatCircleIcon,
  TerminalWindowIcon,
  CaretRightIcon,
  ClockIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { useReferenceDirectory } from "../../features/messages/ReferenceText";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { MessageRow } from "../../features/messages/MessageRow";
import {
  useProfileGeneration,
  useRowProfiles,
} from "../../features/relay/react";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { plainText } from "../../features/notifications/content";
import { rowProfileIds } from "../../features/relay/membership";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import type { RelaySession } from "../../features/relay/session";
import type {
  AttentionHistory,
  AttentionEntry,
} from "../../features/agents/store";
import {
  heading,
  recentMessages,
  channelIcon,
  type Channel,
} from "./presentation";
const noProfiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};

export function createAttentionActivity(navigation: Context["navigation"]) {
  const h = React.createElement;
  function Destination({
    channel,
    root,
    name,
    scope,
    summary,
    prefix = "Runs in",
    compact = false,
  }: {
    channel: string;
    root?: string | undefined;
    name: string;
    scope?: string | undefined;
    summary?: Channel | undefined;
    prefix?: string;
    compact?: boolean;
  }) {
    const text = (
      <span className="attention-destination-label">
        {prefix}
        {h(channelIcon(summary), { size: 16, "aria-hidden": true })}
        <span className="attention-channel-name">{`${name}${root ? " thread" : ""}`}</span>
      </span>
    );
    const at = scope?.lastIndexOf(":") ?? -1;
    if (!scope || at < 0)
      return (
        <span
          className="text-caption text-subtle"
          title={`Delivers to ${name}`}
        >
          {text}
        </span>
      );
    return (
      <Button
        variant={compact ? "outline" : "link"}
        size={compact ? "xs" : "inline"}
        type="button"
        title={`Delivers to ${name}`}
        aria-label={
          compact ? `Open reference ${name}` : `Open destination ${name}`
        }
        onClick={() =>
          void navigation.open({
            version: 1,
            kind: "conversation",
            scope: {
              communityOrigin: scope.slice(0, at),
              viewer: scope.slice(at + 1),
            },
            channelId: channel,
            ...(root ? { messageId: root, threadRootId: root } : {}),
          })
        }
      >
        {text}
      </Button>
    );
  }
  /** A recent event that was a message, shown as the conversation shows it. */
  function Message({
    entry,
    author,
    channel,
    session,
    scope,
  }: {
    entry: AttentionEntry;
    author: string;
    channel: string;
    session?: RelaySession | undefined;
    scope?: string | undefined;
  }) {
    const row = React.useMemo(
      () => ({
        id: entry.id ?? `${author}:${entry.at}`,
        channelId: channel,
        authorId: author,
        createdAt: entry.at,
        content: entry.text,
        mentions: entry.mentions ?? [],
        mentionReferences: entry.mentionReferences ?? [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }),
      [entry, author, channel],
    );
    const queries = session?.profiles ?? noProfiles;
    const profileGeneration = useProfileGeneration(queries);
    React.useEffect(() => {
      void profileGeneration;
      void queries.ensure(rowProfileIds(row), "background").catch(() => {});
    }, [queries, row, profileGeneration]);
    const profiles = useRowProfiles(queries, [row]);
    const resolve = useChannelIdentityNames(session, channel);
    const profile = profiles.get(author);
    const name = resolve(author, profile?.name ?? "");
    const at = scope?.lastIndexOf(":") ?? -1;
    return (
      <li>
        <MessageRow
          row={row}
          profile={name ? { ...profile, name } : profile}
          participantProfiles={profiles}
          references={session}
          scope={entry.id ? scope : undefined}
          media={session?.media ?? (() => undefined)}
          onOpenLink={(url) => {
            const target =
              scope &&
              at > 0 &&
              buzzLinkTarget(url, {
                communityOrigin: scope.slice(0, at),
                viewer: scope.slice(at + 1),
              });
            if (!target) return false;
            void navigation.open(target);
            return true;
          }}
          day={false}
          retry={undefined}
          layout="thread"
        />
      </li>
    );
  }
  /** One recent output, or an event that was not a message, with its time. */
  function Entry({
    entry,
    session,
    scope,
    command,
    showTime = true,
  }: {
    entry: AttentionEntry;
    session?: RelaySession | undefined;
    scope?: string | undefined;
    command: boolean;
    showTime?: boolean;
  }) {
    const directory = useReferenceDirectory(session);
    const { author, channel } = entry;
    if (author && channel && !command)
      return (
        <Message
          entry={entry}
          author={author}
          channel={channel}
          session={session}
          scope={scope}
        />
      );
    return (
      <li>
        {showTime && (
          <p className="text-caption text-subtle">
            {relativeTimestamp(entry.at)}
          </p>
        )}
        {command ? (
          <pre className="text-caption text-standard">{entry.text}</pre>
        ) : session ? (
          <div className="text-body-sm">
            <MessageMarkdown
              row={{
                id: `${entry.at}`,
                authorId: entry.author ?? "",
                createdAt: entry.at,
                channelId: entry.channel ?? "",
                content: entry.text,
                mentions: [],
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              directory={directory}
              session={session}
              media={session.media}
              onOpenLink={() => false}
              interactive={false}
            />
          </div>
        ) : (
          <p className="text-body-sm">{entry.text}</p>
        )}
      </li>
    );
  }
  function ActivityEntry({
    entry,
    session,
    scope,
    command,
  }: {
    entry: AttentionEntry;
    session?: RelaySession | undefined;
    scope?: string | undefined;
    command: boolean;
  }) {
    const [open, setOpen] = React.useState(false);
    // Command output is literal; anything else is Markdown, so its spoilers stay hidden.
    const summary =
      (command
        ? heading(entry.text.trim().split("\n")[0] ?? "").text
        : plainText(entry.text)) || "Recorded event";
    return (
      <li className="attention-timeline-event">
        <details open={open}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary handles keyboard activation; the click controls lazy mounting. */}
          <summary
            className="attention-activity-row"
            aria-label={`Open activity: ${summary}`}
            onClick={(event: React.MouseEvent) => {
              event.preventDefault();
              setOpen(!open);
            }}
          >
            {h(command ? TerminalWindowIcon : ChatCircleIcon, {
              size: 16,
              "aria-hidden": true,
            })}
            <span
              className={
                "attention-activity-summary text-body-sm text-secondary"
              }
            >
              {summary}
            </span>
            <span className="attention-activity-time text-caption text-subtle">
              {entry.at ? relativeTimestamp(entry.at) : ""}
            </span>
            <CaretRightIcon size={16} aria-hidden={true} />
          </summary>
          {open && (
            <ol
              className={
                "attention-list attention-recent attention-activity-preview"
              }
            >
              <Entry
                entry={entry}
                session={session}
                scope={scope}
                command={command}
                showTime={false}
              />
            </ol>
          )}
        </details>
      </li>
    );
  }
  function WatchActivity({
    history,
    label,
    session,
    scope,
    command,
    messages,
  }: {
    history: AttentionHistory | undefined;
    label: string;
    session?: RelaySession | undefined;
    scope?: string | undefined;
    command: boolean;
    messages: boolean;
  }) {
    return (
      <details className="attention-watch-activity">
        <summary
          className="attention-disclosure text-body-sm text-subtle"
          aria-label={`Show activity for ${label}`}
        >
          <span className="attention-disclosure-icon">
            <ClockIcon size={16} aria-hidden={true} />
          </span>
          {"Activity"}
          <span className="attention-detail-preview">
            {history?.events?.length
              ? `${history.events.length} event${history.events.length === 1 ? "" : "s"}`
              : history?.output
                ? "1 event"
                : "No activity yet"}
          </span>
          <CaretRightIcon size={16} aria-hidden={true} />
        </summary>
        <ol className="attention-timeline" aria-label={`Activity for ${label}`}>
          {(history?.events?.length
            ? [...history.events].reverse()
            : history?.output
              ? [
                  {
                    at: history.lastWokeAt ?? 0,
                    text: messages
                      ? recentMessages(
                          history.output.replace(
                            /^\d{4}-\d{2}-\d{2}T[^\n]+ · [^\n]+\n/,
                            "",
                          ),
                        )
                      : history.output,
                  },
                ]
              : []
          ).map((entry) => (
            <ActivityEntry
              key={
                entry.id ?? `${entry.at}:${entry.author ?? ""}:${entry.text}`
              }
              entry={entry}
              session={session}
              scope={scope}
              command={command}
            />
          ))}
          {!history?.events?.length && !history?.output && (
            <li>
              <p className="text-body-sm text-subtle">{"No activity yet"}</p>
            </li>
          )}
        </ol>
      </details>
    );
  }
  return { Destination, Message, Entry, WatchActivity };
}
