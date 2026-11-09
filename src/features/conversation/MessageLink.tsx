import { invoke, isTauri } from "@tauri-apps/api/core";
import { useConversationPresentation } from "./ConversationPresentation";
import {
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent,
} from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import type { ContributionReader, LinkRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuLinkItem,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  BrowserIcon,
  ChatCircleIcon,
  CopyIcon,
  CaretRightIcon,
  MessageReplyIcon,
  LockIcon,
} from "../../shared/design-system/icons";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import type { RelaySession } from "../relay/session";
import {
  fullSession,
  type ComposerSession,
} from "../messages/composer-session";
import { parseBuzzLink, isBuzzLink } from "../navigation/buzz-links";
import { safeLinkUrl } from "../relay/message-content";
import {
  LinkChannelPrivateContext,
  LinkDescriptionContext,
  LinkInteractiveContext,
  LinkLabelContext,
  LinkContentContext,
  LinkPreviewContext,
  LinkThreadTabContext,
  type LinkPreview,
} from "./LinkLabelContext";
import {
  BuzzLinkPreview,
  ChannelLinkPreview,
  previewFailures,
} from "./BuzzLinkPreview";
import { namedChannel, useChannelReference } from "./channel-reference";
import { useLinkedMessageByline } from "./linked-message";
import { messageViewKey } from "../messages/view-key";
import { soloChatLinkName } from "../solo/labels";
import styles from "./LinkPreview.module.css";
import { writeClipboardText } from "../../shared/clipboard";

const empty: readonly Contribution<LinkRenderer>[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};

/** Lowest `order` among active matches wins, like panels; a broken matcher
 * leaves other candidates eligible and never prevents opening a link. */
export const resolveLink = (
  url: string,
  renderers: readonly Contribution<LinkRenderer>[],
) => resolveMatch(renderers, url);

const previewGap = 8;

/** Lift a preview above the hovered message's actions, not over them. */
function clearMessageActions(link: HTMLElement | null) {
  const actions = link
    ?.closest("[data-actions-revealed]")
    ?.querySelector("[data-message-actions]");
  if (!link || !actions) return previewGap;
  return Math.max(
    previewGap,
    link.getBoundingClientRect().top -
      actions.getBoundingClientRect().top +
      previewGap,
  );
}

