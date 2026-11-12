import { invoke } from "@tauri-apps/api/core";
import { communityDestination } from "./destination";
import { profilePictureError } from "../profiles/avatar-upload";
import {
  connectNativeTransport,
  nativeRelayInfo,
  nativeRelayRequest,
  nativeRelaySigner,
} from "../relay/native";
import { joinPolicy as readJoinPolicy } from "./join-policy";
import { leaveRefusal, leaveRequestTemplate } from "./leave-protocol";
import { adminReason, memberCommand } from "./admin-protocol";
import { readRelayLibrary } from "../agents/relay-library";
import { eventDto } from "../relay/events";
import { readApiFailure } from "../relay/http-admission";
import { admitSignedRequest } from "../relay/transport";
import type { PersonalProfile } from "./service";

export async function nativeCommunityRequest(
  community: string,
  route: string,
  body?: unknown,
  caller?: AbortSignal,
): Promise<unknown> {
  const signal = AbortSignal.any([
    ...(caller ? [caller] : []),
    AbortSignal.timeout(25_000),
  ]);
  if (route === "query") return nativeSignedQuery(community, body, signal);
  if (route === "agent-inventory") {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    )
      throw new Error("Explicit owner community resolution required");
    // Discovery reads the owner's records only; it grants no setup or custody.
    const owner = await nativeRelaySigner(community).getPublicKey();
    const inventory = await readRelayLibrary(
      {
        read: async (filters) =>
          (await nativeSignedQuery(community, filters, signal)).map(eventDto),
      },
      owner,
      signal,
    );
    return { identities: inventory.identities.map(({ pubkey }) => pubkey) };
  }
  if (route === "info") {
    // Independent reads: issue both at once rather than paying two round trips.
    const discovery = nativeRelayInfo(community, signal);
    const joinPolicy = nativeRelayRequest(
      community,
      "/api/join-policy",
      undefined,
      signal,
    );
    // A discovery failure is reported first; the policy outcome is then unused.
    joinPolicy.catch(() => {});
    const info = await discovery;
    const response = await joinPolicy;
    return {
      membershipRequired:
        Array.isArray(info.supported_nips) && info.supported_nips.includes(43),
      name: typeof info.name === "string" ? info.name : undefined,
      icon: typeof info.icon === "string" ? info.icon : undefined,
      policy:
        response.status === 404
          ? null
          : readJoinPolicy(await readResponse(response)),
    };
  }
  if (route === "session") {
    const transport = await connectNativeTransport(community, signal);
    return { viewer: transport.viewer, relayAuthor: transport.relayAuthor };
  }
  if (route === "claim" || route === "accept-policy") {
    const input = body as
      | {
          code?: unknown;
          policy_version?: unknown;
          age_confirmed?: unknown;
          policy_receipt?: unknown;
        }
      | undefined;
    if (
      !input ||
      typeof input.code !== "string" ||
      !/^[a-zA-Z0-9._-]{1,256}$/.test(input.code)
    )
      throw new Error("Invalid invite code");
    const value =
      route === "claim"
        ? { code: input.code, policy_receipt: input.policy_receipt }
        : {
            code: input.code,
            policy_version: input.policy_version,
            age_confirmed: input.age_confirmed === true,
          };
    const result = await readResponse(
      await nativeRelayRequest(
        community,
        `/api/invites/${route}`,
        value,
        signal,
      ),
    );
    if (
      route === "accept-policy" &&
      (typeof result.receipt !== "string" || !result.receipt)
    )
      throw new Error("Policy acceptance was not confirmed");
    return result;
  }
  if (route === "resolve-agent-community") {
    const target = body as
      | { owner?: unknown; pubkey?: unknown; confirmed?: unknown }
      | undefined;
    if (
      !target ||
      typeof target.owner !== "string" ||
      typeof target.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(target.owner) ||
      !/^[0-9a-f]{64}$/.test(target.pubkey) ||
      target.owner === target.pubkey ||
      Object.keys(target).length !== 3 ||
      target.confirmed !== true
    )
      throw new Error("Explicit owner community resolution required");
    signal.throwIfAborted();
    return invoke("relay_agent_resolve", {
      community: communityDestination(community).url,
      target,
    });
  }
  if (route === "invite") {
    const input = body as
      | { ttl_secs?: unknown; max_uses?: unknown }
      | undefined;
    const ttl = input?.ttl_secs;
    const uses = input?.max_uses ?? null;
    if (
      !Number.isSafeInteger(ttl) ||
      (ttl as number) < 60 ||
      (ttl as number) > 2_592_000
    )
      throw new Error("Invalid invite expiry");
    if (
      uses !== null &&
      (!Number.isSafeInteger(uses) ||
        (uses as number) < 1 ||
        (uses as number) > 10_000)
    )
      throw new Error("Invalid invite use limit");
    return readResponse(
      await nativeRelayRequest(
        community,
        "/api/invites",
        { ttl_secs: ttl, max_uses: uses },
        signal,
      ),
    );
  }
  if (route === "profile") {
    const profile = body as PersonalProfile & {
      existing?: Record<string, unknown>;
    };
    if (
      !profile ||
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      profile.name.length > 100 ||
      typeof profile.picture !== "string" ||
      profilePictureError(profile.picture) ||
      (profile.about !== undefined &&
        (typeof profile.about !== "string" || profile.about.length > 500))
    )
      throw new Error("Check your profile name, picture and description");
    const content = JSON.stringify({
      ...profile.existing,
      name: profile.name.trim(),
      display_name: profile.name.trim(),
      picture: profile.picture,
      about: (
        profile.about ??
        (typeof profile.existing?.about === "string"
          ? profile.existing.about
          : "")
      ).trim(),
    });
    if (new TextEncoder().encode(content).length > 16000)
      throw new Error("Profile too large");
    const event = await nativeRelaySigner(community).signEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    });
    const result = await readResponse(
      await nativeRelayRequest(community, "/events", event, signal),
    );
    if (result.event_id !== event.id || result.accepted !== true)
      throw new Error("Profile publication was not confirmed");
    return result;
  }
  if (route === "member") {
    // The relay decides each change; only its allowed refusals come back verbatim.
    const event = await nativeRelaySigner(community).signEvent(
      memberCommand(body),
    );
    const result = await readResponse(
      await nativeRelayRequest(community, "/events", event, signal),
      adminReason,
    );
    if (result.event_id !== event.id || typeof result.accepted !== "boolean")
      throw new Error("Member change could not be confirmed");
    return result;
  }
  if (route === "leave") {
    // The membership refusals come back verbatim so the caller can tell an
    // already-absent membership from a failed request.
    const event = await nativeRelaySigner(community).signEvent(
      leaveRequestTemplate(),
    );
    const result = await readResponse(
      await nativeRelayRequest(community, "/events", event, signal),
      leaveRefusal,
    );
    if (result.event_id !== event.id || result.accepted !== true)
      throw new Error("The leave request was not confirmed");
    return result;
  }
  throw new Error("This operation is unavailable on the packaged connection");
}

