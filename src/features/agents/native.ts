import type {
  ProtectionBinding,
  ProtectionDefaults,
} from "../agent-protection/service";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { eventsDto, type RelayEvent } from "../relay/events";
import { effectiveEditDto, effectiveEditFilter } from "../relay/effective-edit";
import { importedEmojiPicture } from "./import-picture";

/** A plugin agent's identity in one community as native custody reports it;
 * never the key. The saved identities are the agent list: one for each
 * community the agent is in, sharing its key, name and type. */
export type AgentIdentity = Readonly<{
  pubkey: string;
  /** The canonical `wss://` community origin of this membership. */
  relay: string;
  owner: string;
  /** The agent type's key, `pluginId/typeId`, fixed at create. */
  type: string;
  name: string;
  /** Its profile picture in this community, an HTTPS image URL. */
  picture?: string;
  /** It left this community, or was deleted: this community still has to
   * drop it from its channels and archive it, after which `forget` removes
   * it. */
  deleted: boolean;
  /** The required installed protection plugin and saved policy. */
  protection?: ProtectionBinding;
  /** Monotonic native generation shared by every membership of this identity. */
  protectionRevision?: number;
  /** Its Delete, or its leaving this community, started and has not
   * finished. It stays stopped here until that is pressed again. */
  deleting?: true;
  /** The `wss://` origin of its home community, the first it was in, on a
   * membership added to another; absent, this community is its home. */
  home?: string;
  /** Its Add here was saved but its key not yet: nothing runs or counts it. */
  joining?: true;
}>;
/** An agent in one community: what calls made there as the agent name. */
export type Membership = Readonly<{ pubkey: string; relay: string }>;
/** Where an earlier agent system saved an identity on this machine: this app's
 * harness agents, or the installed or development build of old Buzz. */
export type PortSource = "harness" | "installed" | "development";
/** An identity an earlier agent system saved, which Agents can take over. */
export type SavedConnection = Readonly<{
  runtime: string;
  provider?: string;
  model?: string;
  effort?: string;
}>;
export type PortableAgent = Readonly<{
  source: PortSource;
  connection?: SavedConnection;
  pubkey: string;
  name: string;
  picture?: string;
  /** The community it was saved for there, if valid. */
  relay: string;
}>;
/** An old Buzz team as old Buzz last saved it, keyed by its old ID. */
export type OldTeam = Readonly<{
  id: string;
  name: string;
  /** Its shared instructions, "" for none. */
  instructions: string;
  /** Each identity on it, named and sourced as the agent list has it, whether
   * or not it is here already. */
  members: readonly Readonly<{
    pubkey: string;
    name: string;
    source: PortSource;
  }>[];
}>;
/** What an agent kept in an earlier system that its new type may adopt. */
export type Carry = Readonly<{
  instructions?: string;
  /** Its working directory, absolute or `~/…`. */
  workspace?: string;
}>;
export type PortableAgents = Readonly<{
  agents: readonly PortableAgent[];
  /** Old Buzz's teams with a member, built-in ones left out. */
  teams: readonly OldTeam[];
  /** A store that could not be read; the others are still listed. */
  warnings: readonly string[];
}>;
const UNCONFIRMED_EVENT =
  /^Agent event ([0-9a-f]{64}) unconfirmed; it may or may not have been accepted$/;
export function unconfirmedAgentEvent(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return UNCONFIRMED_EVENT.exec(message)?.[1];
}

export type AgentEventTemplate = Readonly<{
  kind: number;
  content: string;
  tags?: readonly (readonly string[])[];
}>;
/** The community's description of an uploaded blob. */
export type AgentUpload = Readonly<{
  url: string;
  sha256: string;
  size: number;
  type: string;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}>;
/** A community media blob saved to a local file for the agent; `data`
 * (base64) is the image itself when the agent can be shown it. */
