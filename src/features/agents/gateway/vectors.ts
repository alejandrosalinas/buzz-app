// Shared reference vectors. Adapters that carry their own copy of the
// contract's pure functions (Pi's host, which loads raw; native admission in
// Rust) run these and must agree with the TypeScript here, which runs them
// in vectors.test.ts. Values match the contract's message, timer and
// standalone reference fixtures.

import type { AdmissionInput, AdmissionOutput } from "./admission";
import type {
  GatewayBinding,
  GatewayIdentity,
  GatewayProfile,
  TurnContext,
} from "./contract";

const SESSION = "11111111-1111-4111-8111-111111111111";
/** A neutral header profile: deployed names come only from the build's
 * descriptor. Matches the full profile in descriptor-vectors.json. */
export const VECTOR_PROFILE: GatewayProfile = Object.freeze({
  launcher_client: "client-a",
  headers: Object.freeze({
    launcher_client: "x-gw-launcher-client",
    launcher_session: "x-gw-launcher-session",
    human_pubkey: "x-gw-ctx-human-pubkey",
    agent_pubkey: "x-gw-ctx-agent-pubkey",
    community_id: "x-gw-ctx-community-id",
    channel_id: "x-gw-ctx-channel-id",
    message_id: "x-gw-ctx-message-id",
    thread_id: "x-gw-ctx-thread-id",
  }),
  reserved_prefixes: Object.freeze(["x-gw-ctx-"]),
});
export const VECTOR_IDENTITY: GatewayIdentity = Object.freeze({
  community_id: "22222222-2222-4222-8222-222222222222",
  human_pubkey: "a".repeat(64),
  agent_pubkey: "b".repeat(64),
});
export const VECTOR_BINDING: GatewayBinding = Object.freeze({
  v: 1,
  client_session_id: SESSION,
  identity: VECTOR_IDENTITY,
});
const IDENTITY_HEADERS = {
  "x-gw-launcher-client": "client-a",
  "x-gw-launcher-session": SESSION,
  "x-gw-ctx-human-pubkey": "a".repeat(64),
  "x-gw-ctx-agent-pubkey": "b".repeat(64),
  "x-gw-ctx-community-id": "22222222-2222-4222-8222-222222222222",
};

/** `inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, turn)` gives `headers`, in this order. */
export const INFERENCE_VECTORS: readonly Readonly<{
  name: string;
  turn: TurnContext;
  headers: Readonly<Record<string, string>>;
}>[] = [
  {
    name: "message",
    turn: {
      channel_id: "33333333-3333-4333-8333-333333333333",
      message_id: "c".repeat(64),
      thread_id: "d".repeat(64),
    },
    headers: {
      ...IDENTITY_HEADERS,
      "x-gw-ctx-channel-id": "33333333-3333-4333-8333-333333333333",
      "x-gw-ctx-message-id": "c".repeat(64),
      "x-gw-ctx-thread-id": "d".repeat(64),
    },
  },
  {
    name: "timer",
    turn: {
      channel_id: "33333333-3333-4333-8333-333333333333",
      message_id: null,
      thread_id: "d".repeat(64),
    },
    headers: {
      ...IDENTITY_HEADERS,
      "x-gw-ctx-channel-id": "33333333-3333-4333-8333-333333333333",
      "x-gw-ctx-thread-id": "d".repeat(64),
    },
  },
  {
    name: "standalone",
    turn: {
      channel_id: null,
      message_id: null,
      thread_id: null,
    },
    headers: {
      ...IDENTITY_HEADERS,
    },
  },
];

/** `composeGatewayHeaders(VECTOR_PROFILE, assembled, bundle)` gives
 * `composed`. */
export const COMPOSE_VECTORS: readonly Readonly<{
  name: string;
  assembled: Readonly<Record<string, string>>;
  bundle: Readonly<Record<string, string>>;
  composed: Readonly<Record<string, string>>;
}>[] = [
  {
    name: "other headers pass through and the bundle is added",
    assembled: {
      Authorization: "Bearer x",
      "content-type": "application/json",
    },
    bundle: { "x-gw-launcher-client": "client-a" },
    composed: {
      Authorization: "Bearer x",
      "content-type": "application/json",
      "x-gw-launcher-client": "client-a",
    },
  },
  {
    name: "reserved headers are dropped in any case or spelling, even ones the bundle omits",
    assembled: {
      "X-Gw-Launcher-Session": "stale",
      "x-gw-ctx-message-id": "stale",
      "X-GW-CTX-THREAD-ID": "stale",
      X_GW_CTX_CHANNEL_ID: "stale",
      "x_gw-launcher_client": "stale",
      "x-gw-launcher-client": "other",
    },
    bundle: { "x-gw-launcher-client": "client-a" },
    composed: { "x-gw-launcher-client": "client-a" },
  },
  {
    name: "a discovery subset composes, with null headers left out",
    assembled: { "x-gw-ctx-purpose": "stale" },
    bundle: {
      "x-gw-launcher-client": "client-a",
      "x-gw-ctx-human-pubkey": "a".repeat(64),
      "x-gw-ctx-agent-pubkey": "b".repeat(64),
      "x-gw-ctx-community-id": "22222222-2222-4222-8222-222222222222",
    },
    composed: {
      "x-gw-launcher-client": "client-a",
      "x-gw-ctx-human-pubkey": "a".repeat(64),
      "x-gw-ctx-agent-pubkey": "b".repeat(64),
      "x-gw-ctx-community-id": "22222222-2222-4222-8222-222222222222",
    },
  },
  {
    name: "unreserved x-gw headers are not Buzz's to remove",
    assembled: {
      "x-gw-request-id": "keep",
      "x-gw-launcher": "keep",
      "x-gw-buzz": "keep",
    },
    bundle: {},
    composed: {
      "x-gw-request-id": "keep",
      "x-gw-launcher": "keep",
      "x-gw-buzz": "keep",
    },
  },
];
/** Bundles `composeGatewayHeaders` must refuse. */
export const COMPOSE_REFUSED: readonly Readonly<Record<string, string>>[] = [
  { authorization: "Bearer x" },
  { "X-Gw-Launcher-Client": "client-a" },
  { x_gw_ctx_channel_id: "x" },
  // Retired context headers, and any other name under the reserved prefix.
  { "x-gw-ctx-purpose": "inference" },
  { "x-gw-ctx-trigger-kind": "message" },
  { "x-gw-ctx-trigger-id": "c".repeat(64) },
  { "x-gw-ctx-trigger-author-pubkey": "e".repeat(64) },
  { "x-gw-ctx-message-created-at": "1793821398" },
  { "x-gw-ctx-unknown": "x" },
];

