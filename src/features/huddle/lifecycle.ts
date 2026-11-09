import type { EventData } from "../relay/events";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix = "Buzz Huddle (buzz.huddles/v1)\nparent:";
export const huddleDescription = (parent: string) => `${prefix}${parent}`;
export function huddleParent(description: string | undefined) {
  if (!description?.startsWith(prefix)) return;
  const parent = description.slice(prefix.length);
  return uuid.test(parent) ? parent : undefined;
}
export const isHuddleRoom = (description: string | undefined) =>
  huddleParent(description) !== undefined;
export function huddleRoom(event: Pick<EventData, "content">) {
  try {
    const id = JSON.parse(event.content)?.ephemeral_channel_id;
    return typeof id === "string" && uuid.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
/** Relay-signed participation is display evidence, never permission to join. */
export function huddleLifecycle(
  events: readonly EventData[],
  room: string,
  parent: string,
  authority?: string,
) {
  const scoped = events.filter(
    (e) =>
      huddleRoom(e) === room &&
      e.tags.some((t) => t[0] === "h" && t[1] === parent),
  );
  const start = scoped
    .filter((e) => e.kind === 48100)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  const participants = new Set<string>();
  let endedAt: number | undefined;
  for (const event of scoped.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      a.kind - b.kind ||
      a.id.localeCompare(b.id),
  )) {
    if (start && event.created_at < start.created_at) continue;
    if (
      event.kind === 48103 &&
      (event.pubkey === authority || event.pubkey === start?.pubkey)
    ) {
      endedAt = event.created_at;
    } else if (!endedAt && event.pubkey === authority) {
      const key = event.tags.find((t) => t[0] === "p")?.[1];
      if (!key || !/^[0-9a-f]{64}$/.test(key)) continue;
      if (event.kind === 48101) participants.add(key);
      if (event.kind === 48102) participants.delete(key);
    }
  }
  return {
    startedAt: start?.created_at,
    endedAt,
    participants: [...participants],
  };
}
