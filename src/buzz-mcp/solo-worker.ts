// The Solo worker tools: an agent its owner has authorized asks the owner's
// Buzz to start, message, read, stop and archive workers in their Solo
// chats. Each call is one protocol request (see solo-worker-protocol.ts),
// signed by this agent and posted in its private control channel with the
// owner; the answer counts only when the owner's Buzz signs it there. The
// owner's Buzz decides everything: these tools find the channel, ask and
// report what it said.
import { channelVisibility } from "../features/relay/channel-details-protocol";
import type { RelayEvent } from "../features/relay/events";
import type { BuzzClient, BuzzEvent } from "./client";
import {
  ACK_HORIZON,
  ADMISSION_WINDOW,
  type Action,
  answers,
  checkArgs,
  checkIntent,
  type GrantAck,
  type Intent,
  intentId,
  latest,
  MUTATIONS,
  type Phase,
  PAGE_MAX,
  readRecord,
  recordTemplate,
  type Response,
  SOLO_WORKER_VERSION,
  TEXT_MAX,
  TITLE_MAX,
} from "./solo-worker-protocol";

/** How long a call waits for the owner's answer, and how often it looks. */
const WAIT_MS = 20_000;
const POLL_MS = 1_000;
/** Memberships read while finding the agent's control channel. */
const SCAN_MAX = 500;
/** Candidate channels whose privacy and grant are read at once. */
const READS_AT_ONCE = 8;
/** Phases after which the owner's Buzz will say more. */
const INTERIM: readonly Phase[] = ["accepted", "preparing", "stop_pending"];

export type Clock = Readonly<{
  /** Seconds since the epoch. */
  now(): number;
  wait(ms: number): Promise<void>;
}>;
const SYSTEM: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const str = { type: "string" } as const;
const owner = {
  ...str,
  description:
    "Owner's public key (hex). Without it, only your own owner's grant is used; give it to run another person's workers.",
};
const solo = { ...str, description: "The worker's Solo chat id." };
const epoch = {
  type: "integer",
  description: "worker_epoch from the latest create, list or read.",
} as const;
const retry = {
  type: "object",
  description:
    "The retry request from an earlier unsent or pending answer. Sends that same request again; give nothing else with it except owner, which is needed again if you gave it for that request.",
} as const;
const limit = { type: "integer", minimum: 1, maximum: PAGE_MAX } as const;
const workerTool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[],
  annotations: Readonly<{ readOnlyHint?: true; destructiveHint?: boolean }>,
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { owner, ...properties },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, ...annotations },
});

export const SOLO_WORKER_TOOLS = [
  workerTool(
    "solo_worker_connections",
    "The owners whose Solo workers you may run, each with the workers and actions they allow. None means no owner has authorized you yet; only the owner can, in Buzz.",
    {},
    [],
    { readOnlyHint: true },
  ),
  workerTool(
    "solo_worker_readiness",
    "Whether the owner's Buzz can take worker requests now.",
    {},
    [],
    { destructiveHint: false },
  ),
  workerTool(
    "solo_worker_create",
    "Start an idle worker in a new Solo chat. Give it work with solo_worker_send.",
    {
      worker: { ...str, description: "The worker's public key (hex)." },
      title: { ...str, maxLength: TITLE_MAX },
      retry,
    },
    [],
    { destructiveHint: false },
  ),
  workerTool(
    "solo_worker_send",
    "Send a worker a message in its Solo chat.",
    { solo, worker_epoch: epoch, text: { ...str, maxLength: TEXT_MAX }, retry },
    [],
    { destructiveHint: false },
  ),
  workerTool(
    "solo_worker_read",
    "A worker's state and its Solo chat's messages, oldest first.",
    {
      solo,
      limit,
      after: { ...str, description: "next from the previous page." },
    },
    ["solo"],
    { destructiveHint: false },
  ),
  workerTool(
    "solo_worker_stop",
    "Stop a worker's current turn.",
    { solo, worker_epoch: epoch, retry },
    [],
    { destructiveHint: true },
  ),
  workerTool(
    "solo_worker_archive",
    "Archive a worker's Solo chat. Stop the worker first.",
    { solo, retry },
    [],
    { destructiveHint: true },
  ),
  workerTool(
    "solo_worker_list",
    "The workers you have started for the owner, newest first.",
    {
      limit,
      archived: { type: "boolean" },
      cursor: { ...str, description: "next from the previous page." },
    },
    [],
    { destructiveHint: false },
  ),
] as const;

const PREFIX = "solo_worker_";
export const isSoloWorkerTool = (name: string) =>
  SOLO_WORKER_TOOLS.some((tool) => tool.name === name);

/** Runs Solo worker tool `name` as `client`. A throw is a tool error for the
 * agent to correct; anything the owner's Buzz says is an answer. */