export type AgentMedia = Readonly<{
  path: string;
  type: string;
  size: number;
  data?: string;
}>;
/** A repository's URL and the `Authorization` header Git sends there. */
export type GitAuth = Readonly<{ url: string; header: string }>;
export type AgentsNative = {
  list(): Promise<readonly AgentIdentity[]>;
  /** Generates a key, has the signed-in owner attest it, and saves both. */
  create(
    destination: string,
    owner: string,
    type: string,
    name: string,
  ): Promise<AgentIdentity>;
  /** Earlier agent systems' identities on this machine. */
  portable(): Promise<PortableAgents>;
  /** Takes one over with its key, name and picture, as `create` does, with
   * what it kept there for its new type. */
  port(
    source: PortSource,
    pubkey: string,
    destination: string,
    owner: string,
    type: string,
  ): Promise<
    Readonly<{ agent: AgentIdentity; carry: Carry; notes?: readonly string[] }>
  >;
  /** Renames it in every community it is in. */
  rename(pubkey: string, name: string): Promise<void>;
  protectionDefaults?(owner: string): Promise<ProtectionDefaults>;
  setProtectionDefaults?(
    owner: string,
    revision: number,
    provider: string,
    policy: unknown | null,
  ): Promise<void>;
  setProtection?(
    pubkey: string,
    revision: number,
    provider: string,
    policy: unknown | null,
  ): Promise<void>;
  /** Sets its profile picture in one community, an HTTPS image URL, or with
   * `null` clears it. */
  setPicture(member: Membership, picture: string | null): Promise<void>;
  /** Makes it an agent of another type, keeping its identity and profile. */
  setType(pubkey: string, type: string): Promise<void>;
  /** Adds it to `destination`, another community, with the key it has in
   * `from`, and `picture` there. */
  join(
    pubkey: string,
    from: string,
    destination: string,
    picture: string | undefined,
  ): Promise<AgentIdentity>;
  /** Marks its leaving one community as started, when it is in another;
   * only `remove` finishing it clears that. */
  beginLeave(member: Membership): Promise<void>;
  /** Marks its Delete as started in every community. */
  beginDelete(pubkey: string): Promise<void>;
  /** Takes its removal from one community, whose Delete or leaving started,
   * for this copy of the app, until `releaseRemoval`: no other copy's cleanup
   * there runs meanwhile, nor starts once its row there goes. Refused while
   * another copy holds it. */
  holdRemoval(member: Membership): Promise<void>;
  releaseRemoval(member: Membership): Promise<void>;
  /** Marks it deleted in one community, under `holdRemoval`; the key goes
   * with its last one. */
  remove(member: Membership): Promise<void>;
  /** Drops it from a community it is deleted in. */
  forget(member: Membership): Promise<void>;
  /** Signs one event as the agent (deletions, reactions, messages, edits,
   * canvases and DM opens only) with its owner attestation and posts it to the
   * membership's community. */
  publish(member: Membership, event: AgentEventTemplate): Promise<RelayEvent>;
  /** Reads the membership's community as the agent: one to eight filters. */
  query(member: Membership, filters: readonly object[]): Promise<RelayEvent[]>;
  effectiveEdit(
    member: Membership,
    id: string,
    channel: string,
  ): Promise<RelayEvent>;
  /** Finds profiles by `name` or `display_name` in the agent's community, as
   * the agent, best match first. `undefined` when the community has no
   * profile name search. */
  searchProfiles(
    member: Membership,
    query: string,
    limit: number,
  ): Promise<RelayEvent[] | undefined>;
  /** Uploads base64 `data`, a file of any type its community accepts, as
   * the agent. `mime` is a hint; the community decides the type. */
  upload(member: Membership, data: string, mime: string): Promise<AgentUpload>;
  /** Saves one of its community's media blobs, of any type, as the agent. */
  media(member: Membership, url: string): Promise<AgentMedia>;
  /** A repository's URL in the agent's community and the Git header that
   * authorizes it there as the agent for a minute. */
  gitAuth(member: Membership, owner: string, repo: string): Promise<GitAuth>;
  /** Writes memory entry `slug`, encrypted to the owner, newer than `after`;
   * a `null` body deletes it. */
  remember(
    member: Membership,
    slug: string,
    body: string | null,
    after: number,
  ): Promise<RelayEvent>;
  /** Publishes its name and picture as its profile in one community unless
   * that community already has it. */
  publishProfile(member: Membership): Promise<void>;
  /** Whether this app runs the agent: every copy of the app on this machine
   * shares the agent list, and one runs each agent. The installed app always
   * runs what it can; a dev build lets go while it does. */
  claim(pubkey: string, revision?: number): Promise<boolean>;
  /** Lets another copy run it. */
  release(pubkey: string): Promise<void>;
  /** Keeps this Mac from idle sleep, or lets it sleep again. */
  keepAwake(hold: boolean): Promise<void>;
};

