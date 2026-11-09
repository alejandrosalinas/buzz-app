// What one agent session gets of the Buzz tools, whatever harness runs it:
// the tools to list, each loaded up front or on search, a note for the end of
// each turn, and the handler for every call. The attention tools are among
// them, and so are any tools plugins add. A harness passes all of this on
// without knowing what is in it.
import {
  ATTENTION_NONE,
  ATTENTION_OFF,
  ATTENTION_REVIEW,
} from "../features/agent-harness/attention-prompt";
import {
  ATTENTION_TOOLS,
  callAttentionTool,
  isAttentionTool,
} from "./attention";
import type { BuzzClient, Context } from "./client";
import { callOwnerTool, isOwnerTool, OWNER_TOOLS } from "./owner";
import { callPluginTool, isPluginTool, PLUGIN_TOOLS } from "./plugins";
import { callSettingsTool, isSettingsTool, SETTINGS_TOOLS } from "./settings";
import {
  callSoloWorkerTool,
  isSoloWorkerTool,
  SOLO_WORKER_TOOLS,
} from "./solo-worker";
import {
  callTool,
  captureToolBody,
  type Reply,
  TOOLS,
  type Tool,
} from "./tools";

/** A tool a plugin adds to every agent session in the app, listed after
 * the Buzz tools under the same server and loaded on search. Its name should
 * start with its plugin's, as `notes_get` does; no two tools share one. */
export type AddedTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Runs it as the agent working in `context`. A throw is a tool error for
   * the agent to correct. */
  call(
    client: BuzzClient,
    context: Context,
    args: Record<string, unknown>,
  ): Promise<Reply>;
}>;
type Listed = Pick<AddedTool, "name" | "description" | "inputSchema">;

export {
  isFinalMessage,
  isMessageTool,
  MESSAGE_TOOLS,
} from "./message-tools";

export type BuzzSession = Readonly<{ tools: readonly Tool[] }>;

/** What every session of an agent in the app gets. It never changes with
 * the owner's attention setting, so a session (and its cached prompt prefix)
 * never needs replacing when attention is turned on or off: the attention
 * tools refuse calls while it is off, and `turnNote` says which it is. */
export const BUZZ_SESSION: BuzzSession = Object.freeze({
  tools: [
    ...TOOLS,
    ...ATTENTION_TOOLS,
    ...SOLO_WORKER_TOOLS,
    ...PLUGIN_TOOLS,
    ...SETTINGS_TOOLS,
  ],
});

const listed = ({ name, description, inputSchema }: AddedTool): Listed => ({
  name,
  description,
  inputSchema,
});

/** A tool as a session lists it. `search` means a harness that can load
 * tools on demand lists it by name only, and the model loads it when it
 * needs it; `always` means it is listed in full up front. Only the Buzz tools
 * choose: those plugins add always load on search, so installing plugins
 * never grows what every turn carries. */
export type SessionTool = Listed & Readonly<{ load: "always" | "search" }>;

/** The tools a session lists: the Buzz tools, then those plugins add. The
 * owner tools only with `owner`: a client with `ownerAccess`. */
export const sessionTools = (
  added: readonly AddedTool[] = [],
  owner = false,
): readonly SessionTool[] => [
  ...TOOLS.map((tool) => ({ ...tool, load: "always" as const })),
  ...ATTENTION_TOOLS.map((tool) => ({ ...tool, load: "search" as const })),
  ...SOLO_WORKER_TOOLS.map((tool) => ({ ...tool, load: "search" as const })),
  ...PLUGIN_TOOLS.map((tool) => ({ ...tool, load: "search" as const })),
  ...SETTINGS_TOOLS.map((tool) => ({ ...tool, load: "search" as const })),
  ...(owner
    ? OWNER_TOOLS.map((tool) => ({ ...tool, load: "search" as const }))
    : []),
  ...added.map((tool) => ({ ...listed(tool), load: "search" as const })),
];

/** What the server (Claude) or namespace (Codex) with the tools says up
 * front, so the model knows what it can search for. */
export function sessionHint(added: readonly AddedTool[] = [], owner = false) {
  const plugins = added.length
    ? ` and tools plugins add (${added.map((tool) => tool.name).join(", ")})`
    : "";
  const owned = owner
    ? ", your owner's channels, members, messages and canvases read with their access (owner_channel_list, owner_read)"
    : "";
  return `Read and act in Buzz as this agent. Search for the rest when you need them: your attention (Interests, event watches and timers; interest_set and watch_add say how they work), Nexus workers an owner lets you run (solo_worker_connections), this device's plugins (plugin_list; install, update, enable and remove are requests your owner confirms)${owned}${plugins}.`;
}

