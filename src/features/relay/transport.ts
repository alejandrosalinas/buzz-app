import type { ArtifactIncrementalReader } from "./artifact-incremental-reader.ts";
import {
  networkContext,
  networkCancellation,
} from "../developer/network-context";
import type { VerifiedProfileAuthority } from "./verified-profile";
import type { ReminderHost } from "./reminders";
import {
  memoryResponseText,
  type MemoryReader,
  type MemoryListing,
} from "../agents/memory";
import { publicationRefusal } from "../developer/traffic";
import { avatarSource } from "../../shared/avatar-source";
import { brokerUpload, hostUpload, type AttachmentUpload } from "./attachments";
import type { ChannelKitHost } from "../channel-templates/host";
import type { PrivateRecord } from "../channel-templates/model";
import { workflowHost } from "../workflows/http";
import {
  communityGitRepository,
  repoGitHost,
  type RepoGit,
} from "../repos/git";
import type { WorkflowHost } from "../workflows/host";
import { readReceiptText } from "./receipt";
import {
  ReadStateTimestampRejected,
  readStateRefusal,
  READ_STATE_TIMESTAMP_REFUSAL,
  type ReadStateHost,
  type ReadStateSigning,
} from "./read-state-host";
import {
  parseReadSnapshot,
  readSnapshotFilter,
  readSnapshotText,
} from "./read-state-snapshot";
import type { AgentLibraryReader } from "../agents/library";
import {
  projectSidebarPreferences,
  type SidebarAssignmentMutator,
  type SidebarSectionOrderMutator,
  type SidebarSectionRenameMutator,
  type SidebarSectionRemovalMutator,
  type SidebarStarMutator,
  type SidebarSortMutator,
  type SidebarFilterMutator,
  type SidebarDecoder,
  type SidebarMuteMutator,
  type SidebarPreferences,
} from "./sidebar-preferences";
import { createHostAdmission } from "./host-admission";
import { relayOrigin } from "../communities/destination";
import {
  admittedApiRequest,
  ApiPaused,
  ApiNotSent,
  readApiFailure,
  presenceFilter,
  presenceText,
  type CommunityRefusal,
  BROKER_REFUSAL_HEADER,
} from "./http-admission";
import { yieldToHost } from "./yield";
import { clientMetrics } from "../developer/client-metrics";
import { networkRecorder } from "../developer/network-diagnostics";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import {
  subscribeRelayTraffic,
  type LiveCallbacks,
  type LiveSocket,
  type LiveSubscription,
} from "./live";
import { subscribeBrokerTraffic } from "./broker-live";
import { PublishNotSent, PublishRejected } from "./outbox";
import { httpReadError, ReadError } from "./errors";
import { ARTIFACT_KIND } from "../agents/agent-config-artifacts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  createEventVerifier,
  eventDto,
  type EventVerifier,
  type ReadFilter,
  type RelayEvent,
  type SignatureVerifier,
} from "./events";

