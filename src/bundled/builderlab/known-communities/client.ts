import { relayAddress } from "../../../features/communities/destination";
import type { HostResponse } from "../../../features/host/service";
import type { BuilderlabSession, Credential } from "../session";

/** The service's refusals. None is retried as sent: each waits for a fresh
 * sign-in. A client error the service did not name is `rejected` with its
 * status: the request as sent will not be accepted, unlike a timeout, a rate
 * limit or a server error. A success whose body this client cannot read is
 * `invalid_response`: a contract the two sides no longer share, which no
 * retry mends either. */
export type Refusal =
  | { kind: "invalid_request" }
  | { kind: "forbidden" }
  | { kind: "limit_reached" }
  | { kind: "invalid_response" }
  | { kind: "rejected"; status: number };
export type ListResult =
  | {
      kind: "listed";
      /** In the device's spelling (`relayAddress`), which the service shares. */
      communities: string[];
      /** Rows whose address this device could never save, left out. */
      dropped?: number;
    }
  | Refusal;
export type UpdateResult = { kind: "accepted" } | Refusal;

/** Refusals the framework answers in plain text, by status alone. */
const BY_STATUS: Record<number, Refusal["kind"]> = {
  400: "invalid_request",
  403: "forbidden",
  422: "limit_reached",
};
type Named = Exclude<Refusal, { kind: "rejected" }>["kind"];
const REFUSALS: ReadonlySet<string> = new Set<Named>([
  "invalid_request",
  "forbidden",
  "limit_reached",
]);
const isRefusal = (code: unknown): code is Named =>
  typeof code === "string" && REFUSALS.has(code);
/** A status outside the route's contract: another client error is a refusal
 * of the request as sent, while a timeout, a rate limit or a server error is
 * a failure to retry. A 401 refuses only this request: the native session
 * decides when it ends. */
function unexpected(status: number): Refusal {
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { kind: "rejected", status };
  throw Object.assign(
    new Error(`Builderlab request failed (HTTP ${status}).`),
    {
      status,
    },
  );
}

/** A listed row's destination. `null` is a row whose address this device could
 * never save (dropped on its own), `undefined` a row of a shape this client
 * does not understand, which makes the whole response invalid. */
export function listedAddress(row: unknown): string | null | undefined {
  if (!row || typeof row !== "object") return undefined;
  const { community_url } = row as Record<string, unknown>;
  if (typeof community_url !== "string") return undefined;
  try {
    return community_url.startsWith("wss://")
      ? relayAddress(community_url)
      : null;
  } catch {
    return null;
  }
}

/** The known-communities routes under the signed-in Builderlab session. The
 * service refuses adds past about 1,000 destinations (a best-effort quota that
 * concurrent adds can overshoot), so the list stays far inside the host
 * transport's response cap and no cap is imposed here. */
export function createKnownCommunitiesClient(session: BuilderlabSession) {
  function check(credential: Credential, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      session.snapshot().status !== "signed-in" ||
      session.credential() !== credential
    )
      throw new DOMException("Builderlab session changed.", "AbortError");
  }
  /** Posts under the current credential and parses the body on every status:
   * the service answers its refusals in JSON, while the framework's own
   * refusals are plain text. `value` is absent when the body is not a JSON
   * object, which a refusal's status still explains and a success does not. */
  async function request(path: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const credential = session.credential();
    let response: HostResponse;
    try {
      response = await session.request(credential, {
        path: `/v1/buzz/known-communities/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      check(credential, signal);
      throw new Error("Couldn’t reach Builderlab.");
    }
    check(credential, signal);
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      /* A plain-text framework refusal; the status carries the meaning. */
    }
    return {
      status: response.status,
      value:
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined,
    };
  }
  const refusal = (
    status: number,
    value: Record<string, unknown> | undefined,
  ): Refusal => {
    const code =
      typeof value?.error === "string" ? value.error : BY_STATUS[status];
    return isRefusal(code) ? { kind: code } : unexpected(status);
  };
  /** Both edits are idempotent, so a lost answer is retried as sent. */
  async function send(
    path: "add" | "remove",
    url: string,
    signal: AbortSignal,
  ): Promise<UpdateResult> {
    const { status, value } = await request(
      path,
      { community_url: url },
      signal,
    );
    return status === 200 ? { kind: "accepted" } : refusal(status, value);
  }
  return {
    /** Every destination the account holds, in the service's spelling. */
    async list(signal: AbortSignal): Promise<ListResult> {
      const { status, value } = await request("list", {}, signal);
      if (status !== 200) return refusal(status, value);
      // An empty or non-JSON body (a proxy's block page, say) is not an
      // empty list: reading it as one would forget every synced community.
      if (!value) return { kind: "invalid_response" };
      // Protobuf JSON can omit an empty repeated field.
      const rows = value.communities ?? [];
      if (!Array.isArray(rows)) return { kind: "invalid_response" };
      const addresses = rows.map(listedAddress);
      if (addresses.includes(undefined)) return { kind: "invalid_response" };
      const communities = addresses.filter((a): a is string => a !== null);
      return {
        kind: "listed",
        communities,
        ...(communities.length < rows.length
          ? { dropped: rows.length - communities.length }
          : {}),
      };
    },
    add: (url: string, signal: AbortSignal) => send("add", url, signal),
    remove: (url: string, signal: AbortSignal) => send("remove", url, signal),
  };
}
export type KnownCommunitiesClient = ReturnType<
  typeof createKnownCommunitiesClient
>;
