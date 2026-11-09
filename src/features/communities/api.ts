import { nativeIdentityEnabled } from "../identity/service";
import { retryRead } from "../relay/read-retry";
import { ReadError, transientStatus } from "../relay/errors";
import { nativeCommunityRequest } from "./native-api";
import { connectCommunityTransport, registerCommunity } from "./connection";
import { settledRefusal, type SettledRefusal } from "./leave-protocol";
import { registerBrokerCommunity } from "../relay/transport";
import type { EventData } from "../relay/events";
import type { RelaySession } from "../relay/session";
import type { JoinPolicy } from "./join-policy";
import type { PersonalProfile } from "./service";
export type CommunityInfo = {
  /** NIP-43 is advertised only when Buzz enforces relay membership. */
  membershipRequired?: boolean;
  name?: string;
  icon?: string;
  policy: JoinPolicy | null;
};
export async function communityRequest<T>(
  id: string,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (nativeIdentityEnabled())
    return nativeCommunityRequest(id, route, body, signal) as Promise<T>;
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
    : AbortSignal.timeout(25000);
  // Scoped HTTP reads need broker registration, not an acquired relay session.
  await registerBrokerCommunity(id, signal);
  signal.throwIfAborted();
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/${route}`,
    {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal,
    },
  );
  const result = await response.json();
  if (!response.ok) {
    const message =
      result.error ?? `Community request failed (${response.status})`;
    // Preserve retryable HTTP failures across the broker boundary without
    // reclassifying validation or admission refusals as network outages.
    if (transientStatus(response.status))
      throw new ReadError("unavailable", message, response.status);
    throw new Error(message);
  }
  return result as T;
}
export async function inspectProfile(id: string, session?: RelaySession) {
  // Existing-community editors use the captured session so confirmed reads also
  // update its shared profile directory. Joining uses the selected host adapter.
  const transport =
    session ??
    (await retryRead(
      (signal) => connectCommunityTransport(id, signal),
      AbortSignal.timeout(12000),
    ));
  if (!transport.viewer) throw new Error("Profile identity is unavailable");
  const filters = [
    {
      kinds: [0],
      authors: [transport.viewer],
      limit: 5,
      ...(nativeIdentityEnabled() ? { consistency: "strong" as const } : {}),
    },
  ];
  const events =
    "read" in transport
      ? await transport.read(filters, {
          signal: AbortSignal.timeout(12000),
          fresh: true,
        })
      : await retryRead(
          (signal) => transport.query(filters, signal),
          AbortSignal.timeout(12000),
        );
  const event = events
    .filter((e) => e.kind === 0 && e.pubkey === transport.viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  return profileFromEvent(event);
}

/** Parse a verified profile head consistently for fresh reads and same-session display. */
export function profileFromEvent(
  event: Pick<EventData, "content"> | undefined,
) {
  const parsed: unknown = event ? JSON.parse(event.content) : {};
  const existing: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const profile: PersonalProfile = {
    name: String(existing.display_name ?? existing.name ?? ""),
    picture: typeof existing.picture === "string" ? existing.picture : "",
    about: typeof existing.about === "string" ? existing.about : "",
  };
  return { existing, profile, exists: !!event };
}
export async function publishProfile(
  id: string,
  profile: PersonalProfile,
  existing: Record<string, unknown>,
) {
  const receipt = await communityRequest<{
    accepted: boolean;
    event_id: string;
    message?: string;
  }>(id, "profile", { ...profile, existing });
  if (!receipt.accepted || !receipt.event_id)
    throw new Error(receipt.message ?? "Profile publication was not confirmed");
}
export type LeaveOutcome = "left" | SettledRefusal;
/** Publishes a NIP-43 leave request to the community's relay by origin, without
 * acquiring a session. Resolves only once the relay accepts it, answers that
 * it holds no membership for the viewer, or refuses the viewer as banned (the
 * membership stays on the relay, but no retry can reach it while the ban
 * lasts); any other refusal, transport failure or timeout throws and leaves
 * the membership for the caller to retry. */
export async function requestLeave(id: string): Promise<LeaveOutcome> {
  await registerCommunity(id, AbortSignal.timeout(12000));
  try {
    const receipt = await communityRequest<{
      accepted: boolean;
      event_id: string;
      message?: string;
    }>(id, "leave", {});
    if (!receipt.accepted || !receipt.event_id)
      throw new Error(receipt.message ?? "The leave request was not confirmed");
    return "left";
  } catch (error) {
    const settled =
      error instanceof Error ? settledRefusal(error.message) : undefined;
    if (settled) return settled;
    throw error;
  }
}
