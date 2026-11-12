import { linkedDraftKey, readLinkedChat, type LinkedChat } from "./linked-chat";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { startingChatTitle } from "./chat-title";
import { ChatNotStarted } from "../relay/channel-writes";
import { DraftSettings } from "./DraftSettings";
import { SoloDraftView } from "./SoloPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { GearIcon } from "../../shared/design-system/icons";
import {
  defaultsRevision,
  loadChatSetup,
  parseChatSetup,
  type ChatSetup,
} from "./workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import {
  parseSoloModelPicks,
  soloModelPicksKey,
  lockSoloModelPicks,
} from "../messages/solo-model-picks";
import {
  transactModelPicks,
  publishModelPicks,
} from "../messages/solo-model-picks-storage";
import type { DraftPicks } from "../messages/ComposerModels";
import type { MentionPicks } from "../relay/messages";
import { useDefaultAgent } from "./default-agent";
import { draftLifetime } from "./default-lifetime";
import { WorkspaceControl } from "./WorkspaceControl";
import { rememberedMentions } from "../messages/remembered-mentions";
import { composerMarkdown } from "../messages/composer-markdown";
import { draftTokens, signMessageTokens } from "../messages/message-tokens";
import {
  addressingOnly,
  followupDraft,
  mentionDraft,
  type MentionDraft,
  type MentionRecipient,
} from "../messages/mention-draft";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  attachmentDraft,
  attachmentDraftCount,
  clearAttachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import { usePassThroughUntilDrafted } from "../messages/draft-visit";
import type { PageNavigation } from "../navigation/service";
import {
  regionDraftKey,
  regionStartKey,
  soloNavigationFor,
} from "../channel-navigation/solo-navigation";
import { useSoloNavigation } from "../channel-navigation/solo-navigation-react";
import styles from "./Solo.module.css";

/** Starting a new chat from a project starts it in that project, even when an
 * earlier draft there was switched to another one. */
function readDraftSettings(scope: string, draftKey: string) {
  const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
  const settings = saved && typeof saved === "object" ? saved : {};
  return {
    name: "name" in settings ? (settings.name as string) : "",
    canvas:
      "canvas" in settings && typeof settings.canvas === "string"
        ? settings.canvas
        : undefined,
    // Preserve malformed lifetime input for the existing visible validation.
    ttlSeconds: ("ttlSeconds" in settings ? settings.ttlSeconds : undefined) as
      | number
      | undefined,
    // A chosen Ongoing saves no ttlSeconds, which older builds also read as
    // Ongoing. Without either, the draft follows the default for new chats.
    ...("lifetimeChosen" in settings && settings.lifetimeChosen === true
      ? { lifetimeChosen: true as const }
      : {}),
  };
}

export function resetNewChatProject(scope: string, projectId: string) {
  const key = `solo:project:${projectId}`;
  const selected = readView<unknown>(scope, `${key}:new-project`, projectId);
  // Instructions belong to the previous project; name and lifetime stay.
  if (selected !== projectId)
    writeView(scope, `${key}:settings`, {
      ...readDraftSettings(scope, key),
      canvas: undefined,
    });
  writeView(scope, `${key}:new-project`, null);
}

/** New chats share one saved draft. When it holds only tags for agents
 * other than the named one, it has no text of the person's to keep. */
function dropOtherAgentTag(scope: string, key: string, agent?: string) {
  if (!agent) return;
  const saved = mentionDraft(readView<unknown>(scope, key, ""));
  if (
    addressingOnly(saved) &&
    !saved.recipients.some((item) => item.pubkey === agent)
  )
    writeView(scope, key, null);
}

/** Whether New chat holds nothing of the person's since a start cleared it:
 * tags at most, no files, and its settings and workspace untouched. */
