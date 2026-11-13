// The standing instructions a plugin gave one agent in one conversation,
// which each of that agent's turns there shows. They are kept on this device
// for now, keyed as harnesses key the conversation's session.
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";
import type { TurnInstructions } from "./service";

const PREFIX = "buzz.agents.conversation-instructions.v1:";
const storageKey = (scope: string, agent: AgentKey, conversation: string) =>
  `${PREFIX}${JSON.stringify([scope, agent, conversation])}`;

/** The conversation's instructions and the plugin that gave them. Empty text
 * means they were cleared, so a turn says none apply now; undefined means it
 * never had any. */
export function conversationInstructions(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
): TurnInstructions | undefined {
  const saved = store.get(storageKey(scope, agent, conversation));
  if (!saved) return undefined;
  try {
    const { plugin, text } = JSON.parse(saved) as Partial<TurnInstructions>;
    if (typeof plugin === "string" && typeof text === "string")
      return { plugin, text };
  } catch {
    // Unreadable, as if it had none.
  }
  return undefined;
}

/** Replaces the conversation's instructions with `text`, which `plugin`
 * gave; empty text clears them. Clearing a conversation that never had any
 * keeps nothing, so its turns say nothing of them. */
export async function setConversationInstructions(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
  plugin: string,
  text: string,
) {
  if (
    !text &&
    !conversationInstructions(store, scope, agent, conversation)?.text
  )
    return;
  await store.set(
    storageKey(scope, agent, conversation),
    JSON.stringify({ plugin, text }),
  );
}

/** Drops every conversation's instructions for the agent, in every scope.
 * A failure only warns: it must not stop the agent's removal. */
export async function forgetConversationInstructions(
  store: AgentStore,
  agent: AgentKey,
) {
  const keys = store.keys().filter((key) => {
    if (!key.startsWith(PREFIX)) return false;
    try {
      return (JSON.parse(key.slice(PREFIX.length)) as string[])[1] === agent;
    } catch {
      return false;
    }
  });
  await Promise.all(keys.map((key) => store.set(key, null))).catch((error) =>
    console.warn("Conversation instructions were not removed", error),
  );
}
