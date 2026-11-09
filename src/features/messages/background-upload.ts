import { useEffect, useState, useSyncExternalStore } from "react";
import type { UploadedAttachment } from "../relay/attachments";
import type { ComposerSession } from "./composer-session";
import {
  attachmentDraft,
  clearAttachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
  type DraftAttachment,
} from "./attachment-draft";

const recoveryNotice = (recovery: boolean | "conflict", to: string) =>
  recovery === "conflict"
    ? `Failed send to ${to} was kept because its draft changed. Clear that draft, then retry recovery before leaving this session.`
    : `Could not restore the failed send to ${to}. Retry recovery before leaving this session.`;

/** Where a send is going: its conversation's name and, unless only its own
 * entry point opens it (a huddle), a link that opens it. */
export type Destination = Readonly<{ name: string; link?: string }>;
type Notice = Readonly<{
  id: string;
  title: string;
  description?: string;
  destination: Destination;
  retry?: () => void;
}>;
export type BackgroundUploads = Readonly<{
  uploading: boolean;
  phase: "Preparing upload" | "Uploading" | "Finishing upload";
  /** Fraction of bytes sent, or null while the host reports no byte counts. */
  progress: number | null;
  /** The send Cancel stops, and how many other sends are running. */
  destination: Destination | undefined;
  others: number;
  /** False while every listed send is cancelled but not yet settled. */
  cancellable: boolean;
  notices: readonly Notice[];
  host: object | undefined;
}>;
type Job = {
  owner: string;
  destination: Destination;
  store: AttachmentDraft;
  controller: AbortController;
};
type Queue = {
  jobs: Job[];
  notices: readonly Notice[];
  hosts: object[];
  listeners: Set<() => void>;
  snapshot: BackgroundUploads;
  subscribe(listener: () => void): () => void;
};

// Sends outlive their composer but not their session: in memory, as Desktop.
const queues = new WeakMap<ComposerSession, Queue>();