/** Relay connection. Implementations verify signatures; callers never see raw JSON. */
export interface RelayWriter {
  readonly kinds?: readonly number[];
  /** True only when the host proves that publication did not deliver the event. */
  isNotSent?(error: unknown): boolean;
  sign(event: EventTemplate, signal: AbortSignal): Promise<RelayEvent>;
  /** Accepted receipt text is ephemeral; callers must never journal it. */
  publish(
    event: RelayEvent,
    signal: AbortSignal,
  ): Promise<string> | Promise<void>;
}
export interface ReadTransport {
  /** Hear the relay refuse this account for the whole community, on any
   * request after connecting: its sign-in ended, or it has no access. One
   * item's refusal (a gated channel, say) stays with whoever asked for it. */
  readonly observeRefusal?: (
    listener: (kind: CommunityRefusal) => void,
  ) => () => void;
  readonly artifactIncremental?: ArtifactIncrementalReader;
  readonly projectGit?: RepoGit;
  readonly readAgentMemories?: MemoryReader;
  /** Session-scoped owner proof, not an arbitrary signing capability. */
  readonly authorizeAgentLog?: (
    target: { id: string; pubkey: string; relayUrl: string },
    nonce: string,
  ) => Promise<string>;
  /** One-repository Git authorization for this community's Buzz git; null for any other URL.
   * The token is the NIP-98 value after `Authorization: Nostr `. */
  readonly authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
  readonly uploadAttachment?: AttachmentUpload;
  /** Host-owned idempotent DM opening. The session verifies membership before use. */
  readonly openDirectMessage?: (
    pubkeys: readonly string[],
    signal: AbortSignal,
  ) => Promise<string>;
  readonly workflows?: WorkflowHost;
  /** Narrow lifecycle signer/publisher; never supplied to the message outbox. */
  readonly channelLifecycle?: RelayWriter;
  /** Name/about/private-only metadata writer, separate from lifecycle and outbox. */
  readonly channelDetails?: RelayWriter;
  readonly memberAdministration?: RelayWriter;
  /** NIP-AR kind-45010 config artifacts only; never supplied to the outbox. */
  readonly configArtifacts?: RelayWriter;
  /** Narrow NIP-IA 9035/9036 signer/publisher; never supplied to the message outbox. */
  readonly identityArchive?: RelayWriter;
  /** Purpose-bound observer decoding on the shared host live stream. */
  readonly agentActivity?: boolean;
  /** Explicit relay-advertised session command support. */
  /** Host-projected local library; display only, never relay authority. */
  readonly readAgentLibrary?: AgentLibraryReader;
  /** Host-only decoder of the viewer's signed sidebar preference coordinates. */
  readonly decodeSidebarPreferences?: SidebarDecoder;
  readonly writeSidebarSort?: SidebarSortMutator;
  readonly writeSidebarFilter?: SidebarFilterMutator;
  readonly readState?: ReadStateHost;
  /** Purpose-bound NIP-ER codec; never a general NIP-44 or signing primitive. */
  readonly reminders?: ReminderHost;
  readonly channelKit?: ChannelKitHost;
  /** The relay advertises NIP-CL (`nip-cl` in NIP-11 `supported_extensions`):
   * it keeps channel labels and answers label lookups. */
  readonly channelIdentity?: true;
  /** The relay advertises `buzz-search-sort`: bridge search accepts
   * `search_sort: "newest"`. Older relays silently rank by relevance. */
  readonly searchSort?: true;
  /** The relay advertises NIP-AR sync (`artifacts.sync.version` 1 in NIP-11):
   * a REQ with `"artifact": "current"` streams a complete set, then live heads. */
  readonly artifactSync?: true;
  /** Strictly validated atomic writer snapshot; never an ordinary event-array query. */
  readStateSnapshot?(
    signal: AbortSignal,
    requestId: string,
    priority: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Demand-scoped verified ephemeral events on the session-owned socket. */
  observePresence?(
    authors: readonly string[],
    receive: (event: RelayEvent) => void,
  ): () => void;
  /** Complete bounded presence read. null is a local admission skip. */
  presenceSnapshot?(
    authors: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<
    string,
    "online" | "away" | "offline" | "unknown"
  > | null>;
  readonly writeSidebarMute?: SidebarMuteMutator;
  /** Host-only, relay-scoped mutation of one existing sidebar group assignment. */
  readonly writeSidebarAssignment?: SidebarAssignmentMutator;
  readonly removeSidebarSection?: SidebarSectionRemovalMutator;
  readonly writeSidebarSectionOrder?: SidebarSectionOrderMutator;
  readonly renameSidebarSection?: SidebarSectionRenameMutator;
  readonly writeSidebarStar?: SidebarStarMutator;
  /** Host-only private account record of the main agent the viewer chose:
   * null when they saved none or it was cleared, undefined when there is no
   * record. */
  readMainAgent?(signal: AbortSignal): Promise<string | null | undefined>;
  /** Null saves that this account has no main agent. */
  writeMainAgent?(agent: string | null, signal: AbortSignal): Promise<void>;
  /** Clears only the expected choice and returns the resulting choice. */
  clearMainAgent?(
    expected: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  readonly profiling?: RelayProfiler;
  /** Verifies events read back from device storage as a relay read does, with
   * the host's native batch check; only present with one. Rejects on any bad record or host failure. */
  verifyStored?(values: readonly unknown[]): Promise<RelayEvent[]>;
  /** Verified incoming traffic. The session owns this subscription and fences late delivery. */
  subscribe?(callbacks: LiveCallbacks): LiveSubscription;
  /** Stable community endpoint identity for durable session partitioning. */
  readonly scope?: string;
  /** Relay HTTP base for display only, such as a workflow's webhook address. */
  readonly relayHttpUrl?: string;
  /** Optional host-owned write capability, exposed to plugins only through the outbox. */
  readonly writer?: RelayWriter;
  /** The signed-in viewer whose channel roster is authoritative. */
  readonly viewer: string;
  /** Relay authority that signs discovery and window-bounds events. */
  readonly relayAuthor: string;
  /** Explicit NIP-11 self from this community, never a contact-key fallback. */
  readonly archiveAuthority?: string;
  /** Optional verified-profile capability from this community's explicit NIP-11 self. */
  readonly verifiedProfiles?: VerifiedProfileAuthority | undefined;
  /** Refresh NIP-11; null is an explicit disable, rejection preserves discovery. */
  readVerifiedProfileAuthority?(
    signal: AbortSignal,
  ): Promise<VerifiedProfileAuthority | null>;
  /** Purpose-bound authoritative recency, verified and max 128 channel IDs. */
  channelActivity?(
    channelIds: readonly string[],
    signal: AbortSignal,
  ): Promise<RelayEvent[]>;
  query(
    filters: readonly ReadFilter[],
    signal?: AbortSignal,
    requestId?: string,
    priority?: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Relay `POST /profiles/search`: one page of current kind:0 profiles whose
   * `name` or `display_name` matches `query` by the NIP-50 prefix rule, best
   * match first. A relay without the endpoint fails with a 404 or 405
   * `ReadError`. */
  searchProfiles?(
    query: string,
    limit: number,
    page: number,
    signal: AbortSignal,
    priority: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Display URL for a media URL, or undefined when this transport cannot fetch it. */
  media(url: string, size?: "small"): string | undefined;
}
/** Third-party https images load directly; relay-hosted media needs a signed read. */
export function mediaUrl(
  url: string,
  relayProxy: ((url: string) => string) | undefined,
  relayOrigin: string | undefined,
  size?: "small",
): string | undefined {
  if (url.startsWith("data:")) return avatarSource(url);
  if (url.startsWith(`${relayOrigin}/media/`)) {
    // Desktop appends `#buzz-anim=<url>` to animated avatars. A fragment never
    // reaches the relay, and both media proxies reject it, so load the still.
    const still = url.split("#", 1)[0] ?? url;
    const media =
      size === "small"
        ? still.replace(
            /\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/,
            "/$1.thumb.webp",
          )
        : still;
    return relayProxy?.(media);
  }
  return /^https:\/\//.test(url) ? url : undefined;
}
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  /** The host authenticates and sends exact bytes without exposing credentials to JS. */
  request(url: string, body: string, signal?: AbortSignal): Promise<Response>;
  /** Native hosts sign and send `PUT /upload` for these exact bytes. */
  upload?(file: File, signal: AbortSignal): Promise<Response>;
  /** Native hosts serve relay `/media/` URLs through an authenticated proxy. */
  media?(url: string): string;
  /** Native hosts check incoming signatures with libsecp256k1, off the main thread. */
  verifySignatures?: SignatureVerifier;
}

/** The host's explicit HTTP base wins; otherwise translate the ws(s) relay URL's scheme. */
export function relayHttpBase(
  explicit: unknown,
  relayUrl: unknown,
): string | undefined {
  const candidate =
    typeof explicit === "string"
      ? explicit
      : typeof relayUrl === "string"
        ? relayUrl.replace(/^ws(s?):\/\//i, "http$1://")
        : undefined;
  return candidate && /^https?:\/\/[^\s/?#@]+\/?$/i.test(candidate)
    ? candidate.replace(/\/$/, "")
    : undefined;
}

export async function parseEvents(
  raw: unknown,
  verify: EventVerifier,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  if (!Array.isArray(raw))
    throw new ReadError(
      "invalid-response",
      "Relay response is not an event array",
    );
  const { native } = verify;
  // Signature checks are CPU work too. Yield between small batches so speculative
  // head/profile responses cannot monopolize input and foreground rendering.
  // A native host checks signatures; JS still validates and hashes each event.
  const checkChunks = async <T>(check: (value: unknown) => T) => {
    const checked: T[] = [];
    for (let index = 0; index < raw.length; index += 12) {
      if (signal?.aborted)
        throw new DOMException("Read cancelled", "AbortError");
      const started = performance.now();
      const batch = raw.slice(index, index + 12).map(check);
      clientMetrics.cpu(
        "verify.read",
        performance.now() - started,
        batch.length,
      );
      checked.push(...batch);
      if (index + 12 < raw.length) await yieldToHost();
    }
    return checked;
  };
  if (!native) return checkChunks(verify);
  const events = await native.settle(await checkChunks(native.prepare));
  if (signal?.aborted) throw new DOMException("Read cancelled", "AbortError");
  if (!events.every((event) => event !== undefined))
    throw new ReadError(
      "invalid-response",
      "Relay supplied a malformed or invalidly signed event",
    );
  return events;
}

/** Development metrics: one record per finite read, never per event.
 * `sized` passes the decoded response body through and records its length. */
async function measureQuery<T>(
  session: string,
  priority: "foreground" | "background",
  read: (sized: (text: string) => string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const started = performance.now();
  let bytes = 0;
  let ok = false;
  let failure: unknown;
  try {
    const result = await read((text) => {
      bytes = text.length;
      return text;
    });
    ok = true;
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (networkRecorder.collecting())
      networkRecorder.record({
        level: ok ? "debug" : "warn",
        event: "read",
        relay: session.startsWith("http") ? session : undefined,
        ms: performance.now() - started,
        reason: ok ? undefined : failure,
        status: failure instanceof ReadError ? failure.status : undefined,
        detail: priority,
        ...networkContext(signal),
        outcome: ok ? "completed" : signal?.aborted ? "cancelled" : "failed",
        cancellation: networkCancellation(signal),
      });
    clientMetrics.query(session, {
      ms: performance.now() - started,
      bytes,
      priority,
      ok,
    });
  }
}
/** Report live route state to development metrics before the session sees it. */
function measuredLive(
  session: string,
  callbacks: LiveCallbacks,
): LiveCallbacks {
  return {
    ...callbacks,
    state(snapshot) {
      clientMetrics.live(session, snapshot);
      callbacks.state(snapshot);
    },
  };
}

/** Binds the presence owner to the existing session stream, including startup ordering. */
function presenceObservation() {
  let traffic: LiveSubscription | undefined;
  let authors: readonly string[] = [];
  let listener: ((event: RelayEvent) => void) | undefined;
  return {
    receive: (event: RelayEvent) => listener?.(event),
    attach(value: LiveSubscription) {
      traffic = value;
      traffic.watchPresence?.(authors);
    },
    observe(keys: readonly string[], receive: (event: RelayEvent) => void) {
      authors = keys;
      listener = receive;
      traffic?.watchPresence?.(authors);
      return () => {
        if (listener !== receive) return;
        listener = undefined;
        authors = [];
        traffic?.watchPresence?.(authors);
      };
    },
  };
}

async function parsePresence(
  raw: unknown,
  authors: readonly string[],
  relay: string,
  signal: AbortSignal,
) {
  if (!Array.isArray(raw) || raw.length > authors.length)
    throw new Error("Invalid presence snapshot");
  const values = new Map<string, "online" | "away" | "offline" | "unknown">();
  for (const event of await parseEvents(raw, eventDto, signal)) {
    const subjects = event.tags.filter(([tag]) => tag === "p");
    const subject = subjects[0]?.[1];
    let status: unknown = event.content;
    if (event.content.startsWith("{")) {
      try {
        status = JSON.parse(event.content).status;
      } catch {
        status = undefined;
      }
    }
    if (
      event.kind !== 20001 ||
      event.pubkey !== relay ||
      subjects.length !== 1 ||
      subjects[0]?.length !== 2 ||
      !subject ||
      !authors.includes(subject) ||
      values.has(subject)
    )
      throw new Error("Untrusted presence snapshot");
    // The relay permits extensible status strings. An unsupported value is
    // Unknown for this subject, not a trust failure for unrelated peers.
    values.set(
      subject,
      status === "online" || status === "away" || status === "offline"
        ? status
        : "unknown",
    );
  }
  signal.throwIfAborted();
  for (const author of authors)
    if (!values.has(author)) values.set(author, "offline");
  return values;
}

/** Register trusted-app-origin intent before contacting a new destination. No remote join. */
export async function registerBrokerCommunity(
  community: string,
  signal?: AbortSignal,
  base = "",
) {
  const response = await fetch(`${base}/api/relay/register`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: community }),
    signal: signal ?? null,
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(
      result.error ?? `Community registration failed (${response.status})`,
    );
  }
}

/** A failed finite read keeps its status, so callers can tell a missing
 * endpoint from denial or an outage. */
async function readResponseError(response: Response) {
  const failure = await readApiFailure(response);
  return new ReadError(
    response.status === 401 || response.status === 403
      ? "denied"
      : "unavailable",
    failure.error,
    response.status,
    failure.retryAfterMs,
  );
}

/** The broker marks any response whose upstream relay request met a community
 * refusal with `x-buzz-refusal` (`relay-broker.mjs`), whatever its route does
 * with the relay's body. Every broker request below goes through here. */
function brokerRefusals() {
  const listeners = new Set<(kind: CommunityRefusal) => void>();
  return {
    observe(listener: (kind: CommunityRefusal) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const response = await fetch(input, init);
      const kind = response.headers.get(BROKER_REFUSAL_HEADER);
      if (kind === "sign-in" || kind === "access")
        for (const listener of [...listeners]) listener(kind);
      return response;
    },
  };
}

/** Dev-only: a same-origin broker (see browser-host/relay-broker.mjs) holds the key and signs reads. */
export async function connectBrokerTransport(
  base = "",
  signal?: AbortSignal,
  community?: string,
): Promise<ReadTransport> {
  // Every broker read below, the session's included, goes through here.
  const { fetch, observe: observeRefusal } = brokerRefusals();
  if (community) await registerBrokerCommunity(community, signal, base);
  const endpoint = `${base}/api/relay${community ? `/${encodeURIComponent(community)}` : ""}`;
  const profiling = createRelayProfiler();
  const verify = createEventVerifier();
  const response = await fetch(`${endpoint}/session`, {
    credentials: "same-origin",
    signal: signal ?? null,
  });
  if (!response.ok) throw httpReadError(response.status);
  const session = (await response.json()) as {
    viewer?: unknown;
    relayAuthor?: unknown;
    archiveAuthority?: unknown;
    writeKinds?: number[];
    workflowReads?: boolean;
    projectGit?: boolean;
    attachmentUploads?: boolean;
    directMessages?: boolean;
    channelLifecycle?: boolean;
    channelDetails?: boolean;
    memberAdministration?: boolean;
    identityArchives?: boolean;
    relayUrl?: string;
    relayHttpUrl?: string;
    live?: boolean;
    presence?: boolean;
    sidebarPreferences?: boolean;
    sidebarSortWrites?: boolean;
    sidebarFilterWrites?: boolean;
    channelActivity?: boolean;
    sidebarMuteWrites?: boolean;
    channelKit?: boolean;
    channelIdentity?: boolean;
    searchSort?: boolean;
    artifactSync?: boolean;
    sidebarPreferenceWrites?: boolean;
    sidebarSectionRemoval?: boolean;
    sidebarSectionOrder?: boolean;
    sidebarSectionRename?: boolean;
    sidebarStarWrites?: boolean;
    agentLibrary?: boolean;
    agentMemories?: boolean;
    agentLogProof?: boolean;
    gitAuthorization?: boolean;
    agentActivity?: boolean;
    readState?: boolean;
    readStateCommunity?: string;
  };
  if (
    typeof session.viewer !== "string" ||
    typeof session.relayAuthor !== "string" ||
    (session.archiveAuthority !== undefined &&
      (typeof session.archiveAuthority !== "string" ||
        !/^[0-9a-f]{64}$/.test(session.archiveAuthority) ||
        session.archiveAuthority !== session.relayAuthor))
  )
    throw new ReadError(
      "invalid-response",
      "Relay broker session is malformed",
    );
  let traffic: LiveSubscription | undefined;
  const presence = presenceObservation();
  const relayHttpUrl = relayHttpBase(session.relayHttpUrl, session.relayUrl);
  const publicationHeaders = () => ({
    "Content-Type": "application/json",
    // Matched development frontend/host: publication requires the existing owner.
    "X-Buzz-Live-ID": traffic?.identity?.() ?? "",
  });
  const publish = async (event: RelayEvent, signal: AbortSignal) => {
    const result = await fetch(`${endpoint}/publish`, {
      method: "POST",
      credentials: "same-origin",
      headers: publicationHeaders(),
      body: JSON.stringify(event),
      signal,
    });
    recordServerTiming(result, profiling, event.id);
    return acceptPublish(result, event.id);
  };
  const sign = async (template: EventTemplate, signal: AbortSignal) => {
    const result = await fetch(`${endpoint}/sign`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
      signal,
    });
    if (!result.ok) throw new Error(`Signing failed (${result.status})`);
    const event = eventDto(await result.json());
    recordServerTiming(result, profiling, event.id);
    return event;
  };
  /** Dedicated shape-limited host sign/publish routes, separate from the outbox writer. */
  const routeWriter = (route: string): RelayWriter => ({
    async sign(template: EventTemplate, signal: AbortSignal) {
      const response = await fetch(`${endpoint}/${route}-sign`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(template),
        signal,
      });
      if (!response.ok) throw new Error((await readApiFailure(response)).error);
      return eventDto(await response.json());
    },
    async publish(event: RelayEvent, signal: AbortSignal) {
      const response = await fetch(`${endpoint}/${route}-publish`, {
        method: "POST",
        credentials: "same-origin",
        headers: publicationHeaders(),
        body: JSON.stringify(event),
        signal,
      });
      return acceptPublish(response, event.id);
    },
  });
  return {
    profiling,
    observeRefusal,
    ...(session.attachmentUploads === true && session.relayUrl
      ? { uploadAttachment: brokerUpload(endpoint, session.relayUrl, fetch) }
      : {}),
    ...(session.presence && session.live
      ? {
          observePresence: presence.observe,
          async presenceSnapshot(
            authors: readonly string[],
            signal: AbortSignal,
          ) {
            const filters = [
              { kinds: [20001], authors, limit: authors.length },
            ];
            if (!presenceFilter(filters))
              throw new Error("Invalid presence demand");
            const bounded = AbortSignal.any([
              signal,
              AbortSignal.timeout(10000),
            ]);
            const result = await fetch(`${endpoint}/presence-snapshot`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(filters),
              signal: bounded,
            });
            if (result.status === 204) return null;
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new ReadError(
                "unavailable",
                failure.error,
                result.status,
                failure.retryAfterMs,
              );
            }
            return parsePresence(
              JSON.parse(await presenceText(result)),
              authors,
              session.relayAuthor as string,
              bounded,
            );
          },
        }
      : {}),
    agentActivity: session.agentActivity === true && session.live === true,
    ...(session.live
      ? {
          subscribe: (callbacks: LiveCallbacks) => {
            traffic = subscribeBrokerTraffic(
              endpoint,
              measuredLive(endpoint, {
                ...callbacks,
                presence: presence.receive,
              }),
            );
            presence.attach(traffic);
            return { ...traffic, publishTyping: publish };
          },
        }
      : {}),
    ...(session.relayUrl ? { scope: session.relayUrl } : {}),
    ...(relayHttpUrl ? { relayHttpUrl } : {}),
    ...(session.directMessages === true
      ? {
          async openDirectMessage(
            pubkeys: readonly string[],
            signal: AbortSignal,
          ) {
            const result = await fetch(`${endpoint}/direct-message`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pubkeys }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!result.ok)
              throw new Error("Could not open the direct message. Try again.");
            const value = await result.json();
            if (
              typeof value?.channelId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                value.channelId,
              )
            )
              throw new Error("The relay returned an invalid direct message.");
            return value.channelId;
          },
        }
      : {}),
    viewer: session.viewer,
    relayAuthor: session.relayAuthor,
    ...(typeof session.archiveAuthority === "string"
      ? { archiveAuthority: session.archiveAuthority }
      : {}),
    ...(session.workflowReads === true
      ? {
          workflows: workflowHost((route, body, signal) =>
            fetch(`${endpoint}/${route}`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal,
            }),
          ),
        }
      : {}),
    ...(session.projectGit === true
      ? {
          projectGit: repoGitHost((body, signal) =>
            fetch(`${endpoint}/project-git`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal,
            }),
          ),
        }
      : {}),
    ...(session.agentLogProof === true && community
      ? {
          authorizeAgentLog: async (
            target: { id: string; pubkey: string; relayUrl: string },
            nonce: string,
          ) => {
            if (
              !session.relayUrl ||
              relayOrigin(target.relayUrl) !== relayOrigin(session.relayUrl)
            )
              throw new Error("Log authorization unavailable");
            const response = await fetch(`${endpoint}/agent-log-proof`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...target, nonce }),
            });
            if (!response.ok) throw new Error("Log authorization unavailable");
            const value: unknown = await response.json();
            if (
              !value ||
              typeof value !== "object" ||
              !("signature" in value) ||
              typeof value.signature !== "string" ||
              !/^[0-9a-f]{128}$/.test(value.signature)
            )
              throw new Error("Log authorization unavailable");
            return value.signature;
          },
        }
      : {}),
    ...(session.gitAuthorization === true && community && session.relayUrl
      ? {
          authorizeGit: async (input: string) => {
            const repository = communityGitRepository(
              relayOrigin(session.relayUrl ?? ""),
              input,
            );
            if (!repository) return null;
            const response = await fetch(`${endpoint}/git-authorization`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repository }),
            });
            const value: unknown = response.ok ? await response.json() : null;
            if (
              !value ||
              typeof value !== "object" ||
              !("token" in value) ||
              typeof value.token !== "string"
            )
              throw new Error("Repository sign-in unavailable");
            return { repository, token: value.token };
          },
        }
      : {}),
    ...(session.agentMemories === true && community
      ? {
          readAgentMemories: async (
            agent: string,
            signal: AbortSignal,
          ): Promise<MemoryListing> => {
            // Bounds the request and its body, so a stalled read ends in error.
            const bounded = AbortSignal.any([
              signal,
              AbortSignal.timeout(10000),
            ]);
            const response = await fetch(`${endpoint}/agent-memories`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agent }),
              signal: bounded,
            });
            if (!response.ok) {
              await response.body?.cancel();
              const error = new Error("Memory read failed");
              if (response.status === 401 || response.status === 403)
                error.name = "MemoryDenied";
              throw error;
            }
            const listing = JSON.parse(
              await memoryResponseText(response),
            ) as MemoryListing;
            bounded.throwIfAborted();
            return listing;
          },
        }
      : {}),
    ...(session.agentLibrary
      ? {
          readAgentLibrary: async (signal: AbortSignal) => {
            const result = await fetch(`${endpoint}/agent-library`, {
              credentials: "same-origin",
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!result.ok) throw new Error("Current Buzz library unavailable");
            return result.json();
          },
        }
      : {}),
    ...(session.sidebarPreferences
      ? {
          async decodeSidebarPreferences(
            events: readonly RelayEvent[],
            signal: AbortSignal,
          ): Promise<SidebarPreferences> {
            const result = await fetch(`${endpoint}/sidebar-preferences`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(events),
              signal,
            });
            if (!result.ok)
              // A 5xx is the host being unavailable; a 4xx rejects these events.
              throw new ReadError(
                result.status >= 500 ? "unavailable" : "invalid-response",
                `Local decoder failed (HTTP ${result.status})`,
                result.status,
              );
            return result.json();
          },
        }
      : {}),
    ...(session.channelIdentity === true
      ? { channelIdentity: true as const }
      : {}),
    ...(session.searchSort === true ? { searchSort: true as const } : {}),
    ...(session.artifactSync === true ? { artifactSync: true as const } : {}),
    ...(session.channelKit
      ? {
          channelKit: {
            async prepare(record: PrivateRecord, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/channel-kit-prepare`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(record),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Recipe preparation failed (${response.status})`,
                );
              const result = await response.json();
              if (
                typeof result.content !== "string" ||
                result.content.length > 64 * 1024
              )
                throw new Error("Invalid encrypted recipe");
              return result.content as string;
            },
            async decode(events: readonly RelayEvent[], signal: AbortSignal) {
              const response = await fetch(`${endpoint}/channel-kit-decode`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(events),
                signal,
              });
              if (!response.ok)
                throw new Error(`Recipe decode failed (${response.status})`);
              return response.json();
            },
          },
        }
      : {}),
    ...(session.readState
      ? {
          readState: {
            ...(session.readStateCommunity
              ? { communityId: session.readStateCommunity }
              : {}),
            async decode(events: readonly RelayEvent[], signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-decode`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(events),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state decode failed (${response.status})`,
                );
              return response.json();
            },
            async sign(intent: ReadStateSigning, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-sign`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(intent),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state signing failed (${response.status})`,
                );
              return eventDto(await response.json());
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-publish`, {
                method: "POST",
                credentials: "same-origin",
                headers: publicationHeaders(),
                body: JSON.stringify(event),
                signal,
              });
              await acceptReadStatePublish(response, event.id);
            },
          },
        }
      : {}),
    ...(session.readStateCommunity
      ? {
          async readStateSnapshot(
            signal: AbortSignal,
            requestId: string,
            priority: "foreground" | "background",
          ) {
            return measureQuery(
              endpoint,
              priority,
              async (sized) => {
                const response = await fetch(`${endpoint}/query`, {
                  method: "POST",
                  credentials: "same-origin",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Buzz-Read-Priority": priority,
                  },
                  body: JSON.stringify(
                    readSnapshotFilter(session.viewer as string),
                  ),
                  signal,
                });
                if (!response.ok)
                  throw new Error(
                    `Read-state snapshot failed (${response.status})`,
                  );
                recordServerTiming(response, profiling, requestId);
                return parseReadSnapshot(
                  JSON.parse(sized(await readSnapshotText(response))),
                  session.viewer as string,
                  session.readStateCommunity as string,
                  signal,
                );
              },
              signal,
            );
          },
        }
      : {}),
    ...(session.sidebarSortWrites
      ? {
          async writeSidebarSort(group, mode, sectionIds, signal) {
            const result = await fetch(`${endpoint}/sidebar-sort`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group, mode, sectionIds }),
              signal,
            });
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new Error(failure.error);
            }
            const value = (await result.json()) as { groups?: unknown };
            return (
              projectSidebarPreferences(
                undefined,
                undefined,
                undefined,
                {
                  version: 1,
                  groups: value.groups,
                },
                sectionIds,
              ).sort ?? {}
            );
          },
        }
      : {}),
    ...(session.sidebarFilterWrites
      ? {
          async writeSidebarFilter(
            group,
            mode,
            sectionIds,
            signal,
            activeWindowSeconds,
          ) {
            const result = await fetch(`${endpoint}/sidebar-filter`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                group,
                mode,
                sectionIds,
                activeWindowSeconds,
              }),
              signal,
            });
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new Error(failure.error);
            }
            const value = (await result.json()) as {
              groups?: unknown;
              activeWindowSeconds?: unknown;
            };
            const projected = projectSidebarPreferences(
              undefined,
              undefined,
              undefined,
              undefined,
              sectionIds,
              {
                version: 1,
                groups: value.groups,
                activeWindowSeconds: value.activeWindowSeconds,
              },
            );
            return {
              filters: projected.filters ?? {},
              activeWindowSeconds: projected.activeWindowSeconds ?? {},
            };
          },
        }
      : {}),
    ...(session.sidebarMuteWrites
      ? {
          async writeSidebarMute(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-mute`, {
              method: "POST",
              credentials: "same-origin",
              headers: publicationHeaders(),
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok)
              throw new Error((await readApiFailure(result)).error);
            return projectSidebarPreferences(
              undefined,
              undefined,
              await result.json(),
            ).muted;
          },
        }
      : {}),
    ...(session.channelDetails === true
      ? { channelDetails: routeWriter("channel-details") }
      : {}),
    ...(session.memberAdministration === true
      ? { memberAdministration: routeWriter("member-administration") }
      : {}),
    ...(session.channelLifecycle === true
      ? { channelLifecycle: routeWriter("channel-lifecycle") }
      : {}),
    ...(session.identityArchives === true
      ? { identityArchive: routeWriter("identity-archive") }
      : {}),
    ...(session.sidebarSectionRemoval
      ? {
          async removeSidebarSection(sectionId: string, signal: AbortSignal) {
            const response = await fetch(
              `${endpoint}/sidebar-section-removal`,
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sectionId }),
                signal,
              },
            );
            if (!response.ok)
              throw new Error((await readApiFailure(response)).error);
            const value = await response.json();
            const { sections, assignments } = projectSidebarPreferences(
              {
                version: 1,
                sections: value.sections,
                assignments: value.assignments,
              },
              undefined,
            );
            return { sections, assignments };
          },
        }
      : {}),
    ...(session.sidebarSectionRename
      ? {
          async renameSidebarSection(
            intent: { sectionId: string; name: string },
            signal: AbortSignal,
          ) {
            const response = await fetch(`${endpoint}/sidebar-section-rename`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(intent),
              signal,
            });
            if (!response.ok)
              throw new Error((await readApiFailure(response)).error);
            const value = await response.json();
            const { sections, assignments } = projectSidebarPreferences(
              {
                version: 1,
                sections: value.sections,
                assignments: value.assignments,
              },
              undefined,
            );
            return { sections, assignments };
          },
        }
      : {}),
    ...(session.sidebarSectionOrder
      ? {
          async writeSidebarSectionOrder(
            sectionIds: readonly string[],
            signal: AbortSignal,
          ) {
            const response = await fetch(`${endpoint}/sidebar-section-order`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sectionIds }),
              signal,
            });
            if (!response.ok)
              throw new Error((await readApiFailure(response)).error);
            const value = await response.json();
            const { sections, assignments } = projectSidebarPreferences(
              {
                version: 1,
                sections: value.sections,
                assignments: value.assignments,
              },
              undefined,
            );
            return { sections, assignments };
          },
        }
      : {}),
    ...(session.sidebarPreferenceWrites
      ? {
          async writeSidebarAssignment(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-assignment`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new Error(failure.error);
            }
            const value = (await result.json()) as SidebarPreferences;
            const groups = projectSidebarPreferences(
              {
                version: 1,
                sections: value.sections,
                assignments: value.assignments,
              },
              undefined,
            );
            return {
              sections: groups.sections,
              assignments: groups.assignments,
            };
          },
        }
      : {}),
    ...(session.sidebarStarWrites
      ? {
          async writeSidebarStar(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-star`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok)
              throw new Error((await readApiFailure(result)).error);
            return projectSidebarPreferences(undefined, await result.json())
              .starred;
          },
        }
      : {}),
    ...(session.writeKinds
      ? {
          writer: {
            kinds: session.writeKinds,
            sign,
            publish,
          },
        }
      : {}),
    // Artifact saves are the viewer's own kind 45010 events, signed and
    // published through the ordinary routes, which admit that kind and leave
    // write permission to the relay. Unlike the desktop host, which allows
    // nearly 512 KiB, the broker body and socket frame cap them at 64 KiB.
    ...(session.writeKinds?.includes(ARTIFACT_KIND)
      ? {
          configArtifacts: {
            kinds: [ARTIFACT_KIND],
            isNotSent: (error: unknown) => error instanceof PublishNotSent,
            async sign(template: EventTemplate, signal: AbortSignal) {
              if (template.kind !== ARTIFACT_KIND)
                throw new Error("Not an artifact");
              const event = await sign(template, signal);
              if (
                event.kind !== ARTIFACT_KIND ||
                event.pubkey !== session.viewer
              )
                throw new Error("Invalid artifact signature");
              return event;
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              if (
                event.kind !== ARTIFACT_KIND ||
                event.pubkey !== session.viewer
              )
                throw new Error("Not this viewer's artifact");
              return publish(event, signal);
            },
          },
        }
      : {}),
    ...(session.channelActivity
      ? {
          async channelActivity(channelIds, signal) {
            return measureQuery(
              endpoint,
              "background",
              async (sized) => {
                const result = await fetch(`${endpoint}/channel-activity`, {
                  method: "POST",
                  credentials: "same-origin",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Buzz-Read-Priority": "background",
                  },
                  body: JSON.stringify(
                    channelIds.map((channelId) => ({
                      kinds: [9, 40002, 40008, 45001, 45003],
                      "#h": [channelId],
                      limit: 1,
                    })),
                  ),
                  signal,
                });
                if (!result.ok) throw httpReadError(result.status);
                return parseEvents(
                  JSON.parse(sized(await result.text())),
                  verify,
                  signal,
                );
              },
              signal,
            );
          },
        }
      : {}),
    searchProfiles: (query, limit, page, signal, priority) =>
      measureQuery(
        endpoint,
        priority,
        async (sized) => {
          const result = await fetch(`${endpoint}/profile-search`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-Buzz-Read-Priority": priority,
            },
            body: JSON.stringify({ query, limit, page }),
            signal,
          });
          if (!result.ok) throw await readResponseError(result);
          return parseEvents(
            JSON.parse(sized(await result.text())),
            verify,
            signal,
          );
        },
        signal,
      ),
    media: (url, size) =>
      mediaUrl(
        url,
        (target) => `${endpoint}/media?url=${encodeURIComponent(target)}`,
        session.relayUrl,
        size,
      ),
    query: (filters, signal, requestId = "read", priority = "foreground") =>
      measureQuery(
        endpoint,
        priority,
        async (sized) => {
          const result = await fetch(`${endpoint}/query`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-Buzz-Read-Priority": priority,
            },
            body: JSON.stringify(filters),
            signal: signal ?? null,
          });
          if (!result.ok) {
            const failure = await readApiFailure(result);
            throw new ReadError(
              failure.denied ? "denied" : "unavailable",
              failure.error,
              result.status,
              failure.retryAfterMs,
            );
          }
          recordServerTiming(result, profiling, requestId);
          return profiling.measureAsync("read.verify", requestId, async () =>
            parseEvents(JSON.parse(sized(await result.text())), verify, signal),
          );
        },
        signal,
      ),
  };
}

