// The Buzz tools as an MCP server inside the host process: answers one
// JSON-RPC message at a time, as Claude sends them over its stream-json
// pipe to an in-process (`sdk`) server, or goose over loopback HTTP. Holds no
// state between messages.
import type { BuzzClient, Context } from "./client";
import {
  type AddedTool,
  callSessionTool,
  type SessionTool,
  sessionTools,
} from "./session-tools";
import { isSettingsTool } from "./settings";
import type { Reply } from "./tools";

type Message = Readonly<{
  id?: string | number | null;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}>;

/** How a harness has the server list its tools. By default each is listed
 * without its `load`, and the server says nothing up front. */
export type Listing = Readonly<{
  instructions?: string;
  tool?: (tool: SessionTool) => object;
}>;

/** Answers `input`, listing the session's Buzz tools and the `added` ones
 * plugins add. Without a client, tools are listed but cannot be called. */
export async function respond(
  client: BuzzClient | undefined,
  context: Context,
  input: unknown,
  added: readonly AddedTool[] = [],
  listing: Listing = {},
) {
  const { id, method, params = {} } = (input ?? {}) as Message;
  // A notification needs no answer, but the pipe expects one.
  if (id === undefined || id === null)
    return { jsonrpc: "2.0", id: 0, result: {} };
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz", version: "1" },
        ...(listing.instructions === undefined
          ? {}
          : { instructions: listing.instructions }),
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({
        // A connection keeps its client, so its list stays the same. One
        // whose client can't change settings, such as a plugin's, lacks them.
        tools: sessionTools(added)
          .filter(
            ({ name }) => !client || client.settings || !isSettingsTool(name),
          )
          .map(listing.tool ?? (({ load: _, ...tool }) => tool)),
      });
    case "tools/call":
      try {
        const name = String(params.name);
        const args = params.arguments === undefined ? {} : params.arguments;
        // Anything but an object would reach a tool as no arguments, and act
        // on its defaults, such as the current channel.
        if (typeof args !== "object" || args === null || Array.isArray(args))
          throw new Error("arguments must be an object.");
        const reply = await callSessionTool(
          client,
          context,
          name,
          args as Record<string, unknown>,
          added,
        );
        return result({ content: content(reply) });
      } catch (error) {
        return result({
          content: [{ type: "text", text: errorText(error) }],
          isError: true,
        });
      }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `No method ${String(method)}` },
      };
  }
}

/** A tool's answer as MCP content. */
export const content = (reply: Reply) =>
  typeof reply === "string"
    ? [{ type: "text" as const, text: reply }]
    : [
        { type: "image" as const, data: reply.data, mimeType: reply.type },
        ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
      ];

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
