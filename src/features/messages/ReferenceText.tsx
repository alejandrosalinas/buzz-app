import { useChannelIdentityNames } from "../identity-names/react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { AtIcon, RobotIcon } from "../../shared/design-system/icons/index";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import type { ChannelList, ChannelSummary, Profile } from "../relay/contracts";
import { messageReferences } from "./message-references";
import { MessageLink } from "../conversation/MessageLink";
import type { ConversationExtensions } from "../conversation/contracts";
import { parseBuzzLink } from "../navigation/buzz-links";
import type { AgentLibrary } from "../agents/library";
import styles from "../../shared/InlineReference.module.css";

const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A mention chip's contents. The icon stays with the first character, so a
 * chip at a line end never strands its icon; the rest wraps within the message. */
export function MentionLabel({
  agent,
  label,
}: {
  agent: boolean;
  label: string;
}) {
  const Icon = agent ? RobotIcon : AtIcon;
  const lead = graphemes.segment(label).containing(0)?.segment ?? "";
  return (
    <>
      <span className={styles.lead}>
        <Icon aria-hidden="true" className={styles.icon} />
        {lead}
      </span>
      {label.slice(lead.length)}
    </>
  );
}
/** The only channel fields a reference may read; the rest can be out of date. */
export type ReferenceChannel = Pick<
  ChannelSummary,
  "id" | "name" | "channelType" | "private" | "archived"
>;
const emptyChannels: readonly ReferenceChannel[] = [];
const emptyAgents: AgentLibrary["identities"] = [];
export const emptyReferenceDirectory = {
  profiles: emptyProfiles,
  /** The joined list. Raw `buzz://channel/<id>` links resolve through it
   * alone, so an unjoined channel takes its exact reference's name. */
  channels: emptyChannels,
  /** Channels `#name` prose may link: the joined list, then the open channels
   * a completed public directory read named. */
  named: emptyChannels,
  agents: emptyAgents,
};
const noop = () => () => {};
const profilesSnapshot = () => emptyProfiles;
const channelsSnapshot = () => emptyChannels;
const agentsSnapshot = () => undefined;
type ChannelLists = Pick<RelaySession["channels"], "list" | "openDirectory">;
const referenced = new WeakMap<
  ChannelLists,
  {
    list: ChannelList;
    open: readonly ReferenceChannel[];
    channels: readonly ReferenceChannel[];
    named: readonly ReferenceChannel[];
  }
>();
const sameReference = (a: ReferenceChannel, b: ReferenceChannel | undefined) =>
  a.id === b?.id &&
  a.name === b.name &&
  a.channelType === b.channelType &&
  a.private === b.private &&
  a.archived === b.archived;
const retained = (
  next: readonly ReferenceChannel[],
  prior: readonly ReferenceChannel[] | undefined,
) =>
  prior?.length === next.length &&
  next.every((channel, index) => sameReference(channel, prior[index]))
    ? prior
    : next;
/** Previews and activity replace the list and its summaries on every message.
 * Retain the prior channels while every field a reference reads is unchanged,
 * so mounted rows render only when a label could change.
 *
 * Open channels a completed directory read named follow the joined list in
 * `named`, so `#name` prose links a channel the viewer has not joined once
 * the directory is warm, without reading it to render. The joined list owns a
 * name both carry: the roster's channel links, the directory's duplicate does
 * not. Id links never see the directory (`channels`): its name can be older
 * than the exact reference a mounted link resolves. */
function referenceChannels(queries: ChannelLists) {
  const list = queries.list();
  const open = queries.openDirectory?.() ?? emptyChannels;
  const prior = referenced.get(queries);
  if (prior?.list === list && prior.open === open) return prior;
  const channels = retained(list.channels, prior?.channels);
  const joined = new Set(channels.map((channel) => channel.id));
  const taken = new Set(
    channels
      .filter((channel) => !channel.archived)
      .map((channel) => channel.name),
  );
  const named = open.length
    ? retained(
        [
          ...channels,
          ...open.filter(
            (channel) => !joined.has(channel.id) && !taken.has(channel.name),
          ),
        ],
        prior?.named,
      )
    : channels;
  const entry = { list, open, channels, named };
  referenced.set(queries, entry);
  return entry;
}