const signedAdmissions = createHostAdmission();
/** A native purpose-bound read shares signed HTTP capacity and server cooldowns. */
export function admittedSignedWorkflowRead(
  origin: string,
  viewer: string,
  request: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  const lane = signedAdmissions(relayOrigin(origin), viewer).api;
  return lane.prepare(() =>
    admitSignedRequest(origin, viewer, request, signal),
  );
}

export const admitSignedRequest = (
  origin: string,
  viewer: string,
  request: () => Promise<Response>,
  signal?: AbortSignal,
  priority: "foreground" | "background" = "foreground",
  reason?: Parameters<typeof admittedApiRequest>[4],
) =>
  admittedApiRequest(
    signedAdmissions(relayOrigin(origin), viewer).api,
    request,
    signal,
    priority,
    reason,
  );
/** NIP-98 signed reads and writes through a host that owns the signer and authenticates each HTTP request. Reads and writes use the same identity and relay scope. */
export async function connectSignedTransport(
  signer: Signer,
  httpOrigin: string,
  relayAuthor: string,
  socketFactory?: (url: string) => LiveSocket,
): Promise<ReadTransport> {
  const viewer = await signer.getPublicKey();
  httpOrigin = relayOrigin(httpOrigin);
  const principal = () => signedAdmissions(httpOrigin, viewer);
  const profiling = createRelayProfiler();
  const verify = createEventVerifier(undefined, signer.verifySignatures);
  const presence = presenceObservation();
  const upload = signer.upload?.bind(signer);
  return {
    profiling,
    ...(verify.native
      ? { verifyStored: (values) => parseEvents(values, verify) }
      : {}),
    ...(upload ? { uploadAttachment: hostUpload(upload, httpOrigin) } : {}),
    observePresence: presence.observe,
    async presenceSnapshot(authors, signal) {
      const filters = [{ kinds: [20001], authors, limit: authors.length }];
      if (!presenceFilter(filters)) throw new Error("Invalid presence demand");
      const lane = principal().api;
      const release = lane.tryPresence();
      if (!release) return null;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const response = await signedPost(
          signer,
          `${httpOrigin}/query`,
          filters,
          bounded,
          profiling,
          "presence",
          lane,
          "background",
          true,
        );
        if (!response.ok) {
          const failure = await readApiFailure(response);
          if (failure.quota === "api" && failure.retryAfterMs !== undefined)
            lane.pause(failure.retryAfterMs);
          throw new ReadError(
            "unavailable",
            failure.error,
            response.status,
            failure.retryAfterMs,
          );
        }
        return await parsePresence(
          JSON.parse(await presenceText(response)),
          authors,
          relayAuthor,
          bounded,
        );
      } finally {
        release();
      }
    },
    subscribe: (callbacks) => {
      const owner = principal();
      owner.streams++;
      let traffic: LiveSubscription;
      try {
        traffic = subscribeRelayTraffic(
          httpOrigin.replace(/^http/, "ws"),
          (event) => signer.signEvent(event),
          viewer,
          measuredLive(httpOrigin, {
            ...callbacks,
            presence: presence.receive,
          }),
          socketFactory,
          owner.live,
          undefined,
          undefined,
          undefined,
          undefined,
          signer.verifySignatures,
        );
      } catch (error) {
        owner.streams--;
        throw error;
      }
      presence.attach(traffic);
      let closed = false;
      return {
        ...traffic,
        dispose() {
          if (closed) return;
          closed = true;
          owner.streams--;
          traffic.dispose();
        },
      };
    },
    scope: httpOrigin,
    relayHttpUrl: httpOrigin,
    viewer,
    relayAuthor,
    media: (url, size) =>
      mediaUrl(url, signer.media?.bind(signer), httpOrigin, size),
    writer: {
      sign: (event) => signer.signEvent(event),
      async publish(event, signal) {
        return acceptPublish(
          await signedPost(
            signer,
            `${httpOrigin}/events`,
            event,
            signal,
            profiling,
            event.id,
            principal().api,
            "foreground",
            false,
            refusalText,
          ).catch((error) => {
            if (error instanceof ApiPaused || error instanceof ApiNotSent)
              throw new PublishNotSent(error.message);
            throw error;
          }),
          event.id,
        );
      },
    },
    searchProfiles: (query, limit, page, signal, priority) =>
      measureQuery(
        httpOrigin,
        priority,
        async (sized) => {
          const result = await signedPost(
            signer,
            `${httpOrigin}/profiles/search`,
            { query, limit, page },
            signal,
            profiling,
            "profile-search",
            principal().api,
            priority,
          );
          if (!result.ok) throw await readResponseError(result);
          return parseEvents(
            JSON.parse(sized(await result.text())),
            verify,
            signal,
          );
        },
        signal,
      ),
    query: (filters, signal, requestId = "read", priority = "foreground") =>
      measureQuery(
        httpOrigin,
        priority,
        async (sized) => {
          const result = await signedPost(
            signer,
            `${httpOrigin}/query`,
            filters,
            signal,
            profiling,
            requestId,
            principal().api,
            priority,
          );
          if (!result.ok) {
            const failure = await readApiFailure(result);
            throw new ReadError(
              failure.denied ? "denied" : "unavailable",
              failure.error,
              result.status,
              failure.retryAfterMs,
            );
          }
          recordServerTiming(result, profiling, requestId);
          return profiling.measureAsync("read.verify", requestId, async () =>
            parseEvents(JSON.parse(sized(await result.text())), verify, signal),
          );
        },
        signal,
      ),
  };
}

