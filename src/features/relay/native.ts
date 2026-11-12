import {
  artifactIncrementalCapability,
  artifactIncrementalFailure,
  createArtifactIncrementalReader,
} from "./artifact-incremental-reader";
import {
  networkContext,
  networkCancellation,
  networkSignals,
  markNetworkCancellation,
} from "../developer/network-context";
import { networkMetrics } from "../developer/network-metrics";
import { networkRecorder } from "../developer/network-diagnostics";
import {
  verifiedProfileAuthority,
  verifiedProfileDiscovery,
} from "./verified-profile";
import { nativeSocket } from "./native-socket";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventTemplate } from "nostr-tools";
import { communityDestination, relayOrigin } from "../communities/destination";
import {
  audioDemuxer,
  isHeic,
  isVoiceNote,
  videoDemuxer,
} from "./video-preparation";
import {
  hostUpload,
  readUploadResponse,
  UPLOAD_TIMEOUT_MS,
  UploadError,
  UPLOAD_MAX_BYTES,
  validateUploadResult,
  type UploadProgress,
} from "./attachments";
import {
  createEventVerifier,
  eventDto,
  type RelayEvent,
  type SignatureVerifier,
} from "./events";
import {
  privateTag,
  privateCoordinate,
  parsePrivateRecord,
  type PrivateRecord,
} from "../channel-templates/model";
import { parseEvents, type RelayWriter } from "./transport";
import { communityGitRepository } from "../repos/git";
import { validateLifecycleTemplate } from "./channel-lifecycle-protocol";
import { validateMemberAdministrationTemplate } from "../channel-members/administration-protocol";
import { validateDetailsTemplate } from "./channel-details-protocol";
import { validateArchiveRequestTemplate } from "./identity-archive-protocol";
import { workflowHost, workflowRunsPath } from "../workflows/http";
import { WORKFLOW_KINDS } from "../workflows/protocol";
import { repoGitHost } from "../repos/git";

import { PublishNotSent, PublishRejected } from "./outbox";

import { readCoordinate, parseReadBlob } from "./read-state-model";
import { readStateRefusal, type ReadStateSigning } from "./read-state-host";
import {
  readSnapshotCommunity,
  readSnapshotFilter,
  parseReadSnapshot,
  readSnapshotText,
} from "./read-state-snapshot";
import {
  memoryAgent,
  memoryListing,
  type MemoryListing,
} from "../agents/memory";
import type { AgentLibrary } from "../agents/library";
import { observerFrame } from "../agents/observer";
import { ARTIFACT_KIND } from "../agents/agent-config-artifacts";
import {
  acceptPublish,
  acceptReadStatePublish,
  admitSignedRequest,
  connectSignedTransport,
  admittedSignedWorkflowRead,
  type ReadTransport,
  type Signer,
} from "./transport";
import { nativeSidebar } from "./native-sidebar";
import { readApiFailure, type CommunityRefusal } from "./http-admission";

async function nativeReadInvoke<T>(
  command: string,
  args: Record<string, unknown>,
) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Tauri commands reject with a string; domain health expects an Error.
    throw typeof error === "string" ? new Error(error) : error;
  }
}

export const nativeWriteKinds = [
  48103,
  30078,
  7,
  9,
  1984,
  9000,
  9001,
  30030,
  30175,
  30177,
  30178,
  30315,
  40003,
  40100,
  42000,
  45010,
  ...WORKFLOW_KINDS,
] as const;

/** Searches and reads native code may abandon. Mirrors `cancellable_read` in
 * `src-tauri/src/relay.rs`. */
const CANCELLABLE_READS = new Set([
  "/query",
  "/profiles/search",
  "/gifs/search",
]);

/** Cancellation stops a native read at once; a dispatched native write may
 * still complete, so it only fences the JS result. */
