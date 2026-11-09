import { nativeRelayRequest, relaySelf } from "../relay/native";
import { communityIcon } from "./community-icon";
import { joinPolicy, type JoinPolicy } from "./join-policy";

/** Public relay metadata available before admission; no owner or member count. */
export type FoundCommunity = {
  /** Canonical secure origin. */
  url: string;
  host: string;
  name?: string | undefined;
  icon?: string | undefined;
  /** The relay deployment's key (NIP-11 `self`), when it is well-formed. */
  self?: string | undefined;
  policy: JoinPolicy | null;
};

export type FindFailure = "unreachable" | "not-buzz" | "no-community";

export class FindCommunityError extends Error {
  constructor(readonly failure: FindFailure) {
    super(failure);
  }
}

export type RelayFetch = (
  origin: string,
  path: string,
  signal: AbortSignal,
) => Promise<Response>;

/** Unauthenticated `relay_http` GETs: the reads the host allows before a key exists. */
export const nativeRelayFetch: RelayFetch = (origin, path, signal) =>
  nativeRelayRequest(origin, path, undefined, signal);

const BUZZ_SOFTWARE = "https://github.com/block/buzz";

/**
 * NIP-11 and the join policy in parallel; the NIP-11 verdict is reported first.
 * A policy 404 means "none" only once NIP-11 has confirmed a Buzz relay; any
 * other non-answer is retryable rather than a silent waiver of consent.
 */
export async function findCommunity(
  url: string,
  request: RelayFetch,
  signal: AbortSignal,
): Promise<FoundCommunity> {
  // The native request bounds the wait (10 s connect, 30 s total); IPC cannot
  // end it sooner.
  const get = (path: string) =>
    request(url, path, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new FindCommunityError("unreachable");
    });
  const discovery = get("/");
  const policy = get("/api/join-policy");
  policy.catch(() => {});
  const info = await relayInfo(await discovery);
  return {
    url,
    host: new URL(url).host,
    name: typeof info.name === "string" ? info.name : undefined,
    icon: communityIcon(info.icon),
    self: relaySelf(info),
    policy: await policyAnswer(await policy),
  };
}

async function policyAnswer(response: Response) {
  if (response.status === 404) return null;
  try {
    const body: unknown = response.ok ? await response.json() : undefined;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return joinPolicy(body as Record<string, unknown>);
  } catch {
    throw new FindCommunityError("unreachable");
  }
}

/** buzz-relay's NIP-11 answer for a host it maps to no community. */
const NO_COMMUNITY = "relay: no community is configured for this host";

async function relayInfo(response: Response) {
  if (response.status >= 500) throw new FindCommunityError("unreachable");
  if (
    response.status === 404 &&
    (await response.text().catch(() => "")) === NO_COMMUNITY
  )
    throw new FindCommunityError("no-community");
  const body: unknown = response.ok
    ? await response.json().catch(() => undefined)
    : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new FindCommunityError("not-buzz");
  const info = body as Record<string, unknown>;
  // buzz-relay nip11.rs hard-codes both; either identifies the software.
  if (
    info.name !== "Buzz Relay" &&
    !(
      typeof info.software === "string" &&
      info.software.startsWith(BUZZ_SOFTWARE)
    )
  )
    throw new FindCommunityError("not-buzz");
  return info;
}