export const nativeAgents = (): AgentsNative | undefined =>
  isTauri()
    ? {
        list: () => invoke("app_agent_list"),
        create: (destination, owner, agentType, name) =>
          invoke("app_agent_create", { destination, owner, agentType, name }),
        portable: () => invoke("app_agent_portable"),
        port: async (source, pubkey, destination, owner, agentType) => {
          // Preparation is optional; native reports a skipped picture if it fails.
          let convertedPicture: Awaited<
            ReturnType<typeof importedEmojiPicture>
          >;
          try {
            const found = await invoke<PortableAgents>("app_agent_portable");
            const picture = found.agents.find(
              (agent) => agent.source === source && agent.pubkey === pubkey,
            )?.picture;
            convertedPicture = await importedEmojiPicture(picture);
          } catch {
            // A picture failure must not prevent taking over the identity.
          }
          return invoke("app_agent_port", {
            source,
            pubkey,
            destination,
            owner,
            agentType,
            convertedPicture,
          });
        },
        protectionDefaults: (owner) =>
          invoke("app_agent_protection_defaults", { owner }),
        setProtectionDefaults: (owner, revision, provider, policy) =>
          invoke("app_agent_set_protection_defaults", {
            owner,
            revision,
            provider,
            policy,
          }),
        setProtection: (pubkey, revision, provider, policy) =>
          invoke("app_agent_set_protection", {
            pubkey,
            revision,
            provider,
            policy,
          }),
        rename: (pubkey, name) => invoke("app_agent_rename", { pubkey, name }),
        setPicture: ({ pubkey, relay }, picture) =>
          invoke("app_agent_set_picture", { pubkey, relay, picture }),
        setType: (pubkey, agentType) =>
          invoke("app_agent_set_type", { pubkey, agentType }),
        join: (pubkey, from, destination, picture) =>
          invoke("app_agent_join", {
            pubkey,
            from,
            destination,
            picture: picture ?? null,
          }),
        beginLeave: ({ pubkey, relay }) =>
          invoke("app_agent_begin_leave", { pubkey, relay }),
        beginDelete: (pubkey) => invoke("app_agent_begin_delete", { pubkey }),
        holdRemoval: ({ pubkey, relay }) =>
          invoke("app_agent_hold_removal", { pubkey, relay }),
        releaseRemoval: ({ pubkey, relay }) =>
          invoke("app_agent_release_removal", { pubkey, relay }),
        remove: ({ pubkey, relay }) =>
          invoke("app_agent_delete", { pubkey, relay }),
        forget: ({ pubkey, relay }) =>
          invoke("app_agent_forget", { pubkey, relay }),
        publish: ({ pubkey, relay }, event) =>
          invoke("app_agent_publish", {
            pubkey,
            relay,
            event: {
              kind: event.kind,
              content: event.content,
              tags: event.tags ?? [],
            },
          }),
        query: async ({ pubkey, relay }, filters) =>
          eventsDto(
            await invoke("app_agent_query", { pubkey, relay, filters }),
          ),
        effectiveEdit: async ({ pubkey, relay }, id, channel) =>
          effectiveEditDto(
            await invoke("app_agent_query", {
              pubkey,
              relay,
              filters: effectiveEditFilter(id, channel),
            }),
            id,
            channel,
          ),
        searchProfiles: async ({ pubkey, relay }, query, limit) => {
          const found = await invoke("app_agent_search_profiles", {
            pubkey,
            relay,
            query,
            limit,
          });
          return found == null ? undefined : eventsDto(found);
        },
        upload: ({ pubkey, relay }, data, mime) =>
          invoke("app_agent_upload", { pubkey, relay, data, mime }),
        media: ({ pubkey, relay }, url) =>
          invoke("app_agent_media", { pubkey, relay, url }),
        gitAuth: ({ pubkey, relay }, owner, repo) =>
          invoke("app_agent_git_auth", { pubkey, relay, owner, repo }),
        remember: ({ pubkey, relay }, slug, body, after) =>
          invoke("app_agent_remember", { pubkey, relay, slug, body, after }),
        publishProfile: ({ pubkey, relay }) =>
          invoke("app_agent_publish_profile", { pubkey, relay }),
        claim: (pubkey, revision) =>
          invoke("app_agent_claim", { pubkey, revision: revision ?? 0 }),
        release: (pubkey) => invoke("app_agent_release", { pubkey }),
        keepAwake: (hold) => invoke("keep_awake_set", { hold }),
      }
    : undefined;