export function useReferenceDirectory(
  session: RelaySession | ComposerSession | undefined,
  selectedProfiles?: ReadonlyMap<string, Profile>,
) {
  const profiles = useSyncExternalStore(
    selectedProfiles ? noop : (session?.profiles?.subscribe ?? noop),
    selectedProfiles
      ? () => selectedProfiles
      : (session?.profiles?.snapshot ?? profilesSnapshot),
    profilesSnapshot,
  );
  const queries = session?.channels;
  // Two snapshots: each list stays identical while its labels are unchanged,
  // so a message that only replaces the joined list re-renders no row.
  const channels = useSyncExternalStore(
    queries?.subscribeList ?? noop,
    queries?.list
      ? () => referenceChannels(queries).channels
      : channelsSnapshot,
    channelsSnapshot,
  );
  const named = useSyncExternalStore(
    queries?.subscribeList ?? noop,
    queries?.list ? () => referenceChannels(queries).named : channelsSnapshot,
    channelsSnapshot,
  );
  const agents = useSyncExternalStore(
    session?.agentLibrary?.subscribe ?? noop,
    session?.agentLibrary?.snapshot ?? agentsSnapshot,
    agentsSnapshot,
  );
  const identities = agents?.identities ?? emptyAgents;
  // One object per snapshot set, so memoized consumers skip unchanged renders.
  return useMemo(
    () => ({ profiles, channels, named, agents: identities }),
    [profiles, channels, named, identities],
  );
}

/** Buzz links carry no community, so they always name a channel in the receiving one. */
export function channelForLink(
  url: string,
  channels: readonly ReferenceChannel[],
) {
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return target && channels.find((item) => item.id === target.channelId);
}

export function channelLinkLabel(
  url: string,
  channels: readonly ReferenceChannel[],
) {
  const channel = channelForLink(url, channels);
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return channel
    ? `${channel.channelType === "dm" || target?.messageId ? "" : "#"}${channel.name}`
    : undefined;
}

export function ReferenceText({
  text,
  mentions,
  directory,
  renderText,
  onOpenLink,
  extensions,
  session,
  scope,
  channelId,
  interactive = true,
}: {
  text: string;
  mentions: readonly string[];
  directory: ReturnType<typeof useReferenceDirectory>;
  renderText(text: string): ReactNode;
  onOpenLink(url: string): boolean;
  extensions?: ConversationExtensions | undefined;
  session?: RelaySession | ComposerSession | undefined;
  scope?: string | undefined;
  channelId?: string | undefined;
  interactive?: boolean;
}) {
  const resolveName = useChannelIdentityNames(session, channelId);
  const references = messageReferences(
    text,
    mentions,
    directory.profiles,
    directory.named,
    directory.agents,
  );
  if (!references.length) return renderText(text);
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const reference of references) {
    parts.push(
      <span key={`text:${offset}`}>
        {renderText(text.slice(offset, reference.start))}
      </span>,
    );
    const label =
      reference.kind === "channel"
        ? reference.label.slice(1)
        : resolveName(reference.id, reference.label.slice(1));
    parts.push(
      reference.kind === "channel" ? (
        <MessageLink
          key={reference.start}
          url={`buzz://channel/${encodeURIComponent(reference.id)}`}
          label={reference.label}
          registry={extensions?.links}
          onOpenLink={onOpenLink}
          session={session}
          scope={scope}
          interactive={interactive}
          channelPrivate={!!reference.private}
        />
      ) : (
        <span
          key={reference.start}
          className={styles.link}
          data-mention-kind={reference.kind}
          data-mention-self={reference.id === session?.viewer ? "" : undefined}
          title={`${reference.kind === "agent" ? "Agent" : "Person"}: ${label}\n${reference.id}`}
        >
          <MentionLabel agent={reference.kind === "agent"} label={label} />
        </span>
      ),
    );
    offset = reference.end;
  }
  parts.push(
    <span key={`text:${offset}`}>{renderText(text.slice(offset))}</span>,
  );
  return <>{parts}</>;
}
