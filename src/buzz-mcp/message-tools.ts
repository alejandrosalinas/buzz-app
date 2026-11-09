// The message tools by name alone, without the tool set, so a transcript in
// the renderer can recognize them without importing every tool.

/** The Buzz tools that post a message, and so take `final`. Each harness
 * strips its own prefix from a tool's name before asking. */
export const MESSAGE_TOOLS = ["send", "reply_in_subthread"] as const;
export const isMessageTool = (name: unknown) =>
  (MESSAGE_TOOLS as readonly unknown[]).includes(name);
/** Whether a call posts a message marked final, which can end the turn. */
export const isFinalMessage = (name: unknown, args: unknown) =>
  isMessageTool(name) && (args as { final?: unknown } | null)?.final === true;