function blankNewChat(
  session: RelaySession,
  scope: string,
  key: string,
  choices: string | null,
  allowUnclearedPicks = false,
) {
  const saved = mentionDraft(readView<unknown>(scope, `${key}:new-draft`, ""));
  return (
    (!composerMarkdown(saved).trim() || addressingOnly(saved)) &&
    !attachmentDraftCount(session, `${scope}:${key}:new-draft`) &&
    (!Object.keys(parseSoloModelPicks(choices)).length ||
      allowUnclearedPicks) &&
    readView(scope, `${key}:settings`, null) === null &&
    readView(scope, `${key}:new-project`, null) === null
  );
}

/** Keep only explicit draft selections validated for a first-send recipient. */
function firstChatPicks(
  draftPicks: DraftPicks | undefined,
  validated: MentionPicks,
  recipients: readonly string[],
): DraftPicks {
  return Object.fromEntries(
    Object.entries(draftPicks ?? {}).flatMap(([pubkey, saved]) => {
      const sent = validated[pubkey];
      if (!sent || !recipients.includes(pubkey)) return [];
      const { model, effort, type } = saved;
      const pick = {
        ...(model && model === sent.model ? { model } : {}),
        ...(effort && effort === sent.effort ? { effort } : {}),
        ...(type ? { type } : {}),
      };
      return pick.model || pick.effort ? [[pubkey, pick] as const] : [];
    }),
  );
}
/** Open New chats. Asked whether they hold work of the person's that view
 * state does not show: a draft that couldn't be saved, or Settings being
 * edited. Told when a refused start gives their draft back, since their
 * composer reads it only as it mounts. */
const openNewChats = new Set<{
  scope: string;
  key: string;
  editing(): boolean;
  restored(): void;
}>();
/** The prompt last given back to each New chat, as saved, so a later refusal
 * that finds it still there can say so. */
const restoredPrompts = new Map<string, string>();
const REGION_UNAVAILABLE =
  "This chat's plugin is unavailable. Your draft is saved.";

