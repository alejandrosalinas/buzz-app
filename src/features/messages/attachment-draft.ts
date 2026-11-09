import { validateRecording, type VoiceRecording } from "../relay/voice-media";
import { useState, useSyncExternalStore } from "react";
import type { ComposerSession } from "./composer-session";
import {
  UPLOAD_MAX_BYTES,
  UploadError,
  type UploadedAttachment,
  type UploadProgress,
} from "../relay/attachments";
import { prepareAttachment } from "./prepare-attachment";

export type DraftAttachment = Readonly<{
  id: string;
  file: File;
  voice?: UploadedAttachment["voice"];
  status: "queued" | "preparing" | "uploading" | "ready" | "error";
  uploaded?: UploadedAttachment;
  error?: string | undefined;
  /** Host-reported bytes for the current prepared transfer. */
  transfer?: Readonly<{ sent: number; total: number }> | undefined;
}>;
export type AttachmentDraft = {
  snapshot(): readonly DraftAttachment[];
  subscribe(listener: () => void): () => void;
  /** Admits the files that fit, in order. A lone file that does not fit throws
   * why; otherwise one sentence per reason names the first files left out
   * and counts the rest. */
  add(files: readonly File[], recording?: VoiceRecording): readonly string[];
  addUploaded(attachment: UploadedAttachment): void;
  adopt(files: readonly DraftAttachment[]): boolean;
  prepareForSend(signal: AbortSignal): Promise<readonly UploadedAttachment[]>;
  remove(id: string): void;
  retry(id: string): void;
  cancel(): void;
  resume(): void;
  clear(): void;
};
type UploadTask = {
  controller: AbortController;
  settled(): void;
  update(id: string, change: Partial<DraftAttachment>): void;
};
type DraftWork = {
  items: readonly DraftAttachment[];
  active: Map<string, UploadTask>;
  pending: Map<string, Promise<UploadedAttachment>>;
};
const handoffs = new WeakMap<
  AttachmentDraft,
  {
    take(): DraftWork;
    receive(work: DraftWork): void;
  }
>();

/** Send transfers the existing upload owner; clearing the composer cannot abort it. */
export function transferAttachmentDraft(
  source: AttachmentDraft,
  target: AttachmentDraft,
) {
  if (source === target || target.snapshot().length)
    throw new Error("Attachment upload handoff unavailable");
  const files = source.snapshot();
  if (files.every((item) => item.uploaded)) {
    target.adopt(files);
    source.clear();
    return;
  }
  const from = handoffs.get(source),
    to = handoffs.get(target);
  if (!from || !to) throw new Error("Attachment upload handoff unavailable");
  to.receive(from.take());
}

const drafts = new WeakMap<ComposerSession, Map<string, AttachmentDraft>>();

/** Files held for a composer `key`, without creating its draft. */
export function attachmentDraftCount(session: ComposerSession, key: string) {
  return drafts.get(session)?.get(key)?.snapshot().length ?? 0;
}
const countListeners = new WeakMap<ComposerSession, Set<() => void>>();
/** Hear when any of the session's drafts gains or loses files, including
 * drafts whose composer is no longer mounted. */