/** Changes when the added tools change, so a session that keeps the list it
 * started with can be replaced; empty while plugins add none. A short hash,
 * since Codex saves it with each binding. Sorted by name, so the order
 * plugins start in does not change it. */
export function addedKey(added: readonly AddedTool[]) {
  if (!added.length) return "";
  const text = JSON.stringify(
    added.map(listed).sort((a, b) => (a.name < b.name ? -1 : 1)),
  );
  // FNV-1a.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** Text for the end of a turn's prompt, as the agent's attention is now.
 * An agent with no Interests has nothing to review, so it need not load the
 * attention tools to find that out. */
export function turnNote(client?: Pick<BuzzClient, "attention">) {
  const attention = client?.attention;
  if (!attention) return undefined;
  if (!attention.enabled()) return ATTENTION_OFF;
  return attention.interests().length ? ATTENTION_REVIEW : ATTENTION_NONE;
}

/** Answers one tool call. Throws when the tool cannot run now; the message
 * is for the agent. Without a client, no tool can be called yet. `added`
 * are the tools plugins add now. */
export async function callSessionTool(
  client: BuzzClient | undefined,
  context: Context,
  name: string,
  args: Record<string, unknown>,
  added: readonly AddedTool[] = [],
): Promise<Reply> {
  if (!client) throw new Error("Buzz is not ready yet. Try again.");
  // Hold the reviewed destination and arguments while the checker waits.
  if (client.protect) {
    context = structuredClone(context);
    args = structuredClone(args);
  }
  const session = JSON.stringify(context);
  // A natively gated call was reviewed with these exact arguments; it is
  // reviewed again only when a captured file changes what it sends.
  const reviewed = client.nativeToolGate && JSON.stringify(args);
  // Plugin tools own their argument semantics, even when shadowing a builtin.
  if (client.protect && !added.some((tool) => tool.name === name))
    await captureToolBody(client, name, args).catch((error) =>
      checkedToolError(client, session, error),
    );
  if (JSON.stringify(args) !== reviewed)
    await client.protect?.({
      kind: "tool",
      session,
      content: { title: name, arguments: args },
      ...(typeof args.command === "string" ? { command: args.command } : {}),
    });
  let reply: Reply;
  let held: (() => void) | undefined;
  try {
    if (isOwnerTool(name) && !added.some((tool) => tool.name === name))
      ({ text: reply, held } = await callOwnerTool(client, name, args));
    else reply = await dispatchSessionTool(client, context, name, args, added);
  } catch (error) {
    return checkedToolError(client, session, error);
  }
  await client.protect?.({ kind: "tool-result", session, content: reply });
  // An owner read is released only while the binding it was read with holds.
  held?.();
  return reply;
}

/** File capture and dispatch errors cross the same tool-result boundary. */
async function checkedToolError(
  client: BuzzClient,
  session: string,
  error: unknown,
): Promise<never> {
  await client.protect?.({
    kind: "tool-result",
    session,
    content: { error: error instanceof Error ? error.message : String(error) },
  });
  throw error;
}
async function dispatchSessionTool(
  client: BuzzClient,
  context: Context,
  name: string,
  args: Record<string, unknown>,
  added: readonly AddedTool[],
): Promise<Reply> {
  const tool = added.find((tool) => tool.name === name);
  if (tool) {
    // A plugin's tool doesn't get the agent's device settings or owner access.
    const { settings: _, ownerAccess: __, ...plugin } = client;
    return tool.call(plugin, context, args);
  }
  if (isSoloWorkerTool(name)) return callSoloWorkerTool(client, name, args);
  if (isPluginTool(name)) return callPluginTool(client, context, name, args);
  if (isSettingsTool(name)) return callSettingsTool(client, name, args);
  if (!isAttentionTool(name)) return callTool(client, context, name, args);
  const { attention } = client;
  if (!attention) throw new Error(`No tool ${name}`);
  // The owner can turn attention off while the session runs.
  if (!attention.enabled())
    throw new Error(
      `Attention is off for you on this device, so these tools do nothing now.\n(classifier: ${attention.classifier()})`,
    );
  return callAttentionTool(attention, name, args);
}
