// The Solo worker control protocol, version 1: the records a controller agent
// (C) and its owner's Buzz (H, on device D) exchange as kind 9 messages in their
// private control channel (K), so C can run H's workers in their Solo
// chats. C signs requests; H's Buzz signs grant acknowledgements and responses.
// This file is the whole wire contract, with no I/O, so both sides can run
// the same checks. Authority lives in the owner's Buzz; nothing here grants it.
import { eventDto } from "../features/relay/events";
import type { BuzzEvent, Template } from "./client";

export const SOLO_WORKER_VERSION = 1;
/** Seconds a request may be admitted for, and how far ahead of the
 * reader's clock its `issued_at` may be. */
export const ADMISSION_WINDOW = 120;
export const FUTURE_SKEW = 30;
/** Longest a readiness answer stays usable, in seconds. */
export const READINESS_TTL = 30;
export const TEXT_MAX = 16_000;
export const TITLE_MAX = 120;
export const PAGE_MAX = 50;
/** The owner's Buzz keeps its latest grant acknowledgement among its newest
 * this-many events in the control channel, posting it again as needed, so a
 * controller finds it with one read. */
export const ACK_HORIZON = 50;

export const ACTIONS = [
  "readiness",
  "create",
  "send",
  "read",
  "stop",
  "archive",
  "list",
] as const;
export type Action = (typeof ACTIONS)[number];
/** Actions with an effect: each needs a current custody epoch. */
export const MUTATIONS: readonly Action[] = [
  "create",
  "send",
  "stop",
  "archive",
];
export const PHASES = [
  "accepted",
  "preparing",
  "ready",
  "running",
  "stop_pending",
  "settled",
  "refused",
  "uncertain",
  "receipt_expired",
] as const;
export type Phase = (typeof PHASES)[number];
export const REASONS = [
  "authorization_required",
  "approval_required",
  "grant_changed",
  "revoked",
  "readiness_required",
  "expired",
  "conflict",
  "capacity",
  "unsupported",
  "stop_required",
  "not_found",
  "outcome_unavailable",
] as const;
export const WORKER_STATES = [
  "preparing",
  "idle",
  "running",
  "stopping",
  "stopped",
  "archived",
  "unknown",
] as const;
export const ARCHIVE_SCOPES = [
  "complete",
  "local_only",
  "watch_removal_pending",
] as const;

export type Grant = Readonly<{ id: string; revision: number }>;
/** Where a request goes and under which grant. Every record repeats it. */
export type Route = Readonly<{
  owner: string;
  controller: string;
  stream: string;
  community: string;
  device: string;
  grant: Grant;
}>;
type Json = Readonly<Record<string, unknown>>;
export type Intent = Route &
  Readonly<{
    v: 1;
    type: "request";
    action: Action;
    nonce: string;
    issued_at: number;
    admit_before: number;
    custody_epoch?: string;
    args: Json;
  }>;
export type Response = Route &
  Readonly<{
    v: 1;
    type: "response";
    request: string;
    action: Action;
    revision: number;
    phase: Phase;
    reason?: (typeof REASONS)[number];
    observed_at: number;
    receipt_retained_until?: number;
    result?: Json;
  }>;
export type GrantAck = Route &
  Readonly<{
    v: 1;
    type: "grant_ack";
    workers: readonly string[];
    operations: readonly Action[];
    state: "active" | "revoked";
    issued_at: number;
  }>;
type Kind = "request" | "response" | "grant_ack";

// --- Canonical JSON -------------------------------------------------------

/** The one encoding every record is hashed and sent in: RFC 8785 limited to
 * strings, booleans, non-negative safe integers, arrays and objects. Keys are
 * sorted by UTF-16 code units, with no whitespace. */