/** A signed scoped read for any joined community; it acquires no relay session. */
async function nativeSignedQuery(
  community: string,
  filters: unknown,
  signal: AbortSignal,
): Promise<unknown[]> {
  if (!Array.isArray(filters) || !filters.length)
    throw new Error("Invalid community query");
  const origin = communityDestination(community).url;
  const viewer = await nativeRelaySigner(origin).getPublicKey();
  const response = await admitSignedRequest(
    origin,
    viewer,
    () => nativeRelayRequest(origin, "/query", filters, signal),
    signal,
    "background",
  );
  signal.throwIfAborted();
  if (!response.ok) throw new Error((await readApiFailure(response)).error);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024)
    throw new Error("Community query response is too large");
  const events: unknown = JSON.parse(text);
  if (!Array.isArray(events)) throw new Error("Invalid community query");
  return events;
}

/** Exact invite admission refusal codes (buzz-relay api/invites.rs). */
function admissionRefusal(result: unknown) {
  const body = result as { error?: unknown; reason?: unknown } | null;
  return [
    "invite_expired",
    "invite_exhausted",
    "invite_invalid",
    "join_policy_required",
    "join_policy_not_accepted",
  ].find((value) => body?.error === value || body?.reason === value);
}

async function readResponse(
  response: Response,
  refusal: (result: unknown) => string | undefined = admissionRefusal,
): Promise<Record<string, unknown>> {
  // A body that is not JSON (proxy HTML, plain text) is never shown: it maps to
  // the status-based failure or, on success, an invalid response.
  const result: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      refusal(result) ?? `Community request failed (${response.status})`,
    );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid community response");
  return result as Record<string, unknown>;
}