export async function callSoloWorkerTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
  clock: Clock = SYSTEM,
): Promise<string> {
  const tool = SOLO_WORKER_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const extra = Object.keys(args).filter(
    (key) => !Object.hasOwn(tool.inputSchema.properties, key),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  const found = await connections(client, clock);
  if (name === "solo_worker_connections")
    return JSON.stringify({
      connections: found.connections.map(
        ({ owner, stream, workers, operations, state }) => ({
          owner,
          stream,
          workers,
          actions: operations,
          state,
        }),
      ),
      complete: found.complete,
    });
  const action = name.slice(PREFIX.length) as Action;
  const route = pick(found, args.owner, client.owner, action);
  if (args.retry !== undefined) {
    if (Object.keys(args).some((key) => key !== "retry" && key !== "owner"))
      throw new Error("Give retry on its own, or with owner.");
    return JSON.stringify(
      await resend(client, route, action, args.retry, clock),
    );
  }
  const request = { ...args };
  delete request.owner;
  if (action === "read" || action === "list") request.limit ??= 20;
  if (action === "list") request.archived ??= false;
  // Before readiness, so a malformed change posts nothing.
  checkArgs(action, request);
  if (
    action === "create" &&
    typeof request.worker === "string" &&
    !route.workers.includes(request.worker)
  )
    throw new Error("The owner has not allowed you to run that worker.");
  // Discovery checked the channel before reading the grant; check it again
  // just before the first request, which names the worker and the route.
  await requirePrivate(client, clock, route);
  if (!MUTATIONS.includes(action))
    return JSON.stringify(
      await exchange(
        client,
        intent(client, route, action, request, clock.now()),
        clock,
      ),
    );
  // A change needs the owner's current custody epoch, which readiness gives.
  const ready = await exchange(
    client,
    intent(client, route, "readiness", {}, clock.now()),
    clock,
  );
  if (ready.phase !== "ready" || !ready.result)
    return JSON.stringify({
      ...ready,
      note: `${ready.note ? `${ready.note} ` : ""}The owner's Buzz is not ready, so the change was not sent.`,
    });
  // The change may carry task text, and the channel had time to change while
  // the owner answered.
  await requirePrivate(client, clock, route);
  const { custody_epoch, valid_until } = ready.result as {
    custody_epoch: string;
    valid_until: number;
  };
  // Readiness is the owner's clock, so the change is issued on it too: then
  // skew between the two clocks neither shortens nor stretches that window.
  return JSON.stringify(
    await exchange(
      client,
      intent(
        client,
        route,
        action,
        request,
        ready.observed_at as number,
        custody_epoch,
        valid_until,
      ),
      clock,
    ),
  );
}

function intent(
  client: BuzzClient,
  route: GrantAck,
  action: Action,
  args: Readonly<Record<string, unknown>>,
  now: number,
  custody?: string,
  validUntil = Number.POSITIVE_INFINITY,
): Intent {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return checkIntent({
    v: SOLO_WORKER_VERSION,
    type: "request",
    action,
    owner: route.owner,
    controller: client.pubkey,
    stream: route.stream,
    community: route.community,
    device: route.device,
    grant: route.grant,
    nonce,
    issued_at: now,
    admit_before: Math.min(now + ADMISSION_WINDOW, validUntil),
    ...(custody ? { custody_epoch: custody } : {}),
    args,
  });
}

/** Sends a request from an earlier answer again, unchanged, so the owner's
 * Buzz can report what happened to it rather than act twice. */
async function resend(
  client: BuzzClient,
  route: GrantAck,
  action: Action,
  value: unknown,
  clock: Clock,
) {
  const request = checkIntent(value);
  if (
    request.action !== action ||
    request.controller !== client.pubkey ||
    request.owner !== route.owner ||
    request.stream !== route.stream
  )
    throw new Error(
      `That retry is not a ${PREFIX}${action} request of yours for this owner.`,
    );
  // Discovery read other channels after checking this one.
  await requirePrivate(client, clock, route);
  return exchange(client, request, clock);
}

type Outcome = Readonly<{
  status: "answered" | "pending" | "unsent";
  request: string;
  phase?: Phase;
  reason?: string;
  result?: unknown;
  /** When the owner's Buzz answered, by its clock. */
  observed_at?: number;
  /** Present when the outcome is not known: pass it as `retry` to ask again. */
  retry?: Intent;
  note?: string;
}>;

/** Posts `request` and waits for the owner's Buzz to answer it. */
async function exchange(
  client: BuzzClient,
  request: Intent,
  clock: Clock,
): Promise<Outcome> {
  const id = await intentId(request);
  const retry = MUTATIONS.includes(request.action) ? { retry: request } : {};
  const deadline = clock.now() + WAIT_MS / 1000;
  let posted: BuzzEvent | typeof LATE;
  try {
    posted = await by(deadline, clock, client.publish(recordTemplate(request)));
  } catch (error) {
    return {
      status: "unsent",
      request: id,
      ...retry,
      note: `Posting the request failed (${error instanceof Error ? error.message : String(error)}). It may still have arrived.`,
    };
  }
  if (posted === LATE)
    return {
      status: "unsent",
      request: id,
      ...retry,
      note: "Posting the request did not finish in time. It may still have arrived.",
    };
  let answer: Response | undefined;
  for (;;) {
    let events: readonly BuzzEvent[] | typeof LATE;
    try {
      events = await by(
        deadline,
        clock,
        client.query([
          {
            kinds: [9],
            "#h": [request.stream],
            "#e": [posted.id],
            authors: [request.owner],
            limit: 50,
          },
        ]),
      );
    } catch (error) {
      return {
        status: "pending",
        request: id,
        ...(answer ? { phase: answer.phase } : {}),
        ...retry,
        note: `Checking for the answer failed (${error instanceof Error ? error.message : String(error)}). The request was sent and may have run.`,
      };
    }
    if (events === LATE) break;
    const word = latest(
      events.flatMap((event) => {
        const response = readRecord(event, "response");
        return response && answers(response, request, id) ? [response] : [];
      }),
    );
    if (word === "conflict")
      return {
        status: "answered",
        request: id,
        phase: "uncertain",
        reason: "conflict",
        ...retry,
        note: "The owner's Buzz gave two different answers.",
      };
    answer = word;
    if ((answer && !INTERIM.includes(answer.phase)) || clock.now() >= deadline)
      break;
    await clock.wait(POLL_MS);
  }
  if (!answer || INTERIM.includes(answer.phase))
    return {
      status: "pending",
      request: id,
      ...(answer ? { phase: answer.phase } : {}),
      ...retry,
      note: answer
        ? "Still in progress; ask again with retry to see how it ends."
        : "No answer yet: the owner's Buzz may be closed. No answer does not mean it did nothing.",
    };
  return {
    status: "answered",
    request: id,
    phase: answer.phase,
    observed_at: answer.observed_at,
    ...(answer.reason ? { reason: answer.reason } : {}),
    ...(answer.result ? { result: shown(answer, request) } : {}),
  };
}

const LATE = Symbol("late");

/** What `work` gives, or `LATE` if it is still unsettled at `deadline`, so a
 * stalled relay cannot hold a call past its wait. */
async function by<T>(deadline: number, clock: Clock, work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof LATE>((resolve) => {
        timer = setTimeout(
          resolve,
          Math.max(0, deadline - clock.now()) * 1000,
          LATE,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A read's messages as the agent needs them, not as signed events. */
function shown(response: Response, request: Intent) {
  if (response.action !== "read" || !response.result) return response.result;
  const { events, ...rest } = response.result as { events: BuzzEvent[] };
  return {
    ...rest,
    messages: [...events]
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
      .map((event) => ({
        id: event.id,
        from: event.pubkey === request.owner ? "you" : "worker",
        at: event.created_at,
        text: event.content,
      })),
  };
}

/** The owners' grants to this agent: the latest acknowledgement in each
 * private channel whose only members are this agent and its owner. Authority
 * is the owner's signature there; the relay-signed roster and metadata say
 * where to look, who the other member is and that the channel is still
 * private, so a connection that cannot verify them finds nothing. */
async function connections(client: BuzzClient, clock: Clock) {
  const { relayAuthor } = client;
  if (relayAuthor === undefined)
    throw new Error(
      "This Buzz connection does not know its relay's key, so it cannot verify channel members or find an owner's grant.",
    );
  const query = bounded(client, clock);
  const streams = new Map<string, string>();
  const seen = new Set<string>();
  const complete = await scan(
    query,
    // From the relay's writer, like the metadata below: a replica may lag
    // behind a member being added.
    {
      kinds: [39002],
      "#p": [client.pubkey],
      authors: [relayAuthor],
      consistency: "strong",
    },
    (event) => {
      if (event.pubkey !== relayAuthor) return true;
      const stream = event.tags.find((tag) => tag[0] === "d")?.[1];
      // Newest first, and only a channel's newest roster counts.
      if (!stream || seen.has(stream)) return true;
      seen.add(stream);
      const other = partner(event, client.pubkey);
      if (other) streams.set(stream, other);
      return true;
    },
  );
  // A few channels at a time, so many of them still fit in the deadline.
  const candidates = [...streams];
  const found: (GrantAck | undefined)[] = [];
  const check = async (index: number) => {
    const [stream, owner] = candidates[index] as [string, string];
    if (!(await isPrivate(query, relayAuthor, stream))) return;
    const events = await query({
      kinds: [9],
      "#h": [stream],
      authors: [owner],
      limit: ACK_HORIZON,
      consistency: "strong",
    });
    // The highest revision is the owner's latest word on the grant; records
    // from the same second come back in no useful order.
    let ack: GrantAck | undefined;
    for (const event of events) {
      const record = readRecord(event, "grant_ack");
      if (
        record?.controller === client.pubkey &&
        (!ack || record.grant.revision > ack.grant.revision)
      )
        ack = record;
    }
    found[index] = ack;
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: READS_AT_ONCE }, async () => {
      while (next < candidates.length) await check(next++);
    }),
  );
  return {
    connections: found.filter((ack) => ack !== undefined),
    complete,
  };
}

type Query = (filter: Record<string, unknown>) => Promise<readonly BuzzEvent[]>;

/** `client.query` under one shared wait, failing once it has passed. */
function bounded(client: BuzzClient, clock: Clock): Query {
  const deadline = clock.now() + WAIT_MS / 1000;
  return async (filter) => {
    const events = await by(deadline, clock, client.query([filter]));
    if (events === LATE)
      throw new Error(
        "Checking the owner's grant took too long, so nothing was sent. Try again.",
      );
    return events;
  };
}

/** The other member of a roster listing exactly this agent and one other. */
function partner(roster: BuzzEvent, agent: string) {
  const members = new Set(
    roster.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]),
  );
  const [other] = [...members].filter((key) => key !== agent);
  return members.size === 2 && members.has(agent) ? other : undefined;
}

/** Whether the relay marks `stream` private. Requests, retries included, are
 * posted before the owner can refuse them, so only a private channel may
 * carry them: read from the relay's writer, which a replica may lag. */
async function isPrivate(query: Query, relayAuthor: string, stream: string) {
  const [metadata] = await query({
    kinds: [39000],
    "#d": [stream],
    authors: [relayAuthor],
    limit: 1,
    consistency: "strong",
  });
  return (
    metadata?.pubkey === relayAuthor &&
    channelVisibility(metadata as RelayEvent) === "private"
  );
}

/** Refuses unless `route`'s channel is still private to this agent and its
 * owner, just before a request that may carry task text is posted there. */
async function requirePrivate(
  client: BuzzClient,
  clock: Clock,
  { stream, owner }: GrantAck,
) {
  const relayAuthor = client.relayAuthor as string;
  const query = bounded(client, clock);
  const [roster] = await query({
    kinds: [39002],
    "#d": [stream],
    authors: [relayAuthor],
    limit: 1,
    consistency: "strong",
  });
  if (
    roster?.pubkey !== relayAuthor ||
    partner(roster, client.pubkey) !== owner ||
    !(await isPrivate(query, relayAuthor, stream))
  )
    throw new Error(
      "The channel is no longer private to you and the owner, so the request was not sent.",
    );
}

/** The grant to use: `owner`'s, or else only that of `mine`, the agent's own
 * owner as its host records it. Anyone can grant an agent their own workers,
 * so another person's grant, which would receive the agent's task text, is
 * never chosen unless named. */
function pick(
  found: Awaited<ReturnType<typeof connections>>,
  owner: unknown,
  mine: string | undefined,
  action: Action,
) {
  const wanted = owner ?? mine;
  const active = found.connections.filter(
    (connection) =>
      connection.state === "active" &&
      (wanted === undefined || connection.owner === wanted),
  );
  const [route] = active;
  if (!route)
    throw new Error(
      owner === undefined &&
        found.connections.some((connection) => connection.state === "active")
        ? `Your own owner has not authorized you${found.complete ? "" : ", as far as could be found"}. To run another person's workers, give owner.`
        : `No owner has authorized you to run their workers${owner === undefined ? "" : " for that owner"}${found.complete ? "" : ", as far as could be found"}. Only the owner can, in Buzz.`,
    );
  if (wanted === undefined)
    throw new Error("Give owner: the person whose workers you mean to run.");
  if (active.length > 1)
    throw new Error(
      "That owner has authorized you in more than one channel; ask them to revoke one.",
    );
  if (!route.operations.includes(action))
    throw new Error(`The owner has not allowed ${PREFIX}${action}.`);
  return route;
}

/** Visits matching events newest first; false when the budget ran out. */
async function scan(
  query: (filter: Record<string, unknown>) => Promise<readonly BuzzEvent[]>,
  filter: Record<string, unknown>,
  visit: (event: BuzzEvent) => boolean,
) {
  let count = 0;
  for (let cursor = {}; ; ) {
    const page = await query({ ...filter, ...cursor, limit: PAGE_MAX });
    for (const event of page) {
      if (++count > SCAN_MAX) return false;
      if (!visit(event)) return true;
    }
    const last = page.at(-1);
    if (!last || page.length < PAGE_MAX) return true;
    cursor = { until: last.created_at, before_id: last.id };
  }
}
