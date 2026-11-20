import { invoke, isTauri } from "@tauri-apps/api/core";
import { useConversationPresentation } from "./ConversationPresentation";
import {
  useContext,
  useLayoutEffect,
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
  CopyIcon,
  ThreadIcon,
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
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import {
  LinkChannelKindContext,
  LinkDescriptionContext,
  LinkAccessibleNameContext,
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
  channelSolo = false,
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
  /** The joined list holds the destination as a Solo chat, confirmed or not. */
  channelSolo?: boolean;
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
  const [accessibleName, setAccessibleName] = useState<string>();
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
  // Any Buzz link names a channel the reader may not have joined. A composer
  // decoration is the writer's own draft: it never looks one up.
  const lookedUp = interactive ? destination?.channelId : undefined;
  // Only a channel-only link presents the channel itself; a message or thread
  // link keeps its own text and preview, and uses the answer only to stay
  // inert while the channel is withheld.
  const referenced =
    destination && !destination.messageId && !destination.threadRootId
      ? lookedUp
      : undefined;
  const reference = useChannelReference(host?.channels, lookedUp);
  // Subscribe to the session's presentation, including chosen-name provenance.
  // A string snapshot stays stable when unrelated channel activity changes.
  const channels = session?.channels;
  const chatName = useSyncExternalStore(
    channels?.subscribeList ?? subscribe,
    () => {
      if (!destination || destination.messageId || destination.threadRootId)
        return "";
      const channel = channels
        ?.list()
        .channels.find((item) => item.id === destination.channelId);
      return channel?.channelType === "solo" && !channel.cached
        ? soloChatLinkName(channel)
        : "";
    },
    () => "",
  );
  const named = referenced ? namedChannel(reference) : undefined;
  const withheld = reference.state === "withheld";
  const withheldChannel = withheld && !!referenced;
  // A card focused while the lookup was pending stops being a link once the
  // channel is withheld, and its focused node is replaced: return focus to
  // the link the reader came from.
  const cardFocused = useRef(false);
  useLayoutEffect(() => {
    if (!withheld || !cardFocused.current) return;
    cardFocused.current = false;
    const focused = document.activeElement;
    if (!focused || focused === document.body)
      trigger.current?.focus({ preventScroll: true });
  }, [withheld]);
  const soloChat =
    !!chatName ||
    (!!referenced &&
      reference.state === "found" &&
      reference.channelType === "solo");
  const channelKind = withheldChannel
    ? "private"
    : soloChat
      ? "chat"
      : channelPrivate || named?.private
        ? "private"
        : "channel";
  const channelName = withheldChannel
    ? undefined
    : (directoryLabel ?? (named ? `#${named.name}` : undefined));
  // The `#` completion writes a channel's name of the moment as its Markdown
  // link's text. Text that is only `#` and a channel name, which may hold
  // spaces, therefore follows the channel's current name once known, as a
  // profile link follows its person's. `#name` prose has no children: its
  // author wrote that name. A listed channel whose metadata has not arrived
  // is called by the start of its ID, which is no name to show instead, and
  // a Solo chat's title is not a channel name. The length is checked first:
  // it keeps the canonical-name scan, quadratic in whitespace, off an
  // arbitrary label.
  const written =
    !channelSolo &&
    channelName?.startsWith("#") &&
    channelName !== `#${destination?.channelId.slice(0, 8)}` &&
    typeof children === "string" &&
    children.startsWith("#")
      ? children.slice(1)
      : "";
  const current =
    written &&
    [...written].length <= 120 &&
    written === canonicalDetailsName(written)
      ? channelName
      : undefined;
  // Any other authored label is message text, so it stays; the lock marks it.
  // A raw destination has no name to show.
  const shown =
    withheldChannel && label === undefined
      ? "Private channel"
      : (current ?? children);
  // A raw message destination names its author once read; a draft never reads.
  const byline = useLinkedMessageByline(
    interactive && label === undefined && children === undefined
      ? host
      : undefined,
    destination?.channelId,
    destination?.messageId,
  );
  const display =
    current ??
    label ??
    (withheldChannel
      ? "Private channel"
      : (byline ?? (chatName || undefined) ?? channelName));
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
      // A withheld link has nowhere to go until its recheck admits it.
      if (!active || withheld) {
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
          if (!active || withheld) {
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
    const content = Content ? <Content url={url} /> : (shown ?? display ?? url);
    // Selection copy reads the authored label; empty marks a raw destination.
    const element = interactive ? (
      <a
        ref={trigger}
        href={url}
        aria-label={accessibleName ?? display}
        aria-description={
          // A withheld message link has no title; its preview says why.
          description ??
          (withheld && !referenced ? previewFailures.withheld : undefined)
        }
        aria-disabled={withheld || undefined}
        data-link-label={current ?? label ?? ""}
        data-panel-target={panelTarget ? url : undefined}
        title={
          withheld && !preview
            ? previewFailures.withheld
            : !preview && !named
              ? url
              : undefined
        }
        className={entry?.className}
        data-link-renderer={entry?.key}
        {...navigation}
      >
        {content}
      </a>
    ) : (
      <span className={entry?.className} data-link-renderer={entry?.key}>
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
        // A withheld destination's card only explains why; it isn't a link
        // until a recheck admits the reader.
        {...(controls
          ? { actionRef: offeredAction }
          : withheld
            ? {}
            : {
                link: (
                  <a
                    href={url}
                    {...navigation}
                    onFocus={() => {
                      cardFocused.current = true;
                    }}
                    onBlur={() => {
                      cardFocused.current = false;
                    }}
                  />
                ),
              })}
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
              disabled={withheld}
              onClick={() => {
                if (!active || withheld) return;
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
                <ThreadIcon size={16} />
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
    <LinkChannelKindContext value={channelKind}>
      <LinkLabelContext value={display}>
        <LinkContentContext value={shown}>
          <LinkInteractiveContext value={interactive}>
            <LinkDescriptionContext
              value={interactive ? setDescription : undefined}
            >
              <LinkPreviewContext
                value={interactive && host ? setOffered : undefined}
              >
                <LinkAccessibleNameContext
                  value={interactive ? setAccessibleName : undefined}
                >
                  {result}
                </LinkAccessibleNameContext>
              </LinkPreviewContext>
            </LinkDescriptionContext>
          </LinkInteractiveContext>
        </LinkContentContext>
      </LinkLabelContext>
    </LinkChannelKindContext>
  );
}
