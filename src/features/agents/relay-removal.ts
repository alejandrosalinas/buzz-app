import type { EventData } from "../relay/events";
import type { LocalEvents, Outbox } from "../relay/outbox";
import type { IdentityAttest } from "../relay/identity-archives";
import type { RelaySession } from "../relay/session";

type RemovalSession = Pick<
  RelaySession,
  "outbox" | "channels" | "channelWrites" | "archives"
>;

/** A fresh owner proof (NIP-OA) for an agent the caller owns. */
export type OwnerProof = (
  pubkey: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

/** How the caller proves it owns an agent: `issue`, a fresh owner proof
 * (NIP-OA); `attest`, only with the agent's key, republishes its own profile
 * with its saved owner proof when the profile has none. */
export type OwnerConsent = { issue: OwnerProof; attest?: IdentityAttest };

/** Archives the agent unless a read started now finds it archived already, so
 * a retry goes on past it. Rejects unless the relay confirms the archive.
 * "skipped": the community advertises no archive authority, so nothing is
 * hidden by one there and Delete goes on without it. */
export async function archiveAgent(
  session: Pick<RelaySession, "archives">,
  pubkey: string,
  signal: AbortSignal,
  owner?: OwnerConsent,
): Promise<"archived" | "skipped"> {
  const { archives } = session;
  if (!archives.supported) return "skipped";
  if (!archives.writable)
    throw new Error("Archive is unavailable on this connection");
  // The archive cache is not live; this needs a read started now.
  await archives.ensure();
  await archives.refresh();
  signal.throwIfAborted();
  const state = archives.state(pubkey);
  // An unfinished read says nothing, least of all "not archived".
  if (state === "unknown") throw new Error("Archive state is unknown");
  if (state === "not-archived")
    await archives.request(
      "archive",
      pubkey,
      signal,
      owner?.issue,
      owner?.attest,
    );
  return "archived";
}

/** Remove a relay-only agent from this community: archive its identity,
 * delete the owner's kind 30177 record, then try to remove it from its
 * channels. Archive and record deletion must succeed; a refusal stops the
 * later steps and Remove stays retryable. Channel removal is best effort: its
 * failure does not fail the removal. */
export async function removeRelayAgent(
  session: RemovalSession,
  viewer: string,
  pubkey: string,
  signal: AbortSignal,
  owner?: OwnerConsent,
): Promise<void> {
  await archiveAgent(session, pubkey, signal, owner);
  await deleteAgentRecord(session, viewer, pubkey, signal);
  try {
    await removeAgentFromChannels(session, pubkey, signal);
  } catch (error) {
    signal.throwIfAborted();
    // Best effort: leave no failed channel removals in the outbox to retry.
    const outbox = session.outbox;
    await Promise.all(
      (outbox?.snapshot() ?? [])
        .filter(
          ({ event, delivery }) =>
            delivery !== "sending" &&
            event.kind === 9001 &&
            event.tags.some(
              ([name, value]) => name === "p" && value === pubkey,
            ),
        )
        .map(({ event }) => outbox?.dismiss(event.id)),
    );
    console.warn("Agent channel removal was not confirmed", error);
  }
}

/** The content and tags of a kind 30177 record as read. */
export type AgentRecordBody = Readonly<{
  content: Readonly<Record<string, unknown>>;
  tags: readonly (readonly string[])[];
}>;
/** The viewer's own kind 30177 record of an agent, as Agents writes it. */
export type AgentRecordEntry = Readonly<{
  pubkey: string;
  name: string;
  /** An HTTPS image URL. */
  picture?: string;
  /** The agent type's key, `pluginId/typeId`, as the `runtime` tag. */
  runtime: string;
  /** The record this replaces, whose other settings and tags it keeps. */
  prior?: AgentRecordBody | undefined;
}>;

/** Publishes the viewer's kind 30177 record of an agent, replacing any
 * before it, and resolves with what it wrote once the relay accepts it.
 * Another desktop applies the record whole to an agent it has with that key,
 * and its parser requires `parallelism` and `respond_to`, so the record keeps
 * every setting of the one it replaces and defaults those two
 * (docs/relay-queries.md, "Managed-agent registration"). */
export async function publishAgentRecord(
  session: Pick<RelaySession, "outbox">,
  { pubkey, name, picture, runtime, prior }: AgentRecordEntry,
  signal: AbortSignal,
): Promise<AgentRecordBody> {
  const outbox = session.outbox;
  if (!outbox?.supports(30177))
    throw new Error("This community cannot list agents.");
  await outbox.ready();
  signal.throwIfAborted();
  const kept = Object.entries(prior?.content ?? {}).filter(
    ([field]) => field !== "picture",
  );
  const content = {
    parallelism: 1,
    respond_to: "owner-only",
    ...Object.fromEntries(kept),
    name,
    ...(picture ? { picture } : {}),
  };
  const tags = [
    ["d", pubkey],
    ["runtime", runtime],
    ...(prior?.tags ?? [])
      .filter(([tag]) => !["d", "runtime", "client-id"].includes(tag ?? ""))
      .map((tag) => [...tag]),
  ];
  const id = outbox.send(
    { kind: 30177, content: JSON.stringify(content), tags },
    undefined,
    () => !signal.aborted,
  );
  await delivered(outbox, id, signal, "The agent list was not updated. Retry.");
  await outbox.dismiss(id);
  return { content, tags };
}

/** NIP-09 coordinate deletion of the viewer's own kind 30177 agent record. */
export async function deleteAgentRecord(
  session: Pick<RelaySession, "outbox">,
  viewer: string,
  pubkey: string,
  signal: AbortSignal,
  fence?: AbortSignal,
) {
  const outbox = session.outbox;
  if (!outbox?.supports(5))
    throw new Error("This community cannot delete agent records.");
  const waits = fenced(signal, fence);
  await outbox.ready();
  waits.throwIfAborted();
  const coordinate = `30177:${viewer}:${pubkey}`;
  const active = () => !waits.aborted;
  const previous = await resumable(
    outbox,
    (event) =>
      event.kind === 5 &&
      event.tags.some(([name, value]) => name === "a" && value === coordinate),
  );
  if (previous) outbox.retry(previous.event.id, active);
  const id =
    previous?.event.id ??
    outbox.send(
      { kind: 5, content: "", tags: [["a", coordinate]] },
      undefined,
      active,
    );
  await delivered(
    outbox,
    id,
    signal,
    "Record deletion is not confirmed. Retry.",
  );
  await outbox.dismiss(id);
}

/** Base Buzz `removeAgentFromAllChannels` over the relay's rosters for this
 * agent plus the viewer's loaded channels, skipping archived ones. Resolves
 * only once a fresh relay read lists the agent in none of them; any refusal or
 * unknown outcome throws after every channel operation has settled. */
export async function removeAgentFromChannels(
  session: Pick<RelaySession, "outbox" | "channels" | "channelWrites">,
  pubkey: string,
  signal: AbortSignal,
) {
  const pending = await session.channelWrites.memberChannels(
    pubkey,
    signal,
    session.channels
      .list()
      .channels.filter((channel) => channel.members?.includes(pubkey))
      .map((channel) => channel.id),
  );
  if (!pending.length) return;
  const outbox = session.outbox;
  if (!outbox?.supports(9001))
    throw new Error("This community cannot remove agents from channels.");
  await outbox.ready();
  signal.throwIfAborted();
  // Nothing new is signed or published for a cancelled Delete.
  const active = () => !signal.aborted;
  // Keep each operation as it is enqueued: a later enqueue can still throw,
  // for example when the outbox is full.
  const operations: string[] = [];
  let enqueueFailure: unknown;
  try {
    for (const id of pending) {
      const previous = await resumable(
        outbox,
        (event) =>
          event.kind === 9001 &&
          event.tags.some(([name, value]) => name === "h" && value === id) &&
          event.tags.some(([name, value]) => name === "p" && value === pubkey),
      );
      // Retry reuses the outbox's own operation, including an unknown result.
      if (previous) {
        outbox.retry(previous.event.id, active);
        operations.push(previous.event.id);
      } else
        operations.push(
          outbox.send(
            {
              kind: 9001,
              content: "",
              tags: [
                ["h", id],
                ["p", pubkey],
              ],
            },
            undefined,
            active,
          ),
        );
    }
  } catch (error) {
    enqueueFailure = error;
  }
  // Settle every enqueued operation before reporting a failure, so no channel
  // removal is still sending when the caller cleans up or its view goes away.
  const outcomes = await Promise.allSettled(
    operations.map((id) =>
      delivered(outbox, id, signal, "Channel removal is not confirmed. Retry."),
    ),
  );
  if (enqueueFailure !== undefined) throw enqueueFailure;
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  // Confirm each channel against its own fresh roster: a cached loaded roster
  // may still list the agent after the relay removed it.
  const listed = await Promise.all(
    pending.map((id) => session.channelWrites.listsMember(id, pubkey, signal)),
  );
  const remaining = listed.filter(Boolean);
  if (remaining.length)
    throw new Error(
      `The relay did not confirm removal from ${remaining.length} channel${remaining.length === 1 ? "" : "s"}. Retry.`,
    );
  // The rosters confirm the outcome; nothing is left for the outbox to retry.
  await Promise.all(operations.map((id) => outbox.dismiss(id)));
}

/** `fence` keeps anything new from being admitted, while a publish already
 * started settles under `signal` alone. */
function fenced(signal: AbortSignal, fence?: AbortSignal) {
  return fence ? AbortSignal.any([signal, fence]) : signal;
}

/** The relay refuses an event more than 15 minutes from its clock, and a
 * retry republishes the same signed event, so an older saved attempt can never
 * land. Removal repeats safely: drop a stale attempt so the caller signs anew. */
const RESUMABLE_ATTEMPT_MS = 10 * 60_000;
async function resumable(
  outbox: Outbox,
  matches: (event: EventData) => boolean,
) {
  const previous = outbox
    .snapshot()
    .find(
      ({ event, delivery }) =>
        delivery !== "accepted" && delivery !== "seen" && matches(event),
    );
  if (
    !previous ||
    previous.delivery === "sending" ||
    Date.now() - previous.event.created_at * 1000 < RESUMABLE_ATTEMPT_MS
  )
    return previous;
  await outbox.dismiss(previous.event.id);
  return undefined;
}

/** Settles once the outbox reports the relay accepted `id`, or rejects with
 * its refusal. */
export function delivered(
  outbox: LocalEvents,
  id: string,
  signal: AbortSignal,
  failure: string,
) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: unknown) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(signal.reason);
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Callers that need more than relay acceptance confirm it themselves.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(new Error(item.error ?? failure));
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}
