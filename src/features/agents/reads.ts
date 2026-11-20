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
import { type OwnerCanvas, ownerCanvas } from "../agent-harness/project";
import type { ChannelLabel } from "../channels/channel-icon";
import { soloChat } from "./solo-chat";
import { communityDestination } from "../communities/destination";
import { relayPartition } from "../relay/partition";

/** The agent's memory entries, deleted entries' tombstones, and whether
 * some may be missing. */
export type MemoryListing = Memories;

/** What a turn needs to know of its channel. */
export type ChannelFacts = Readonly<{
  name?: string;
  about?: string;
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
  canvas?(channelId: string, owner: string): Promise<OwnerCanvas | undefined>;
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
            ...(summary.description ? { about: summary.description } : {}),
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

/** Whether a mention says a workflow wrote it, rather than the owner. The
 * marker only decides whether a turn waits for its community; the permission
 * check still decides whether it runs. */
export function workflowMarked(event: RelayEvent, owner: string) {
  return (
    event.pubkey !== owner &&
    event.tags.some(
      ([name, value]) => name === "buzz:workflow" && value === "true",
    )
  );
}

/** `ownerReads` of the agent's own community and owner, once the community is
 * ready, has listed its channels and knows the kind of `channelId`, which a
 * turn needs to tell where to answer: now when it has, or after the reconnect
 * under way, through a new session in the same community and owner if that
 * replaces the old one. Rejects when the community ends up another one or another owner's, is
 * disconnected or fails in a way the service does not recover from by itself,
 * or when `signal` aborts first. It waits for the service's own notifications
 * and never reconnects. Its errors name what waits, `what`. */
export function readyOwnerReads(
  relay: RelayData | undefined,
  agent: Readonly<{ relay: string; owner: string; pubkey: string }>,
  signal: AbortSignal,
  channelId?: string,
  what = "Workflow request",
): Promise<AgentReads> {
  const unavailable = () =>
    new Error(`${what} could not start: its community is no longer connected.`);
  let origin: string;
  try {
    origin = communityDestination(agent.relay).url;
  } catch {
    return Promise.reject(unavailable());
  }
  const scope = relayPartition(origin, agent.owner);
  // The reads, `pending` while the community reconnects or lists its
  // channels, or undefined when it will not become ready here.
  const pending = Symbol();
  const settled = (): AgentReads | undefined | typeof pending => {
    const snapshot = relay?.snapshot();
    if (!relay || !snapshot) return undefined;
    if (snapshot.status === "ready" && !snapshot.cached) {
      if (
        snapshot.origin !== origin ||
        snapshot.viewer !== agent.owner ||
        snapshot.scope !== scope
      )
        return undefined;
      const { channels } = snapshot.session;
      const { status, channels: listed } = channels.list();
      if (status === "idle" || status === "loading") return pending;
      // A list restored from disk or still paging can lack the destination's
      // kind, and an unknown one would answer a DM in a thread.
      if (
        channelId &&
        !(
          listed.find((item) => item.id === channelId) ??
          channels.get?.(channelId)
        )?.channelType
      )
        return pending;
      return ownerReads(relay, agent.pubkey);
    }
    if (
      snapshot.status === "connecting" ||
      (snapshot.status === "ready" && snapshot.cached) ||
      (snapshot.status === "error" && snapshot.retrying && !snapshot.denied)
    )
      return pending;
    return undefined;
  };
  return new Promise((resolve, reject) => {
    let stop = () => {};
    let stopList = () => {};
    let listed: object | undefined;
    const finish = () => {
      stop();
      stopList();
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      finish();
      reject(
        new Error(
          `${what} could not start: its community did not reconnect before the delivery deadline.`,
          { cause: signal.reason },
        ),
      );
    };
    const check = () => {
      const reads = settled();
      if (reads !== pending) {
        finish();
        return reads ? resolve(reads) : reject(unavailable());
      }
      // Listen to the channel list of the session the community has now.
      const session = relay?.snapshot().session;
      if (session && session !== listed) {
        stopList();
        listed = session;
        stopList = session.channels.subscribeList(check);
      }
    };
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    // Subscribe before reading, so a change in between is not missed.
    stop = relay?.subscribe(check) ?? stop;
    check();
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
