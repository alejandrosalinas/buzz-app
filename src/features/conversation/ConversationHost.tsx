import type { Context } from "@deepseek-ai/cordis";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { PanelView } from "../panels/PanelView";
import { panelOpening, type PanelOpening } from "../panels/service";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { useConversationPresentation } from "./ConversationPresentation";
import { ForwardMessageProvider } from "../messages/ForwardMessage";
import type { MediaReview } from "./Conversation";

export type ConversationHostServices = Pick<
  Context,
  "panels" | "relay" | "navigation"
>;
export type ConversationInteractions = Required<
  Pick<ThreadPanelProps, "onOpenLink" | "canOpenLink" | "onOpenMediaReview">
>;
type ConversationHostProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName"
> & {
  host: ConversationHostServices;
  threadId?: string | undefined;
  children(
    interactions: ConversationInteractions,
    mediaReview: MediaReview | undefined,
  ): ReactNode;
};

/** At most one modal surface: opening a panel or a media review replaces the other. */
type Overlay =
  | (PanelOpening & { media?: undefined })
  | {
      media: Pick<
        MediaReview,
        | "messageId"
        | "attachment"
        | "initialTime"
        | "hasComments"
        | "initialAttachments"
      >;
      panel?: undefined;
    };

export function ConversationHost({
  host,
  session,
  scope,
  channelId,
  channelName,
  threadId,
  children,
}: ConversationHostProps) {
  const presented = useConversationPresentation();
  const presentation = useRef(presented);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!presented) setOverlay(undefined);
  }, [presented]);
  const viewer = scope.slice(-64);
  const relayUrl = scope.slice(0, -65);
  const panels = useSyncExternalStore(
    host.panels.subscribe,
    host.panels.snapshot,
  );
  const [overlay, setOverlay] = useState<Overlay>();
  // A panel never outlives its contribution.
  if (overlay?.panel && !panels.includes(overlay.panel)) setOverlay(undefined);
  // Captured callbacks may run late: nothing acts after unmount, and a plugin
  // panel acts only while it is still the overlay on screen.
  const mounted = useRef(false);
  const shown = useRef(overlay);
  useLayoutEffect(() => {
    mounted.current = true;
    shown.current = overlay;
    presentation.current = presented;
    return () => {
      mounted.current = false;
    };
  }, [overlay, presented]);
  const active = () => {
    const connection = host.relay.snapshot();
    return (
      mounted.current &&
      presentation.current &&
      connection.status === "ready" &&
      connection.session === session &&
      connection.scope === scope
    );
  };
  // Focus returns to what opened the first overlay, not to a replaced one.
  const enter = () => {
    if (!shown.current)
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
  };
  const canOpen = (target: string) => !!host.panels.resolve(target);
  /** Replacements stay in the opening message's thread, like Channels. */
  const open = (url: string, rootId?: string) => {
    if (!active()) return false;
    const target = buzzLinkTarget(url, { viewer, communityOrigin: relayUrl });
    if (target) {
      setOverlay(undefined);
      void host.navigation.open(target);
      return true;
    }
    const next = panelOpening(host.panels, channelId, url, rootId);
    if (!next) return false;
    enter();
    setOverlay(next);
    return true;
  };
  return (
    <ForwardMessageProvider
      session={session}
      scope={scope}
      navigation={host.navigation}
    >
      {children(
        {
          onOpenLink: (url, origin) => open(url, origin?.rootId),
          canOpenLink: canOpen,
          onOpenMediaReview: (
            messageId,
            attachment,
            initialTime,
            hasComments = false,
            initialAttachments,
          ) => {
            if (active()) {
              enter();
              setOverlay({
                media: {
                  messageId,
                  attachment,
                  initialTime,
                  hasComments,
                  initialAttachments,
                },
              });
            }
          },
        },
        presented && overlay?.media
          ? {
              ...overlay.media,
              restoreFocus: trigger,
              close: () => setOverlay(undefined),
            }
          : undefined,
      )}
      {presented && overlay?.panel && (
        <Dialog
          open
          title={overlay.panel.title}
          placement="right"
          height="stable"
          finalFocus={() =>
            trigger.current?.isConnected ? trigger.current : false
          }
          onOpenChange={(next) => {
            if (!next) setOverlay(undefined);
          }}
        >
          <PanelView
            panel={overlay.panel}
            target={overlay.target}
            close={() => {
              if (shown.current === overlay) setOverlay(undefined);
            }}
            channelContext={{
              scope,
              channelId,
              channelName,
              viewer,
              relayUrl,
              ...(threadId ? { threadId } : {}),
            }}
            context={{
              channelId,
              ...(overlay.rootId && { rootId: overlay.rootId }),
              canOpen,
              open: (target) =>
                shown.current === overlay &&
                host.panels.snapshot().includes(overlay.panel) &&
                open(target, overlay.rootId),
            }}
          />
        </Dialog>
      )}
    </ForwardMessageProvider>
  );
}
