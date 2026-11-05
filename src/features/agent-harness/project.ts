// A Solo chat's Canvas, handed to its agent with every turn: the workspace's
// instructions and the folders it works in. A shared Solo chat's members can
// write its Canvas too, so only a head the owner or one of their attested
// agents approved is handed over as the chat's standing instructions; agents
// never read it on their own initiative.
import {
  approvedCanvas,
  type CanvasHead,
} from "../channel-templates/canvas-approval";
import { workspaceDirectories } from "../solo/workspace";
import { unframed } from "./plugin-wake";

export type Project = Readonly<{
  /** The prompt section; empty when the Canvas is. */
  section: string;
  /** The folders the agent may work in, besides its own workspace. */
  directories: readonly string[];
}>;

/** A Solo chat with no owner's Canvas: says so, so an agent stops following
 * one it was handed before. */
export const NO_PROJECT: Project = Object.freeze({
  section:
    "<workspace-canvas>\nThis Solo chat has no workspace Canvas from its owner now. Disregard any earlier workspace Canvas, its instructions and its folders.\n</workspace-canvas>",
  directories: [],
});

export function project(canvas: string | undefined): Project {
  if (!canvas?.trim()) return NO_PROJECT;
  const directories = workspaceDirectories(canvas);
  const folders = directories.length
    ? ` This chat's work happens in these folders, not your own workspace: ${directories.map((folder) => `\`${folder}\``).join(", ")}. \`cd\` into the one you need; your workspace keeps your notes.`
    : "";
  return {
    section: `<workspace-canvas>\nThis Solo chat's Canvas as of this message: its standing instructions for this chat, which the owner's messages override. It replaces any earlier workspace Canvas.${folders}\n\n${unframed(canvas.trim())}\n</workspace-canvas>`,
    directories,
  };
}

/** How long a turn waits for its chat's Canvas. */
export const CANVAS_TIMEOUT_MS = 4_000;

/** The channel's Canvas text when `owner`, or an agent they attest, approved its
 * current head; undefined when it has none or someone else wrote it. A chat
 * the owner's device is still `starting` answers with the Canvas it starts
 * with, before the relay has it. */
export async function ownerCanvas(
  canvas:
    | Readonly<{
        available: boolean;
        read(channelId: string): Promise<CanvasHead | null | undefined>;
      }>
    | undefined,
  owner: string,
  channelId: string,
  starting?: string,
): Promise<string | undefined> {
  if (starting !== undefined) return starting || undefined;
  if (!canvas?.available) return undefined;
  const head = await canvas.read(channelId);
  if (!head) return undefined;
  if (await approvedCanvas(head, owner)) return head.content;
  console.warn(
    "Ignoring a Canvas its owner's side has not approved",
    channelId,
  );
  return undefined;
}

/** The chat's project from `read`, or undefined when it could not be read in
 * time or there is no reader: the caller keeps what it knew. */
export async function readProject(
  read: (() => Promise<string | undefined>) | undefined,
): Promise<Project | undefined> {
  if (!read) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return project(
      await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Canvas read timed out")),
            CANVAS_TIMEOUT_MS,
          );
        }),
      ]),
    );
  } catch (error) {
    console.warn("Could not read the chat's Canvas", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