export function MessageLink({
  url,
  children,
  registry,
  onOpenLink,
  canOpenLink,
  label,
  directoryLabel,
  session,
  scope,
  interactive = true,
  channelPrivate = false,
}: {
  url: string;
  children?: ReactNode;
  registry: ContributionReader<LinkRenderer> | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((url: string) => boolean) | undefined;
  label?: string | undefined;
  /** The receiving community's name for a raw destination. Display only: a raw
   * link copies as its URL. */
  directoryLabel?: string | undefined;
  session?: RelaySession | ComposerSession | undefined;
  scope?: string | undefined;
  interactive?: boolean;
  channelPrivate?: boolean;
}) {
  const active = useConversationPresentation();
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? subscribe,
    registry?.snapshot ?? snapshot,
    registry?.snapshot ?? snapshot,
  );
  const renderer = resolveLink(url, renderers);
  const [unavailable, setUnavailable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [description, setDescription] = useState<string>();
  // A renderer's own hover card, such as an agent card's Add to Buzz.
  const [offered, setOffered] = useState<LinkPreview>();
  const offeredAction = useRef<HTMLDivElement>(null);
  if (!active && previewOpen) setPreviewOpen(false);
  const trigger = useRef<HTMLAnchorElement>(null);
  // Entering the card hides the row's actions; keep its lift while it's open.
  const lift = useRef(previewGap);
  const panelTarget = !safeLinkUrl(url) && !isBuzzLink(url) && !!canOpenLink;
  const internal = isBuzzLink(url) || panelTarget;
  const parsed = internal ? parseBuzzLink(url) : null;
  const destination = parsed?.format === "legacy" ? parsed : undefined;
  const host = fullSession(session);
  // Channel-only links name a channel the reader may not have joined. A
  // composer decoration is the writer's own draft: it never looks one up.
  const referenced =
    interactive &&
    destination &&
    !destination.messageId &&
    !destination.threadRootId
      ? destination.channelId
      : undefined;
  const reference = useChannelReference(host?.channels, referenced);
  // Subscribe to the session's presentation, including chosen-name provenance.
  // A string snapshot stays stable when unrelated channel activity changes.
  const chatName = useSyncExternalStore(
    host?.channels.subscribeList ?? subscribe,
    () => {
      if (!destination || destination.messageId || destination.threadRootId)
        return "";
      const channel = host?.channels
        .list()
        .channels.find((item) => item.id === destination.channelId);
      return channel?.channelType === "solo" && !channel.cached
        ? soloChatLinkName(channel)
        : "";
    },
    () => "",
  );
  // Authored Session labels survive access loss; they are presentation only.
  const sentChatName = label?.match(/^(?:Session|Chat)(?::| ·)\s+(.+)$/s)?.[1];
  const chatChip = !!(
    destination &&
    !destination.messageId &&
    !destination.threadRootId &&
    (chatName ||
      (reference.state === "found" && reference.channelType === "solo") ||
      (reference.state !== "found" && sentChatName))
  );
  const chipName =
    chatName || sentChatName || destination?.channelId.slice(0, 8);
  const chatLabel = chatChip ? `Chat: ${chipName}` : undefined;
  const named = namedChannel(reference);
  const withheld = reference.state === "withheld";
  // The authored label is message text, so it stays; the lock marks it. A raw
  // destination has no name to show.
  const shown = withheld && label === undefined ? "Private channel" : children;
  // A raw message destination names its author once read; a draft never reads.
  const byline = useLinkedMessageByline(
    interactive && label === undefined && children === undefined
      ? host
      : undefined,
    destination?.channelId,
    destination?.messageId,
  );
  const display =
    label ??
    byline ??
    directoryLabel ??
    (named ? `#${named.name}` : withheld ? "Private channel" : undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLAnchorElement>();
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  if (!active && menuOpen) setMenuOpen(false);
  if (!active && notice) setNotice(undefined);
  const external = /^https?:\/\//i.test(url);
  const openThreadTab = useContext(LinkThreadTabContext);
  const thread =
    openThreadTab && destination?.messageId
      ? {
          channelId: destination.channelId,
          messageId: destination.messageId,
          rootId: destination.threadRootId ?? destination.messageId,
        }
      : undefined;
  const menu = active && interactive && (external || !!thread);
  async function copy() {
    if (!active || busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await writeClipboardText(url);
      setNotice({ text: "Link copied", error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy the link. Try again from the link menu.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }
  const preview =
    host && destination?.messageId
      ? { channelId: destination.channelId, messageId: destination.messageId }
      : undefined;
  const openInternal = () => {
    if (trigger.current?.isConnected)
      trigger.current.focus({ preventScroll: true });
    const opened = (!panelTarget || !!canOpenLink?.(url)) && onOpenLink(url);
    setUnavailable(!opened);
    if (opened) setPreviewOpen(false);
  };
  const navigation = {
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!active) {
        event.preventDefault();
        return;
      }
      if (internal) {
        event.preventDefault();
        openInternal();
        return;
      }
      // Tauri's automatic external-link opener skips Command-clicks.
      if (external && event.metaKey && event.button === 0 && isTauri()) {
        event.preventDefault();
        setNotice(undefined);
        void invoke("plugin:opener|open_url", { url }).catch(() => {
          setNotice({
            text: "Couldn’t open the link in your browser.",
            error: true,
          });
        });
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        onOpenLink(url)
      )
        event.preventDefault();
    },
    onAuxClick: internal
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          if (!active) {
            event.preventDefault();
            return;
          }
          if (event.button === 1) {
            event.preventDefault();
            openInternal();
          }
        }
      : undefined,
  };
  const anchor = (entry?: Contribution<LinkRenderer>) => {
    const Content = entry?.component;
    const content =
      chatChip && destination ? (
        <span className={styles.soloChip}>
          <span className={styles.soloIcon}>
            <ChatCircleIcon size={16} aria-hidden="true" />
          </span>
          <span className={styles.soloPrefix}>Chat:</span>
          <span className={styles.soloName}>{chipName}</span>
          {withheld ? (
            <LockIcon
              className={styles.soloLock}
              size={12}
              aria-hidden="true"
            />
          ) : reference.state === "found" ? (
            <CaretRightIcon size={16} aria-hidden="true" />
          ) : null}
        </span>
      ) : Content ? (
        <Content url={url} />
      ) : (
        (shown ?? display ?? url)
      );
    // Selection copy reads the authored label; empty marks a raw destination.
    const element = interactive ? (
      <a
        ref={trigger}
        href={url}
        aria-label={
          chatLabel
            ? withheld
              ? `${chatLabel}, unavailable`
              : `Open ${chatLabel}`
            : display
        }
        aria-description={
          chatChip && withheld
            ? "Chat unavailable. You don’t have access, or it no longer exists."
            : description
        }
        data-link-label={label ?? ""}
        data-panel-target={panelTarget ? url : undefined}
        data-solo-link={chatChip ? "" : undefined}
        title={
          chatLabel
            ? withheld
              ? `${chatLabel}. Chat unavailable. You don’t have access, or it no longer exists.`
              : chatLabel
            : withheld
              ? previewFailures.withheld
              : !preview && !named
                ? url
                : undefined
        }
        className={chatChip ? styles.soloLink : entry?.className}
        data-link-renderer={entry?.key}
        {...navigation}
      >
        {content}
      </a>
    ) : (
      <span
        className={chatChip ? styles.soloLink : entry?.className}
        data-link-renderer={entry?.key}
      >
        {content}
      </span>
    );
    const menuTrigger = menu ? (
      <ContextMenuTrigger
        render={element}
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(trigger.current ?? undefined);
            setMenuOpen(true);
          }
        }}
      />
    ) : (
      element
    );
    const card =
      !active || !interactive || !host
        ? undefined
        : preview
          ? {
              label: "Message preview",
              body: previewOpen && (
                <BuzzLinkPreview
                  key={messageViewKey(host, scope, url)}
                  session={host}
                  channelId={preview.channelId}
                  messageId={preview.messageId}
                />
              ),
            }
          : named
            ? {
                label: "Channel preview",
                body: <ChannelLinkPreview channel={named} />,
              }
            : offered
              ? {
                  label: offered.label,
                  body: (
                    <div ref={offeredAction} tabIndex={-1}>
                      {offered.render((target) => {
                        if (!active) return false;
                        const opened = onOpenLink(target);
                        setUnavailable(!opened);
                        if (opened) setPreviewOpen(false);
                        return opened;
                      })}
                    </div>
                  ),
                  controls: true,
                }
              : undefined;
    // A channel-only link keeps one root while its name resolves, so a link
    // focused during the lookup keeps its focus. Its card opens once found.
    // A renderer that may offer its own card keeps one root too: wrapping
    // the link when the card arrives would remount the renderer offering it.
    const root =
      card ??
      (active && interactive && session && referenced
        ? { label: "Channel preview", body: null }
        : active && interactive && host && entry
          ? { label: "Link preview", body: null }
          : undefined);
    // A card with its own controls is not itself the link's destination.
    const controls = !!card && "controls" in card;
    const linked = root ? (
      <PreviewCard
        trigger={menuTrigger}
        {...(controls
          ? { actionRef: offeredAction }
          : { link: <a href={url} {...navigation} /> })}
        open={previewOpen && !!card && !menuOpen}
        onOpenChange={(next) => {
          if (next) lift.current = previewGap;
          setPreviewOpen(next);
        }}
        side="top"
        sideOffset={({ side }) => {
          if (side !== "top") return previewGap;
          lift.current = Math.max(
            lift.current,
            clearMessageActions(trigger.current),
          );
          return lift.current;
        }}
        className={styles.popup ?? ""}
        aria-label={root.label}
      >
        {root.body}
      </PreviewCard>
    ) : (
      menuTrigger
    );
    if (!menu) return linked;
    return (
      <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
        {linked}
        <MenuPopup size="compact" anchor={menuAnchor} finalFocus={trigger}>
          {thread ? (
            <MenuItem
              onClick={() => {
                if (!active) return;
                // The host records the focused link as the tab's return target.
                if (trigger.current?.isConnected)
                  trigger.current.focus({ preventScroll: true });
                // A workspace that cannot show the thread opens it as a click would.
                if (
                  openThreadTab?.(
                    thread.channelId,
                    thread.messageId,
                    thread.rootId,
                  )
                )
                  setUnavailable(false);
                else openInternal();
              }}
            >
              <MenuIcon>
                <MessageReplyIcon size={16} />
              </MenuIcon>
              Open link
            </MenuItem>
          ) : (
            <MenuLinkItem
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              closeOnClick
            >
              <MenuIcon>
                <BrowserIcon size={16} />
              </MenuIcon>
              Open in browser
            </MenuLinkItem>
          )}
          <MenuItem disabled={copying} onClick={() => void copy()}>
            <MenuIcon>
              <CopyIcon size={16} />
            </MenuIcon>
            Copy link
          </MenuItem>
        </MenuPopup>
      </ContextMenuRoot>
    );
  };
  const link = renderer ? (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${url}`}
      fallback={anchor()}
    >
      {anchor(renderer)}
    </ContributionBoundary>
  ) : (
    anchor()
  );
  const result = (
    <>
      {link}
      {active && notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
      {unavailable && (
        <span role="status"> This Buzz link couldn’t be opened here.</span>
      )}
    </>
  );
  return (
    <LinkChannelPrivateContext
      value={channelPrivate || withheld || !!named?.private}
    >
      <LinkLabelContext value={display}>
        <LinkContentContext value={shown}>
          <LinkInteractiveContext value={interactive}>
            <LinkDescriptionContext
              value={interactive ? setDescription : undefined}
            >
              <LinkPreviewContext
                value={interactive && host ? setOffered : undefined}
              >
                {result}
              </LinkPreviewContext>
            </LinkDescriptionContext>
          </LinkInteractiveContext>
        </LinkContentContext>
      </LinkLabelContext>
    </LinkChannelPrivateContext>
  );
}
