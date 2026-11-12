import type { ProtectionAction } from "../features/agent-protection/service";
// What the Buzz tools need from whoever holds the agent's key: the app's native
// custody in Buzz Desktop, or a key in the environment of a standalone server.
// The tools never see the key itself.
import type { GitAuth } from "../features/agents/native";
import type {
  AgentAttention,
  SoloPlacement,
  AgentReadout,
  TeamReadout,
  TeamUpdateInput,
} from "../features/agents/service";
import type { AgentPlugins } from "../plugins/requests";
import type { SettingState } from "../shared/device-settings";

export type BuzzEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
}>;
export type Template = Readonly<{
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;
export type Filter = Readonly<Record<string, unknown>>;
/** The community's description of an uploaded blob. */
export type Upload = Readonly<{
  url: string;
  sha256: string;
  size: number;
  type: string;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}>;
/** A community media blob saved to a local file; `data` (base64) is the
 * image itself when the agent can be shown it. */
export type Media = Readonly<{
  path: string;
  type: string;
  size: number;
  data?: string;
}>;
/** One of the owner's channel templates, as a channel made from it starts:
 * its Canvas and the owner's agents it adds. */
export type ChannelTemplate = Readonly<{
  name: string;
  canvas: string;
  agents: readonly string[];
}>;
/** Memory entries, and whether some may be missing: a read cut short by a
 * limit, a deadline or the relay's rate limit. */
export type Memories = Readonly<{
  entries: readonly Memory[];
  /** Deleted entries' tombstones, which a write recreating one must follow. */
  deleted?: readonly Readonly<{ slug: string; createdAt: number }>[];
  partial: boolean;
}>;

/** The owner's tabs on this device for a channel's own threads, in that
 * channel's workspace. `shown` is a tab the viewer sees, which `close` leaves
 * open. */
export type ThreadTabs = Readonly<{
  list(channel: string): readonly Readonly<{
    root: string;
    pane: string;
    name?: string | undefined;
    shown: boolean;
  }>[];
  /** False when the thread already has a tab there. */
  open(channel: string, root: string): boolean;
  close(channel: string, root: string): "closed" | "missing" | "shown";
  /** An empty name restores the automatic title; false when it has no tab. */
  rename(channel: string, root: string, name: string): boolean;
}>;
export type Memory = Readonly<{
  slug: string;
  body: string;
  createdAt: number;
}>;

export interface BuzzClient {
  /** The host's cancellation signal for this call. Keep this signal across
   * waits; a later turn cannot restore a canceled call. Hosts without request
   * cancellation omit it. */
  readonly signal?: AbortSignal;
  protect?(action: ProtectionAction): Promise<void>;
  /** The runtime reviews each tool call itself before Buzz dispatches it. */
  readonly nativeToolGate?: true;
  readonly pubkey: string;
  /** The agent's membership key in this client's community: its pubkey in
   * its home community, which is the only one a standalone client has. */
  readonly key: string;
  /** Owner-reviewed creation requests, bound by the app to the caller's owner/community. */
  agentTypes?(): Promise<readonly Readonly<{ key: string; title: string }>[]>;
  createAgent?(
    input: Readonly<{
      type: string;
      name: string;
      instructions?: string;
      /** Uploads the picture once the request is valid: its URL. */
      picture?: () => Promise<string>;
    }>,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  updateAgent?(
    input: Readonly<{
      agent: string;
      name?: string;
      type?: string;
      instructions?: string;
      /** Uploads the picture once the request is valid: its URL. */
      picture?: () => Promise<string>;
    }>,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  readAgents?(agent?: string): Promise<AgentReadout | readonly AgentReadout[]>;
  readTeams?(team?: string): Promise<TeamReadout | readonly TeamReadout[]>;
  updateTeam?(
    input: TeamUpdateInput,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  /** This device's plugins, where the host has them: read directly, changed
   * by owner-confirmed request. */
  plugins?: AgentPlugins;
  /** Wakes the agent in another of its conversations here, `from` this one. */
  handoff?(
    handoff: Readonly<{
      channel: string;
      root?: string;
      text: string;
      from: Readonly<{ channel?: string; root?: string }>;
    }>,
  ): void;
  /** The agent's owner, as its host records it. */
  readonly owner?: string | undefined;
  /** Trusted connection authorities, never inferred from query results. */
  readonly relayAuthor?: string | undefined;
  readonly signingAuthority?: string | undefined;
  /** Reads the community as the agent. Every filter names its kinds. */
  query(filters: readonly Filter[]): Promise<readonly BuzzEvent[]>;
  /** Latest live attachment state, read as this agent from a primary snapshot. */
  effectiveEdit?(id: string, channel: string): Promise<BuzzEvent>;
  /** Finds profiles whose `name` or `display_name` matches `query`, best
   * match first. `undefined` when the community has no profile name search;
   * NIP-50 search, which matches the whole profile, is the fallback. */
  searchProfiles?(
    query: string,
    limit: number,
  ): Promise<readonly BuzzEvent[] | undefined>;
  /** Signs `event` as the agent and posts it. */
  publish(event: Template): Promise<BuzzEvent>;
  /** Uploads a file; `mime` is a hint, and the community decides the type. */
  upload(data: Uint8Array, mime: string): Promise<Upload>;
  /** Uploads an image for an avatar, without its metadata, as the owner's
   * own avatar upload prepares it. Only where the host can prepare images. */
  uploadPicture?(data: Uint8Array, mime: string): Promise<Upload>;
  /** Saves a community media blob of any type, by its URL or
   * `sha256[.ext]`, to a local file. */
  media(url: string): Promise<Media>;
  /** Repository `repo` of `owner` in the community: its URL, and the Git
   * header that authorizes it there as the agent for a minute. Only where
   * the host holds the key. */
  gitAuth?(owner: string, repo: string): Promise<GitAuth>;
  /** A local file's bytes, for tools that take a `path`. */
  read(path: string): Promise<Uint8Array>;
  /** The agent's memory entries, decrypted; only entry `slug` when given. */
  memories(slug?: string): Promise<Memories>;
  /** Writes entry `slug`, newer than the one it replaces (`after`, or 0);
   * a `null` body deletes it. */
  remember(slug: string, body: string | null, after: number): Promise<void>;
  /** Local run-only discovery and one-use placement of a newly published Solo. */
  soloWorkspaces?: Readonly<{
    list(): Promise<readonly Readonly<{ id: string; name: string }>[]>;
    prepare(
      workspace: string,
      members: readonly string[],
      channelId: string,
    ): Promise<(id: string) => Promise<SoloPlacement>>;
  }>;
  /** The owner's channel templates, where the host has them. */
  templates?(): Promise<readonly ChannelTemplate[]>;
  /** The agent's attention, where its host keeps one. Without it the
   * attention tools have nothing to act on. */
  readonly attention?: AgentAttention;
  /** The owner's thread tabs, where the host shows them. */
  tabs?: ThreadTabs;
  /** Buzz settings on this device, in an agent's own run. Each call checks
   * the turn first, as the other tools do. */
  settings?: Readonly<{
    list(): readonly SettingState[];
    get(key: unknown): SettingState;
    set(key: unknown, value: unknown): SettingState;
  }>;
}

/** Where the agent is working, so tools can default to it. `topLevel` keeps
 * this channel's messages out of threads. With no `root`, or with
 * `wholeChannel`, its session is the whole channel. */
export type Context = Readonly<{
  session?: import("../features/agents/session-admission").AgentSessionAssociation;
  channel?: string;
  root?: string;
  topLevel?: boolean;
  wholeChannel?: boolean;
}>;
