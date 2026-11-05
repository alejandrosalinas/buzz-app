import { attestedOwner } from "../agents/owner-attestation";
import type { EventData } from "../relay/events";

export const CANVAS_INSTRUCTIONS = "canvas-instructions";
export type CanvasHead = Pick<
  EventData,
  "pubkey" | "kind" | "created_at" | "tags" | "content"
>;

/** Partial edits do not approve instructions inherited from another writer. */
export async function approvedCanvas(head: CanvasHead, owner: string) {
  if (head.tags.some((tag) => tag[0] === CANVAS_INSTRUCTIONS)) return false;
  return head.pubkey === owner || (await attestedOwner(head)) === owner;
}
