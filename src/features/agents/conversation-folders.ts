// The working folder a plugin gave one conversation of a local agent, which
// its harness starts that conversation's session in instead of the agent's
// workspace. Paths only mean something on this device, so each is kept here,
// never on the relay. A folder is set once: harnesses find a session's
// history by the folder it ran in, so moving it would lose the conversation.
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

/** A conversation as harnesses key their sessions: a channel, or one of its
 * threads. */
export const conversationKey = (channelId: string, root?: string) =>
  root ? `${channelId}/${root}` : channelId;

const storageKey = (scope: string, agent: AgentKey, conversation: string) =>
  `buzz.agents.conversation-folder.v1:${JSON.stringify([scope, agent, conversation])}`;

/** The folder the conversation was given, as it was resolved then; it may no
 * longer exist. */
export function conversationFolder(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
): string | undefined {
  return store.get(storageKey(scope, agent, conversation)) ?? undefined;
}

/** Every folder the agent's conversations were given, by conversation. */
export function agentFolders(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
): Map<string, string> {
  const prefix = storageKey(scope, agent, "").slice(0, -2);
  const folders = new Map<string, string>();
  for (const key of store.keys()) {
    if (!key.startsWith(prefix)) continue;
    const [, , conversation] = JSON.parse(
      key.slice(key.indexOf(":") + 1),
    ) as string[];
    const folder = store.get(key);
    if (conversation && folder) folders.set(conversation, folder);
  }
  return folders;
}

/** Gives the conversation `folder`, an existing directory's resolved path.
 * Giving it the folder it has again is a no-op; any other folder rejects. */
export async function assignConversationFolder(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
  folder: string,
): Promise<string> {
  const kept = await store.add(storageKey(scope, agent, conversation), folder);
  if (kept !== folder)
    throw new Error(`This conversation already works in ${kept}`);
  return kept;
}

/** `folder`, checked to still be a directory without creating it, for a turn
 * to start in. A removed one rejects naming it: the turn never falls back to
 * the agent's workspace. */
export async function existingFolder(
  resolve:
    | ((path: string, options: { create: false }) => Promise<string>)
    | undefined,
  folder: string,
): Promise<string> {
  if (!resolve)
    throw new Error(
      "Conversation folders are available only in the desktop app",
    );
  try {
    return await resolve(folder, { create: false });
  } catch (error) {
    // Other failures, such as too many file operations at once, are passing.
    if (!/Could not find|is not a directory/.test(String(error))) throw error;
    throw new Error(
      `This conversation's folder ${folder} no longer exists. Restore it, or continue in another conversation.`,
    );
  }
}