type AdmitsRoute =
  | Readonly<{ kind: "external"; revision: number }>
  | Readonly<{
      kind: "eligible";
      identity: GatewayIdentity;
      revision: number;
    }>
  | Readonly<{
      kind: "blocked";
      reason: string;
      message: string;
      revision: number;
    }>;
/** `bindingAdmits(route, VECTOR_BINDING)` gives `result` (message aside). */
export const ADMITS_VECTORS: readonly Readonly<{
  name: string;
  route: AdmitsRoute;
  result: Readonly<{ ok: boolean; reason?: string; revision: number }>;
}>[] = [
  {
    name: "eligible with the same identity",
    route: { kind: "eligible", identity: VECTOR_IDENTITY, revision: 4 },
    result: { ok: true, revision: 4 },
  },
  {
    name: "eligible with another agent",
    route: {
      kind: "eligible",
      identity: { ...VECTOR_IDENTITY, agent_pubkey: "f".repeat(64) },
      revision: 5,
    },
    result: { ok: false, reason: "binding_changed", revision: 5 },
  },
  {
    name: "eligible in another community",
    route: {
      kind: "eligible",
      identity: {
        ...VECTOR_IDENTITY,
        community_id: "44444444-4444-4444-8444-444444444444",
      },
      revision: 5,
    },
    result: { ok: false, reason: "binding_changed", revision: 5 },
  },
  {
    name: "pending readiness keeps its reason",
    route: {
      kind: "blocked",
      reason: "readiness_pending",
      message: "",
      revision: 6,
    },
    result: { ok: false, reason: "readiness_pending", revision: 6 },
  },
  {
    name: "auth failure keeps its reason",
    route: { kind: "blocked", reason: "auth", message: "", revision: 7 },
    result: { ok: false, reason: "auth", revision: 7 },
  },
  {
    name: "external never admits a gateway binding",
    route: { kind: "external", revision: 8 },
    result: { ok: false, reason: "binding_changed", revision: 8 },
  },
];

/** Steps through `admit` from INITIAL_ADMISSION, one native scope per
 * vector unless a step closes it. Each step's output must match. */
export const ADMISSION_VECTORS: readonly Readonly<{
  name: string;
  steps: readonly Readonly<{
    input: AdmissionInput;
    output: AdmissionOutput;
  }>[];
}>[] = [
  {
    name: "pending then ready opens at the ready revision only",
    steps: [
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 1, admits: false },
      },
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 2, admits: true },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "admitted", revision: 2 },
      },
    ],
  },
  {
    // The page discards a probe that settles after the revision moved, so
    // nothing is pushed for it; the route stays at the newer pending one.
    name: "a stale probe success pushes nothing and opens nothing",
    steps: [
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 2, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "refused", current: 2, admits: false },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
    ],
  },
  {
    name: "reordered pushes: ready before the pending it followed",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "stale" },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 2, admits: false },
        output: { type: "stale" },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "admitted", revision: 2 },
      },
    ],
  },
  {
    name: "a higher revision terminally revokes, and a later ready never reopens",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 3, admits: false },
        output: { type: "applied", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "push", revision: 4, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "open", handle: "g2", revision: 4 },
        output: { type: "opened", current: 4 },
      },
      {
        input: { type: "request", handle: "g2" },
        output: { type: "admitted", revision: 4 },
      },
    ],
  },
  {
    name: "a ready revision revokes generations opened under older ones",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 4, admits: true },
        output: { type: "applied", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
    ],
  },
  {
    // A reloaded page is a new native scope: its routes count from 1 again.
    name: "page reload revokes the old scope's generations",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "close_scope" },
        output: { type: "closed", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "open", handle: "g2", revision: 2 },
        output: { type: "opened", current: 2 },
      },
    ],
  },
  {
    name: "a handle opens once",
    steps: [
      {
        input: { type: "push", revision: 1, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "opened", current: 1 },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 1, admits: true },
      },
    ],
  },
];