export async function nativeRelayRequest(
  community: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = AbortSignal.timeout(30_000);
  markNetworkCancellation(deadline, {
    initiator: "deadline",
    owner: "native-http",
  });
  const bounded = networkSignals([...(signal ? [signal] : []), deadline]);
  bounded.throwIfAborted();
  const diagnostic = networkRecorder.enabled("debug")
    ? (networkContext(signal) ?? {
        operationId: `request:${crypto.randomUUID()}`,
        owner: "native-http",
      })
    : undefined;
  const metrics = networkMetrics.enabled()
    ? networkMetrics.relay(community)
    : undefined;
  const metric = metrics?.operation("request");
  const responseLatency = metrics?.timer("http");
  const id =
    body !== undefined && CANCELLABLE_READS.has(path)
      ? crypto.randomUUID()
      : undefined;
  const cancel = () => {
    invoke("relay_http_cancel", { id }).catch(() => {});
  };
  if (id) bounded.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>("relay_http", {
      community: communityDestination(community).url,
      path,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? null : JSON.stringify(body),
      ...(id ? { id } : {}),
      ...(diagnostic
        ? { diagnostic: { operationId: diagnostic.operationId } }
        : {}),
    }).catch((error: unknown) => {
      metric?.(
        bounded.aborted
          ? deadline.aborted && bounded.reason === deadline.reason
            ? "deadline"
            : "cancelled"
          : "failed",
      );
      throw error;
    });
    metric?.(
      bounded.aborted
        ? deadline.aborted && bounded.reason === deadline.reason
          ? "deadline"
          : "cancelled"
        : result.status >= 200 && result.status < 300
          ? "ok"
          : "failed",
    );
    // Keep the admission slot until native cancellation or completion acknowledges.
    if (bounded.aborted)
      if (networkRecorder.enabled("debug"))
        networkRecorder.record({
          level: "debug",
          event: "native.result-discarded",
          ...diagnostic,
          relay: community,
          status: result.status,
          cancellation: networkCancellation(bounded),
          outcome: "discarded",
        });
    bounded.throwIfAborted();
    responseLatency?.();
    const response = nativeResponse(result);
    // Only a signed request speaks for the session, as native decides (`send`
    // in relay.rs signs only POST): a refused GET says nothing about it.
    if (
      body !== undefined &&
      (response.status === 401 || response.status === 403)
    )
      await announceRefusal(community, response);
    return response;
  } finally {
    if (id) bounded.removeEventListener("abort", cancel);
  }
}

function nativeResponse(result: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): Response {
  return new Response(
    [204, 205, 304].includes(result.status) ? null : result.body,
    { status: result.status, headers: result.headers },
  );
}

/** Relay media through the native `buzz-media` scheme (`src-tauri/src/relay.rs`),
 * which signs each Blossom `get`, including every `Range` request. */
export function nativeMediaUrl(url: string): string {
  return convertFileSrc(url, "buzz-media");
}

/** Bounded IPC chunks; native code spools, hashes, signs and streams to `PUT /upload`.
 * Aborting settles at once and tells native code to drop the request. */
async function nativeUpload(
  origin: string,
  file: File,
  signal: AbortSignal,
  preparation?: string,
  progress?: UploadProgress,
) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      invoke("relay_upload_cancel", { id }).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const send = async () => {
      await invoke("relay_upload_begin", { id, size: file.size });
      signal.throwIfAborted();
      // Acknowledgement supplies backpressure on every platform, including
      // WebKit's JSON IPC fallback. Never read the complete File into JS.
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        signal.throwIfAborted();
        const bytes = await file
          .slice(offset, offset + chunkSize)
          .arrayBuffer();
        signal.throwIfAborted();
        await invoke("relay_upload_chunk", bytes, {
          headers: {
            "x-buzz-upload-id": id,
            "x-buzz-upload-offset": String(offset),
          },
        });
      }
      signal.throwIfAborted();
      return invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>(
        "relay_upload",
        {},
        {
          headers: {
            "x-buzz-upload-id": id,
            "x-buzz-community": origin,
            "x-buzz-content-type": file.type || "application/octet-stream",
            ...(preparation ? { "x-buzz-preparation": preparation } : {}),
            ...(progress && {
              "x-buzz-upload-progress": new Channel<{
                sent: number;
                total: number;
              }>(({ sent, total }) => {
                if (!signal.aborted) progress(sent, total);
              }).toJSON(),
            }),
          },
        },
      );
    };
    const result = await Promise.race([send(), aborted]);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  } catch (error) {
    if (!signal.aborted)
      void invoke("relay_upload_cancel", { id }).catch(() => {});
    if (typeof error === "string" && /temporary storage/.test(error))
      throw new UploadError("io");
    if (error === "Uploads are busy") throw new UploadError("capacity");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Preparation is performed and uploaded inside the host. Converted bytes never
 * cross back into JS; only the validated relay descriptor does. */
async function nativeAttachmentUpload(
  origin: string,
  file: File,
  signal: AbortSignal,
  progress?: UploadProgress,
) {
  signal.throwIfAborted();
  if (!file.size || file.size > UPLOAD_MAX_BYTES) throw new UploadError("size");
  const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  signal.throwIfAborted();
  const voice = isVoiceNote(file.name);
  const heic = !voice && isHeic(header, file.name);
  if (voice && file.size > 128 * 1024 * 1024) throw new UploadError("size");
  const demuxer = voice
    ? audioDemuxer(header)
    : heic
      ? "mov"
      : videoDemuxer(header);
  if (!demuxer) {
    if (voice || file.type.startsWith("video/")) throw new UploadError("video");
    return hostUpload(
      (item, bounded, report) =>
        nativeUpload(origin, item, bounded, undefined, report),
      origin,
    )(file, signal, progress);
  }
  // Native preparation has its own 600 s deadline; leave a separate upload
  // budget, as broker prepareMedia + hostUpload do.
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(600_000 + UPLOAD_TIMEOUT_MS),
  ]);
  const response = await nativeUpload(
    origin,
    file,
    bounded,
    `${heic ? "image" : voice ? "voice" : "video"}:${demuxer}`,
    progress,
  );
  bounded.throwIfAborted();
  const body = await readUploadResponse(response);
  const type = heic ? "image/jpeg" : "video/mp4";
  const name = `${file.name.replace(/\.[^.]+$/, "") || "Attachment"}.${heic ? "jpg" : "mp4"}`;
  bounded.throwIfAborted();
  const size = (body as { size?: number } | null)?.size;
  if (
    typeof size !== "number" ||
    (body as { type?: string } | null)?.type !== type
  )
    throw new UploadError("invalid");
  return validateUploadResult(body, origin, size, name);
}

