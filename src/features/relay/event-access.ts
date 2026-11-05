import type { EventData } from "./events";
import { channelRowChannel, channelRowKind } from "./membership";

const AUXILIARY = new Set([5, 7, 9005, 40003, 39005]);
/** Visibility, not a second membership model. Reference-only auxiliaries need
 * retained target evidence; never guess that an orphan belongs to a public entity.
 * Resolve the whole batch before filtering, independently of arrival order. */
export function eventVisibility(
  canAccess: (channelId: string) => boolean,
  find: (id: string) => EventData | undefined,
) {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  function visible(event: EventData): boolean {
    if (channelRowKind(event.kind) && !channelRowChannel(event)) return false;
    const cached = memo.get(event.id);
    if (cached !== undefined) return cached;
    if (visiting.has(event.id) || visiting.size >= 32) return false;
    visiting.add(event.id);
    // The relay stores kind 0 globally and ignores a stray h tag
    // (is_global_only_kind), so a profile is never a channel's evidence.
    const channels =
      event.kind === 0
        ? []
        : event.tags.flatMap(([name, value]) =>
            name === "h" && value ? [value] : [],
          );
    if ([39000, 39001, 39002].includes(event.kind)) {
      const channel = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (channel) channels.push(channel);
    }
    let allowed = channels.every(canAccess);
    if (allowed && AUXILIARY.has(event.kind)) {
      const targets = event.tags.flatMap(([name, value]) =>
        name === "e" && value ? [value] : [],
      );
      allowed =
        (channels.length > 0 || targets.length > 0) &&
        targets.every((id) => {
          const parent = find(id);
          // Every referenced target must be known and visible. An explicit #h
          // cannot launder a second denied/unknown target in the same raw event.
          return !!parent && visible(parent);
        });
    }
    visiting.delete(event.id);
    memo.set(event.id, allowed);
    return allowed;
  }
  return visible;
}
/** Reads each channel's access once: for a visibility used in one synchronous
 * pass, where access cannot change. */
export function accessOnce(canAccess: (channelId: string) => boolean) {
  const answers = new Map<string, boolean>();
  return (channelId: string) => {
    let allowed = answers.get(channelId);
    if (allowed === undefined) {
      allowed = canAccess(channelId);
      answers.set(channelId, allowed);
    }
    return allowed;
  };
}