async function signedPost(
  signer: Signer,
  url: string,
  value: unknown,
  signal: AbortSignal | undefined,
  profiling: RelayProfiler,
  id: string,
  admission: Parameters<typeof admittedApiRequest>[0],
  priority: "foreground" | "background" = "foreground",
  optionalPresence = false,
  reason?: (body: unknown, status: number) => string | undefined,
) {
  const dispatch = (request: () => Promise<Response>) =>
    optionalPresence
      ? admission.prepare(request)
      : admittedApiRequest(admission, request, signal, priority, reason);
  signal?.throwIfAborted();
  return admission.prepare(async () => {
    const body = JSON.stringify(value);
    return dispatch(() => {
      signal?.throwIfAborted();
      return profiling.measureAsync("http.fetch", id, () =>
        signer.request(url, body, signal),
      );
    });
  });
}
export async function acceptReadStatePublish(response: Response, id: string) {
  if (!response.ok) {
    const failure = await readApiFailure(response, (body) => {
      if (readStateRefusal(body)) return READ_STATE_TIMESTAMP_REFUSAL;
      const value = body as { sent?: unknown; error?: unknown } | null;
      if (
        value?.sent === false &&
        typeof value.error === "string" &&
        value.error.startsWith("rate-limited:")
      )
        return publicationRefusal(value.error);
    });
    if (
      (response.status === 400 ||
        (response.status === 503 && failure.sent === false)) &&
      failure.error === READ_STATE_TIMESTAMP_REFUSAL
    )
      throw new ReadStateTimestampRejected();
    response = Response.json(failure, { status: response.status });
  }
  return acceptPublish(response, id);
}

