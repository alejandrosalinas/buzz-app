import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { agentUnavailable, canMessageAgent } from "../agents/choices";
import { avatarMedia } from "../../shared/avatar-source";
import { useChannelWindow } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import {
  ConversationChannel,
  ConversationTimeline,
} from "../conversation/Conversation";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import { composerMarkdown } from "../messages/composer-markdown";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { attachmentMessage } from "../relay/attachments";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { DraftMentionRoster } from "../messages/draft-mention-roster";
import {
  clearAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import { MessageComposer } from "../messages/MessageComposer";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { clearView, readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../profiles/useVerifiedNames";
import { RecipientPicker } from "./RecipientPicker";
import type { Recipient } from "./usePeople";
import { usePassThroughUntilDrafted } from "../messages/draft-visit";
import type { PageNavigation } from "../navigation/service";
import styles from "./NewMessage.module.css";

const draftKey = "direct-message:new-draft";
const recoveryKey = "direct-message:new";

type Pending = {
  id: string;
  channelId: string;
  recipients: string;
  draft: MentionDraft;
  attachments: readonly (readonly string[])[];
};
const keyFor = (people: readonly Recipient[]) =>
  people
    .map((person) => person.pubkey)
    .sort()
    .join(":");
// Persist identity and a bounded label, never the directory's full metadata.
const recipientView = ({ pubkey, name, isAgent }: Recipient): Recipient => ({
  pubkey,
  name: name.slice(0, 500),
  ...(isAgent === true ? { isAgent: true } : {}),
});
function savedRecipients(scope: string, viewer?: string) {
  return validRecipients(
    readView<unknown>(scope, "direct-message:recipients", []),
    viewer,
  );
}
function validRecipients(saved: unknown, viewer?: string) {
  if (!Array.isArray(saved)) return [];
  return [
    ...new Map(
      saved
        .filter(
          (person): person is Recipient =>
            person &&
            typeof person.pubkey === "string" &&
            /^[0-9a-f]{64}$/.test(person.pubkey) &&
            person.pubkey !== viewer &&
            typeof person.name === "string",
        )
        .map((person) => [person.pubkey, recipientView(person)]),
    ).values(),
  ].slice(0, 8);
}
// Earlier development builds wrote a separate pointer. Keep it confirmation-only;
// its absence from the journal must never authorize a replacement message.
function savedLegacy(scope: string, viewer?: string) {
  const value = readView<Partial<Pending> | null>(
    scope,
    "direct-message:pending",
    null,
  );
  if (
    value &&
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    typeof value.channelId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.channelId) &&
    typeof value.recipients === "string" &&
    value.recipients.length <= 519 &&
    value.draft
  )
    return {
      id: value.id,
      channelId: value.channelId,
      recipients: value.recipients,
      draft: mentionDraft(value.draft),
      attachments: [],
      people: savedRecipients(scope, viewer),
    };
}

function recovered(operations: readonly OutgoingEvent[], viewer?: string) {
  const item = operations.find((item) => item.recovery?.key === recoveryKey);
  if (!item?.recovery) return undefined;
  const value = JSON.parse(item.recovery.value);
  const people = validRecipients(value.people, viewer);
  const channelId = item.event.tags.find(([name]) => name === "h")?.[1];
  if (item.event.kind !== 9 || !channelId || !people.length)
    throw new Error("The saved new message could not be restored.");
  return {
    id: item.event.id,
    channelId,
    recipients: keyFor(people),
    draft: mentionDraft(value.draft),
    attachments: item.event.tags.filter(([name]) => name === "imeta"),
    people,
  };
}

/** Recipient-first conversation that can open directly or send through the durable outbox. */
export function NewMessage({
  session,
  scope,
  extensions,
  channels,
  onPreparing,
  host,
  onOpenThread,
  onStarted,
  visit,
}: {
  session: RelaySession;
  scope: string;
  /** The visit presenting this composer, a Back stop only once drafted. */
  visit?: PageNavigation | undefined;
  extensions?: ConversationExtensions | undefined;
  channels: readonly ChannelSummary[];
  host: ConversationHostServices;
  onPreparing?(pubkeys: readonly string[]): void;
  onOpenThread(
    channelId: string,
    messageId: string,
    threadRootId: string,
    intent?: "reply",
  ): void;
  onStarted(channelId: string, messageId: string): void;
}) {
  // A message held for delivery or retry stays a Back stop even when its
  // draft view is gone or it carries only attachments.
  const held = useRef(false);
  const holds = useCallback(() => held.current, []);
  const draftEdited = usePassThroughUntilDrafted(
    visit,
    session,
    scope,
    draftKey,
    { held: holds },
  );
  const [recipients, setRecipients] = useState(() =>
    savedRecipients(scope, session.viewer),
  );
  // Recipients keep the facts they were chosen with; their labels follow the
  // current verification and otherwise the current profile name, falling back
  // to those facts.
  const verified = useVerifiedNames(session, recipients);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const named = useMemo(
    () =>
      withVerifiedNames(
        recipients.map((person) => {
          const current = profiles.get(person.pubkey);
          return current && !current.verified
            ? { ...person, name: current.name }
            : person;
        }),
        verified,
        profiles,
      ),
    [recipients, verified, profiles],
  );
  const recipientNames = named.map((person) => person.name).join(", ");
  const roster = useMemo(() => ({ recipients }), [recipients]);
  // Text still in the To field may be a recipient not chosen yet, so Send
  // waits for it to become one or be cleared.
  const [typed, setTyped] = useState(false);
  const [legacy, setLegacy] = useState(() =>
    savedLegacy(scope, session.viewer),
  );
  const initialLegacy = useRef(legacy);
  const [ready, setReady] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<MentionDraft>();
  const [draftRevision, setDraftRevision] = useState(0);
  const [composerFocus, setComposerFocus] = useState(0);
  const focusComposer = useCallback(() => {
    setComposerFocus((request) => request + 1);
  }, []);
  const retiring = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState<"uploading" | "sending" | undefined>();
  const [error, setError] = useState("");
  const [uploadFailed, setUploadFailed] = useState(false);
  const [draftChannel] = useState(() => crypto.randomUUID());
  const attempt = useRef<AbortController | null>(null);
  const prepared = useRef<{ key: string; id: string } | undefined>(undefined);
  const outbox = session.outbox;
  const operations = useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  let pending: (Pending & { people: Recipient[] }) | undefined;
  try {
    pending = recovered(operations, session.viewer) ?? legacy;
  } catch {
    /* Readiness presents invalid recovery. */
  }
  held.current = !!pending;
  const failed =
    pending && session.directMessages.delivery(pending.id) === "failed";
  const locked = !ready || !!busy || (!!pending && !failed);
  const retire = useCallback(() => {
    clearAttachmentDraft(session, `${scope}:${draftKey}`);
    retiring.current = undefined;
    prepared.current = undefined;
    draftEdited(undefined);
    setRecipients([]);
    setRestoredDraft(mentionDraft(""));
    setDraftRevision((revision) => revision + 1);
  }, [session, scope, draftEdited]);
  useLayoutEffect(() => {
    const confirmed = pending && session.directMessages.delivery(pending.id);
    if (pending) {
      retiring.current =
        confirmed === "accepted" || confirmed === "seen"
          ? pending.id
          : undefined;
    } else if (retiring.current) {
      // A different mount may have completed acknowledgement while this page
      // restored its recovery payload. Never leave that payload as a fresh draft.
      retire();
    }
  }, [pending, session.directMessages, retire]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await outbox?.ready();
        if (!active) return;
        const saved =
          recovered(outbox?.snapshot() ?? [], session.viewer) ??
          initialLegacy.current;
        if (saved) {
          const editable =
            session.directMessages.delivery(saved.id) === "failed";
          setRecipients(
            editable
              ? validRecipients(
                  readView(scope, "direct-message:recipients", saved.people),
                  session.viewer,
                )
              : saved.people,
          );
          setRestoredDraft(
            editable
              ? mentionDraft(readView(scope, draftKey, saved.draft))
              : saved.draft,
          );
        }
        setReady(true);
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not restore the message.",
          );
      }
    })();
    return () => {
      active = false;
      attempt.current?.abort();
    };
  }, [outbox, session.viewer, session.directMessages, scope]);
  function validateAgents() {
    const controlled = new Set(
      session.agentChoices
        .snapshot()
        // Forward-looking: neither archived nor being deleted.
        .selectable.filter(canMessageAgent)
        .map((agent) => agent.pubkey),
    );
    if (
      recipients.some(
        (person) =>
          // By key, whatever its profile says.
          agentUnavailable(session, person.pubkey) ||
          ((person.isAgent ||
            session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
            !controlled.has(person.pubkey)),
      )
    )
      throw new Error(
        "A selected agent is no longer available. Remove it or refresh its details and try again.",
      );
  }
  function change(people: Recipient[]) {
    if (locked || attempt.current) return;
    prepared.current = undefined;
    setRecipients(people);
    writeView(scope, "direct-message:recipients", people.map(recipientView));
    setError("");
    setUploadFailed(false);
  }
  async function send(draft: MentionDraft, files?: AttachmentDraft) {
    const content = composerMarkdown(draft);
    if (
      attempt.current ||
      !ready ||
      !recipients.length ||
      (!content.trim() && !files?.snapshot().length && !pending) ||
      !session.directMessages.available
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(
      files?.snapshot().some((file) => !file.uploaded)
        ? "uploading"
        : "sending",
    );
    setError("");
    setUploadFailed(false);
    const key = keyFor(recipients);
    let current: Pending | undefined = pending;
    let preparingFiles = !!files;
    try {
      // Confirmation-only retries must retain the exact durable event.
      const uploaded = files
        ? await files.prepareForSend(controller.signal)
        : [];
      controller.signal.throwIfAborted();
      preparingFiles = false;
      setBusy("sending");
      // Compare the complete published metadata; messages.send still validates
      // every upload against the actual community origin.
      const attachments = attachmentMessage(
        "",
        uploaded,
        uploaded[0]?.url,
      ).tags;
      if (current && session.directMessages.delivery(current.id) === "failed")
        validateAgents();
      if (
        current &&
        (current.recipients !== key ||
          JSON.stringify(current.draft) !==
            JSON.stringify(mentionDraft(draft)) ||
          (files &&
            JSON.stringify(current.attachments) !==
              JSON.stringify(attachments)))
      ) {
        if (session.directMessages.delivery(current.id) !== "failed")
          throw new Error(
            "Retry the earlier message to confirm its delivery before editing.",
          );
        validateAgents();
        await outbox?.dismiss(current.id);
        controller.signal.throwIfAborted();
        current = undefined;
        setLegacy(undefined);
        writeView(scope, "direct-message:pending", null);
      }
      if (!current) {
        validateAgents();
        onPreparing?.(recipients.map((person) => person.pubkey));
        const id =
          prepared.current?.key === key
            ? prepared.current.id
            : await session.directMessages.open(
                recipients.map((person) => person.pubkey),
                controller.signal,
              );
        controller.signal.throwIfAborted();
        prepared.current = { key, id };
        validateAgents();
        const messageId = session.messages.send(
          id,
          content,
          draft.recipients.map((person) => person.pubkey),
          uploaded,
          {
            key: recoveryKey,
            value: JSON.stringify({
              people: recipients.map(recipientView),
              draft,
            }),
          },
        );
        current = {
          id: messageId,
          channelId: id,
          recipients: key,
          draft,
          attachments,
        };
      }
      await session.directMessages.delivered(
        current.id,
        current.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      // Clear disposable views before releasing durable recovery. A failed clear
      // retains the operation for confirmation-only retry, even across unmount.
      clearView(
        scope,
        draftKey,
        "direct-message:pending",
        "direct-message:recipients",
      );
      await outbox?.acknowledge(current.id);
      if (controller.signal.aborted) return;
      setLegacy(undefined);
      // The page can stay mounted (Settings open), so never leave the sent
      // message as an editable draft that could be published again.
      retire();
      onStarted(current.channelId, current.id);
    } catch (reason) {
      if (!controller.signal.aborted && preparingFiles) setUploadFailed(true);
      else if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not send your message. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      if (attempt.current === controller) attempt.current = null;
    }
  }
  const existing = useMemo(() => {
    if (!recipients.length) return undefined;
    const members = new Set([
      session.viewer,
      ...recipients.map((person) => person.pubkey),
    ]);
    let match: ChannelSummary | undefined;
    for (const channel of channels) {
      if (
        channel.channelType !== "dm" ||
        channel.archived ||
        channel.cached ||
        channel.readOnly ||
        channel.pending ||
        channel.huddle ||
        channel.members?.length !== members.size ||
        !channel.members.every((member) => members.has(member))
      )
        continue;
      const activity = channel.lastActivityAt ?? 0;
      const latest = match?.lastActivityAt ?? 0;
      if (
        !match ||
        activity > latest ||
        (activity === latest && channel.id.localeCompare(match.id) < 0)
      )
        match = channel;
    }
    return match;
  }, [channels, recipients, session.viewer]);
  return (
    <section
      className={styles.page}
      aria-label="New message"
      data-attachment-drop-zone
    >
      <RecipientPicker
        session={session}
        scope={scope}
        selected={recipients}
        labels={named}
        disabled={locked}
        onChange={change}
        onComplete={focusComposer}
        onTyped={setTyped}
      />
      <div className={styles.blank} data-new-message-body="">
        {existing ? (
          <ExistingDiscussion
            key={existing.id}
            session={session}
            scope={scope}
            channel={existing}
            extensions={extensions}
            host={host}
            onRecovered={focusComposer}
            onOpen={(messageId, threadRootId, intent) =>
              onOpenThread(existing.id, messageId, threadRootId, intent)
            }
          />
        ) : recipients.length > 0 ? (
          <div className={styles.introduction}>
            <AvatarStack
              animateEntrance
              size="hero-large"
              max={5}
              items={named.map((person) => ({
                id: person.pubkey,
                name: person.name,
                src: avatarMedia(person.picture, session.media),
                shape: person.isAgent ? "squircle" : "circle",
              }))}
            />
          </div>
        ) : null}
      </div>
      <div className={styles.feedback}>
        {busy && (
          <p role="status">
            {busy === "uploading" ? "Uploading files…" : "Sending message…"}
          </p>
        )}
        {uploadFailed && (
          <p role="status">
            A file couldn’t upload. Retry or remove it, then send again.
          </p>
        )}
        {!session.directMessages.available && (
          <p role="status">
            Starting direct messages is unavailable on this connection.
          </p>
        )}
        {pending && !failed && !busy && !error && (
          <Button
            type="button"
            onClick={() => pending && void send(pending.draft)}
          >
            Retry send
          </Button>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {pending && !failed && (
              <Button
                type="button"
                disabled={!!busy}
                onClick={() => pending && void send(pending.draft)}
              >
                Retry send
              </Button>
            )}
          </div>
        )}
      </div>
      <DraftMentionRoster.Provider value={roster}>
        <MessageComposer
          key={`${ready ? "ready" : "hydrating"}:${draftRevision}`}
          session={session}
          scope={scope}
          extensions={extensions}
          channelId={draftChannel}
          focusRequest={composerFocus}
          channelName={recipientNames || "new message"}
          label={recipientNames ? `Message ${recipientNames}` : "New message"}
          placeholder={recipientNames ? undefined : ""}
          disabled={!recipients.length}
          submission={{
            draftKey,
            attachments: true,
            allowAttachmentOnly: true,
            recoveredDraft: restoredDraft,
            onDraftChange: draftEdited,
            locked,
            disabled:
              !ready ||
              !!busy ||
              !recipients.length ||
              typed ||
              !session.directMessages.available,
            submit: (draft, files) => void send(draft, files),
          }}
        />
      </DraftMentionRoster.Provider>
    </section>
  );
}
const empty: readonly never[] = [];
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};

/** History owns paging and loading; the draft and send journal stay mounted above. */
function ExistingDiscussion({
  session,
  scope,
  channel,
  extensions,
  host,
  onOpen,
  onRecovered,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions?: ConversationExtensions | undefined;
  host: ConversationHostServices;
  onOpen(messageId: string, threadRootId: string, intent?: "reply"): void;
  onRecovered(): void;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const retry = useRef<HTMLButtonElement>(null);
  const [recovering, setRecovering] = useState(false);
  const waiting = !window.rows.length && window.status !== "ready";
  useLayoutEffect(() => {
    if (waiting || !recovering) return;
    // Hand off before removing Retry, and only while it still owns focus.
    if (document.activeElement === retry.current) onRecovered();
    setRecovering(false);
  }, [waiting, recovering, onRecovered]);
  if (waiting || recovering)
    return (
      <div
        className={styles.feedback}
        role={window.status === "error" ? "alert" : "status"}
      >
        <p>{window.status === "error" ? window.error : "Loading messages…"}</p>
        {(window.status === "error" || recovering) && (
          <Button
            ref={retry}
            type="button"
            loading={window.status !== "error"}
            onClick={() => {
              setRecovering(true);
              session.channels.ensure(channel.id);
            }}
          >
            Retry messages
          </Button>
        )}
      </div>
    );
  return (
    <ConversationChannel
      session={session}
      scope={scope}
      channel={channel}
      extensions={extensions}
      active={false}
      host={host}
    >
      <ConversationTimeline
        window={window}
        transient
        marksRead={false}
        onOpenThread={onOpen}
      />
    </ConversationChannel>
  );
}