export function nativeRelaySigner(community: string): Signer {
  const origin = communityDestination(community).url;
  return {
    async getPublicKey() {
      const viewer = await invoke<string | null>("identity_restore");
      if (!viewer || !/^[a-f0-9]{64}$/.test(viewer))
        throw new Error("Set up your identity first");
      return viewer;
    },
    async signEvent(event: EventTemplate) {
      const { kind, created_at, tags, content } = event;
      return eventDto(
        await invoke(kind === 30078 ? "relay_kit_sign" : "relay_sign", {
          community: origin,
          event: { kind, created_at, tags, content },
        }),
      );
    },
    request(url, body, signal) {
      const target = new URL(url);
      if (target.origin !== origin || target.search || target.hash)
        throw new Error("Relay request changed community");
      return nativeRelayRequest(
        origin,
        target.pathname,
        JSON.parse(body),
        signal,
      );
    },
    upload: (file, signal) => nativeUpload(origin, file, signal),
    media: nativeMediaUrl,
    verifySignatures: verifyNativeSignatures,
  };
}

const verifyNativeSignatures: SignatureVerifier = (claims) =>
  nativeReadInvoke<boolean[]>("relay_verify_signatures", { claims });

/** Device evidence can be verified before any relay connection exists. */
export function verifyNativeStored(values: readonly unknown[]) {
  return parseEvents(
    values,
    createEventVerifier(undefined, verifyNativeSignatures),
  );
}

export const NOT_A_COMMUNITY_ERROR =
  "That URL didn't look like a Buzz community. Enter a community URL like wss://communities.buzz.xyz.";

export async function nativeRelayInfo(community: string, signal?: AbortSignal) {
  const response = await nativeRelayRequest(community, "/", undefined, signal);
  if (!response.ok) throw new Error("Community discovery failed");
  // A website's HTML would otherwise surface WebKit's opaque JSON parse error.
  const info: unknown = await response.json().catch(() => undefined);
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error(NOT_A_COMMUNITY_ERROR);
  return info as Record<string, unknown>;
}

/** The relay's own key as NIP-11 `self` publishes it: 64 lowercase hex, else absent. */
export function relaySelf(info: Record<string, unknown>): string | undefined {
  const self = info.self;
  return typeof self === "string" && /^[a-f0-9]{64}$/.test(self)
    ? self
    : undefined;
}

type RefusalListener = (kind: CommunityRefusal) => void;
const refusalListeners = new Map<string, Set<RefusalListener>>();
let refusalEvents: Promise<unknown> | undefined;
function notifyRefusal(community: string, kind: CommunityRefusal) {
  for (const listener of [...(refusalListeners.get(community) ?? [])])
    listener(kind);
}
/** The response itself also reports a refusal, so the community's owner hears
 * it even when the window event never arrives (its listener failed to
 * install). The owner takes the first report; a repeat changes nothing. */
