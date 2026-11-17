import { useCallback, useMemo } from "react";
import type { AttachmentRendererProps } from "../../features/conversation/contracts";
import {
  isNativeMediaSource,
  isProxySource,
} from "../../features/messages/attachment-source";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { PluginModule } from "../../plugins/api";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { fileFormat, formatLabel } from "./formats";
import { fileTarget, isCommunityMedia, parseFileTarget } from "./target";
import { Viewer } from "./Viewer";

/** A basic default: a plugin made for one format, claiming at the host's
 * default order 0, takes those files over. */
const ORDER = 100;

/** Where the viewer may read `url` from: only media shared in this community,
 * through the session's own media source. Files and Markdown images alike. */
function readableSource(
  url: string,
  origin: string | undefined,
  session: RelaySession,
): string | undefined {
  if (!isCommunityMedia(url, origin)) return undefined;
  const source = session.media(url);
  return source && (isProxySource(source) || isNativeMediaSource(source))
    ? source
    : undefined;
}

export const inject = ["panels", "conversation", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay: RelayData = ctx.relay;

  ctx.panels.register({
    id: "file-viewer",
    title: "File viewer",
    keepOpen: true,
    deferUntilShown: true,
    order: ORDER,
    matches: (target) => parseFileTarget(target) !== undefined,
    component: function FileViewerPanel({ target, context }) {
      const connection = useRelayConnection(relay);
      const file = useMemo(() => parseFileTarget(target), [target]);
      usePanelTabTitle(file?.name ?? "File viewer");
      const { origin, session } = connection;
      const media = useCallback(
        (url: string) => readableSource(url, origin, session),
        [origin, session],
      );
      const openLink = useCallback(
        (url: string) => context?.open(url) ?? false,
        [context],
      );
      if (!file) return null;
      if (!connection.origin && connection.status !== "ready")
        return (
          <LoadingRegion pending label={`Loading ${file.name}`}>
            {null}
          </LoadingRegion>
        );
      return (
        // A new file starts afresh, never showing the last one's contents under its name.
        <Viewer
          key={target}
          file={file}
          source={readableSource(file.url, origin, session)}
          session={session}
          openLink={openLink}
          media={media}
        />
      );
    },
  });

  function FileCard({
    attachment,
    message,
    source,
    placement,
    FileCard: HostFileCard,
    open,
  }: AttachmentRendererProps) {
    if (!HostFileCard) return null;
    const format = fileFormat(attachment.name, attachment.mime);
    return (
      <HostFileCard
        attachment={attachment}
        source={source}
        onOpenLink={open}
        {...(format ? { typeLabel: formatLabel(format) } : {})}
        {...(placement === "message"
          ? {
              onPreview: () =>
                void open(
                  fileTarget({
                    ...attachment,
                    ...(message ? { time: message.createdAt } : {}),
                  }),
                ),
            }
          : {})}
      />
    );
  }
  ctx.conversation.registerAttachment({
    id: "file-card",
    title: "File viewer",
    order: ORDER,
    matches: (attachment) =>
      attachment.kind === "file" &&
      fileFormat(attachment.name, attachment.mime) !== undefined &&
      isCommunityMedia(attachment.url, relay.snapshot().origin),
    component: FileCard,
  });
};
