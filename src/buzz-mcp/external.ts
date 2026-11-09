import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import type { AddedTool } from "./session-tools";
import {
  type ExternalScope,
  fullAgentAccess,
} from "../features/agents/external-connection";

const required = { "buzz/requiredScopes": ["agent"] };
const instructions =
  "Act as the agent selected by the owner in Buzz, with all of its Buzz tools. There is no current conversation: supply explicit channel or message IDs. Keys stay in Buzz. Use saved approval to restore a closed connection. Revoked or expired approval needs owner consent. Never repeat a post after a lost response. Read its destination first.";

/** An approved external app acts as the selected agent: it lists and calls
 * the tools that agent's sessions get, plugins' included, through the same
 * dispatcher, without an implicit conversation. Only full-agent approval
 * calls them; an older, narrower approval must be approved again. */
export async function respondExternal(
  client: BuzzClient,
  input: unknown,
  connected: () => void,
  scopes: readonly ExternalScope[],
  added: () => readonly AddedTool[],
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected one JSON-RPC message.");
  const {
    id,
    method,
    params = {},
  } = input as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (id === undefined || id === null) return undefined;
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("params must be an object.");
  const error = (message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message },
  });
  const granted = fullAgentAccess(scopes) ? ["agent"] : [];
  if (method === "initialize") {
    if (params.protocolVersion !== "2025-06-18")
      return error("Use MCP 2025-06-18.");
    connected();
  }
  if (method === "tools/list") {
    if (params.cursor !== undefined)
      return error("Tool cursors are not supported.");
    const list = await respond(client, {}, input, added(), {
      tool: ({ load: _, ...tool }) => ({ ...tool, _meta: required }),
    });
    return {
      ...list,
      result: {
        ...(list as { result: object }).result,
        _meta: {
          "buzz/grantedScopes": granted,
          "buzz/supportedScopes": ["agent"],
        },
      },
    };
  }
  if (method === "tools/call" && !granted.length)
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "Full agent access is required. Request authorization, then call this tool again.",
          },
        ],
        _meta: {
          "buzz/error": {
            code: "authorization_required",
            required_scopes: ["agent"],
          },
        },
      },
    };
  return respond(client, {}, input, added(), { instructions });
}