function queueFor(session: ComposerSession) {
  let queue = queues.get(session);
  if (!queue) {
    const listeners = new Set<() => void>();
    queue = {
      jobs: [],
      notices: [],
      hosts: [],
      listeners,
      snapshot: {
        uploading: false,
        phase: "Preparing upload",
        progress: null,
        destination: undefined,
        others: 0,
        cancellable: false,
        notices: [],
        host: undefined,
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    queues.set(session, queue);
  }
  return queue;
}

function update(queue: Queue) {
  const files = queue.jobs.flatMap((job) => job.store.snapshot());
  // A queued or preparing file has no trustworthy transfer total. Completed
  // files have a validated descriptor even when their host emitted no reports.
  const known = files.every(
    (item) => item.status === "ready" || item.transfer !== undefined,
  );
  const total = files.reduce(
    (sum, item) => sum + (item.uploaded?.size ?? item.transfer?.total ?? 0),
    0,
  );
  const sent = files.reduce(
    (sum, item) =>
      sum +
      (item.status === "ready"
        ? (item.uploaded?.size ?? 0)
        : (item.transfer?.sent ?? 0)),
    0,
  );
  // A cancelled send stays listed until it settles; name the one Cancel stops.
  const running = live(queue);
  const named = running.at(-1) ?? queue.jobs.at(-1);
  queue.snapshot = Object.freeze({
    uploading: queue.jobs.length > 0,
    phase: files.some((item) => item.status === "uploading")
      ? "Uploading"
      : files.every((item) => item.status === "ready")
        ? "Finishing upload"
        : "Preparing upload",
    progress: known && total ? sent / total : null,
    destination: named?.destination,
    others: running.filter((job) => job !== named).length,
    cancellable: running.length > 0,
    notices: queue.notices,
    host: queue.hosts[0],
  });
  for (const listener of queue.listeners) listener();
}

function reason(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Unknown error";
}

/** Takes admitted files after Send; files upload in order, then publish once.
 * Every unpublished outcome hands the files back to `recover`. */
export function sendInBackground(
  session: ComposerSession,
  owner: string,
  channelId: string,
  destination: Destination,
  files: readonly DraftAttachment[],
  publish: (uploaded: readonly UploadedAttachment[]) => void | Promise<void>,
  recover: (
    files: readonly DraftAttachment[],
    preparationError?: unknown,
  ) => boolean | "conflict",
  source?: AttachmentDraft,
) {
  const queue = queueFor(session);
  const key = `background:${crypto.randomUUID()}`;
  const store = attachmentDraft(session, key, channelId);
  if (source) transferAttachmentDraft(source, store);
  else store.adopt(files);
  const job = { owner, destination, store, controller: new AbortController() };
  const { signal } = job.controller;
  queue.jobs.push(job);
  const stop = store.subscribe(() => update(queue));
  update(queue);
  void (async () => {
    let uploaded: readonly UploadedAttachment[] | undefined;
    let failure: { title: string; description: string } | undefined;
    let preparationError: unknown;
    try {
      uploaded = await store.prepareForSend(signal);
      signal.throwIfAborted();
      await publish(uploaded);
      return;
    } catch (error) {
      // Session aborts (access change, cache clear, close) restore like failures.
      if (!signal.aborted) {
        if (uploaded) preparationError = error;
        failure = {
          title: uploaded
            ? `Message to ${destination.name} failed to send`
            : `Upload to ${destination.name} failed`,
          description: reason(error),
        };
      }
    } finally {
      if (failure || signal.aborted) {
        let recovery: boolean | "conflict" = false;
        try {
          recovery = recover(store.snapshot(), preparationError);
        } catch {
          /* Retain bytes for retry. */
        }
        if (recovery !== true) {
          // Keep the session-owned bytes when storage cannot confirm restoration.
          // An abandoned job cannot publish again; its files remain reachable here.
          queue.notices = [
            ...queue.notices,
            {
              id: key,
              title: recoveryNotice(recovery, destination.name),
              destination,
              retry: () => {
                let result: boolean | "conflict" = false;
                try {
                  result = recover(store.snapshot(), preparationError);
                } catch {
                  /* Retain bytes for another retry. */
                }
                if (result !== true) {
                  queue.notices = queue.notices.map((item) =>
                    item.id === key
                      ? {
                          ...item,
                          title: recoveryNotice(result, destination.name),
                        }
                      : item,
                  );
                  update(queue);
                  return;
                }
                clearAttachmentDraft(session, key);
                dismissBackgroundUploadNotice(session, key);
              },
            },
          ];
        } else clearAttachmentDraft(session, key);
      } else clearAttachmentDraft(session, key);
      if (failure)
        queue.notices = [
          ...queue.notices,
          { id: `${key}:failure`, ...failure, destination },
        ];
      queue.jobs = queue.jobs.filter((candidate) => candidate !== job);
      stop();
      update(queue);
    }
  })();
}

function live(queue: Queue) {
  return queue.jobs.filter((job) => !job.controller.signal.aborted);
}

/** Desktop's Cancel stops the newest send and restores it like a failure. */
export function cancelBackgroundUpload(session: ComposerSession) {
  const queue = queueFor(session);
  live(queue).at(-1)?.controller.abort();
  // The abort does not stop a publish in flight: the message still sends, and
  // the job then restores its draft as if cancelled. The pill leaves it
  // uncounted either way.
  update(queue);
}

/** Like Desktop, a conversation cannot send again until its upload settles. */
export function useBackgroundSendPending(
  session: ComposerSession,
  owner: string,
) {
  const queue = queueFor(session);
  const pending = () => queue.jobs.some((job) => job.owner === owner);
  return useSyncExternalStore(queue.subscribe, pending, pending);
}

export function dismissBackgroundUploadNotice(
  session: ComposerSession,
  id: string,
) {
  const queue = queueFor(session);
  queue.notices = queue.notices.filter((notice) => notice.id !== id);
  update(queue);
}

/** Every composer shows progress; only the first mounted one hosts notices. */
export function useBackgroundUploads(session: ComposerSession) {
  const queue = queueFor(session);
  const [host] = useState(() => ({}));
  useEffect(() => {
    queue.hosts.push(host);
    update(queue);
    return () => {
      queue.hosts = queue.hosts.filter((candidate) => candidate !== host);
      update(queue);
    };
  }, [queue, host]);
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    () => queue.snapshot,
    () => queue.snapshot,
  );
  return {
    ...snapshot,
    notices: snapshot.host === host ? snapshot.notices : [],
  };
}
