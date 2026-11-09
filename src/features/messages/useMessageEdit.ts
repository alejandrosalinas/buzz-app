import { messageEditText, validateMessageEdit } from "./message-edit";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import type { ComposerSession } from "./composer-session";

export function lastEditableMessage(
  session: ComposerSession,
  rows: readonly ChannelMessage[],
): ChannelMessage | undefined {
  if (!session.viewer || !session.outbox?.supports(40003)) return;
  const pending = session.outbox.snapshot();
  return [...rows]
    .reverse()
    .find(
      (row) =>
        row.authorId === session.viewer &&
        !row.membership &&
        !row.agentEnvelope &&
        !row.diff &&
        (!row.delivery ||
          row.delivery === "accepted" ||
          row.delivery === "seen") &&
        !pending.some(
          (item) =>
            ((item.event.kind === 40003 &&
              item.delivery !== "accepted" &&
              item.delivery !== "seen") ||
              item.event.kind === 5) &&
            item.event.tags.some(([name, id]) => name === "e" && id === row.id),
        ),
    );
}

const source = (row: ChannelMessage) => row.sourceContent ?? row.content;

const empty: readonly OutgoingEvent[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};

export type DraftMessageEdit = {
  id: string;
  content: string;
  saveDraft(body: string): Promise<void>;
  cancelDraft(): void;
};

/** Edit delivery uses the session outbox; the composer owns input and draft restoration. */
export function useMessageEdit(session: ComposerSession, restore: () => void) {
  const [target, setTarget] = useState<ChannelMessage | DraftMessageEdit>();
  const [draftSaving, setDraftSaving] = useState(false);
  const [operation, setOperation] = useState<string>();
  const submitted = useRef<string | undefined>(undefined);
  const initial = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const pending = useSyncExternalStore(
    session.outbox?.subscribe ?? subscribe,
    session.outbox?.snapshot ?? snapshot,
    session.outbox?.snapshot ?? snapshot,
  );
  const delivery = pending.find((item) => item.event.id === operation);
  const busy = draftSaving || (!!operation && delivery?.delivery === "sending");
  const retryable =
    delivery?.delivery === "failed" || delivery?.delivery === "unknown";
  useEffect(
    () => () => {
      if (target && "cancelDraft" in target) target.cancelDraft();
    },
    [target],
  );
  const close = () => {
    if (target && "cancelDraft" in target) target.cancelDraft();
    restore();
    setTarget(undefined);
    setOperation(undefined);
    submitted.current = undefined;
    initial.current = undefined;
    setError(undefined);
  };
  const finish = useEffectEvent(close);
  useEffect(() => {
    if (
      operation &&
      (!delivery ||
        delivery.delivery === "accepted" ||
        delivery.delivery === "seen")
    )
      finish();
  }, [operation, delivery]);
  return {
    target,
    busy,
    locked: !!operation || draftSaving,
    retryable,
    error: error ?? delivery?.error,
    close,
    clearError: () => setError(undefined),
    start(
      row: ChannelMessage,
      normalize: (body: string) => string = (body) => body,
    ) {
      setTarget(row);
      setError(undefined);
      const body = messageEditText(
        row,
        session.profiles.snapshot(),
        session.agentLibrary.snapshot().identities,
      );
      initial.current = normalize(body);
      return body;
    },
    startDraft(draft: DraftMessageEdit) {
      setTarget(draft);
      setError(undefined);
      initial.current = draft.content;
      return draft.content;
    },
    save(body: string, current: ChannelMessage | undefined) {
      if (!target || submitted.current || draftSaving) return;
      if ("saveDraft" in target) {
        setDraftSaving(true);
        void target
          .saveDraft(body)
          .then(close, (reason) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          })
          .finally(() => setDraftSaving(false));
        return;
      }
      if (!body.trim()) return;
      if (!current || !lastEditableMessage(session, [current])) {
        setError("This message is no longer available to edit.");
        return;
      }
      if (source(current) !== source(target)) {
        setError(
          "This message changed while you were editing. Copy your changes, then cancel and reopen it.",
        );
        return;
      }
      if (body === initial.current || body === source(target)) {
        close();
        return;
      }
      try {
        const id = session.messages.edit(
          target.id,
          validateMessageEdit(target, source(target), body),
          current.attachmentSourceId ?? current.id,
        );
        submitted.current = id;
        setOperation(id);
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    retry() {
      if (!operation) return;
      try {
        session.outbox?.retry(operation);
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
  };
}
