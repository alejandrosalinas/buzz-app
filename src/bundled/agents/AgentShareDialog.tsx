// Share: send the agent to people or a channel, list it in its community's Marketplace, or
// export it as a file.
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  catalogContent,
  catalogHead,
  isShared,
  publishShare,
  shareable,
  snapshotJson,
  snapshotPng,
} from "../../features/agents/agent-share";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import { cardModel, drawShareCard } from "../../features/agents/share-card";
import { agentCardColor } from "../../features/agents/agent-card-color";
import {
  type SharedAgent,
  sharedAgents,
} from "../../features/agents/shared-agents";
import type { EventData } from "../../features/relay/events";
import { downloadNativeFile } from "../../features/messages/native-download";
import type { UploadedAttachment } from "../../features/relay/attachments";
import type { RelaySession } from "../../features/relay/session";
import { bundledPoster } from "../../features/agents/avatar-packs";
import { avatarSource } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuNote,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SplitButton } from "../../shared/design-system/ui/SplitButton";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { AgentCardPreview } from "./AgentCardPreview";
import styles from "./AgentShareDialog.module.css";
import {
  AgentShareRecipients,
  type ShareTarget,
  targetName,
} from "./AgentShareRecipients";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** What went wrong in a sentence of its own. */
const errorText = (error: unknown) => {
  const text = message(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

/** How long export waits for the picture, which keeps the dialog open. */
const ARTWORK_MS = 5000;

/** The agent's picture, decoded. Missing, unreadable or slow artwork is left
 * out. */
async function loadPicture(picture: string | undefined, session: RelaySession) {
  const source = avatarSource(picture);
  // Pack art is read from the app's own copy; other pictures go through the
  // session's media path.
  const src = source?.startsWith("data:")
    ? source
    : source && (bundledPoster(source) ?? session.media(source));
  if (!src) return undefined;
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image.crossOrigin = "anonymous";
    image.src = src;
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => {
        timer = setTimeout(reject, ARTWORK_MS);
      }),
    ]);
    return image;
  } catch {
    // Stops a load still in flight.
    image.src = "";
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The model the agent runs, as its harness names it, including the default
 * it runs when none is chosen; its summary when the harness can't say. */
async function modelOf(agent: Agent, type: RegisteredAgentType | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      type?.models?.(agent),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ARTWORK_MS);
      }),
    ]);
    const label = found?.models.find(
      (model) => model.id === found.current,
    )?.label;
    if (label) return label;
  } catch {
    // Its summary stands in.
  } finally {
    clearTimeout(timer);
  }
  try {
    return type?.summary?.(agent) ?? "";
  } catch {
    return "";
  }
}

/** The agent's card as PNG bytes. A picture whose origin keeps the card from
 * being read back gives way to the agent's initial; a card that can't be
 * drawn at all leaves the snapshot without artwork. */
async function cardArt(
  agent: Agent,
  type: RegisteredAgentType | undefined,
  session: RelaySession,
) {
  const [picture, model] = await Promise.all([
    loadPicture(agent.picture, session),
    modelOf(agent, type),
  ]);
  const harness = type?.title ?? "";
  const accentColor = agentCardColor(agent.pubkey, picture);
  for (const art of picture ? [picture, undefined] : [undefined]) {
    try {
      const card = await drawShareCard({
        name: agent.name,
        harness,
        model: cardModel(harness, model),
        picture: art,
        accentColor,
      });
      return {
        bytes: new Uint8Array(await card.arrayBuffer()),
        accentColor,
        portrait:
          art && agent.picture ? bundledPoster(agent.picture) : undefined,
      };
    } catch {
      // Try without the picture, then give up.
    }
  }
  return undefined;
}

/** A plain, bounded file name on every desktop, where Windows reserves device
 * names such as `CON` whatever the extension. */
function fileName(name: string, format: string) {
  const stem = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  const plain = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    ? `${stem}-agent`
    : stem;
  return `${plain}.agent.${format}`;
}

