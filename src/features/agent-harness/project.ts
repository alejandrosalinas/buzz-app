// A Solo chat's Canvas, handed to its agent with every turn: the workspace's
// instructions and the folders it works in. A shared Solo chat's members can
// write its Canvas too, so only a head the owner or one of their attested
// agents approved is handed over as the chat's standing instructions; agents
// never read it on their own initiative.
import {
  approvedCanvas,
  type CanvasHead,
} from "../channel-templates/canvas-approval";
import {
  agentCanvas,
  ownerWorktreeRules,
  workspaceDirectories,
} from "../solo/workspace";
import { unframed } from "./plugin-wake";
import type { SectionChoices } from "./sections/choices";
import { replacedBy } from "./sections/compose";

/** A Canvas the owner's side approved. `agent`: one of the owner's attested
 * agents wrote it, not the owner. */
export type OwnerCanvas = Readonly<{ content: string; agent?: true }>;

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
    "<workspace-canvas>\nThis conversation has no workspace Canvas from its owner now. Disregard any earlier workspace Canvas, its instructions and its folders.\n</workspace-canvas>",
  directories: [],
});

/** A shared session retains an unread Canvas only for the same source. */
export class ProjectSource {
  private source: string | undefined;
  private project: Project = NO_PROJECT;
  preview(source: string | undefined, project: Project | undefined): Project {
    return project ?? (source === this.source ? this.project : NO_PROJECT);
  }
  resolve(source: string | undefined, project: Project | undefined): Project {
    this.project = this.preview(source, project);
    this.source = source;
    return this.project;
  }
}

/** The tags that rank instructions in the base instructions' Trust order.
 * A Canvas's text prints none: only the host says who wrote the Canvas. */
const RANKED =
  /<(\/?)(workspace-canvas|agent-instructions|owner-instructions|team-instructions|team)(?![\w-])/gi;

/** Whether a chat's Canvas does not say where its work happens: the
 * conversation has a `folder` of its own, or the plugin that manages it
 * replaced the working location rule. */
export const worksElsewhere = (
  folder: string | undefined,
  choices: SectionChoices | undefined,
) => !!folder || replacedBy("working-location", choices) === "plugin";

/** `elsewhere`: the chat's work happens elsewhere (`worksElsewhere`), so the
 * Canvas's folders are for reading, unless its owner wrote worktree rules
 * for them by hand. The section states the rule for the folders it lists;
 * the base prompt's working location rule points here. It also says who
 * wrote the Canvas, which the base prompt ranks it by. */
export function project(
  canvas: OwnerCanvas | undefined,
  elsewhere = false,
): Project {
  const content = canvas?.content;
  if (!content?.trim()) return NO_PROJECT;
  // Only the owner's own hand edit is the owner's rule for the chat.
  const ownerWrote = !canvas?.agent;
  const directories = workspaceDirectories(content);
  // Its paths come from the Canvas too, so they rank nothing either.
  const list = directories
    .map((folder) => `\`${folder.replace(RANKED, "<\\$1$2")}\``)
    .join(", ");
  const folders = !directories.length
    ? ""
    : elsewhere
      ? ` These folders hold code that is relevant to this chat: ${list}.${ownerWrote && ownerWorktreeRules(content) ? "" : " They are for reading."}`
      : ` This chat's work happens in these folders, not your own workspace: ${list}. To change files there, follow this Canvas's rule for them, or your working location rule when it gives none; your workspace keeps your notes.`;
  const standing = ownerWrote
    ? "which your owner wrote: their standing instructions for this chat, which your owner's messages override"
    : "which an agent wrote: standing instructions for this chat, which your owner's messages and your base instructions override";
  return {
    section: `<workspace-canvas>\nThis Solo chat's Canvas as of this message, ${standing}. It replaces any earlier workspace Canvas.${folders}\n\n${unframed(agentCanvas(content, elsewhere, ownerWrote).trim()).replace(RANKED, "<\\$1$2")}\n</workspace-canvas>`,
    directories,
  };
}

/** How long a turn waits for its chat's Canvas. */
export const CANVAS_TIMEOUT_MS = 4_000;

/** The channel's Canvas when `owner`, or an agent they attest, approved its
 * current head, with which of them wrote it; undefined when it has none or
 * someone else wrote it. A chat the owner's device is still `starting`
 * answers with the Canvas it starts with, before the relay has it: the
 * owner's own. */
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
): Promise<OwnerCanvas | undefined> {
  if (starting !== undefined)
    return starting ? { content: starting } : undefined;
  if (!canvas?.available) return undefined;
  const head = await canvas.read(channelId);
  if (!head) return undefined;
  if (await approvedCanvas(head, owner))
    return head.pubkey === owner
      ? { content: head.content }
      : { content: head.content, agent: true };
  console.warn(
    "Ignoring a Canvas its owner's side has not approved",
    channelId,
  );
  return undefined;
}

/** The chat's Canvas from `read`, or undefined when it could not be read in
 * time or there is no reader: the caller keeps what it knew. */
export async function readCanvas(
  read: (() => Promise<OwnerCanvas | undefined>) | undefined,
): Promise<{ text: OwnerCanvas | undefined } | undefined> {
  if (!read) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return {
      text: await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Canvas read timed out")),
            CANVAS_TIMEOUT_MS,
          );
        }),
      ]),
    };
  } catch (error) {
    console.warn("Could not read the chat's Canvas", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The chat's project from `read`, or undefined as for `readCanvas`. */
export async function readProject(
  read: (() => Promise<OwnerCanvas | undefined>) | undefined,
  elsewhere = false,
): Promise<Project | undefined> {
  const canvas = await readCanvas(read);
  return canvas && project(canvas.text, elsewhere);
}