export function canonical(value: unknown): string {
  if (typeof value === "string") {
    // With the u flag only an unpaired surrogate matches.
    if (/\p{Surrogate}/u.test(value))
      throw new Error("Text has an unpaired surrogate");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Numbers must be non-negative integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  throw new Error("Value has no canonical form");
}

/** Parses text that must already be canonical, so one record has one
 * spelling: reordered keys, spaces or duplicate keys are refused. */
export function parseCanonical(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Record is not JSON");
  }
  if (canonical(value) !== text) throw new Error("Record is not canonical");
  return value;
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A request's logical id: the hash of its whole canonical intent, so the same
 * id can never stand for different arguments, epochs or deadlines. */
export async function intentId(intent: Intent) {
  return `sw1:${await sha256(canonical(checkIntent(intent)))}`;
}

// --- Validation -----------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^sw1:[0-9a-f]{64}$/;

type Check = (value: unknown, field: string) => void;
const fail = (field: string, problem: string): never => {
  throw new Error(`${field} ${problem}`);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const pattern =
  (regex: RegExp, what: string): Check =>
  (value, field) => {
    if (typeof value !== "string" || !regex.test(value))
      fail(field, `must be ${what}`);
  };
const pubkey = pattern(HEX64, "a lowercase hex public key");
const channel = pattern(UUID, "a channel id");
const token = pattern(TOKEN, "a short id");
const requestId = pattern(ID, "a sw1: request id");
const nonce = pattern(/^[0-9a-f]{32}$/, "32 lowercase hex characters");
const community = pattern(/^[\x21-\x7e]{1,256}$/, "a community name");
const int: Check = (value, field) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(field, "must be a non-negative integer");
};
const count: Check = (value, field) => {
  int(value, field);
  if ((value as number) < 1 || (value as number) > PAGE_MAX)
    fail(field, `must be 1 to ${PAGE_MAX}`);
};
const bool: Check = (value, field) => {
  if (typeof value !== "boolean") fail(field, "must be true or false");
};
const text =
  (max: number): Check =>
  (value, field) => {
    if (typeof value !== "string" || !value.trim() || [...value].length > max)
      fail(field, `must be text of 1 to ${max} characters`);
  };
const oneOf =
  (values: readonly string[]): Check =>
  (value, field) => {
    if (typeof value !== "string" || !values.includes(value))
      fail(field, `must be one of ${values.join(", ")}`);
  };
/** A set, written in ascending order so it has one spelling. */
const sorted =
  (item: Check, max: number): Check =>
  (value, field) => {
    if (!Array.isArray(value) || value.length > max)
      fail(field, `must be a list of at most ${max}`);
    (value as unknown[]).forEach((entry, index, all) => {
      item(entry, field);
      if (index && !((all[index - 1] as string) < (entry as string)))
        fail(field, "must be sorted with no repeats");
    });
  };
const list =
  (item: Check, max: number): Check =>
  (value, field) => {
    if (!Array.isArray(value) || value.length > max)
      fail(field, `must be a list of at most ${max}`);
    for (const entry of value as unknown[]) item(entry, field);
  };

/** Checks `value` has exactly these fields: every required one, any of the
 * optional ones and nothing else. */
const shape =
  (
    required: Readonly<Record<string, Check>>,
    optional: Readonly<Record<string, Check>> = {},
  ): Check =>
  (value, field) => {
    if (!isObject(value)) fail(field, "must be an object");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
        fail(`${field}.${key}`, "is not part of the protocol");
    for (const [key, check] of Object.entries(required)) {
      if (!Object.hasOwn(record, key)) fail(`${field}.${key}`, "is required");
      check(record[key], `${field}.${key}`);
    }
    for (const [key, check] of Object.entries(optional))
      if (Object.hasOwn(record, key)) check(record[key], `${field}.${key}`);
  };

const grant = shape({ id: token, revision: int });
const route = {
  v: (value: unknown, field: string) => {
    if (value !== SOLO_WORKER_VERSION)
      fail(field, "is an unsupported protocol version");
  },
  owner: pubkey,
  controller: pubkey,
  stream: channel,
  community,
  device: token,
  grant,
};
const literal =
  (expected: string): Check =>
  (value, field) => {
    if (value !== expected) fail(field, `must be ${expected}`);
  };

const ARGS: Readonly<Record<Action, Check>> = {
  readiness: shape({}),
  // No prompt: a worker is made idle, and work arrives only through send.
  create: shape({ worker: pubkey }, { title: text(TITLE_MAX) }),
  send: shape({ solo: channel, worker_epoch: int, text: text(TEXT_MAX) }),
  read: shape({ solo: channel, limit: count }, { after: token }),
  stop: shape({ solo: channel, worker_epoch: int }),
  archive: shape({ solo: channel }),
  list: shape({ limit: count, archived: bool }, { cursor: token }),
};

/** Throws what is wrong with `args` for `action`, as `checkIntent` would. */
export const checkArgs = (action: Action, args: unknown) =>
  ARGS[action](args, "request.args");

/** Returns `value` as a request intent, or throws what is wrong with it. */
export function checkIntent(value: unknown): Intent {
  shape(
    {
      ...route,
      type: literal("request"),
      action: oneOf(ACTIONS),
      nonce,
      issued_at: int,
      admit_before: int,
      args: (args, field) => ARGS[(value as Intent).action](args, field),
    },
    { custody_epoch: token },
  )(value, "request");
  const intent = value as Intent;
  if (intent.owner === intent.controller)
    fail("request.controller", "must not be the owner");
  const window = intent.admit_before - intent.issued_at;
  if (window <= 0 || window > ADMISSION_WINDOW)
    fail(
      "request.admit_before",
      `must be 1 to ${ADMISSION_WINDOW} seconds after issued_at`,
    );
  if (
    MUTATIONS.includes(intent.action) !==
    (intent.custody_epoch !== undefined)
  )
    fail(
      "request.custody_epoch",
      "is required for create, send, stop and archive, and only for them",
    );
  return intent;
}

/** Whether a reader whose clock says `now` (seconds) may admit `intent` as a
 * new request. A request already on record is reconciled, not re-judged. */
export const admissible = (intent: Intent, now: number) =>
  intent.issued_at <= now + FUTURE_SKEW && now < intent.admit_before;

const verified = (value: unknown, field: string) => {
  try {
    eventDto(value);
  } catch {
    fail(field, "must be a validly signed event");
  }
};
const worker = shape(
  {
    solo: channel,
    worker: pubkey,
    state: oneOf(WORKER_STATES),
    worker_epoch: int,
    archived: bool,
  },
  { title: text(TITLE_MAX) },
);
const RESULTS: Readonly<Record<Action, Check>> = {
  readiness: shape({ custody_epoch: token, valid_until: int }),
  create: shape({ solo: channel, worker: pubkey, worker_epoch: int }),
  send: shape({}),
  read: shape(
    {
      worker: pubkey,
      state: oneOf(WORKER_STATES),
      worker_epoch: int,
      events: list(verified, PAGE_MAX),
      complete: bool,
    },
    { next: token },
  ),
  stop: shape({ worker_epoch: int }),
  archive: shape({ scope: oneOf(ARCHIVE_SCOPES) }),
  list: shape(
    { workers: list(worker, PAGE_MAX), complete: bool },
    { next: token },
  ),
};
const FAILURES: readonly Phase[] = ["refused", "uncertain", "receipt_expired"];

/** Returns `value` as a response, or throws what is wrong with it. */
export function checkResponse(value: unknown): Response {
  shape(
    {
      ...route,
      type: literal("response"),
      request: requestId,
      action: oneOf(ACTIONS),
      revision: int,
      phase: oneOf(PHASES),
      observed_at: int,
    },
    {
      reason: oneOf(REASONS),
      receipt_retained_until: int,
      result: (result, field) =>
        RESULTS[(value as Response).action](result, field),
    },
  )(value, "response");
  const response = value as Response;
  const failed = FAILURES.includes(response.phase);
  if (failed !== (response.reason !== undefined))
    fail(
      "response.reason",
      "is required for refused, uncertain and receipt_expired, and only for them",
    );
  if (failed && response.result)
    fail("response.result", "is not allowed when the request did not go ahead");
  if (response.result && response.action === "readiness") {
    const ttl = (response.result.valid_until as number) - response.observed_at;
    if (ttl <= 0 || ttl > READINESS_TTL)
      fail(
        "response.result.valid_until",
        `must be 1 to ${READINESS_TTL} seconds after observed_at`,
      );
  }
  return response;
}

/** Returns `value` as a grant acknowledgement, or throws what is wrong with it. */
export function checkGrantAck(value: unknown): GrantAck {
  shape({
    ...route,
    type: literal("grant_ack"),
    workers: sorted(pubkey, 100),
    operations: sorted(oneOf(ACTIONS), ACTIONS.length),
    state: oneOf(["active", "revoked"]),
    issued_at: int,
  })(value, "grant_ack");
  const ack = value as GrantAck;
  if (ack.owner === ack.controller)
    fail("grant_ack.controller", "must not be the owner");
  return ack;
}

// --- Events ---------------------------------------------------------------

/** The tag that marks a kind 9 message as a protocol record rather than
 * something a person typed. */
export const controlTag = (kind: Kind | "relay") =>
  ["control", "solo_worker", String(SOLO_WORKER_VERSION), kind] as const;
const marked = (event: BuzzEvent, kind: Kind | "relay") => {
  const expected = controlTag(kind);
  const marks = event.tags.filter((tag) => tag[0] === "control");
  return (
    marks.length === 1 &&
    marks[0]?.length === expected.length &&
    expected.every((part, index) => marks[0]?.[index] === part)
  );
};
const CHECKS: Readonly<Record<Kind, (value: unknown) => Route>> = {
  request: checkIntent,
  response: checkResponse,
  grant_ack: checkGrantAck,
};
const SIGNER: Readonly<Record<Kind, keyof Route>> = {
  request: "controller",
  response: "owner",
  grant_ack: "owner",
};

/** The message carrying `record` in its control channel. A response also
 * names the request messages it answers (`answers`), including any repeat of
 * the request, since the agent looks for answers by message. */
export function recordTemplate(
  record: Intent | Response | GrantAck,
  answers: readonly string[] = [],
): Template {
  CHECKS[record.type](record);
  return {
    kind: 9,
    content: canonical(record),
    tags: [
      ["h", record.stream],
      [...controlTag(record.type)],
      ...(record.type === "response" ? answers.map((id) => ["e", id]) : []),
    ],
  };
}

/** The record of kind `kind` that a signed `event` carries, checked against
 * its signer and channel; undefined when the event is no such record. */
export function readRecord(
  event: BuzzEvent,
  kind: "request",
): Intent | undefined;
export function readRecord(
  event: BuzzEvent,
  kind: "response",
): Response | undefined;
export function readRecord(
  event: BuzzEvent,
  kind: "grant_ack",
): GrantAck | undefined;
export function readRecord(event: BuzzEvent, kind: Kind) {
  const channels = event.tags.filter((tag) => tag[0] === "h");
  if (event.kind !== 9 || !marked(event, kind) || channels.length !== 1)
    return undefined;
  let record: Route;
  try {
    eventDto(event);
    record = CHECKS[kind](parseCanonical(event.content));
  } catch {
    return undefined;
  }
  if (
    record.stream !== channels[0]?.[1] ||
    record[SIGNER[kind]] !== event.pubkey
  )
    return undefined;
  return record;
}

/** Whether `response` answers request `id` with `intent`'s exact route. The
 * messages a read returns must come from the Solo it asked about, written by
 * its worker or relayed there by the owner. */
export function answers(response: Response, intent: Intent, id: string) {
  if (
    response.request !== id ||
    response.action !== intent.action ||
    canonical(routeOf(response)) !== canonical(routeOf(intent))
  )
    return false;
  if (response.action !== "read" || !response.result) return true;
  const { worker, events } = response.result as {
    worker: string;
    events: BuzzEvent[];
  };
  return events.every((event) => {
    const channels = event.tags.filter((tag) => tag[0] === "h");
    return (
      event.kind === 9 &&
      channels.length === 1 &&
      channels[0]?.[1] === intent.args.solo &&
      (event.pubkey === worker ||
        (event.pubkey === intent.owner && marked(event, "relay")))
    );
  });
}
const routeOf = ({
  owner,
  controller,
  stream,
  community,
  device,
  grant,
}: Route) => ({
  owner,
  controller,
  stream,
  community,
  device,
  grant,
});

/** The owner's latest word on one request: the highest revision. Two
 * different responses at that revision cannot both be true: `conflict`. */
export function latest(
  responses: readonly Response[],
): Response | "conflict" | undefined {
  let best: Response | undefined;
  let conflict = false;
  for (const response of responses) {
    if (!best || response.revision > best.revision) {
      best = response;
      conflict = false;
    } else if (
      response.revision === best.revision &&
      canonical(response) !== canonical(best)
    )
      conflict = true;
  }
  return conflict ? "conflict" : best;
}
