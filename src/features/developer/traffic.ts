import { getLogger } from "./logging.ts";
import { networkRecorder } from "./network-diagnostics.ts";

/** Traffic logs are allowlists, never truncated payload dumps. */
export function relayLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-relay";
  }
}
export function httpLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const scoped = parts[1] === "relay" && parts.length >= 4;
  let relay = "";
  if (scoped) {
    try {
      relay = `${relayLabel(decodeURIComponent(parts[2] ?? ""))} `;
    } catch {
      relay = "unknown-relay ";
    }
  }
  const action = parts[scoped ? 3 : 2] ?? "";
  return `${relay}/${parts[1] === "builderlab" ? "builderlab" : "relay"}/${/^[a-z-]{1,64}$/.test(action) ? action : "unknown"}`;
}
export function filterSummary(filters: unknown): string {
  if (!Array.isArray(filters)) return "invalid filters";
  return (
    JSON.stringify(
      filters.slice(0, 4).map((filter) => {
        if (!filter || typeof filter !== "object") return {};
        const numbers = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.filter((item) => Number.isSafeInteger(item)).slice(0, 24)
            : undefined;
        return {
          kinds: numbers(filter.kinds),
          limit: Number.isSafeInteger(filter.limit) ? filter.limit : undefined,
          since: Number.isSafeInteger(filter.since) ? filter.since : undefined,
          until: Number.isSafeInteger(filter.until) ? filter.until : undefined,
          authors: Array.isArray(filter.authors)
            ? filter.authors.length
            : undefined,
          ids: Array.isArray(filter.ids) ? filter.ids.length : undefined,
          channels: Array.isArray(filter["#h"])
            ? filter["#h"].length
            : undefined,
        };
      }),
    ) + (filters.length > 4 ? ` (+${filters.length - 4} filters)` : "")
  );
}
/** Negative OK text is untrusted. Preserve only fixed public protocol reasons. */
export function publicationRefusal(reason: string): string {
  const known = [
    "rate-limited: shared admission unavailable",
    "invalid: event timestamp too far from server time",
    "invalid: event pubkey does not match authenticated identity",
    "restricted: channel-scoped tokens cannot publish global events",
    "restricted: community writes are fenced",
    "restricted: insufficient scope (need users:write)",
    "restricted: insufficient scope (need admin:channels)",
    "error: internal server error",
    "invalid: policy:owner_only — agent has no owner set",
    "invalid: policy:owner_only — only the agent owner can add this agent",
    "invalid: policy:nobody — this agent has disabled external channel additions",
    "invalid: actor not authorized",
    "invalid: channel not found",
    "invalid: channel is archived",
    "restricted: not a channel member",
  ];
  const quota = /^rate-limited: quota exceeded; retry in \d{1,5}s$/.exec(
    reason,
  );
  if (known.includes(reason) || quota?.[0] === reason) return reason;
  const category =
    /^(invalid|blocked|restricted|auth-required|rate-limited|error|conflict|forbidden):/.exec(
      reason,
    );
  return category
    ? `${category[1]}: unrecognized reason`
    : "unrecognized reason";
}

const log = getLogger("relay-ws");
const frameTypes = new Set([
  "AUTH",
  "REQ",
  "EVENT",
  "OK",
  "EOSE",
  "CLOSE",
  "CLOSED",
  "NOTICE",
  "COUNT",
]);
const shortId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value.slice(0, 12)
    : "?";
export function logSocketFrame(
  peer: string,
  direction: "→" | "←",
  raw: unknown,
  frame?: unknown,
  connection?: string,
  diagnostic?: {
    operationId?: string | undefined;
    parentId?: string | undefined;
    subscriptionId?: string | undefined;
    nativeAt?: number;
    frameSequence?: number;
  },
) {
  if (log.level < 4 && !networkRecorder.enabled("debug")) return;
  const size =
    typeof raw === "string"
      ? raw.length > 1024 * 1024
        ? undefined
        : new TextEncoder().encode(raw).byteLength
      : raw instanceof ArrayBuffer
        ? raw.byteLength
        : ArrayBuffer.isView(raw)
          ? raw.byteLength
          : undefined;
  const data = Array.isArray(frame) ? frame : [];
  const type = frameTypes.has(data[0]) ? data[0] : "UNKNOWN";
  let detail = "";
  if (["REQ", "CLOSE", "CLOSED", "EOSE", "COUNT"].includes(type))
    detail = ` sub=${shortId(data[1])}`;
  if (type === "OK")
    detail = ` id=${shortId(data[1])} accepted=${data[2] === true}`;
  if (type === "EVENT") {
    const event = direction === "←" ? data[2] : data[1];
    detail = `${direction === "←" ? ` sub=${shortId(data[1])}` : ""} id=${shortId(event?.id)} kind=${Number.isSafeInteger(event?.kind) ? event.kind : "?"}`;
  }
  const length =
    typeof raw === "string" && raw.length > 1024 * 1024
      ? `${raw.length} code units; oversized`
      : `${size ?? "?"} B`;
  log.debug(`${peer} ${direction} ${type}${detail} (${length})`);
  networkRecorder.record({
    level: "debug",
    event: "ws.frame",
    ...diagnostic,
    relay: peer,
    connection,
    bytes: size,
    detail: `${direction} ${type}${detail}`,
  });
  if (networkRecorder.enabled("trace") && type === "REQ")
    networkRecorder.record({
      level: "trace",
      event: "ws.filters",
      ...diagnostic,
      relay: peer,
      connection,
      detail: filterSummary(data.slice(2)),
    });
  if (log.level >= 5 && type === "REQ")
    log.debug(`${peer} filters ${filterSummary(data.slice(2))}`);
}
