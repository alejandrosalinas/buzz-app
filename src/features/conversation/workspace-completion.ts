import { createContext } from "react";
import type { RelaySession } from "../relay/session";
import type { CompletionEdit } from "./contracts";

/** A new chat's workspace, as its composer's workspace control shows it. */
export type WorkspaceCompletionTarget = Readonly<{
  /** The list the workspace control offers. */
  preferences: Pick<RelaySession["soloPreferences"], "snapshot" | "subscribe">;
  /** What choosing it in the workspace control does. */
  choose(workspaceId: string): void;
}>;

/** Host-internal: present only while the composer's chat is new. Plugins
 * cannot import this module, so only host providers can read it. */
export const WorkspaceCompletion = createContext<
  WorkspaceCompletionTarget | undefined
>(undefined);

const edits = new WeakSet<object>();
/** A `#` row that chooses the chat's workspace instead of inserting text.
 * Only host code makes one; a plugin's look-alike edit is dropped. */
export function workspaceEdit(workspaceId: string): CompletionEdit {
  const edit = Object.freeze({ workspace: workspaceId });
  edits.add(edit);
  return edit as unknown as CompletionEdit;
}
export function chosenWorkspace(edit: object) {
  return edits.has(edit)
    ? (edit as unknown as { workspace: string }).workspace
    : undefined;
}
