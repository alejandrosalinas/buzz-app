// A remote agent's stored sessions, as local agent types show theirs: the
// conversation it was opened from, recent ones, and one session's transcript,
// read only when it opens.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import inlineStyles from "../../../shared/InlineReference.module.css";
import activityStyles from "../../../features/agents/ActivityLayout.module.css";
import {
  ConversationName,
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../../features/agents/OpenedConversation";
import type { AgentViewProps } from "../../../features/agents/service";
import { TranscriptPanel } from "../../../features/agents/TranscriptPanel";
import type { ChannelLabel } from "../../../features/channels/channel-icon";
import { PanelSubview } from "../../../features/panels/PanelSubview";
import { useClockFormat } from "../../../shared/clock-preference";
import { formatItemTimestamp } from "../../../shared/datetime";
import { Button } from "../../../shared/design-system/ui/Button";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import type { AgentClient, AgentSession } from "../agents/client";
import type { AgentActivity } from "./Activity";
import { CONVERSATION_LIMIT, readSession, type SessionList } from "./history";

export type ListedSessions = Promise<
  Extract<SessionList, { status: "loaded" }>
>;
type Row = AgentSession &
  Partial<ChannelLabel> &
  Readonly<{ key: string; root?: string; at: number }>;
type Place = Readonly<{ channelId: string; root?: string }>;

const label = ({ channelId, name, root }: Row) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const noTurns: ReturnType<AgentActivity["snapshot"]>["turns"] = [];
const quiet = () => () => {};

function useSettled<T>(promise: Promise<T>) {
  const [settled, setSettled] = useState<{
    promise: Promise<T>;
    value?: T;
    error?: string;
  }>();
  useEffect(() => {
    let live = true;
    promise.then(
      (value) => live && setSettled({ promise, value }),
      (error: unknown) =>
        live && setSettled({ promise, error: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [promise]);
  return settled?.promise === promise ? settled : undefined;
}

export function StoredActivity({
  agent,
  conversation,
  initialTranscript,
  close,
  openConversation,
  client,
  listed,
  activity,
  channelLabel,
  name,
}: {
  agent: AgentViewProps["agent"];
  conversation?: AgentViewProps["conversation"];
  initialTranscript?: AgentViewProps["initialTranscript"];
  close?: AgentViewProps["close"];
  openConversation?: AgentViewProps["openConversation"];
  client: AgentClient;
  /** The agent's sessions, read once when the tab opens. */
  listed: ListedSessions;
  activity: AgentActivity | undefined;
  channelLabel: (channelId: string) => ChannelLabel | undefined;
  name: (pubkey: string) => string | undefined;
}) {
  useClockFormat();
  const settled = useSettled(listed);
  const row = (session: AgentSession): Row => ({
    ...session,
    ...channelLabel(session.channelId),
    key: session.sessionId,
    ...(session.threadRootId ? { root: session.threadRootId } : {}),
    at: session.updatedAt,
  });
  const rows = settled?.value?.sessions.map(row) ?? [];
  // The opened conversation's session may be older than the listed page.
  // Builderlab answers with its thread's session, else its channel's.
  const find = async (place: Place, signal: AbortSignal) => {
    const { agentId, sessions: page } = await listed;
    const listedHere = page.find(
      (session) =>
        session.channelId === place.channelId &&
        session.threadRootId === place.root,
    );
    if (listedHere) return row(listedHere);
    if (!agentId) return undefined;
    const { sessions } = await client.sessions(agentId, signal, {
      community: agent.relay,
      channelId: place.channelId,
      threadRootId: place.root,
    });
    const [found] = sessions;
    return found && row(found);
  };
  const {
    session: here,
    searching,
    error: lookupError,
  } = useOpenedSession(rows, conversation, find, channelLabel);
  const turns = useSyncExternalStore(
    activity?.subscribe ?? quiet,
    () => activity?.snapshot().turns ?? noTurns,
  );
  // Live turns name their session; older frames only their conversation.
  const working = (session: Row) =>
    turns.some(
      (turn) =>
        turn.agent === agent.pubkey &&
        turn.state === "working" &&
        (turn.sessionId
          ? turn.sessionId === session.sessionId
          : turn.channelId === session.channelId &&
            (turn.threadRootId || undefined) === session.root),
    );
  const others = rows
    .filter((item) => item.key !== here?.key)
    .sort(
      (a, b) =>
        Number(b.channelId === conversation?.channelId) -
        Number(a.channelId === conversation?.channelId),
    );
  const recent = others.slice(0, CONVERSATION_LIMIT);
  const older =
    settled?.value?.more === true || others.length > CONVERSATION_LIMIT;
  const conversationLink = (item: Row) =>
    openConversation && (
      // An inline link wraps in a narrow pane at large text sizes.
      <p className="m-0 text-body-sm text-secondary">
        <BaseButton
          data-buzz-ui=""
          className={inlineStyles.link}
          onClick={() => openConversation(item.channelId, item.root)}
        >
          {item.root ? "Open this thread" : "Open this conversation"}
        </BaseButton>
      </p>
    );
  const { open, show, back } = useOpenTranscript(
    conversation,
    label,
    initialTranscript && { initial: here, searching, ...initialTranscript },
    close,
  );
  return (
    <div className={activityStyles.activity}>
      {conversation && (
        <OpenedConversation
          conversation={conversation}
          harness="Builderlab"
          session={here}
          searching={searching}
          error={lookupError}
          status={here && working(here) ? "Working" : undefined}
          onView={() => here && show(here)}
        />
      )}
      <section className={activityStyles.section}>
        <InlineHeader title="Recent conversations" />
        <SettingsGroup layout="form">
          {!settled ? (
            <p role="status" className="m-0 text-body-sm text-subtle">
              Loading conversations…
            </p>
          ) : settled.error !== undefined ? (
            <p role="alert" className="m-0 text-body-sm">
              Could not list conversations: {settled.error}
            </p>
          ) : recent.length ? (
            <ul className={activityStyles.list}>
              {recent.map((item) => (
                <li key={item.key} className={activityStyles.entry}>
                  <div className={activityStyles.row}>
                    <span className={activityStyles.copy}>
                      <ConversationName
                        session={item}
                        title={label(item)}
                        className="text-label-sm"
                      />
                      <span className="block text-body-sm text-subtle">
                        {[
                          item.root
                            ? `Thread ${item.root.slice(0, 8)}`
                            : "Channel",
                          working(item) && "Working",
                          formatItemTimestamp(item.at / 1000, {
                            withTime: true,
                          }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      aria-label={`View transcript: ${label(item)}`}
                      onClick={() => show(item)}
                    >
                      View transcript
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : older ? (
            <p className="m-0 text-body-sm text-subtle">
              No recent conversations found. Older ones aren't shown.
            </p>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              No other conversations stored yet.
            </p>
          )}
          {older && recent.length > 0 && (
            <p className="m-0 text-body-sm text-subtle">
              Older conversations aren't shown.
            </p>
          )}
        </SettingsGroup>
      </section>
      {open && (
        <PanelSubview
          title={label(open)}
          backLabel="Back to profile"
          onBack={back}
        >
          <TranscriptPanel
            key={open.key}
            agent={agent}
            read={(signal) => readSession(client, open, signal, name)}
            readKey={open.sessionId}
            working={working(open)}
            // Each read sends the whole session, so a running turn reads
            // again only when it ends.
            refreshWhileWorking={false}
            reading="Reading the stored session…"
            failed="Could not read the stored session"
            missing={
              <>
                {conversationLink(open)}
                <p className="m-0 text-body-sm text-subtle">
                  Builderlab has no stored transcript for this conversation. It
                  may have ended or been removed.
                </p>
              </>
            }
            notes={(transcript) => (
              <>
                {conversationLink(open)}
                {transcript.more && (
                  <p className="m-0 text-body-sm text-subtle">
                    Showing the latest {transcript.turns.length} turns.
                  </p>
                )}
              </>
            )}
          />
        </PanelSubview>
      )}
    </div>
  );
}