async function announceRefusal(community: string, response: Response) {
  const { admission } = await readApiFailure(response.clone());
  if (admission)
    notifyRefusal(
      new URL(communityDestination(community).url).origin,
      admission,
    );
}
/** Native reports a community's refusal from whichever signed request met it
 * (`observe_refusal` in relay.rs), so no command needs its own check. One
 * window listener serves every connection; it is ready before any connects. */
async function nativeRefusals(origin: string) {
  refusalEvents ??= listen<{ community: string; refusal: string }>(
    "relay-refusal",
    ({ payload }) => {
      const kind = payload.refusal;
      if (kind !== "sign-in" && kind !== "access") return;
      notifyRefusal(payload.community, kind);
    },
  ).catch(() => {
    // Without it the failed response still reports the refusal (see
    // announceRefusal); the next connect retries the listener.
    refusalEvents = undefined;
  });
  await refusalEvents;
  const community = new URL(origin).origin;
  return (listener: RefusalListener) => {
    const listeners = refusalListeners.get(community) ?? new Set();
    refusalListeners.set(community, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && refusalListeners.get(community) === listeners)
        refusalListeners.delete(community);
    };
  };
}

export async function connectNativeTransport(
  community: string,
  signal?: AbortSignal,
): Promise<ReadTransport> {
  const origin = communityDestination(community).url;
  const observeRefusal = await nativeRefusals(origin);
  const info = await nativeRelayInfo(origin, signal);
  const author = relaySelf(info);
  if (!author) throw new Error("Relay did not advertise its identity");
  const creation =
    Array.isArray(info.supported_nips) && info.supported_nips.includes(29);
  // NIP-CL: the relay keeps channel labels and answers label lookups.
  const channelIdentity =
    Array.isArray(info.supported_extensions) &&
    info.supported_extensions.includes("nip-cl");
  const artifactSupport =
    Array.isArray(info.supported_extensions) &&
    info.supported_extensions.includes("nip-ar");
  const searchSort =
    Array.isArray(info.supported_extensions) &&
    info.supported_extensions.includes("buzz-search-sort");
  const artifacts = info.artifacts as
    | { sync?: { version?: unknown } }
    | undefined;
  const artifactSync = artifacts?.sync?.version === 1;
  const transport = await connectSignedTransport(
    nativeRelaySigner(origin),
    origin,
    author,
    nativeSocket,
  );
  signal?.throwIfAborted();
  const writer = transport.writer;
  const readCommunity = readSnapshotCommunity(info.read_state_snapshot);
  if (!writer) throw new Error("Native relay writer is unavailable");
  const commandWriter = (
    route:
      | "channel-details"
      | "channel-lifecycle"
      | "identity-archive"
      | "member-administration",
    validate: (event: EventTemplate) => void,
  ): RelayWriter => ({
    async sign(event, signal) {
      signal.throwIfAborted();
      validate(event);
      const result = eventDto(
        await invoke("relay_channel_sign", {
          community: origin,
          route,
          event,
        }),
      );
      signal.throwIfAborted();
      validate(result);
      if (result.pubkey !== transport.viewer)
        throw new Error("Invalid channel lifecycle command");
      return result;
    },
    async publish(event, signal) {
      signal.throwIfAborted();
      validate(event);
      if (event.pubkey !== transport.viewer)
        throw new Error("Invalid channel lifecycle command");
      const result = await invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>("relay_channel_publish", { community: origin, route, event });
      signal.throwIfAborted();
      return acceptPublish(
        new Response(result.body, {
          status: result.status,
          headers: result.headers,
        }),
        event.id,
      );
    },
  });
  // Capabilities describe implemented host operations, not everything this key can sign.
  return {
    ...transport,
    observeRefusal,
    ...(artifactIncrementalCapability(info)
      ? {
          artifactIncremental: createArtifactIncrementalReader(
            (filter, signal) =>
              admitSignedRequest(
                origin,
                transport.viewer,
                () => nativeRelayRequest(origin, "/query", [filter]),
                signal,
                "background",
                artifactIncrementalFailure,
              ),
          ),
        }
      : {}),
    workflows: workflowHost(async (route, body, signal) => {
      if (route !== "workflow-runs") throw new Error("Invalid workflow read");
      workflowRunsPath(body);
      signal.throwIfAborted();
      const response = await admittedSignedWorkflowRead(
        origin,
        transport.viewer,
        async () => {
          const result = await invoke<{
            status: number;
            headers: Record<string, string>;
            body: string;
          }>("relay_workflow_runs", {
            community: origin,
            id: (body as { id: string }).id,
            cursor:
              (body as { cursor?: { before: string; beforeId: string } })
                .cursor ?? null,
          });
          return nativeResponse(result);
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }),
    projectGit: repoGitHost(async (read, signal) => {
      const response = await admitSignedRequest(
        origin,
        transport.viewer,
        async () => {
          // Admission stays held until native code has stopped and reaped Git.
          const id = crypto.randomUUID();
          const cancel = () => {
            invoke("relay_project_git_cancel", { id }).catch(() => {});
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          try {
            return nativeResponse(
              await invoke<{
                status: number;
                headers: Record<string, string>;
                body: string;
              }>("relay_project_git", { community: origin, id, read }),
            );
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }),
    archiveAuthority: author,
    channelLifecycle: commandWriter(
      "channel-lifecycle",
      validateLifecycleTemplate,
    ),
    channelDetails: commandWriter("channel-details", validateDetailsTemplate),
    memberAdministration: commandWriter("member-administration", (event) =>
      validateMemberAdministrationTemplate(event, transport.viewer ?? ""),
    ),
    identityArchive: commandWriter(
      "identity-archive",
      validateArchiveRequestTemplate,
    ),
    // Artifact saves go straight to the relay, which accepts a replay of an
    // already-accepted revision, so they skip `writer`'s 15-minute retry
    // block below. Signing applies the artifact size bound.
    ...(artifactSupport
      ? {
          configArtifacts: {
            kinds: [ARTIFACT_KIND],
            isNotSent: (error: unknown) => error instanceof PublishNotSent,
            async sign(event: EventTemplate, signal: AbortSignal) {
              if (event.kind !== ARTIFACT_KIND)
                throw new Error("Not an artifact");
              const signed = await writer.sign(event, signal);
              if (
                signed.kind !== ARTIFACT_KIND ||
                signed.pubkey !== transport.viewer
              )
                throw new Error("Invalid artifact signature");
              return signed;
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              if (
                event.kind !== ARTIFACT_KIND ||
                event.pubkey !== transport.viewer
              )
                throw new Error("Not this viewer's artifact");
              return (await writer.publish(event, signal)) ?? "";
            },
          },
        }
      : {}),
    async openDirectMessage(pubkeys, signal) {
      signal.throwIfAborted();
      const id = await invoke<string>("relay_direct_message", {
        community: origin,
        pubkeys,
      });
      signal.throwIfAborted();
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
        throw new Error("The relay returned an invalid direct message.");
      return id;
    },
    channelKit: {
      async prepare(record: PrivateRecord, signal) {
        signal.throwIfAborted();
        const valid = parsePrivateRecord(record, origin);
        const content = await invoke<string>("relay_kit_prepare", {
          community: origin,
          record: valid,
        });
        signal.throwIfAborted();
        if (typeof content !== "string" || content.length > 64 * 1024)
          throw new Error("Invalid encrypted recipe");
        return content;
      },
      async decode(events: readonly RelayEvent[], signal) {
        signal.throwIfAborted();
        if (events.length > 16)
          throw new Error("Recipe decode capacity exceeded");
        const owned = events.map(eventDto);
        const decoded = await invoke<
          { eventId: string; record: PrivateRecord }[]
        >("relay_kit_decode", {
          community: origin,
          events: owned,
        });
        signal.throwIfAborted();
        if (!Array.isArray(decoded) || decoded.length !== owned.length)
          throw new Error("Incomplete private recipe decode");
        return decoded.map((row, index) => {
          const event = owned[index];
          if (
            !event ||
            row.eventId !== event.id ||
            event.pubkey !== transport.viewer ||
            event.kind !== 30078 ||
            event.tags.filter(([key]) => key === "d").length !== 1 ||
            event.tags.filter(([key]) => key === "t").length !== 1 ||
            event.tags.some(
              ([key]) => !["d", "t", "client-id"].includes(key ?? ""),
            )
          )
            throw new Error("Recipe decode mismatch");
          const record = parsePrivateRecord(row.record, origin);
          if (
            !event.tags.some(
              ([key, value]) =>
                key === "d" && value === privateCoordinate(record),
            ) ||
            !event.tags.some(
              ([key, value]) => key === "t" && value === privateTag(record),
            )
          )
            throw new Error("Recipe decode mismatch");
          return { eventId: row.eventId, record };
        });
      },
    },

    agentActivity: true,
    subscribe(callbacks) {
      let active = true;
      let observerGeneration: number | null = null;
      let observerEpoch = 0;
      let listening = false;
      const traffic = transport.subscribe?.({
        ...callbacks,
        state(snapshot) {
          const route = snapshot.routes.find((item) => item.id === "observer");
          const next =
            snapshot.status === "connected" && route?.status === "live";
          if (listening && !next) observerEpoch++;
          listening = next;
          callbacks.state(snapshot);
        },
        telemetry(event, generation) {
          if (generation !== observerGeneration || !listening) return;
          const epoch = observerEpoch;
          void invoke("relay_agent_observer", { community: origin, event })
            .then((value) => {
              if (
                active &&
                listening &&
                observerEpoch === epoch &&
                observerGeneration === generation
              )
                callbacks.observer?.(observerFrame(value), generation);
            })
            .catch(() => {
              /* Invalid encrypted telemetry is not chat traffic. */
            });
        },
      });
      if (!traffic) throw new Error("Native relay stream is unavailable");
      return {
        ...traffic,
        observe(generation) {
          observerEpoch++;
          observerGeneration = generation;
          traffic.observe?.(generation);
        },
        dispose() {
          active = false;
          observerEpoch++;
          traffic.dispose();
        },
      };
    },
    async readAgentLibrary(signal) {
      signal.throwIfAborted();
      const result = await invoke<AgentLibrary>("relay_agent_library", {
        community: origin,
      });
      signal.throwIfAborted();
      return result;
    },
    async readAgentMemories(
      agent: string,
      signal: AbortSignal,
      slug?: string,
      onPage?: (page: MemoryListing) => void,
    ): Promise<MemoryListing> {
      if (!memoryAgent(agent, transport.viewer))
        throw new Error("Invalid memory target");
      // A streamed read has no overall deadline: its pages arrive as they
      // decode, and native code bounds each one.
      const bounded = onPage
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      bounded.throwIfAborted();
      // Aborting stops native paging and drops what it decoded.
      const id = crypto.randomUUID();
      const cancel = () => {
        invoke("relay_http_cancel", { id }).catch(() => {});
      };
      bounded.addEventListener("abort", cancel, { once: true });
      let result: unknown;
      try {
        result = await invoke<unknown>("relay_agent_memories_read", {
          community: origin,
          agent,
          slug: slug ?? null,
          id,
          onPage: onPage
            ? new Channel<unknown>((page) => {
                if (bounded.aborted) return;
                let listing: MemoryListing;
                try {
                  listing = memoryListing(page);
                } catch {
                  // The result is validated in full; an invalid page only
                  // goes unshown.
                  return;
                }
                onPage(listing);
              })
            : null,
        });
      } catch (reason) {
        bounded.throwIfAborted();
        if (reason === "MemoryDenied") {
          const denied = new Error("Memory read failed");
          denied.name = "MemoryDenied";
          throw denied;
        }
        throw reason;
      } finally {
        bounded.removeEventListener("abort", cancel);
      }
      bounded.throwIfAborted();
      return memoryListing(result);
    },
    async authorizeAgentLog(target, nonce) {
      if (relayOrigin(target.relayUrl) !== origin)
        throw new Error("Log authorization unavailable");
      const signature = await invoke<string>("relay_agent_log_proof", {
        community: origin,
        target: { ...target, nonce },
      });
      if (!/^[0-9a-f]{128}$/.test(signature))
        throw new Error("Log authorization unavailable");
      return signature;
    },
    async authorizeGit(input) {
      const repository = communityGitRepository(origin, input);
      if (!repository) return null;
      const token = await invoke<string>("relay_git_authorization", {
        community: origin,
        repository,
      });
      return { repository, token };
    },
    ...nativeSidebar(transport),
    reminders: {
      async decode(events, signal) {
        signal.throwIfAborted();
        const decoded = await invoke<{ eventId: string; content: unknown }[]>(
          "relay_decode_reminders",
          { events },
        );
        signal.throwIfAborted();
        return decoded;
      },
      async sign(intent, signal) {
        signal.throwIfAborted();
        const event = eventDto(
          await invoke<unknown>("relay_sign_reminder", { intent }),
        );
        signal.throwIfAborted();
        if (event.pubkey !== transport.viewer || event.kind !== 30300)
          throw new Error("Invalid reminder event");
        return event;
      },
    },
    readState: {
      ...(readCommunity ? { communityId: readCommunity } : {}),
      async decode(events: readonly RelayEvent[], signal: AbortSignal) {
        signal.throwIfAborted();
        const decoded = await nativeReadInvoke<
          { eventId: string; blob: unknown }[]
        >("relay_decode_read_state", {
          community: origin,
          events,
        });
        signal.throwIfAborted();
        for (const item of decoded) parseReadBlob(item.blob);
        return decoded;
      },
      async sign(intent: ReadStateSigning, signal: AbortSignal) {
        signal.throwIfAborted();
        parseReadBlob(intent.blob);
        const event = eventDto(
          await nativeReadInvoke("relay_sign_read_state", {
            community: origin,
            intent,
          }),
        );
        signal.throwIfAborted();
        if (event.pubkey !== transport.viewer || !readCoordinate(event))
          throw new Error("Invalid read-state event");
        return event;
      },
      async publish(event: RelayEvent, signal: AbortSignal) {
        signal.throwIfAborted();
        if (event.pubkey !== transport.viewer || !readCoordinate(event))
          throw new Error("Invalid read-state event");
        const response = await admitSignedRequest(
          origin,
          transport.viewer,
          async () => {
            // Tauri IPC cannot abort the underlying request. Keep admission until
            // it settles even if the caller no longer needs the receipt.
            const result = await nativeReadInvoke<{
              status: number;
              headers: Record<string, string>;
              body: string;
            }>("relay_publish_read_state", { community: origin, event });
            return nativeResponse(result);
          },
          signal,
          "foreground",
          readStateRefusal,
        );
        signal.throwIfAborted();
        await acceptReadStatePublish(response, event.id);
      },
    },
    ...(readCommunity
      ? {
          async readStateSnapshot(signal: AbortSignal, _requestId, priority) {
            const response = await admitSignedRequest(
              origin,
              transport.viewer,
              () =>
                nativeRelayRequest(
                  origin,
                  "/query",
                  readSnapshotFilter(transport.viewer),
                ),
              signal,
              priority,
            );
            signal.throwIfAborted();
            if (!response.ok)
              throw new Error((await readApiFailure(response)).error);
            return parseReadSnapshot(
              JSON.parse(await readSnapshotText(response)),
              transport.viewer,
              readCommunity,
              signal,
            );
          },
        }
      : {}),
    async channelActivity(channelIds, signal) {
      if (
        channelIds.length < 1 ||
        channelIds.length > 128 ||
        channelIds.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      )
        throw new Error("Activity filter rejected");
      return transport.query(
        channelIds.map((channelId) => ({
          kinds: [9, 40002, 40008, 45001, 45003],
          "#h": [channelId],
          limit: 1,
        })),
        signal,
        "channel-activity",
        "background",
      );
    },
    uploadAttachment: (file, signal, progress) =>
      nativeAttachmentUpload(origin, file, signal, progress),
    ...(channelIdentity ? { channelIdentity: true as const } : {}),
    ...(searchSort ? { searchSort: true as const } : {}),
    ...(artifactSync ? { artifactSync: true as const } : {}),
    verifiedProfiles: verifiedProfileAuthority(info),
    async readVerifiedProfileAuthority(signal) {
      return verifiedProfileDiscovery(await nativeRelayInfo(origin, signal));
    },
    writer: {
      ...writer,
      kinds: creation ? [...nativeWriteKinds, 9007] : nativeWriteKinds,
      async publish(event, signal) {
        // The relay rejects old events before deduplication. An explicit retry
        // can confirm the original ID, but must never silently re-date it.
        if (event.created_at < Math.floor(Date.now() / 1000) - 15 * 60) {
          const found = await transport.query(
            [
              {
                kinds: [event.kind],
                ids: [event.id],
                authors: [event.pubkey],
                limit: 1,
                consistency: "strong",
              },
            ],
            signal,
          );
          if (found.some((value) => value.id === event.id)) return "";
          throw new PublishRejected(
            "This event is too old to retry and was not found on the relay. Check the conversation before sending it again.",
          );
        }
        return (await writer.publish(event, signal)) ?? "";
      },
    },
  };
}
