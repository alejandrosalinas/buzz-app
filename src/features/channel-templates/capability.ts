import type { RelayReader } from "../relay/reader";
import { isTransientFailure } from "../relay/errors";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { ChannelKitHost } from "./host";
import type { ChannelSummary } from "../relay/contracts";
import {
  CanvasConflictError,
  isDefinitiveCanvasConflict,
} from "./canvas-conflict";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  parseKitRecord,
  type KitEntry,
  type KitRecord,
  type KitValue,
} from "./model";
import { CANVAS_HISTORY_PAGE } from "./canvas-limits";
import { TEAM_MANIFEST_TAG } from "./team-payload";
import { approvedCanvas, CANVAS_INSTRUCTIONS } from "./canvas-approval";

export type CanvasHistoryCursor = { until: number; before_id: string };
export type CanvasHistoryPage = {
  revisions: readonly RelayEvent[];
  next: CanvasHistoryCursor | undefined;
};

export const selectedHead = (events: readonly RelayEvent[]) =>
  [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
/** A verified signature does not bind a query result to the requested Canvas. */
function isChannelCanvas(event: RelayEvent, channel: string) {
  if (event.kind !== 40100) return false;
  const tags = event.tags.filter((tag) => tag[0] === "h");
  return tags.length === 1 && tags[0]?.length === 2 && tags[0][1] === channel;
}
type Snapshot = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  entries: readonly KitEntry[];
  error?: string | undefined;
  /** Set with an error that a later retry can fix; see isTransientFailure. */
  transient?: true | undefined;
};
/** Session-owned reads and narrow recipe operations; the existing outbox owns delivery. */
export function createChannelKit({
  host,
  reader,
  outbox,
  local,
  ready,
  viewer,
  community,
  signal,
  canWrite,
  canRead = canWrite,
  delivered,
}: {
  host: ChannelKitHost | undefined;
  reader: RelayReader;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  ready: Promise<void> | undefined;
  viewer: string;
  community: string;
  signal: AbortSignal;
  canWrite(channel: string): boolean;
  canRead?(channel: string): boolean;
  delivered(id: string): Promise<void>;
}) {
  let state: Snapshot = { status: host ? "idle" : "unavailable", entries: [] };
  let pending: Promise<void> | undefined;
  /** One save per record coordinate; saves of other records proceed. */
  const saving = new Set<string>();
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: Snapshot) => {
    signal.throwIfAborted();
    state = next;
    listeners.forEach((l) => {
      l();
    });
  };
  const fresh = (filters: readonly ReadFilter[], readSignal = signal) =>
    reader.read(filters, { signal: readSignal, fresh: true });
  /** `after: true` never joins a read that began before this call, so the
   * result reflects every change visible when the caller asked. */
  async function refresh({ after = false } = {}) {
    if (!host) return;
    if (pending && after) await pending;
    if (pending) return pending;
    const generation = epoch;
    // A loaded catalog stays ready while it revalidates in the background.
    if (state.status !== "ready")
      update({
        ...state,
        status: "loading",
        error: undefined,
        transient: undefined,
      });
    pending = (async () => {
      try {
        const events = await fresh([
          {
            kinds: [30078],
            authors: [viewer],
            "#t": [KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG],
            limit: 500,
          },
        ]);
        if (events.length >= 500)
          throw new Error(
            "Recipe catalog reached its read limit; no partial catalog will be used",
          );
        const heads = new Map<string, RelayEvent>();
        for (const event of events) {
          const d = event.tags.find((t) => t[0] === "d")?.[1];
          if (
            !d ||
            ![KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG].some((tag) =>
              d?.startsWith(`${tag}:${encodeURIComponent(community)}:`),
            ) ||
            // Retired personal groups: ignore saved records, never reject the catalog.
            d === `${KIT_TAG}:${encodeURIComponent(community)}:groups:personal`
          )
            continue;
          const old = heads.get(d);
          if (!old || selectedHead([event, old])?.id === event.id)
            heads.set(d, event);
        }
        const rows = [...heads.values()],
          entries: KitEntry[] = [];
        for (let start = 0; start < rows.length; start += 16) {
          const batch = rows.slice(start, start + 16);
          const decoded = await host.decode(batch, signal);
          if (!Array.isArray(decoded) || decoded.length !== batch.length)
            throw new Error("Incomplete private recipe decode");
          for (const row of decoded) {
            const event = batch.find((e) => e.id === row.eventId);
            const record = parseKitRecord(row.record, community);
            if (
              !event ||
              event.tags.find((t) => t[0] === "d")?.[1] !== coordinate(record)
            )
              throw new Error("Recipe decode mismatch");
            entries.push({
              record,
              eventId: event.id,
              createdAt: event.created_at,
            });
          }
        }
        // A portable record supersedes an ordinary record for the same team.
        const portable = new Set(
          entries.flatMap((entry) =>
            entry.record.version === 2 ? [entry.record.value.id] : [],
          ),
        );
        const current = entries.filter(
          (entry) =>
            entry.record.version === 2 ||
            entry.record.value.type !== "team" ||
            !portable.has(entry.record.value.id),
        );
        if (generation === epoch) update({ status: "ready", entries: current });
      } catch (error) {
        if (!signal.aborted && generation === epoch)
          update({
            ...state,
            status: "error",
            error: String(error),
            transient: isTransientFailure(error) || undefined,
          });
      } finally {
        if (generation === epoch) pending = undefined;
      }
    })();
    return pending;
  }
  async function confirm(id: string) {
    try {
      if (
        (await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        return;
      const saved = local?.snapshot().find((e) => e.event.id === id);
      if (!saved || Date.now() / 1000 - saved.event.created_at >= 15 * 60)
        throw new Error(
          "This operation could not be confirmed and is too old to replay. Keep your draft and inspect the current result before making a new save.",
        );
      // A proven Canvas CAS refusal cannot become valid by replaying these bytes.
      if (isDefinitiveCanvasConflict(saved)) throw new Error(saved.error);
      await delivered(id);
      if (
        !(await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        throw new Error(
          "Save is awaiting exact relay confirmation; your draft is kept",
        );
    } catch (error) {
      const failed = local?.snapshot().find((item) => item.event.id === id);
      if (outbox && isDefinitiveCanvasConflict(failed)) {
        // Refused before mutation. Release the pending gate, not uncertain saves.
        await outbox.dismiss(id);
        throw new CanvasConflictError();
      }
      throw error;
    }
  }
  /** One replaceable private-record write: fresh head check, unresolved-save
   * guard, enqueue, exact confirmation and selected-head readback. With
   * `resume.id` it confirms that earlier event instead of enqueueing again. */
  async function publish(
    record: KitRecord,
    d: string,
    tag: string,
    expected: string | undefined,
    resume: Resume | undefined,
    operationSignal: AbortSignal | undefined,
  ) {
    // Before enqueue, the caller can cancel preparation. After enqueue, the
    // durable outbox and session own delivery; caller cancellation cannot undo it.
    const preparing = operationSignal
      ? AbortSignal.any([signal, operationSignal])
      : signal;
    preparing.throwIfAborted();
    if (!host || !outbox || saving.has(d))
      throw new Error("Recipe saving is unavailable or already in progress");
    saving.add(d);
    try {
      await ready;
      const head = async (readSignal = signal) =>
        selectedHead(
          await fresh(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": [d],
                limit: 1,
              },
            ],
            readSignal,
          ),
        );
      let id = resume?.id;
      if (!id) {
        preparing.throwIfAborted();
        const current = await head(preparing);
        preparing.throwIfAborted();
        if (current?.id !== expected)
          throw new Error(
            "This saved recipe changed. Refresh the catalog and review your draft before replacing it.",
          );
        const previous = local
          ?.snapshot()
          .find(
            (e) =>
              e.event.kind === 30078 &&
              e.event.tags.some((t) => t[0] === "d" && t[1] === d) &&
              !["accepted", "seen"].includes(e.delivery),
          );
        if (previous)
          throw new Error(
            "A save for this recipe is unresolved. Inspect Outbox and refresh before replacing it.",
          );
        // Replaceable records use seconds. Do not create an ambiguous equal-time replacement.
        if (current && current.created_at >= Math.floor(Date.now() / 1000))
          throw new Error(
            "Please wait a second before saving this recipe again",
          );
        const content = await host.prepare(record, preparing);
        preparing.throwIfAborted();
        id = outbox.send({
          kind: 30078,
          content,
          tags: [
            ["d", d],
            ["t", tag],
          ],
        });
        resume?.enqueued(id);
      }
      await confirm(id);
      if ((await head())?.id !== id)
        throw new Error(
          "Another recipe save is selected. Your draft is kept; refresh and review before saving again.",
        );
      return id;
    } finally {
      saving.delete(d);
    }
  }
  const capability = Object.freeze({
    available: !!host && !!outbox?.supports(30078),
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (state.status === "idle") void refresh();
    },
    refresh,
    async save(
      value: KitValue,
      expected: string | undefined,
      deleted = false,
      operationSignal?: AbortSignal,
      resume?: Resume,
    ) {
      const record = parseKitRecord(
        {
          version: value.type === "team" && value.portable ? 2 : 1,
          community,
          value,
          deleted,
        },
        community,
      );
      const id = await publish(
        record,
        coordinate(record),
        kitTag(record),
        expected,
        resume,
        operationSignal,
      );
      // Another record's save may have started a catalog read before this
      // one was confirmed; do not join it.
      await refresh({ after: true });
      return id;
    },
  });
  const canvas = Object.freeze({
    available: !!outbox?.supports(40100),
    async read(channel: string, { strong = true }: { strong?: boolean } = {}) {
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      return selectedHead(
        (
          await fresh([
            {
              kinds: [40100],
              "#h": [channel],
              limit: 1,
              ...(strong ? { consistency: "strong" as const } : {}),
            },
          ])
        ).filter((event) => isChannelCanvas(event, channel)),
      );
    },
    async history(
      channel: string,
      cursor?: CanvasHistoryCursor,
    ): Promise<CanvasHistoryPage> {
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      const rows = await fresh([
        {
          kinds: [40100],
          "#h": [channel],
          limit: CANVAS_HISTORY_PAGE,
          ...(cursor ?? { consistency: "strong" as const }),
        },
      ]);
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      if (
        rows.some(
          (event) =>
            !isChannelCanvas(event, channel) ||
            (cursor &&
              (event.created_at > cursor.until ||
                (event.created_at === cursor.until &&
                  event.id <= cursor.before_id))),
        )
      )
        throw new Error(
          "Canvas history returned an invalid or non-advancing page",
        );
      const revisions = [
        ...new Map(rows.map((event) => [event.id, event])).values(),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const last = revisions.at(-1);
      return {
        revisions,
        next:
          rows.length >= CANVAS_HISTORY_PAGE && last
            ? { until: last.created_at, before_id: last.id }
            : undefined,
      };
    },
    async save(
      channel: string,
      content: string,
      expected: string | undefined,
      /** Partial editors retain approval; only a full-document save grants it. */
      options?: { preserveApproval: boolean },
    ) {
      signal.throwIfAborted();
      if (!outbox?.supports(40100) || !canWrite(channel))
        throw new Error("Canvas writing is unavailable in this channel");
      if (new TextEncoder().encode(content).length > LIVE_CANVAS_BYTES)
        throw new Error(`Keep Canvas below ${LIVE_CANVAS_LIMIT}`);
      await ready;
      signal.throwIfAborted();
      const head = await canvas.read(channel);
      if (head?.id !== expected) throw new CanvasConflictError();
      const unapproved =
        options?.preserveApproval &&
        (!head || !(await approvedCanvas(head, viewer)));
      signal.throwIfAborted();
      const pending = local
        ?.snapshot()
        .find(
          (e) =>
            e.event.kind === 40100 &&
            e.event.tags.some((t) => t[0] === "h" && t[1] === channel) &&
            !["accepted", "seen"].includes(e.delivery),
        );
      if (pending)
        throw new Error(
          "This channel has an unresolved Canvas save. Inspect Outbox before making another save.",
        );
      if (head && head.created_at >= Math.floor(Date.now() / 1000))
        throw new Error("Please wait a second before saving Canvas again");
      if (!canWrite(channel)) throw new Error("Channel access changed");
      const id = outbox.send({
        kind: 40100,
        content,
        tags: [
          ["h", channel],
          ["expected-revision", expected ?? "none"],
          ...(unapproved ? [[CANVAS_INSTRUCTIONS, "unapproved"]] : []),
        ],
      });
      await confirm(id);
      const selected = await canvas.read(channel);
      if (selected?.id !== id)
        throw new Error(
          "Your save was received, but a different Canvas is selected. Your draft is kept; load the current document.",
        );
      return selected;
    },
  });
  signal.addEventListener(
    "abort",
    () => {
      state = { status: "unavailable", entries: [] };
      listeners.forEach((l) => {
        l();
      });
      listeners.clear();
    },
    { once: true },
  );
  return {
    capability,
    canvas,
    confirm,
    clear() {
      epoch++;
      pending = undefined;
      state = {
        status: host && !signal.aborted ? "idle" : "unavailable",
        entries: [],
      };
      listeners.forEach((l) => {
        l();
      });
    },
  };
}
/** Lets a retry confirm the exact event an earlier attempt enqueued. */
export type Resume = { id?: string | undefined; enqueued(id: string): void };
export type ChannelKit = ReturnType<typeof createChannelKit>["capability"];
export type ChannelCanvas = ReturnType<typeof createChannelKit>["canvas"];
/** Canvas and Todos show a channel read-only until the viewer can write it. */
export const canvasReadOnly = (channel: ChannelSummary | undefined) =>
  !channel || !!channel.archived || !!channel.readOnly || !!channel.cached;