const REFUSAL_STATUSES = [400, 401, 403, 404, 413, 422];
/** NIP-01 machine-readable prefixes: the shape of a relay's own refusal. */
const NIP01_PREFIX =
  /^(invalid|blocked|restricted|error|pow|duplicate|rate-limited|conflict|auth-required):\s*/;
/** Prefixes writers match on, so the text is shown as sent. */
const KEPT_PREFIXES = new Set(["rate-limited", "conflict", "auth-required"]);
/** The relay's own `{error}` text for a refused write. Admission otherwise
 * reduces every upstream body to a status summary, so a signed publish asks
 * it to keep this one, bounded by `readApiFailure`. A gateway or VPN edge
 * can answer the same statuses with JSON `{error}`, so only relay-shaped
 * text (a NIP-01 prefix) is kept. The prefix is a shape, not proof of origin. */
const refusalText = (body: unknown, status: number) => {
  const error = (body as { error?: unknown } | null)?.error;
  return REFUSAL_STATUSES.includes(status) &&
    typeof error === "string" &&
    NIP01_PREFIX.test(error)
    ? error
    : undefined;
};

/** The display text for an HTTP refusal: the relay's own words without their
 * NIP-01 machine prefix. `reason` keeps the raw text for classification. Text
 * with a prefix writers match on (`conflict:`, `rate-limited:`) is shown as
 * sent. Text without a prefix is not relay-shaped, so the status summary stays. */
