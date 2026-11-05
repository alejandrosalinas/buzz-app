// What an agent type reads of an agent's community beyond the agent's own
// handle: the channel a turn is in, the conversation before it, the names of
// the people in it, and the agent's memory. The desktop app reads these
// through the owner's connection to the community; a standalone host reads
// them as the agent. Both give a type the same answers, so the type runs the
// same code in either.
import type { Memories } from "../../buzz-mcp/client";
import type { Profile } from "../relay/contracts";
import { validVerifiedName } from "../relay/verified-profile";
import type { AuthorNames } from "../agent-harness/turn-records";
import type { EventData, ReadFilter, RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { ownerCanvas } from "../agent-harness/project";
import type { ChannelLabel } from "../channels/channel-icon";
import { soloChat } from "./solo-chat";

/** The agent's memory entries, deleted entries' tombstones, and whether
 * some may be missing. */
export type MemoryListing = Memories;

/** What a turn needs to know of its channel. */
export type ChannelFacts = Readonly<{
  name?: string;
  dm: boolean;
  members: readonly string[];
  /** The owner's device is still creating it, so it has nothing to read yet. */
  starting?: true;
}>;

export type AgentReads = Readonly<{
  /** The connection these reads go through. A new one, even to the same
   * community, may read as someone else, so nothing read through an old one
   * carries over. */
  connection: object;
  /** The community these reads are of; it changes when the agent's does. */
  scope: string;
  /** The channel as the community lists it, or undefined when unknown. */
  channel(id: string): Promise<ChannelFacts | undefined>;
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly EventData[]>;
  /** Asks for these people's profiles, so `name` can name them. */
  profiles(pubkeys: readonly string[]): Promise<void>;
  /** A person's name, as the channel with these members shows it when
   * given; if known yet. */
  name(pubkey: string, members?: readonly string[]): string | undefined;
  /** A message author's names for a turn's prompt, once `profiles` read them:
   * their verified username, and their display name. Unlike `name`, neither
   * carries a namesake qualifier, so the Buzz tools can resolve them. */
  authorNames?(pubkey: string): AuthorNames | undefined;
  /** A person's signature-verified profile event, once `profiles` read it. */
  profile(pubkey: string): RelayEvent | undefined;
  /** The community's name and kind for a channel, if it lists the channel now. */
  channelLabel(id: string): ChannelLabel | undefined;
  /** Tells `listener` when the community's channel list changes, so
   * `channelLabel` may answer differently. */
  subscribeChannels(listener: () => void): () => void;
  /** The key the community signs workflow messages with, if known. */
  workflowAuthority(): string | undefined;
  /** The connected relay signing its channel metadata. */
  relayAuthor?(): string | undefined;
  /** The agent's memory, or only entry `slug` when given; `partial` when the
   * entries may be incomplete. `signal` stops the read. */
  memoryListing(signal: AbortSignal, slug?: string): Promise<MemoryListing>;
  /** The channel's current Canvas text when `owner`, or an agent they
   * attest, wrote it; undefined when it has none, someone else wrote it, or
   * the reader cannot read Canvas. */
  canvas?(channelId: string, owner: string): Promise<string | undefined>;
  /** Whether a mention in this channel continues `owner`'s Solo chat. Only the
   * owner's own connection can tell; other readers answer false. */
  soloChat(
    owner: string,
    channelId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}>;

/** The reads of the owner's connection to the agent's community, while it is
 * ready; undefined otherwise. Memory is encrypted to the owner, so the owner's
 * session reads it without the agent's key. */
export function ownerReads(
  relay: RelayData | undefined,
  pubkey: string,
): AgentReads | undefined {
  const snapshot = relay?.snapshot();
  if (snapshot?.status !== "ready") return undefined;
  const { session } = snapshot;
  return Object.freeze({
    connection: session,
    scope: snapshot.scope ?? "",
    channel: async (id: string) => {
      const summary =
        session.channels.list().channels.find((item) => item.id === id) ??
        session.channels.get?.(id);
      return summary
        ? {
            ...(summary.name ? { name: summary.name } : {}),
            dm: summary.channelType === "dm",
            members: summary.members ?? [],
            ...(summary.pending ? { starting: true as const } : {}),
          }
        : undefined;
    },
    read: (filters: readonly ReadFilter[], signal: AbortSignal) =>
      session.read(filters, { signal }),
    profiles: async (pubkeys: readonly string[]) => {
      await session.profiles.ensure(pubkeys, "foreground");
    },
    name: (person: string, members?: readonly string[]) =>
      session.names.resolve(person, undefined, members) ??
      session.profiles.snapshot().get(person)?.name ??
      undefined,
    authorNames: (person: string) =>
      profileNames(session.profiles.snapshot().get(person), person),
    profile: (person: string) => session.profiles.event?.(person),
    channelLabel: (id: string) => {
      const summary = session.channels
        .list()
        .channels.find((item) => item.id === id);
      return (
        summary && {
          name: summary.name,
          ...(summary.private ? { private: summary.private } : {}),
          ...(summary.channelType ? { channelType: summary.channelType } : {}),
        }
      );
    },
    subscribeChannels: (listener: () => void) =>
      session.channels.subscribeList(listener),
    workflowAuthority: () => session.workflowAuthority,
    relayAuthor: () => session.relayAuthor,
    soloChat: (owner: string, channelId: string, signal: AbortSignal) =>
      soloChat(() => relay, owner, channelId, signal),
    canvas: (channelId: string, owner: string) =>
      ownerCanvas(
        session.canvas,
        owner,
        channelId,
        session.channelWrites.startingCanvas(channelId),
      ),
    memoryListing: (signal: AbortSignal, slug?: string) =>
      session.agentMemories.read(pubkey, signal, slug),
  });
}

/** `pubkey`'s names for a turn's prompt. `username` only when verified: a
 * self-declared handle is no username. The display name is the verified one,
 * else their own profile's, and none when it is only a key fragment, or when
 * the directory had to qualify an unverified name because someone else holds
 * it too. A verified display name stays: its holder is tagged by username. */
export function profileNames(
  profile: Profile | undefined,
  pubkey: string,
): AuthorNames | undefined {
  if (!profile) return undefined;
  const username = profile.verified?.username;
  const own = profile.name.trim();
  const display_name =
    profile.verified?.displayName ??
    (!profile.nameIsFallback &&
    !own.endsWith(` (${pubkey.slice(0, 10)})`) &&
    validVerifiedName(own)
      ? own
      : undefined);
  if (!username && !display_name) return undefined;
  return {
    ...(username ? { username } : {}),
    ...(display_name ? { display_name } : {}),
  };
}