export function SoloDraft({
  session,
  scope,
  onStarted,
  onFailed,
  projectId,
  extensions,
  focusRequest = 0,
  agent,
  linkedId,
  source,
  visit,
  region,
  lead,
}: {
  /** This region draft starts its workspace's lead. */
  lead?: boolean | undefined;
  /** The Solo region whose source opened this draft; its chat gets that label. */
  region?: string | undefined;
  /** The visit presenting this draft, a Back stop only once drafted. */
  visit?: PageNavigation | undefined;
  linkedId?: string | undefined;
  source?: LinkedChat | undefined;
  /** Start with this agent chosen, as when search opens a new chat with it. */
  agent?: string | undefined;
  focusRequest?: number | AbortSignal;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  /** The started chat `id` was never made; `message` says why, and whether
   * what was sent in it went back to New chat. It does unless a draft was
   * begun there since (an earlier refused prompt included) or it can't be
   * saved on this device; its settings may be saved only in part. */
  onFailed?:
    | ((id: string, message: string, retry?: () => Promise<void>) => void)
    | undefined;
  projectId?: string | undefined;
}) {
  const draftKey = region
    ? regionDraftKey(region, projectId)
    : linkedId
      ? linkedDraftKey(linkedId)
      : projectId
        ? `solo:project:${projectId}`
        : "solo";
  const notify = useToastNotification();
  // Before the composer reads it: a named agent replaces a saved draft that
  // only tags another agent, since that tag was the earlier default.
  useState(() => dropOtherAgentTag(scope, `${draftKey}:new-draft`, agent));
  // Read the source live: starting the chat consumes it.
  const linkedSource = useCallback(
    () => (source ? readLinkedChat(scope, draftKey)?.link : undefined),
    [source, scope, draftKey],
  );
  const draftEdited = usePassThroughUntilDrafted(
    visit,
    session,
    scope,
    `${draftKey}:new-draft`,
    { initialDraft: linkedSource },
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The lifetime Chat settings opened with.
  const [settingsLifetime, setSettingsLifetime] = useState<number>();
  // New chats tag their agent in the draft: the one the route names, else the
  // default.
  const defaultAgent = useDefaultAgent(session, scope, agent);
  const [selectedProject, setSelectedProject] = useState(() => {
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-project`,
      projectId ?? "",
    );
    return typeof saved === "string" ? saved : (projectId ?? "");
  });
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [draftSettings, setDraftSettings] = useState(() =>
    readDraftSettings(scope, draftKey),
  );
  const draftCanvas = draftSettings.canvas;
  // Project entry can reset this draft while the composer stays mounted.
  // Observe only changed revisions so unrelated writes don't discard local edits
  // when ordinary view persistence is unavailable.
  useEffect(() => {
    const projectKey = `${draftKey}:new-project`;
    const settingsKey = `${draftKey}:settings`;
    let projectRevision = viewRevision(scope, projectKey);
    let settingsRevision = viewRevision(scope, settingsKey);
    return subscribeView(scope, () => {
      const nextProject = viewRevision(scope, projectKey);
      const nextSettings = viewRevision(scope, settingsKey);
      if (nextProject !== undefined && nextProject !== projectRevision) {
        projectRevision = nextProject;
        const project = readView<unknown>(scope, projectKey, projectId ?? "");
        setSelectedProject(
          typeof project === "string" ? project : (projectId ?? ""),
        );
      }
      if (nextSettings !== undefined && nextSettings !== settingsRevision) {
        settingsRevision = nextSettings;
        setDraftSettings(readDraftSettings(scope, draftKey));
      }
    });
  }, [scope, draftKey, projectId]);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const input = prompt.current?.querySelector<
      HTMLTextAreaElement | ComposerInputElement
    >('textarea, [contenteditable="true"]');
    input?.focus();
    // A returning draft resumes at its end, not before its first tag.
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [focusRequest]);
  // The remount replaces the editor; one that had the caret keeps it.
  const [restored, setRestored] = useState({ count: 0, focus: false });
  // Whether the composer holds text or model choices it has not saved.
  const unsaved = useRef(false);
  useEffect(() => {
    const chat = {
      scope,
      key: draftKey,
      editing: () => settingsOpen || unsaved.current,
      restored() {
        const focus = !!prompt.current?.contains(document.activeElement);
        setRestored(({ count }) => ({ count: count + 1, focus }));
      },
    };
    openNewChats.add(chat);
    return () => {
      openNewChats.delete(chat);
    };
  }, [scope, draftKey, settingsOpen]);
  // Re-reads the region's owner as its source starts and stops.
  useSoloNavigation(session);
  const owner = region
    ? soloNavigationFor(session)?.draftRegion(region)
    : undefined;
  const draftAgent = owner?.source.draftAgent;
  const ownerBinding = owner?.binding;
  const agentFilter = useCallback(
    (pubkey: string) =>
      !draftAgent || !ownerBinding || draftAgent(ownerBinding, pubkey),
    [draftAgent, ownerBinding],
  );
  const available = session.channelWrites.available && (!region || !!owner);
  const [channelId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  // A workspace's defaults load as soon as it is picked, so starting a chat
  // in it does not wait for them. A start uses them up, or loads them again
  // if that load failed or the saved defaults have changed since.
  const workspace = useRef<{
    id: string;
    setup: ReturnType<typeof loadChatSetup>;
  }>(undefined);
  useEffect(() => {
    if (!selectedProject || workspace.current?.id === selectedProject) return;
    const setup = loadChatSetup(session, selectedProject);
    setup.catch(() => {});
    workspace.current = { id: selectedProject, setup };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function start(
    draft: MentionDraft,
    files: AttachmentDraft,
    addressed?: readonly MentionRecipient[],
    picks?: MentionPicks,
    draftPicks?: DraftPicks,
    draftPicksRevision?: string | null,
  ) {
    const text = composerMarkdown(draft);
    if (submitting.current || !text.trim() || !available) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    const recipients = [
      ...new Set(
        (addressed ?? mentionDraft(draft).recipients).map(
          (item) => item.pubkey,
        ),
      ),
    ];
    const named =
      typeof draftSettings.name === "string" &&
      !!canonicalDetailsName(draftSettings.name);
    const name =
      typeof draftSettings.name === "string"
        ? canonicalDetailsName(draftSettings.name) || startingChatTitle(draft)
        : draftSettings.name;
    const ttlSeconds = draftLifetime(scope, draftSettings);
    const project = selectedProject;
    const canvas = draftCanvas;
    const draftModelPicksKey = soloModelPicksKey(`${draftKey}:new-draft`);
    const chatModelPicksKey = soloModelPicksKey(channelId);
    const startingDraftPicks = draftPicks ?? {};
    try {
      if (typeof name !== "string")
        throw new Error("The chat name could not be verified.");
      const errors = detailsDraftErrors({
        name,
        description: "",
        visibility: "private",
        ttlSeconds,
      });
      if (errors.name) throw new Error(errors.name);
      if (errors.lifetime) throw new Error(errors.lifetime);
      const loaded =
        workspace.current?.id === project
          ? await workspace.current.setup.catch(() => undefined)
          : undefined;
      workspace.current = undefined;
      let setup: ChatSetup | undefined;
      if (project) {
        const kit = session.channelKit.snapshot();
        setup =
          kit.status === "ready" && loaded?.revision === defaultsRevision(kit)
            ? loaded
            : await loadChatSetup(session, project);
      }
      if (!mounted.current) return;
      if (canvas !== undefined)
        setup = parseChatSetup({
          ...(setup ?? {
            ...(project ? { projectId: project } : {}),
            agents: [],
          }),
          canvas,
        });
      // The workspace's agents join in the create with the tagged ones.
      const members = [...new Set([...recipients, ...(setup?.agents ?? [])])];
      // The agents already listed decide at once; only an unknown one waits
      // for a fresh list.
      const selectable = () =>
        members.every((key) =>
          session.agentChoices
            .snapshot()
            .selectable.some((agent) => agent.pubkey === key),
        );
      if (!selectable()) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
        if (!selectable())
          throw new Error(
            "Solo chats can only use your available agents. Check mentions and workspace defaults.",
          );
      }
      // Read at Send: the region's source may have stopped since.
      const regionOwner = () => {
        const current = region
          ? soloNavigationFor(session)?.draftRegion(region)
          : undefined;
        if (region && !current) throw new Error(REGION_UNAVAILABLE);
        return current;
      };
      const eligible = regionOwner();
      const accepts = eligible?.source.draftAgent;
      if (
        eligible &&
        accepts &&
        members.some((key) => !accepts(eligible.binding, key))
      )
        throw new Error(
          "This chat's plugin can't use one of these agents. Choose another agent.",
        );
      // Finish uploads before anything is created, so a failed file blocks
      // the start instead of leaving an empty chat behind.
      const uploaded = await files.prepareForSend(new AbortController().signal);
      if (!mounted.current) return;
      regionOwner();
      // The region's source finds how its chat started, even after a restart.
      const startKey = region ? regionStartKey(channelId) : undefined;
      if (
        startKey &&
        !writeView(scope, startKey, {
          region,
          ...(project ? { workspace: project } : {}),
          // Only while it still targets the workspace it leads.
          ...(lead && project === projectId ? { lead: true } : {}),
        })
      )
        throw new Error(
          "This chat couldn't be saved on this device. Your draft is kept.",
        );
      const attached = files.snapshot();
      // The chat lists at once, in its workspace, and its message goes out
      // behind the create, so the agents start on it without waiting for the
      // relay. Its Canvas is saved once the chat exists; until then local
      // agents read it from the start.
      // A region files its own chats.
      if (setup?.projectId && !region)
        void session.soloPreferences
          .assign(channelId, setup.projectId)
          .catch((reason) =>
            console.warn("Solo chat could not join its workspace", reason),
          );
      let starting: ReturnType<typeof session.channelWrites.start>;
      try {
        starting = session.channelWrites.start(
          channelId,
          name,
          members,
          ttlSeconds,
          named,
          setup?.canvas
            ? {
                canvas: setup.canvas,
                apply: () =>
                  session.canvas.save(channelId, setup.canvas, undefined),
              }
            : undefined,
          // Unguarded, so a restart can retry it like any New chat.
          ...(region ? [{ labels: [region] }] : []),
        );
      } catch (reason) {
        if (startKey) writeView(scope, startKey, null);
        throw reason;
      }
      const { ready } = starting;
      // Observe admission immediately, even while local persistence awaits ownership.
      void ready.catch(() => {});
      const firstPicks: MentionPicks = Object.fromEntries(
        Object.entries(picks ?? {}).filter(([pubkey]) =>
          recipients.includes(pubkey),
        ),
      );
      const retainedPicks = firstChatPicks(
        startingDraftPicks,
        firstPicks,
        recipients,
      );
      try {
        signMessageTokens(draftTokens(draft), () =>
          Object.keys(firstPicks).length
            ? session.messages.send(
                channelId,
                text,
                recipients,
                uploaded,
                undefined,
                [],
                firstPicks,
              )
            : session.messages.send(
                channelId,
                text,
                recipients,
                ...(uploaded.length ? [uploaded] : []),
              ),
        );
        files.clear();
        writeView(
          scope,
          `draft:${channelId}`,
          // The toolbar keeps the agents when it routed the send.
          addressed
            ? followupDraft([])
            : rememberedMentions(session, draft, recipients),
        );
      } catch (reason) {
        // The chat still starts; its own composer keeps the message to send.
        console.warn("Solo first message waits in its chat", reason);
        writeView(scope, `draft:${channelId}`, draft);
        transferAttachmentDraft(
          files,
          attachmentDraft(session, `${scope}:draft:${channelId}`, channelId),
        );
      }
      if (source) writeView(scope, draftKey, null);
      writeView(scope, `${draftKey}:settings`, null);
      // A linked draft is reused for its source: clear it to absent so the
      // next start from that source seeds its link again.
      writeView(scope, `${draftKey}:new-draft`, source ? null : "");
      writeView(scope, `${draftKey}:new-draft:agents`, null);
      writeView(scope, `${draftKey}:new-project`, null);
      let savedChatPicks = !Object.keys(retainedPicks).length;
      let clearedPicks: "saved" | "changed" | "failed" = "failed";
      let ownedDraftVersion = draftPicksRevision;
      try {
        await lockSoloModelPicks(scope, async () => {
          const cleared = await transactModelPicks(
            scope,
            [chatModelPicksKey, draftModelPicksKey],
            (tx) => {
              if (!savedChatPicks)
                tx.write(chatModelPicksKey, {
                  ...retainedPicks,
                  ...parseSoloModelPicks(tx.revision(chatModelPicksKey)),
                });
              if (tx.version(draftModelPicksKey) !== draftPicksRevision)
                return undefined;
              // An already-empty draft has no model choice to consume. Keep its
              // receipt so another choice-free start does not disown recovery.
              return tx.revision(draftModelPicksKey) === null
                ? tx.version(draftModelPicksKey)
                : tx.write(draftModelPicksKey, null);
            },
          );
          savedChatPicks = true;
          ownedDraftVersion = cleared;
          clearedPicks = cleared === undefined ? "changed" : "saved";
          publishModelPicks(scope);
        });
      } catch {
        // Delivery retains its frozen choices; neither shared map is changed unlocked.
      }
      draftEdited(undefined);
      if (mounted.current) onStarted(channelId);
      if (clearedPicks === "failed")
        notify(
          "Could not clear model and effort from New chat. Reset them before starting another chat.",
          "error",
        );
      if (!savedChatPicks)
        notify(
          "Could not save model and effort for this chat. Choose them again before your next message.",
          "error",
        );
      // Only a start that made no chat ends here; the chat and its messages
      // are dropped (see channelWrites.start), and what was sent returns to a
      // New chat still blank. Any other miss leaves the chat listed, with its
      // messages' own Retry.
      void ready.catch((reason: unknown) => {
        if (!(reason instanceof ChatNotStarted)) return;
        if (startKey) writeView(scope, startKey, null);
        let restoring = false;
        let restored = false;
        let prepared: { before: string | null; written: string } | undefined;
        const restore = async () => {
          if (restoring || restored) return;
          restoring = true;
          let failedPromptWrite = false;
          try {
            await lockSoloModelPicks(scope, async () => {
              const open = () =>
                [...openNewChats].filter(
                  (chat) => chat.scope === scope && chat.key === draftKey,
                );
              const blankWith = (choices: string | null) =>
                blankNewChat(
                  session,
                  scope,
                  draftKey,
                  choices,
                  clearedPicks === "failed",
                ) && !open().some((chat) => chat.editing());
              const saved = await transactModelPicks(
                scope,
                [chatModelPicksKey, draftModelPicksKey],
                (tx) => {
                  const current = tx.version(draftModelPicksKey);
                  const ownPrepared =
                    prepared?.written === current ? prepared : undefined;
                  const before = ownPrepared
                    ? ownPrepared.before
                    : tx.revision(draftModelPicksKey);
                  // Even an equal-value Reset belongs to the later writer.
                  const blank =
                    (ownPrepared !== undefined ||
                      current === ownedDraftVersion) &&
                    blankWith(before);
                  tx.write(chatModelPicksKey, null);
                  const written = blank
                    ? tx.write(draftModelPicksKey, startingDraftPicks)
                    : undefined;
                  return { before, blank, written };
                },
              );
              if (saved.written)
                prepared = { before: saved.before, written: saved.written };
              publishModelPicks(scope);
              // Text can change while IDB commits. Keep that newer work, undoing only
              // this attempt's model restoration while we still own the scope lock.
              const blank = saved.blank && blankWith(saved.before);
              const undoPrepared = async () => {
                if (!prepared) return;
                const undo = prepared;
                const version = await transactModelPicks(
                  scope,
                  [draftModelPicksKey],
                  (tx) => {
                    if (tx.version(draftModelPicksKey) === undo.written)
                      return tx.write(
                        draftModelPicksKey,
                        undo.before === null
                          ? null
                          : parseSoloModelPicks(undo.before),
                      );
                  },
                );
                ownedDraftVersion = version;
                prepared = undefined;
                publishModelPicks(scope);
              };
              if (!blank) await undoPrepared();
              // The text first: when it can't be saved, an open New chat may hold
              // unsaved text of its own, so nothing else is given back.
              const returned =
                blank && writeView(scope, `${draftKey}:new-draft`, draft);
              if (blank && !returned) {
                await undoPrepared();
                failedPromptWrite = true;
                throw new Error("The recovered prompt could not be saved.");
              }
              writeView(scope, `draft:${channelId}`, null);
              clearAttachmentDraft(session, `${scope}:draft:${channelId}`);
              // What else could not be saved: the toast says so, since a retry
              // would otherwise silently use the defaults instead.
              const missing: string[] = [];
              const returnedTo = `${scope}\n${draftKey}`;
              if (returned) {
                restoredPrompts.set(returnedTo, JSON.stringify(draft));
                if (source && !writeView(scope, draftKey, source))
                  missing.push("link");
                if (!writeView(scope, `${draftKey}:settings`, draftSettings))
                  missing.push("settings");
                if (!writeView(scope, `${draftKey}:new-project`, project))
                  missing.push("workspace");
                // The pill's agents, when it routed the send; the composer reads
                // them as it mounts. Tags in the text carry their own.
                if (
                  addressed &&
                  !draft.recipients.length &&
                  !writeView(scope, `${draftKey}:new-draft:agents`, addressed)
                )
                  missing.push("agents");
                attachmentDraft(
                  session,
                  `${scope}:${draftKey}:new-draft`,
                  channelId,
                  true,
                ).adopt(attached);
                for (const chat of open()) chat.restored();
              }
              const why = /[.!?]$/.test(reason.message)
                ? reason.message
                : `${reason.message}.`;
              const earlier = restoredPrompts.get(returnedTo);
              const outcome = returned
                ? missing.length
                  ? `Your message is back in New chat, but its ${new Intl.ListFormat(
                      undefined,
                      { type: "conjunction" },
                    ).format(missing)} could not be saved on this device.`
                  : "Your message is back in New chat."
                : earlier !== undefined &&
                    viewRevision(scope, `${draftKey}:new-draft`) === earlier
                  ? "New chat holds an earlier message that couldn't be sent, so this one was not restored."
                  : "New chat has a newer draft, so your message was not restored.";
              restored = true;
              onFailed?.(
                channelId,
                `Couldn't start "${name}": ${why} ${outcome}`,
              );
            });
          } catch {
            const unavailable = failedPromptWrite
              ? "Your message could not be saved on this device."
              : "Window ownership or saved choices are unavailable.";
            onFailed?.(
              channelId,
              `Couldn't start "${name}": ${reason.message}. ${unavailable} Retry to restore your message.`,
              restore,
            );
          } finally {
            restoring = false;
          }
        };
        void restore();
      });
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // The workspace control and `#` in the prompt both choose with this.
  const chooseProject = (project: string) => {
    if (project === selectedProject) return;
    setSelectedProject(project);
    writeView(scope, `${draftKey}:new-project`, project);
    const next = {
      name: draftSettings.name,
      ttlSeconds: draftSettings.ttlSeconds,
      ...(draftSettings.lifetimeChosen
        ? { lifetimeChosen: true as const }
        : {}),
      canvas: undefined,
    };
    setDraftSettings(next);
    writeView(scope, `${draftKey}:settings`, next);
  };
  const composer = (
    <div id="new-chat-prompt" ref={prompt}>
      <MessageComposer
        key={restored.count}
        focusRequest={restored.focus ? restored.count : 0}
        chatPresentation
        ownSoloConversation
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={channelId}
        channelName="this chat"
        label="Message your agents"
        inviteAgents
        agentFilter={draftAgent ? agentFilter : undefined}
        defaultMention={defaultAgent}
        requireMention
        trailingTool={
          session.soloPreferences ? (
            <WorkspaceControl
              session={session}
              value={selectedProject}
              onChange={chooseProject}
              disabled={busy}
            />
          ) : undefined
        }
        workspace={
          session.soloPreferences && !busy
            ? { preferences: session.soloPreferences, choose: chooseProject }
            : undefined
        }
        submission={{
          draftKey: `${draftKey}:new-draft`,
          modelPicksKey: soloModelPicksKey(`${draftKey}:new-draft`),
          // The space ends the link, so typing after it writes prose.
          initialDraft: source && `${source.link} `,
          locked: busy,
          disabled: busy || !available,
          attachments: true,
          unsaved: (held) => {
            unsaved.current = held;
          },
          onDraftChange: draftEdited,
          submit: (draft, files, addressed, picks, draftPicks, revision) => {
            void start(draft, files, addressed, picks, draftPicks, revision);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          {region && !owner
            ? REGION_UNAVAILABLE
            : "Solo preferences or channel creation are unavailable. Your draft is saved."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  return (
    <SoloDraftView
      actions={
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={busy}
          onClick={() => {
            setSettingsLifetime(draftLifetime(scope, draftSettings));
            setSettingsOpen(true);
          }}
        />
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSettings
          finalFocus={settingsTrigger}
          session={session}
          projectId={selectedProject || undefined}
          canvas={draftCanvas}
          name={draftSettings.name}
          ttlSeconds={settingsLifetime}
          close={() => setSettingsOpen(false)}
          save={(canvas, ttlSeconds, name) => {
            // A lifetime changed here, or chosen before, stays chosen; an
            // unchanged one keeps following the default.
            const chosen =
              !!draftSettings.lifetimeChosen ||
              draftSettings.ttlSeconds !== undefined ||
              ttlSeconds !== settingsLifetime;
            const next = {
              canvas,
              ttlSeconds: chosen ? ttlSeconds : undefined,
              ...(chosen ? { lifetimeChosen: true as const } : {}),
              name: name ?? "",
            };
            if (!writeView(scope, `${draftKey}:settings`, next))
              throw new Error(
                "Settings couldn’t be saved on this device. Try again.",
              );
            setDraftSettings(next);
          }}
        />
      )}
    </SoloDraftView>
  );
}
