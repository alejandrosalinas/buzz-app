// Folders and skills an owner's message references with `!` and `/` chips,
// handed to the agent for that turn. Anyone in a chat can sign a chip, so only
// the owner's own chips count: a folder only when their repositories folder on
// this device lists it now, a skill only when it names this agent.
import { invoke } from "@tauri-apps/api/core";
import {
  repositoryFolders,
  type RepositoryFolder,
} from "../communities/repositories";
import { readMessageTokens } from "../messages/message-tokens";
import type { EventData } from "../relay/events";

export type ReferencedFolders = Readonly<{
  /** The prompt section; empty when there are none. */
  section: string;
  directories: readonly string[];
}>;

const NONE: ReferencedFolders = Object.freeze({ section: "", directories: [] });
/** How long a turn waits for the repositories folder listing. */
const LIST_TIMEOUT_MS = 4_000;

/** Literal paths that cannot close a prompt section. */
const quoted = (paths: readonly string[]) =>
  paths
    .map((path) =>
      JSON.stringify(path)
        .replaceAll("<", "\\u003c")
        .replaceAll(">", "\\u003e"),
    )
    .join(", ");

export async function referencedFolders(
  event: Pick<EventData, "pubkey" | "tags">,
  owner: string | undefined,
  scope: string | undefined,
  list = (path: string) =>
    invoke<readonly RepositoryFolder[]>("repositories_folder_list", { path }),
): Promise<ReferencedFolders> {
  if (!owner || !scope || event.pubkey !== owner) return NONE;
  let ids: string[];
  try {
    ids = readMessageTokens(event.tags)
      .filter((token) => token.kind === "folder")
      .map((token) => token.id);
  } catch {
    return NONE;
  }
  if (!ids.length) return NONE;
  try {
    const listed = new Set(
      (
        await repositoryFolders(
          scope,
          AbortSignal.timeout(LIST_TIMEOUT_MS),
          list,
        )
      ).map((folder) => folder.path),
    );
    const directories = ids.filter((id) => listed.has(id));
    if (!directories.length) return NONE;
    return {
      section: `<referenced-folders>\nThe owner's message references these folders on this device (literal paths): ${quoted(directories)}. \`cd\` into the one you need; your workspace keeps your notes.\n</referenced-folders>`,
      directories,
    };
  } catch (error) {
    console.warn("Could not check the referenced folders", error);
    return NONE;
  }
}

/** The prompt section for the skills the owner's message chose for `agent`
 * with `/` chips; empty when there are none. It names each SKILL.md; the
 * agent reads the file itself. */
export function referencedSkills(
  event: Pick<EventData, "pubkey" | "tags">,
  owner: string | undefined,
  agent: string,
) {
  if (!owner || event.pubkey !== owner) return "";
  let paths: string[];
  try {
    paths = readMessageTokens(event.tags)
      .filter((token) => token.kind === "skill" && token.target === agent)
      .map((token) => token.id);
  } catch {
    return "";
  }
  return paths.length
    ? `<referenced-skills>\nThe owner's message asks you to use these skills on this device. Read each SKILL.md before you start (literal paths): ${quoted(paths)}.\n</referenced-skills>`
    : "";
}