/** Desktop saves natively and says where; a browser downloads the file to
 * wherever its settings say. */
async function saveFile(file: Blob, name: string): Promise<string | undefined> {
  if (isTauri()) return downloadNativeFile(file, name);
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // WebKit may still be reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The outbox's durable name for one copy of an agent sent to one person or
 * channel, so a retry, even after a reload, finds that message again rather
 * than sending another. An edited agent is a different copy. */
async function shareRecovery(agent: Agent, target: ShareTarget, copy: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(copy),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    key: `agent-share:${agent.pubkey}:${target.id}:${hex.slice(0, 40)}`,
    value: "1",
  };
}

/** Names in a sentence: "Ana", "Ana and #design", "Ana, Ben and Cy". */
const names = (targets: readonly ShareTarget[]) => {
  const all = targets.map(targetName);
  const last = all.pop() ?? "";
  return all.length ? `${all.join(", ")} and ${last}` : last;
};

export function AgentShareDialog({
  agent,
  type,
  session,
  onViewListing,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  session: RelaySession;
  /** Opens the agent as the Marketplace lists it. */
  onViewListing?: ((agent: SharedAgent) => void) | undefined;
  onClose(): void;
}) {
  const notify = useToastNotification();
  // `null` while the catalog is read; `undefined` once read with no head.
  const [head, setHead] = useState<EventData | undefined | null>(null);
  const [pending, setPending] = useState<
    "done" | "update" | "export" | "send"
  >();
  // What the switch asks for; Done publishes or removes it.
  const [wanted, setWanted] = useState<boolean>();
  // The listing being published or removed, while the relay answers.
  const [listing, setListing] = useState<boolean>();
  const [failure, setFailure] = useState("");
  const [error, setError] = useState("");
  const [format, setFormat] = useState<"png" | "json">("png");
  // Export shows the card it will save before saving it.
  const [previewing, setPreviewing] = useState(false);
  const [card, setCard] = useState<
    | {
        bytes: Uint8Array<ArrayBuffer>;
        url: string;
        accentColor: string;
        portrait?: string | undefined;
      }
    | "failed"
  >();
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // The read failed; clearing it reads again.
  const [unread, setUnread] = useState(false);
  const attempt = useRef<AbortController>(null);
  useEffect(() => {
    if (unread) return;
    const controller = new AbortController();
    attempt.current = controller;
    catalogHead(session, agent.owner, agent.pubkey, controller.signal).then(
      setHead,
      () => !controller.signal.aborted && setUnread(true),
    );
    return () => controller.abort();
  }, [session, agent.owner, agent.pubkey, unread]);
  // A share is a copy: edits reach the Marketplace only when it is updated.
  let definition: ReturnType<typeof shareable> | undefined;
  let refused = "";
  try {
    definition = shareable(agent, type);
  } catch (reason) {
    refused = message(reason);
  }
  const current = definition && catalogContent(definition);
  const listed = isShared(head ?? undefined);
  const stale = !!head && listed && current !== head.content;
  /** Publishes or removes the listing; says whether the relay confirmed it. */
  const share = async (shared: boolean, via: "done" | "update") => {
    const signal = attempt.current?.signal;
    if (head === null || pending || !signal) return false;
    setPending(via);
    setListing(shared);
    setFailure("");
    let reason = "Try again.";
    let content: string | undefined;
    try {
      // Removing keeps what was shared, so it never depends on the agent
      // still being shareable.
      content =
        !shared && head ? head.content : catalogContent(shareable(agent, type));
      await publishShare(session, agent.pubkey, content, shared, head, signal);
    } catch (error) {
      reason = message(error);
    }
    // An accepted publish can still lose to a newer head, and an unanswered
    // one may still have landed, so the relay says which head won. Until it
    // answers, the last head it confirmed stands.
    const next = await catalogHead(
      session,
      agent.owner,
      agent.pubkey,
      signal,
    ).catch(() => head);
    setPending(undefined);
    setListing(undefined);
    if (signal.aborted) return false;
    setHead(next);
    // An update to a listed agent leaves it listed whatever happened, so a
    // publish has landed only when the winning head is what it sent.
    if (
      shared ? isShared(next) && next?.content === content : !isShared(next)
    ) {
      const listed = shared ? sharedAgents(next ? [next] : [])[0] : undefined;
      notify(
        shared
          ? `Published ${agent.name} to the Marketplace.`
          : `Removed ${agent.name} from the Marketplace.`,
        "success",
        listed && onViewListing
          ? { label: "View", onClick: () => onViewListing(listed) }
          : undefined,
      );
      return true;
    }
    // The switch keeps what was asked for, so Done tries again.
    setFailure(
      `Couldn’t ${shared ? "publish" : "remove"} ${agent.name}. ${reason}`,
    );
    return false;
  };
  const finish = async () => {
    if (wanted === undefined || wanted === listed) return onClose();
    if (await share(wanted, "done")) onClose();
  };
  const file = async (as: "png" | "json") =>
    definition &&
    (as === "png"
      ? snapshotPng(definition, (await cardArt(agent, type, session))?.bytes)
      : new Blob([snapshotJson(definition)], { type: "application/json" }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed agent or picture is drawn again.
  useEffect(() => setCard(undefined), [current, agent.picture]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Drawn once per agent and picture, not again whenever the agent's record re-renders.
  useEffect(() => {
    if (!previewing || card) return;
    let live = true;
    void cardArt(agent, type, session).then((art) => {
      if (!live) return;
      setCard(
        art
          ? {
              ...art,
              url: URL.createObjectURL(
                new Blob([art.bytes], { type: "image/png" }),
              ),
            }
          : "failed",
      );
    });
    return () => {
      live = false;
    };
  }, [previewing, card, current, agent.picture, session]);
  useEffect(
    () => () => {
      if (card && card !== "failed") URL.revokeObjectURL(card.url);
    },
    [card],
  );
  const backButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const preview = (open: boolean) => {
    setPreviewing(open);
    setError("");
    // Save waits for the card, so Back holds focus until it is drawn.
    requestAnimationFrame(() => (open ? backButton : search).current?.focus());
  };
  const ready = !!card && card !== "failed";
  useEffect(() => {
    if (ready && document.activeElement === backButton.current)
      saveButton.current?.focus();
  }, [ready]);
  const save = async (as: "png" | "json") => {
    if (pending || !definition) return;
    setPending("export");
    setError("");
    try {
      // The card saved is the one shown.
      // A card that couldn't be drawn still saves the agent, without artwork.
      const snapshot =
        as === "png"
          ? card && snapshotPng(definition, ready ? card.bytes : undefined)
          : await file(as);
      if (!snapshot) return;
      const path = await saveFile(snapshot, fileName(agent.name, as));
      notify(
        `${as === "png" ? "Saved an agent card for" : "Saved"} ${agent.name}${path ? ` to ${path}` : ""}.`,
        "success",
      );
      if (as === "png") preview(false);
    } catch (reason) {
      setError(`Couldn’t export ${agent.name}. ${message(reason)}`);
    } finally {
      setPending(undefined);
    }
  };
  const primary = useRef<HTMLButtonElement>(null);
  const upload = useRef<{ content: string; file: UploadedAttachment }>(
    undefined,
  );
  const sending = useRef<AbortController>(null);
  useEffect(() => () => sending.current?.abort(), []);
  const send = async () => {
    if (pending || !definition || !targets.length) return;
    const uploads = session.attachments;
    const outbox = session.outbox;
    if (!uploads || !outbox) {
      setError("This community can’t send agents in messages.");
      return;
    }
    const controller = new AbortController();
    sending.current = controller;
    const { signal } = controller;
    setPending("send");
    setError("");
    const failed: ShareTarget[] = [];
    const reasons = new Set<string>();
    for (const target of targets) {
      try {
        const recovery = await shareRecovery(agent, target, current ?? "");
        await outbox.ready();
        signal.throwIfAborted();
        // A message the outbox still holds for this copy is confirmed, and
        // retried there if need be, rather than sent again.
        const earlier = outbox
          .snapshot()
          .find((item) => item.recovery?.key === recovery.key)?.event;
        let message = earlier && {
          id: earlier.id,
          channel: earlier.tags.find(([name]) => name === "h")?.[1] ?? "",
        };
        if (!message) {
          if (target.kind === "person" && !session.directMessages.available)
            throw new Error("Direct messages aren’t available here.");
          // A person gets it in a direct message; a channel, in the channel.
          const channel =
            target.kind === "channel"
              ? target.id
              : await session.directMessages.open([target.id], signal);
          // One upload serves every message of this copy: community media
          // isn't scoped to a conversation.
          let copy = upload.current;
          if (!copy || copy.content !== current)
            upload.current = copy = {
              content: current ?? "",
              file: await uploads.upload(
                new File(
                  [(await file("png")) as Blob],
                  fileName(agent.name, "png"),
                  { type: "image/png" },
                ),
                channel,
                signal,
              ),
            };
          message = {
            channel,
            id: session.messages.send(
              channel,
              `Here’s a copy of my agent, ${agent.name}. Choose the card to add it to your agents.`,
              [],
              [copy.file],
              recovery,
            ),
          };
        }
        await session.directMessages.delivered(
          message.id,
          message.channel,
          signal,
        );
        // Delivered: the outbox may let the message go.
        await outbox.acknowledge(message.id);
      } catch (error) {
        if (signal.aborted) return;
        failed.push(target);
        reasons.add(errorText(error));
      }
    }
    if (signal.aborted) return;
    setPending(undefined);
    const delivered = targets.filter((target) => !failed.includes(target));
    if (delivered.length)
      notify(`Sent ${agent.name} to ${names(delivered)}.`, "success");
    // What it couldn't reach stays chosen, to try again.
    setTargets(failed);
    if (failed.length)
      setError(
        `Couldn’t send to ${names(failed)}. ${reasons.size === 1 ? [...reasons][0] : "Try again."}`,
      );
    // Send gives way to Done once everyone is reached; focus follows it.
    requestAnimationFrame(() => primary.current?.focus());
  };
  const busy = !!pending;
  return (
    <Dialog
      open
      headerGap="compact"
      footerGap="compact"
      title={previewing ? `Export ${agent.name}` : `Share ${agent.name}`}
      description={
        previewing
          ? `Anyone with this card can add ${agent.name}, instructions and settings included. Memories and chats stay with you.`
          : "Everyone gets their own copy. Later changes won’t sync."
      }
      // Keep the same frame across steps so entering and leaving the card
      // does not resize the dialog during its crossfade.
      size="default"
      height="stable-tall"
      bodyLayout="flex"
      initialFocus={search}
      preventClose={busy}
      step={
        previewing ? { key: "export", scale: 1 } : { key: "share", scale: 1 }
      }
      onOpenChange={(open) => {
        // Dismissing the preview goes back to sharing.
        if (!open) previewing ? preview(false) : onClose();
      }}
      leadingActions={
        !previewing && (
          <SplitButton
            aria-label={`Export ${agent.name} as ${format === "png" ? "an agent card" : "a JSON file"}`}
            menuLabel="Choose an export format"
            loading={pending === "export"}
            disabled={busy || !definition}
            onClick={() =>
              format === "png" ? preview(true) : void save(format)
            }
            menu={
              <>
                <MenuNote>
                  An agent card is an image that holds the agent’s setup, so
                  anyone can add it to Buzz.
                </MenuNote>
                <MenuRadioGroup
                  value={format}
                  onValueChange={(value: string) =>
                    setFormat(value as "png" | "json")
                  }
                >
                  <MenuRadioItem value="png" closeOnClick>
                    Agent card
                  </MenuRadioItem>
                  <MenuRadioItem value="json" closeOnClick>
                    JSON file
                  </MenuRadioItem>
                </MenuRadioGroup>
              </>
            }
          >
            {format === "png" ? "Export agent card" : "Export JSON"}
          </SplitButton>
        )
      }
      actions={
        previewing ? (
          <>
            <Button
              ref={backButton}
              disabled={busy}
              onClick={() => preview(false)}
            >
              Back
            </Button>
            <Button
              ref={saveButton}
              variant="prominent"
              loading={pending === "export"}
              disabled={busy || !card || !definition}
              onClick={() => void save("png")}
            >
              Save card
            </Button>
          </>
        ) : targets.length ? (
          <Button
            ref={primary}
            variant="prominent"
            loading={pending === "send"}
            disabled={busy || !definition}
            onClick={() => void send()}
          >
            Send
          </Button>
        ) : (
          <Button
            ref={primary}
            variant="prominent"
            loading={pending === "done"}
            disabled={busy}
            onClick={() => void finish()}
          >
            Done
          </Button>
        )
      }
    >
      {previewing ? (
        <div className={styles.preview}>
          <LoadingRegion
            pending={!card}
            label="Drawing the card…"
            feedback={
              // A save can still fail after a card couldn’t be drawn, and an
              // agent can stop being shareable while previewed; say each.
              refused || card === "failed" || error ? (
                <div className="grid gap-1">
                  {refused && (
                    <p role="alert" className="m-0 text-body-sm text-danger">
                      {agent.name} can’t be shared. {refused}
                    </p>
                  )}
                  {card === "failed" && (
                    <p role="alert" className="m-0 text-body-sm text-danger">
                      Couldn’t draw the card. Saving still keeps the agent’s
                      setup.{" "}
                      <Button
                        size="sm"
                        onClick={() => {
                          // Try again leaves while the card is drawn again.
                          backButton.current?.focus();
                          setCard(undefined);
                        }}
                      >
                        Try again
                      </Button>
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="m-0 text-body-sm text-danger">
                      {error}
                    </p>
                  )}
                </div>
              ) : undefined
            }
          >
            <AgentCardPreview
              portrait={ready ? card.portrait : undefined}
              accentColor={ready ? card.accentColor : undefined}
              src={ready ? card.url : undefined}
              alt={`${agent.name}’s agent card`}
            />
          </LoadingRegion>
        </div>
      ) : (
        <div className={styles.layout}>
          {refused && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {agent.name} can’t be shared. {refused}
            </p>
          )}
          <AgentShareRecipients
            session={session}
            query={query}
            chosen={targets}
            disabled={busy || !definition}
            inputRef={search}
            onQueryChange={setQuery}
            onChange={(next) => {
              setTargets(next);
              setError("");
            }}
          />
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
          <div className="grid gap-2">
            <SettingsGroup>
              <SwitchPreferenceRow
                label={
                  listed ? "Published to Marketplace" : "Publish to Marketplace"
                }
                description={
                  unread
                    ? "Couldn’t check the Marketplace."
                    : head === null
                      ? "Checking the Marketplace…"
                      : listing !== undefined
                        ? listing
                          ? "Publishing…"
                          : "Removing…"
                        : stale
                          ? "Your latest changes aren’t in the Marketplace yet."
                          : "Anyone in this community can add a copy, instructions included. Memories and chats stay with you."
                }
                checked={listing ?? wanted ?? listed}
                disabled={
                  head === null || unread || busy || (!listed && !definition)
                }
                onCheckedChange={(on) => {
                  setWanted(on);
                  setFailure("");
                }}
              />
            </SettingsGroup>
            {failure && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {failure}
              </p>
            )}
            {unread && (
              <Button size="sm" onClick={() => setUnread(false)}>
                Try again
              </Button>
            )}
            {stale && (wanted ?? listed) && (
              <Button
                size="sm"
                loading={pending === "update"}
                disabled={busy || !definition}
                onClick={() => void share(true, "update")}
              >
                Update Marketplace
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
