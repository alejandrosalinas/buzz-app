import { regionLabels } from "../solo/region-labels";
import { getEventHash, verifyEvent } from "nostr-tools";
import type { RelayReader } from "./reader";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import { retryRead } from "./read-retry";
import type { RelayWriter } from "./transport";
import type { RelayEvent } from "./events";
import { PublishRejected } from "./outbox";
import { lifecycleChannelId } from "./channel-lifecycle-protocol";
import {
  detailsSettings,
  detailsTemplate,
  sameLabels,
  validateDetailsDraft,
  summaryAccess,
  type ChannelAccess,
  type ChannelDetails,
  type ChannelDetailsDraft,
} from "./channel-details-protocol";
import { channelIdentityUnsupported } from "./channel-labels";
import { SOLO_NAMED_LABEL, soloLabels } from "../solo/labels";

export type DetailsAttempt = Readonly<{
  draft: ChannelDetailsDraft;
  status: "saving" | "unconfirmed";
}>;
type ChannelNames = Pick<ChannelQueries, "get" | "subscribeList">;

export interface ChannelDetailsCapability {
  readonly available: boolean;
  load(id: string, signal?: AbortSignal): Promise<ChannelDetails>;
  /** Present when this capability's edit rule matches the summary's, so access
   * can show without a read. Absent, callers read details. */
  summaryAccess?(channel: ChannelSummary): ChannelAccess | undefined;
  save(
    base: ChannelDetails,
    draft: ChannelDetailsDraft,
    signal?: AbortSignal,
    /** Checked synchronously right before publishing; false publishes nothing. */
    active?: () => boolean,
    /** Present only for name edits initiated by this app's Solo editor. */
    manualRename?: ChannelNames,
  ): Promise<void>;
  /** An in-memory revision of a matching title change initiated here. */
  localRename?(id: string, name: string): number | undefined;
  check(id: string, signal?: AbortSignal): Promise<void>;
  snapshot(id: string): DetailsAttempt | undefined;
  subscribe(listener: () => void): () => void;
}
const uncertain =
  "The change may have been saved. Check its status before trying again.";

