import type { ProtectionAction } from "../features/agent-protection/service";
// What the Buzz tools need from whoever holds the agent's key: the app's native
// custody in Buzz Desktop, or a key in the environment of a standalone server.
// The tools never see the key itself.
import type { GitAuth } from "../features/agents/native";
import type {
  AgentAttention,
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

/** Who an owner tool ran as: the calling agent, the human whose access it
 * used, and the agent's own community. The host supplies all three. */
export type OwnerExecution = Readonly<{
  agent: string;
  owner: string;
  community: string;
}>;
export type OwnerRole = "owner" | "admin" | "member" | "guest" | "bot";
/** One of the owner's channels, as their session lists it. */
export type OwnerChannel = Readonly<{
  id: string;
  name: string;
  type: "stream" | "forum" | "dm" | "solo" | "unknown";
  visibility: "open" | "private" | "unknown";
  archived: boolean;
  /** The owner's role from the relay-signed roster; `null` when they are not
   * a member, absent when unknown. */
  role?: OwnerRole | "unknown" | null;
  /** Membership restored from this device, not yet confirmed by the relay. */
  cached?: true;
  members?: number;
}>;
export type OwnerChannelList = Readonly<{
  execution: OwnerExecution;
  channels: readonly OwnerChannel[];
  /** The owner's channel list is still loading, failed, or hit its cap:
   * missing channels are not evidence that none exist. */
  partial: boolean;
  error?: string;
}>;
export type OwnerChannelDetails = Readonly<{
  execution: OwnerExecution;
  channel: OwnerChannel &
    Readonly<{
      description?: string;
      joinRole?: "member" | "guest";
      ttlSeconds?: number;
      creator?: string;
      createdAt?: number;
    }>;
  /** From the relay-signed admin list and roster, read for this call. The
   * relay still authorizes every command. */
  capabilities: Readonly<{
    manageRoles: boolean;
    removeMembers: boolean;
    archive: boolean;
    unarchive: boolean;
    delete: boolean;
  }>;
}>;
export type OwnerMemberPage = Readonly<{
  execution: OwnerExecution;
  channel: string;
  total: number;
  members: readonly Readonly<{
    pubkey: string;
    role: OwnerRole | "unknown";
    name?: string;
  }>[];
}>;
/** A message read: a thread (any of its messages' IDs) in its own channel, a
 * search (`search`, optionally in `channel`), or else `channel`'s latest.
 * `author` and `since` narrow a search or channel read; `before` and
 * `beforeId` are the relay's cursor. */
export type OwnerReadRequest = Readonly<{
  channel?: string;
  thread?: string;
  search?: string;
  author?: string;
  since?: number;
  before?: number;
  beforeId?: string;
  limit: number;
}>;
export type OwnerMessagePage = Readonly<{
  execution: OwnerExecution;
  /** The channel read: a thread's own, or the one a search was narrowed to. */
  channel?: string;
  root?: string;
  /** The messages, and the edits to them, in any order. A thread's root
   * comes on its first page only. */
  events: readonly BuzzEvent[];
  /** Authors' display names, where they have one. */
  names: Readonly<Record<string, string>>;
  /** Authors' owners, where the owner's Buzz has verified one; their edits
   * in the channel count as the author's. */
  owners?: Readonly<Record<string, string>>;
  /** Where the next older page starts, when older messages remain. */
  more?: Readonly<{ before: number; beforeId: string }>;
  /** A search filled its limit, so more matches may exist. */
  limited?: true;
  /** The edit lookup filled its limit, so some messages may show older text. */
  editsLimited?: true;
  /** The owner's channel list is incomplete, so a search may be missing
   * matches from channels not yet listed. */
  partial?: true;
}>;
export type OwnerCanvas = Readonly<{
  execution: OwnerExecution;
  channel: string;
  /** The current canvas, or the revision asked for; none when it has none. */
  canvas?: BuzzEvent;
}>;
export type OwnerCanvasHistory = Readonly<{
  execution: OwnerExecution;
  channel: string;
  /** A page of revisions, newest first. */
  revisions: readonly BuzzEvent[];
}>;
/** Read-only operations the app runs with its signed-in human's access, for
 * that human's own agent in that agent's community. Typed operations only:
 * no filters, signing or client of the owner's. */
export type OwnerAccess = Readonly<{
  channels(signal?: AbortSignal): Promise<OwnerChannelList>;
  channel(id: string, signal?: AbortSignal): Promise<OwnerChannelDetails>;
  members(
    id: string,
    page: Readonly<{ offset: number; limit: number }>,
    signal?: AbortSignal,
  ): Promise<OwnerMemberPage>;
  messages(
    request: OwnerReadRequest,
    signal?: AbortSignal,
  ): Promise<OwnerMessagePage>;
  /** The current canvas, or its revision `revision`. */
  canvas(
    channel: string,
    revision?: string,
    signal?: AbortSignal,
  ): Promise<OwnerCanvas>;
  canvasHistory(
    channel: string,
    cursor: Readonly<{ before?: number; beforeId?: string }>,
    signal?: AbortSignal,
  ): Promise<OwnerCanvasHistory>;
  /** Throws unless the binding that answered with `execution` still holds,
   * as checked just before its answer is released; reads nothing. */
  held(execution: OwnerExecution): void;
}>;

export interface BuzzClient {
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
  /** Reads with the owner's access, only in the owner's app-hosted run of
   * the agent by a bundled harness where the build enables it. Never given to
   * plugins, including installed harness plugins. */
  readonly ownerAccess?: OwnerAccess;
  /** Trusted connection authorities, never inferred from query results. */
  readonly relayAuthor?: string | undefined;
  readonly signingAuthority?: string | undefined;
  /** Reads the community as the agent. Every filter names its kinds. */
  query(filters: readonly Filter[]): Promise<readonly BuzzEvent[]>;
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
  channel?: string;
  root?: string;
  topLevel?: boolean;
  wholeChannel?: boolean;
}>;