export function subscribeAttachmentDraftCounts(
  session: ComposerSession,
  listener: () => void,
) {
  let listeners = countListeners.get(session);
  if (!listeners) {
    listeners = new Set();
    countListeners.set(session, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const MAX_ATTACHMENT_FILES = 10;
const MAX_RETAINED_BYTES = 2 * UPLOAD_MAX_BYTES;
/** A refusal names this many files, then counts the rest. */
const NAMED_REFUSALS = 3;

/** Tab-local files survive navigation, not reload. Delivery remains outbox-owned.
 * A new chat's draft uploads before its channel exists. */
export function attachmentDraft(
  session: ComposerSession,
  key: string,
  channelId: string,
  newChat = false,
): AttachmentDraft {
  let partition = drafts.get(session);
  if (!partition) {
    partition = new Map();
    drafts.set(session, partition);
  }
  const existing = partition.get(key);
  if (existing) return existing;
  const owners = partition;
  let items: readonly DraftAttachment[] = [];
  const listeners = new Set<() => void>();
  let paused = false;
  let active = new Map<string, UploadTask>();
  let pending = new Map<string, Promise<UploadedAttachment>>();
  let count = 0;
  const emit = () => {
    for (const listener of listeners) listener();
    if (items.length === count) return;
    count = items.length;
    for (const listener of countListeners.get(session) ?? []) listener();
  };
  const replace = (id: string, change: Partial<DraftAttachment>) => {
    items = items.map((item) =>
      item.id === id
        ? {
            ...item,
            ...change,
            ...("error" in change && change.error === undefined
              ? { error: undefined }
              : {}),
          }
        : item,
    );
    emit();
  };
  function cancelActive(retryRequired = true) {
    paused = true;
    for (const task of active.values()) task.controller.abort();
    active.clear();
    pending.clear();
    items = items.map((item) =>
      item.status === "queued" ||
      item.status === "preparing" ||
      item.status === "uploading"
        ? {
            ...item,
            status: retryRequired ? "error" : "queued",
            error: retryRequired
              ? "Upload paused. Retry to continue."
              : undefined,
            transfer: undefined,
          }
        : item,
    );
    emit();
  }
  function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Upload cancelled.", "AbortError");
  }
  function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(abortReason(signal));
      signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(abortReason(signal));
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  async function prepareOne(
    item: DraftAttachment,
    signal: AbortSignal,
  ): Promise<UploadedAttachment> {
    if (item.uploaded) return item.uploaded;
    const attachments = session.attachments;
    const upload = newChat
      ? attachments?.uploadForNewChat
      : attachments &&
        ((file: File, signal: AbortSignal, progress: UploadProgress) =>
          attachments.upload(file, channelId, signal, progress));
    if (!attachments || !upload) throw new UploadError("unavailable");
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const owner = active;
    const task: UploadTask = { controller, update: replace, settled: pump };
    owner.set(item.id, task);
    task.update(item.id, {
      status: "preparing",
      error: undefined,
      transfer: undefined,
    });
    try {
      const prepared = await (attachments.prepare ?? prepareAttachment)(
        item.file,
        combined,
      );
      combined.throwIfAborted();
      task.update(item.id, { status: "uploading" });
      const result = await abortable(
        upload(prepared, combined, (sent, total) => {
          if (
            !combined.aborted &&
            owner.get(item.id) === task &&
            Number.isSafeInteger(sent) &&
            Number.isSafeInteger(total) &&
            total > 0 &&
            sent >= 0 &&
            sent <= total
          )
            task.update(item.id, { transfer: { sent, total } });
        }),
        combined,
      );
      combined.throwIfAborted();
      const uploaded = item.voice ? { ...result, voice: item.voice } : result;
      task.update(item.id, { status: "ready", uploaded });
      return uploaded;
    } catch (error) {
      if (combined.aborted) {
        if (signal.aborted && !controller.signal.aborted)
          task.update(item.id, {
            status: "queued",
            error: undefined,
            transfer: undefined,
          });
      } else
        task.update(item.id, {
          status: "error",
          transfer: undefined,
          error:
            error instanceof Error
              ? error.message
              : "Upload failed. Retry or remove this file.",
        });
      throw error;
    } finally {
      if (owner.get(item.id) === task) owner.delete(item.id);
      task.settled();
    }
  }
  function pump() {
    if (paused || active.size) return;
    const next = items.find((item) => item.status === "queued");
    if (next) start(next);
  }
  function start(item: DraftAttachment, signal = new AbortController().signal) {
    if (item.status === "error")
      return Promise.reject(
        new Error(item.error || "Retry or remove this file."),
      );
    const existing = pending.get(item.id);
    if (existing && active.has(item.id)) return abortable(existing, signal);
    const work = prepareOne(item, signal);
    const owner = pending;
    owner.set(item.id, work);
    // Eager work has no awaiting caller; errors are already visible on the item.
    void work
      .catch(() => {})
      .finally(() => {
        if (owner.get(item.id) === work) owner.delete(item.id);
      });
    return work;
  }
  const store = {
    snapshot: () => items,
    subscribe(listener: () => void) {
      owners.set(key, store);
      listeners.add(listener);
      if (listeners.size === 1) store.resume();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancelActive(false);
          if (!items.length && owners.get(key) === store) owners.delete(key);
        }
      };
    },
    add(files: readonly File[], recording?: VoiceRecording) {
      if (recording) {
        validateRecording(recording);
        if (files.length !== 1 || files[0] !== recording.file)
          throw new Error("Invalid voice note attachment");
      }
      if (!session.attachments) throw new UploadError("unavailable");
      let retained = [...owners.values()]
        .flatMap((owner) => owner.snapshot())
        .reduce((sum, item) => sum + item.file.size, 0);
      const admitted: File[] = [];
      // Reason → the files it left out. Empty files share the "" reason.
      const refused = new Map<string, string[]>();
      for (const file of files) {
        const reason = !file.size
          ? new Error(`${file.name} is empty.`)
          : items.length + admitted.length >= MAX_ATTACHMENT_FILES
            ? new Error(
                `Attach at most ${MAX_ATTACHMENT_FILES} files per message.`,
              )
            : file.size > UPLOAD_MAX_BYTES
              ? new UploadError("size")
              : retained + file.size > MAX_RETAINED_BYTES
                ? new Error(
                    "Attachment drafts are full (1,000 MiB). Send or remove some files first.",
                  )
                : undefined;
        if (!reason) {
          admitted.push(file);
          retained += file.size;
        } else if (files.length === 1) throw reason;
        else {
          const key = file.size ? reason.message : "";
          refused.set(key, [...(refused.get(key) ?? []), file.name]);
        }
      }
      const left = Array.from(refused, ([reason, names]) => {
        const listed =
          names.length > NAMED_REFUSALS
            ? `${names.slice(0, NAMED_REFUSALS).join(", ")} and ${names.length - NAMED_REFUSALS} more`
            : names.join(", ");
        return reason
          ? `${listed}: ${reason}`
          : `${listed} ${names.length === 1 ? "is" : "are"} empty.`;
      });
      if (!admitted.length) return left;
      items = [
        ...items,
        ...admitted.map(
          (file): DraftAttachment => ({
            id: crypto.randomUUID(),
            file,
            status: "queued",
            ...(recording
              ? {
                  voice: {
                    duration: recording.duration,
                    waveform: recording.waveform.map((n) =>
                      Math.round(n * 100),
                    ),
                  },
                }
              : {}),
          }),
        ),
      ];
      owners.set(key, store);
      emit();
      paused = false;
      pump();
      return left;
    },
    addUploaded(attachment: UploadedAttachment) {
      if (!session.attachments) throw new UploadError("unavailable");
      if (items.some((item) => item.uploaded?.url === attachment.url)) return;
      if (items.length >= MAX_ATTACHMENT_FILES)
        throw new Error(
          `Attach at most ${MAX_ATTACHMENT_FILES} files per message.`,
        );
      // No local bytes are retained. Send reuses the already uploaded descriptor.
      items = [
        ...items,
        {
          id: crypto.randomUUID(),
          file: new File([], attachment.name, { type: attachment.type }),
          status: "ready",
          uploaded: attachment,
        },
      ];
      owners.set(key, store);
      emit();
    },
    /** Moves already admitted files, with their results and errors, into an empty draft. */
    adopt(files: readonly DraftAttachment[]) {
      if (items.length || !files.length) return false;
      items = files;
      owners.set(key, store);
      emit();
      return true;
    },
    async prepareForSend(signal: AbortSignal) {
      paused = false;
      if (!items.length) return [];
      const uploaded: UploadedAttachment[] = [];
      try {
        for (const item of items) {
          signal.throwIfAborted();
          const current = items.find((candidate) => candidate.id === item.id);
          if (!current) throw new UploadError("cancelled");
          uploaded.push(await start(current, signal));
        }
      } catch (error) {
        // Eager siblings share this send owner. Freeze retryable state before
        // recovery adopts the snapshot, including transfers not yet awaited.
        cancelActive();
        throw error;
      }
      return uploaded;
    },
    remove(id: string) {
      const uploaded = items.find((item) => item.id === id)?.uploaded;
      if (uploaded) session.attachments?.release?.(uploaded);
      active.get(id)?.controller.abort();

      active.delete(id);
      pending.delete(id);
      items = items.filter((item) => item.id !== id);
      emit();
      pump();
    },
    retry(id: string) {
      if (!items.some((item) => item.id === id && item.status === "error"))
        return;
      replace(id, { status: "queued", error: undefined, transfer: undefined });
      paused = false;
      pump();
    },
    cancel: () => cancelActive(false),
    resume() {
      paused = false;
      pump();
    },
    clear() {
      for (const item of items)
        if (item.uploaded) session.attachments?.release?.(item.uploaded);
      cancelActive();
      items = [];
      emit();
    },
  };
  handoffs.set(store, {
    take() {
      paused = true;
      const work = { items, active, pending };
      items = [];
      active = new Map();
      pending = new Map();
      emit();
      return work;
    },
    receive(work) {
      paused = false;
      items = work.items;
      active = work.active;
      pending = work.pending;
      for (const task of active.values()) {
        task.update = replace;
        task.settled = pump;
      }
      owners.set(key, store);
      emit();
    },
  });
  return store;
}

/** A confirmed deletion discards only this session's exact scoped composer files.
 * A missing store is a no-op; do not allocate a draft merely to clear it. */
export function clearAttachmentDraft(session: ComposerSession, key: string) {
  const owners = drafts.get(session);
  const store = owners?.get(key);
  if (!store) return;
  store.clear(); // abort uploads before disposing the scoped entry
  if (owners?.get(key) === store) owners.delete(key);
}

export function useAttachmentDraft(
  session: ComposerSession,
  key: string,
  channelId: string,
  newChat = false,
) {
  // Composer's destination key remounts this hook on a session/channel/thread change.
  const [store] = useState(() =>
    attachmentDraft(session, key, channelId, newChat),
  );
  const items = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return {
    store,
    items,
    blocked: items.some((item) => item.status === "error"),
  };
}
