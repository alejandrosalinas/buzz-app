import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { agentUnavailable, canMessageAgent } from "../agents/choices";
import { avatarMedia } from "../../shared/avatar-source";
import { useChannelWindow } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import { sameDirectMessage } from "../relay/direct-message-policy";
import {
  ConversationChannel,
  ConversationTimeline,
} from "../conversation/Conversation";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import { composerMarkdown } from "../messages/composer-markdown";
import { restoreChatLinks } from "../messages/composer-chat-cards";
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
import type { MessageIntent } from "../channel-navigation/routes";
import { Button } from "../../shared/design-system/ui/Button";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../profiles/useVerifiedNames";
import { abbreviatedPublicKey } from "../../shared/identity/public-key";
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
  workspace?: string;
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
/** Whether `intent` is a choice newer than the last one this draft took. */
function untaken(scope: string, intent: MessageIntent | undefined) {
  const taken = readView<unknown>(scope, "direct-message:addressed-at", 0);
  return !!intent && !(typeof taken === "number" && intent.at <= taken);
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
    ...(typeof value.workspace === "string" &&
    value.workspace.trim() &&
    value.workspace.length <= 256
      ? { workspace: value.workspace }
      : {}),
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
  intent,
  workspace,
}: {
  session: RelaySession;
  scope: string;
  /** The person this visit was opened from, such as by their profile's Message. */
  intent?: MessageIntent | undefined;
  workspace?: string | undefined;
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
  // A draft opened from a person starts in the message, so To keeps its list
  // closed rather than open it only to lose focus.
  const [addressing] = useState(() => untaken(scope, intent));
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
    setRecipients(people);
    writeView(scope, "direct-message:recipients", people.map(recipientView));
    setError("");
    setUploadFailed(false);
  }
  // Opened from a person, the restored draft is addressed to them as if they
  // were chosen in To. Only a choice newer than the last one taken addresses
  // it, so returning to a visit (Back, reload, closing Settings) keeps the
  // recipients chosen since, and choosing someone again addresses it anew. A
  // message held for delivery, even a failed one, keeps its recipients, so a
  // retry never reaches someone new. A choice made while a send is under way
  // waits for it, so the send keeps its recipients and the choice is not lost.
  // With To already filled, the caret starts in the message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each choice addresses the draft once, after its restore and any send under way.
  useEffect(() => {
    if (!ready || !intent || busy || !untaken(scope, intent)) return;
    writeView(scope, "direct-message:addressed-at", intent.at);
    const { to } = intent;
    if (pending || to === session.viewer) return;
    const profile = session.profiles.snapshot().get(to);
    void session.profiles.ensure([to]).catch(() => {});
    change([
      {
        pubkey: to,
        name: profile?.name ?? abbreviatedPublicKey(to) ?? "",
        ...(profile?.isAgent ? { isAgent: true } : {}),
      },
    ]);
    focusComposer();
  }, [ready, busy, intent?.to, intent?.at]);
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
          JSON.stringify(mentionDraft(restoreChatLinks(current.draft))) !==
            JSON.stringify(mentionDraft(restoreChatLinks(draft))) ||
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
        // The relay picks the DM of these people, which can differ from the
        // one shown, and named agents join it with its history. The message
        // goes where the relay says now: someone may have joined the DM it
        // gave an earlier attempt, so every new message asks again.
        const id = await session.directMessages.open(
          recipients.map((person) => person.pubkey),
          controller.signal,
          true,
        );
        controller.signal.throwIfAborted();
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
              ...(workspace ? { workspace } : {}),
            }),
          },
        );
        current = {
          id: messageId,
          channelId: id,
          ...(workspace ? { workspace } : {}),
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
      if (current.workspace) {
        // Placement can recover through the sidebar without repeating delivery.
        void session.sidebarPreferences
          .assign(current.channelId, current.workspace)
          .catch(() => {});
      }
      // Clear disposable views before releasing durable recovery. A failed clear
      // retains the operation for confirmation-only retry, even across unmount.
      clearView(
        scope,
        draftKey,
        `${draftKey}:files`,
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
    if (!recipients.length || !session.viewer) return undefined;
    const agents = new Set(
      recipients
        .filter((person) => person.isAgent)
        .map((person) => person.pubkey),
    );
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
        !channel.members ||
        !sameDirectMessage(
          channel.members,
          members,
          (key) => agents.has(key) || !!profiles.get(key)?.isAgent,
        )
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
  }, [channels, recipients, session.viewer, profiles]);
  // Agents named for an existing DM of these people join it, with its history.
  const joining = existing
    ? named.filter((person) => !existing.members?.includes(person.pubkey))
    : [];
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
        initiallyOpen={!addressing}
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
        {joining.length > 0 && (
          <p role="status">
            Sending adds{" "}
            {new Intl.ListFormat(undefined, { type: "conjunction" }).format(
              joining.map((person) => person.name),
            )}{" "}
            to this DM. {joining.length === 1 ? "It" : "They"} can read its
            earlier messages.
          </p>
        )}
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