function refusalMessage(status: number, reason: string | undefined) {
  const prefix = reason ? NIP01_PREFIX.exec(reason) : null;
  if (!reason || !prefix) return `Relay rejected the message (${status})`;
  if (KEPT_PREFIXES.has(prefix[1] ?? "")) return reason.trim();
  const text = reason.slice(prefix[0].length).trim();
  if (!text) return `Relay rejected the message (${status})`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A transport failure is an unknown outcome; only a definitive rejection is a failed write. */
export async function acceptPublish(response: Response, id: string) {
  if (!response.ok) {
    // The relay answers 409 only for a compare-and-set refusal before mutation,
    // and the broker relays the socket's equivalent the same way. The fixed
    // prefix tells the writer to reload and reconcile rather than retry.
    if (response.status === 409)
      throw new PublishRejected(
        "conflict: the relay state changed; reload before writing again",
      );
    if (REFUSAL_STATUSES.includes(response.status)) {
      // Keep the relay's bounded `{error}` text for writers that classify it.
      let reason: string | undefined;
      await readApiFailure(response, (value) => {
        const error = (value as { error?: unknown } | null)?.error;
        if (typeof error === "string") reason = error;
        return undefined;
      });
      throw new PublishRejected(
        refusalMessage(response.status, reason),
        reason,
      );
    }
    // Only proven non-delivery is safe to mark failed. Socket quota reasons are
    // display-only: keep them distinct from HTTP API quota/cooldown ownership.
    const body = await readApiFailure(response, (value) => {
      if (!value || typeof value !== "object") return;
      const failure = value as { sent?: unknown; error?: unknown };
      if (
        failure.sent === false &&
        typeof failure.error === "string" &&
        failure.error.startsWith("rate-limited:")
      )
        return publicationRefusal(failure.error);
    });
    if (body.sent === false || body.quota === "api")
      throw new PublishNotSent(body.error);
    throw new Error(
      `Relay delivery could not be confirmed (${response.status})`,
    );
  }
  const text = await readReceiptText(response);
  const result = JSON.parse(text) as {
    accepted?: unknown;
    event_id?: unknown;
    message?: unknown;
  };
  if (result.event_id !== id || typeof result.accepted !== "boolean")
    throw new Error("Relay returned an invalid delivery receipt");
  if (!result.accepted) {
    const message =
      typeof result.message === "string"
        ? result.message
        : "Relay rejected the message";
    // NIP-01: a rate limit asks the client to wait, not to give up.
    throw message.startsWith("rate-limited:")
      ? new PublishNotSent(message)
      : new PublishRejected(message);
  }
  return typeof result.message === "string" ? result.message : "";
}

function recordServerTiming(
  response: Response,
  profiling: RelayProfiler,
  id: string,
) {
  for (const entry of (response.headers.get("Server-Timing") ?? "").split(
    ",",
  )) {
    const match = /^\s*([a-z_]+);dur=([\d.]+)/.exec(entry);
    if (!match) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration))
      profiling.record({
        stage: `broker.${match[1]}`,
        id,
        start: performance.now() - duration,
        duration,
        outcome: response.ok ? "ok" : "error",
      });
  }
}