/** Session owns uncertain intent through panel close/reopen; no automatic publication retry. */
export function createChannelDetails({
  reader,
  writer,
  labels = false,
  viewer,
  relayAuthor,
  canAccess,
  acceptDiscovery,
}: {
  reader?: RelayReader | undefined;
  writer?: RelayWriter | undefined;
  /** The relay keeps channel labels (NIP-CL). Without it, label edits are refused. */
  labels?: boolean;
  viewer: string;
  relayAuthor: string;
  canAccess(id: string): boolean;
  acceptDiscovery(events: readonly RelayEvent[]): void;
}) {
  let closed = false;
  const attempts = new Map<string, DetailsAttempt>();
  const manualNames = new Map<
    string,
    { name: string; previous?: string | undefined; revision: number }
  >();
  let renameRevision = 0;
  let unsubscribeNames: (() => void) | undefined;
  const controllers = new Set<AbortController>();
  const listeners = new Set<() => void>();
  function emit() {
    for (const listener of listeners) listener();
  }
  function forgetManualName(id: string) {
    manualNames.delete(id);
    if (!manualNames.size) {
      unsubscribeNames?.();
      unsubscribeNames = undefined;
    }
  }
  function rememberManualName(
    channels: ChannelNames,
    id: string,
    previous: string,
    name: string,
  ) {
    if (channels.get?.(id)?.name !== previous) return;
    manualNames.set(id, { name, previous, revision: ++renameRevision });
    unsubscribeNames ??= channels.subscribeList(() => {
      for (const [id, rename] of manualNames) {
        const current = channels.get?.(id)?.name;
        if (current === rename.name) rename.previous = undefined;
        else if (current === undefined || current !== rename.previous)
          forgetManualName(id);
      }
    });
  }
  function assertAccess(id: string) {
    if (closed || !canAccess(id))
      throw new Error("Channel access changed. Reopen channel settings.");
  }
  async function owned<T>(
    id: string,
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    lifecycleChannelId(id);
    assertAccess(id);
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
      ...(caller ? [caller] : []),
    ]);
    try {
      signal.throwIfAborted();
      return await work(signal);
    } finally {
      controllers.delete(controller);
    }
  }
  async function read(id: string, signal: AbortSignal) {
    if (!reader)
      throw new Error("Channel editing is unavailable on this connection.");
    assertAccess(id);
    const events = await reader.read(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong" as const,
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      { signal, fresh: true, priority: "foreground" },
    );
    signal.throwIfAborted();
    assertAccess(id);
    if (events.some((event) => ![39000, 39001, 39002].includes(event.kind)))
      throw new Error("Unexpected channel details response.");
    return detailsSettings(events, id, viewer, relayAuthor);
  }
  async function confirm(
    id: string,
    draft: ChannelDetailsDraft,
    signal: AbortSignal,
  ) {
    const { details, metadata } = await read(id, signal);
    acceptDiscovery([metadata]);
    signal.throwIfAborted();
    assertAccess(id);
    if (
      details.name !== draft.name ||
      details.description !== draft.description ||
      details.visibility !== draft.visibility ||
      details.ttlSeconds !== draft.ttlSeconds ||
      (draft.joinRole !== undefined && details.joinRole !== draft.joinRole) ||
      (draft.labels !== undefined &&
        JSON.stringify([...new Set(draft.labels)].sort()) !==
          JSON.stringify([...(details.labels ?? [])].sort()))
    )
      throw new Error(uncertain);
    attempts.delete(id);
    emit();
  }
  const capability: ChannelDetailsCapability = Object.freeze({
    available: !!reader && !!writer,
    localRename(id: string, name: string) {
      const rename = manualNames.get(id);
      return rename?.name === name ? rename.revision : undefined;
    },
    snapshot: (id: string) => attempts.get(id),
    summaryAccess,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(id: string, caller?: AbortSignal) {
      return owned(
        id,
        async (signal) => {
          const { details, metadata } = await retryRead(
            () => read(id, signal),
            signal,
          );
          acceptDiscovery([metadata]);
          signal.throwIfAborted();
          return details;
        },
        caller,
      );
    },
    check(id: string, caller?: AbortSignal) {
      return owned(
        id,
        async (signal) => {
          const attempt = attempts.get(id);
          if (attempt?.status !== "unconfirmed")
            throw new Error("No unconfirmed change to check.");
          await confirm(id, attempt.draft, signal);
        },
        caller,
      );
    },
    async save(
      base: ChannelDetails,
      input: ChannelDetailsDraft,
      caller?: AbortSignal,
      active?: () => boolean,
      manualRename?: ChannelNames,
    ) {
      const id = lifecycleChannelId(base.channelId);
      if (!writer || !reader)
        throw new Error("Channel editing is unavailable on this connection.");
      if (attempts.has(id))
        throw new Error("Check the previous change before saving again.");
      validateDetailsDraft(input);
      // Renaming a Solo chat records that its title is chosen, not automatic.
      const chosenName =
        soloLabels(base.labels) &&
        soloLabels(input.labels ?? base.labels) &&
        input.name !== base.name;
      if (chosenName && !labels) throw channelIdentityUnsupported();
      const draft = Object.freeze({
        ...input,
        ...(input.labels !== undefined
          ? {
              labels: [
                ...new Set([...input.labels, ...regionLabels(base.labels)]),
              ],
            }
          : {}),
        ...(chosenName && labels
          ? {
              labels: [
                ...new Set([
                  ...(input.labels ?? base.labels ?? []),
                  ...regionLabels(base.labels),
                  SOLO_NAMED_LABEL,
                ]),
              ],
            }
          : {}),
      });
      validateDetailsDraft(draft);
      if (
        !labels &&
        draft.labels !== undefined &&
        !sameLabels(draft.labels, base.labels ?? [])
      )
        throw channelIdentityUnsupported();
      let publicationStarted = false;
      let phase = "Could not verify current channel access";
      attempts.set(id, Object.freeze({ draft, status: "saving" }));
      emit();
      try {
        await owned(
          id,
          async (signal) => {
            const authorize = async () => {
              const { details } = await read(id, signal);
              if (!details.canEdit)
                throw new Error(
                  "You no longer have permission to edit this channel.",
                );
              if (details.version !== base.version)
                throw new Error(
                  "Channel details changed. Reload details before saving your edits.",
                );
            };
            await authorize();
            const template = detailsTemplate(id, draft, base);
            phase = "Could not sign the channel change";
            const signed = await writer.sign(structuredClone(template), signal);
            signal.throwIfAborted();
            if (
              signed.pubkey !== viewer ||
              signed.kind !== template.kind ||
              signed.created_at !== template.created_at ||
              signed.content !== template.content ||
              JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
              getEventHash(signed) !== signed.id ||
              !verifyEvent(signed)
            )
              throw new Error("Signer changed the channel details command.");
            phase = "Could not recheck channel access after signing";
            await authorize();
            signal.throwIfAborted();
            if (active?.() === false)
              throw new DOMException("Channel edit cancelled", "AbortError");
            if (manualRename && chosenName)
              rememberManualName(manualRename, id, base.name, draft.name);
            publicationStarted = true;
            await writer.publish(signed, signal);
            await confirm(id, draft, signal);
          },
          caller,
        );
      } catch (error) {
        if (publicationStarted && !(error instanceof PublishRejected)) {
          if (!closed)
            attempts.set(id, Object.freeze({ draft, status: "unconfirmed" }));
          throw new Error(uncertain);
        }
        if (publicationStarted && manualRename && chosenName)
          forgetManualName(id);
        attempts.delete(id);
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (!publicationStarted)
          throw new Error(
            `${phase}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        throw error;
      } finally {
        emit();
      }
    },
  });
  const cancel = () => {
    for (const controller of controllers) controller.abort();
  };
  return {
    capability,
    cancel,
    // Cache clearing cannot prove that an already sent command failed.
    clear: cancel,
    dispose() {
      closed = true;
      cancel();
      attempts.clear();
      unsubscribeNames?.();
      manualNames.clear();
      listeners.clear();
    },
  };
}
