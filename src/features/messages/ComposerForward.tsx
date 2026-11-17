import { isPrivateForwardSource } from "./is-private-forward-source";
import { snapshotAttachments } from "../relay/forwarded-message";
import { useEffect, useState } from "react";
import { fullSession, type ComposerSession } from "./composer-session";
import { prepareForwardSource, type ResolvedForward } from "./resolve-forward";
import type { RelaySession } from "../relay/session";
import { splitPartition } from "../relay/partition";
import { useChannelIdentityNames } from "../identity-names/react";
import { useForwardSource } from "./use-forward-source";
import type { ForwardReference } from "./forward-clipboard";
import { ForwardedMessage } from "./ForwardedMessage";
import { MessageMarkdown } from "./MessageMarkdown";
import { useReferenceDirectory } from "./ReferenceText";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import styles from "./ForwardMessage.module.css";

export function useComposerForward(
  session: RelaySession | ComposerSession | undefined,
  reference: ForwardReference | null | undefined,
  destination: string,
  note: string,
) {
  const host = fullSession(session);
  const bridge = (session as ComposerSession | undefined)?.forwarding;
  const key = JSON.stringify(reference);
  const origin = reference?.origin;
  const sourceChannel = reference?.channelId;
  const sourceId = reference?.id;
  const [remote, setRemote] = useState<{
    key: string;
    source?: ResolvedForward;
    error?: string;
  }>();
  useEffect(() => {
    if (!origin || !sourceChannel || !sourceId || !bridge || host) return;
    const controller = new AbortController();
    void bridge
      .resolve(
        { version: 1, origin, channelId: sourceChannel, id: sourceId },
        controller.signal,
      )
      .then(
        (source) => {
          if (!controller.signal.aborted) setRemote({ key, source });
        },
        (error) => {
          if (!controller.signal.aborted)
            setRemote({
              key,
              error: String(error instanceof Error ? error.message : error),
            });
        },
      );
    return () => controller.abort();
  }, [bridge, host, key, origin, sourceChannel, sourceId]);
  const resolved = remote?.key === key ? remote : undefined;
  const sameCommunity =
    !!reference &&
    !!session?.scope &&
    reference.origin === splitPartition(session.scope)?.communityOrigin;
  const source = useForwardSource(
    host,
    reference?.channelId ?? "",
    reference?.id ?? "",
    !!reference && sameCommunity,
    true,
  );
  const directory = useReferenceDirectory(session);
  const resolve = useChannelIdentityNames(session, reference?.channelId);
  const row = host ? source.row : resolved?.source?.row;
  const author = row?.workflowOwnerId ?? row?.authorId;
  const name =
    resolved?.source?.name ??
    (author
      ? resolve(
          author,
          directory.profiles.get(author)?.name ?? author.slice(0, 10),
        )
      : "");
  const prepared = row
    ? prepareForwardSource(row, name, directory.profiles, directory.agents)
    : undefined;
  const snapshot = prepared?.snapshot;
  const forwardRow = prepared?.row;
  const problem = !reference
    ? undefined
    : !session
      ? "Open this conversation in the main window to paste a forwarded message."
      : !sameCommunity
        ? "This message belongs to another community. Switch communities to forward it."
        : resolved?.error || resolved?.source?.problem
          ? (resolved.error ?? resolved.source?.problem)
          : source.unavailable
            ? "Couldn't load this message. It may have been deleted, or you no longer have access."
            : forwardRow
              ? host?.messages.forwardProblem(
                  destination,
                  forwardRow,
                  name,
                  note,
                )
              : undefined;
  const privateSource = host
    ? isPrivateForwardSource(source.reference)
    : resolved?.source?.privateSource;
  return {
    disclosure:
      !!forwardRow && !!privateSource && sourceChannel !== destination,
    row: forwardRow,
    snapshot,
    name,
    problem,
    directory,
    blocked: !!reference && (!forwardRow || !!problem),
  };
}
export function ComposerForward({
  session,
  state,
  scope,
  onRemove,
}: {
  session: RelaySession | undefined;
  state: ReturnType<typeof useComposerForward>;
  scope: string;
  onRemove(): void;
}) {
  return (
    <div className={styles.composerPreview}>
      <div className={styles.removeForward}>
        <IconButton
          aria-label="Remove forwarded message"
          icon={<XIcon size={16} />}
          onClick={onRemove}
        />
      </div>
      {state.snapshot && state.row ? (
        <ForwardedMessage snapshot={state.snapshot} session={session} compact>
          <MessageMarkdown
            directory={state.directory}
            session={session}
            scope={scope}
            row={{
              ...state.row,
              content: state.snapshot.content,
              mentions: [],
              mentionReferences:
                state.snapshot.mentionLabels?.map(({ id }) => id) ?? [],
              mentionLabels: state.snapshot.mentionLabels ?? [],
              emoji: state.snapshot.emoji ?? [],
            }}
            media={session?.media ?? (() => undefined)}
            onOpenLink={() => false}
            interactive={false}
          />
          {snapshotAttachments(state.row).length > 0 && (
            <span className="text-body-sm">
              {snapshotAttachments(state.row).length} attachments included
            </span>
          )}
        </ForwardedMessage>
      ) : (
        !state.problem && (
          <p role="status" className="text-body-sm">
            Loading forwarded message…
          </p>
        )
      )}
      {state.problem && (
        <p role="alert" className="text-body-sm">
          {state.problem}
        </p>
      )}
    </div>
  );
}
