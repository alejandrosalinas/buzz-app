// The Buzz tools as a standalone stdio MCP server, for an agent that runs
// outside Buzz Desktop. Configured as a harness agent is:
//   BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, BUZZ_AUTH_TAG
// plus BUZZ_CHANNEL, the channel tools default to, and BUZZ_MCP_ROOT, the only
// directory `path` and `files` may read (default: the working directory).
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { nodeClient, relayAuthorityLookup } from "./node";
import { content, errorText } from "./rpc";
import { BUZZ_HELP_PROMPT } from "./prompt";
import {
  callSoloWorkerTool,
  isSoloWorkerTool,
  SOLO_WORKER_TOOLS,
} from "./solo-worker";
import { callTool, TOOLS } from "./tools";

const env = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const auth = process.env.BUZZ_AUTH_TAG?.trim();
const channel = process.env.BUZZ_CHANNEL?.trim();
const relay = env("BUZZ_RELAY_URL");
const relayAuthorLookup = relayAuthorityLookup(relay);
const client = nodeClient({
  relay,
  key: env("BUZZ_PRIVATE_KEY"),
  ...(auth ? { auth } : {}),
  root: process.env.BUZZ_MCP_ROOT?.trim() || process.cwd(),
});
const context = channel ? { channel } : {};

serveStdio(() => {
  const server = new McpServer(
    { name: "buzz", version: "1" },
    { capabilities: { tools: {} }, instructions: BUZZ_HELP_PROMPT },
  );
  const tools: readonly (
    | (typeof TOOLS)[number]
    | (typeof SOLO_WORKER_TOOLS)[number]
  )[] = [...TOOLS, ...SOLO_WORKER_TOOLS];
  for (const tool of tools)
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        ...("annotations" in tool ? { annotations: tool.annotations } : {}),
      },
      async (args) => {
        try {
          return {
            content: content(
              await (isSoloWorkerTool(tool.name)
                ? callSoloWorkerTool(
                    {
                      ...client,
                      relayAuthor: await relayAuthorLookup().catch(
                        () => undefined,
                      ),
                    },
                    tool.name,
                    args,
                  )
                : callTool(
                    { ...client, relayAuthorLookup },
                    context,
                    tool.name,
                    args,
                  )),
            ),
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: errorText(error) }],
            isError: true,
          };
        }
      },
    );
  return server;
});
