import type { ChannelMessage } from "./contracts";

function sameArray<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (a: T, b: T) => boolean = Object.is,
) {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.length === right.length &&
      left.every((value, index) => same(value, right[index] as T)))
  );
}

function sameRow(left: ChannelMessage, right: ChannelMessage) {
  return (
    left.id === right.id &&
    left.channelId === right.channelId &&
    left.delivery === right.delivery &&
    left.deliveryError === right.deliveryError &&
    left.authorId === right.authorId &&
    left.signerId === right.signerId &&
    left.workflowOwnerId === right.workflowOwnerId &&
    left.createdAt === right.createdAt &&
    left.createdAtMs === right.createdAtMs &&
    left.content === right.content &&
    left.sourceContent === right.sourceContent &&
    left.agentEnvelope === right.agentEnvelope &&
    left.audience === right.audience &&
    left.request === right.request &&
    !!left.diff === !!right.diff &&
    left.diff?.filePath === right.diff?.filePath &&
    left.diff?.repoUrl === right.diff?.repoUrl &&
    left.diff?.commitSha === right.diff?.commitSha &&
    left.diff?.description === right.diff?.description &&
    left.diff?.truncated === right.diff?.truncated &&
    left.membership?.type === right.membership?.type &&
    left.membership?.actor === right.membership?.actor &&
    left.membership?.target === right.membership?.target &&
    left.edited === right.edited &&
    left.attachmentSourceId === right.attachmentSourceId &&
    sameArray(left.attachmentSeams, right.attachmentSeams) &&
    sameArray(left.mentions, right.mentions) &&
    sameArray(left.mentionReferences ?? [], right.mentionReferences ?? []) &&
    sameArray(
      left.attachments,
      right.attachments,
      (a, b) =>
        a.url === b.url &&
        a.kind === b.kind &&
        a.mime === b.mime &&
        a.size === b.size &&
        a.name === b.name &&
        a.duration === b.duration &&
        a.voiceNote === b.voiceNote &&
        sameArray(a.waveform, b.waveform) &&
        a.dimensions?.width === b.dimensions?.width &&
        a.dimensions?.height === b.dimensions?.height &&
        a.blurhash === b.blurhash &&
        a.previewUrl === b.previewUrl,
    ) &&
    sameArray(
      left.emoji,
      right.emoji,
      (a, b) => a.shortcode === b.shortcode && a.url === b.url,
    ) &&
    sameArray(
      left.reactions,
      right.reactions,
      (a, b) =>
        a.content === b.content &&
        a.emoji?.shortcode === b.emoji?.shortcode &&
        a.emoji?.url === b.emoji?.url &&
        sameArray(
          a.events,
          b.events,
          (left, right) =>
            left.id === right.id && left.authorId === right.authorId,
        ),
    ) &&
    left.threadRootId === right.threadRootId &&
    left.replyParentId === right.replyParentId &&
    left.mediaTargetUrl === right.mediaTargetUrl &&
    left.sentFromThread?.rootId === right.sentFromThread?.rootId &&
    left.sentFromThread?.excerpt === right.sentFromThread?.excerpt &&
    left.replyCount === right.replyCount &&
    sameArray(left.participants, right.participants)
  );
}

/** Reuse immutable rows whose complete folded value is unchanged. */
export function shareMessageRows(
  previous: readonly ChannelMessage[],
  next: readonly ChannelMessage[],
) {
  if (!previous.length) return next;
  const byId = new Map(previous.map((row) => [row.id, row]));
  const shared = next.map((row) => {
    const existing = byId.get(row.id);
    return existing && sameRow(existing, row) ? existing : row;
  });
  return sameArray(previous, shared) ? previous : shared;
}
