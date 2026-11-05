// The plugin tools: an agent in the app reads this device's plugins, and
// asks the person using Buzz to install, update, enable or remove one. Only
// the desktop app has plugins to manage; elsewhere the tools refuse.
import type { PluginRequestAction } from "../plugins/requests";
import type { BuzzClient, Context } from "./client";
import type { Tool } from "./tools";

const str = { type: "string" } as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});
const repository = {
  ...str,
  description: "HTTPS or SSH Git URL, or GitHub owner/repo.",
};
const reference = {
  ...str,
  description: "Branch, tag or commit; default: the repository's default.",
};

const ACTIONS: readonly PluginRequestAction[] = [
  "install",
  "update",
  "enable",
  "remove",
];

export const PLUGIN_TOOLS: readonly Tool[] = [
  tool(
    "plugin_list",
    "List this device's plugins: enabled, bundled, revision and source.",
    {},
  ),
  tool(
    "plugin_discover",
    "List the built plugins in a Git repository that plugin_request can install.",
    { repository, reference },
    ["repository"],
  ),
  tool(
    "plugin_disable",
    "Disable an installed plugin now. plugin_request with action enable turns it back on.",
    { id: str },
    ["id"],
  ),
  tool(
    "plugin_request",
    "Ask your owner to install, update, enable or remove a plugin. This posts a card with Review and Decline in this conversation, and nothing changes until they confirm it there (or in Settings → Manage plugins). install takes repository, and path when plugin_discover finds several; the others take id. update reads the plugin's recorded repository at reference.",
    {
      action: { type: "string", enum: ACTIONS },
      id: {
        ...str,
        description: "Plugin id; checked against what install finds.",
      },
      repository,
      reference,
      path: str,
      commit: {
        ...str,
        description: "Refuse unless reference is at this commit.",
      },
      reason: {
        ...str,
        description: "Why, shown to your owner; at most 500 characters.",
      },
    },
    ["action", "reason"],
  ),
  tool(
    "plugin_request_status",
    "Read whether your owner approved or declined a plugin request. expired: the app restarted; ask again if it is still needed.",
    { requestId: str },
    ["requestId"],
  ),
];

const NAMES = new Set(PLUGIN_TOOLS.map((tool) => tool.name));
export const isPluginTool = (name: string) => NAMES.has(name);

/** Posts the request into the conversation the agent is working in, as
 * `send` would: its thread when it has one. Without a channel there is
 * nowhere to post, and the owner finds the request in Settings. */
async function announce(
  client: BuzzClient,
  { channel, root }: Context,
  requestId: string,
  content: string,
) {
  if (!channel) return;
  await client.publish({
    kind: 9,
    content,
    tags: [
      ["h", channel],
      ...(root ? [["e", root, "", "reply"]] : []),
      ["plugin-request", requestId],
    ],
  });
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export async function callPluginTool(
  client: BuzzClient,
  context: Context,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { plugins } = client;
  if (!plugins)
    throw new Error("Plugin management is unavailable on this host");
  switch (name) {
    case "plugin_list":
      return JSON.stringify(await plugins.list());
    case "plugin_discover": {
      const repository = text(args.repository);
      if (!repository) throw new Error("repository is required");
      return JSON.stringify(
        await plugins.discover(repository, text(args.reference)),
      );
    }
    case "plugin_disable": {
      const id = text(args.id);
      if (!id) throw new Error("id is required");
      return JSON.stringify(await plugins.disable(id));
    }
    case "plugin_request": {
      const action = ACTIONS.find((item) => item === args.action);
      if (!action)
        throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
      const reason = typeof args.reason === "string" ? args.reason : "";
      const { requestId, applied, pluginName } = await plugins.request({
        action,
        id: text(args.id),
        repository: text(args.repository),
        reference: text(args.reference),
        path: text(args.path),
        commit: text(args.commit),
        reason,
      });
      // The request is queued whether or not this lands; the card is how the
      // owner finds it without opening Settings.
      const posted = await announce(
        client,
        context,
        requestId,
        `Requested: ${action} ${pluginName} — ${reason.trim()}`,
      ).then(
        () => ({}),
        (error: unknown) => ({
          notice: `The request is waiting, but posting it here failed: ${error instanceof Error ? error.message : String(error)}. Tell your owner.`,
        }),
      );
      return JSON.stringify({ requestId, applied, ...posted });
    }
    case "plugin_request_status": {
      const requestId = text(args.requestId);
      if (!requestId) throw new Error("requestId is required");
      return JSON.stringify(plugins.status(requestId));
    }
  }
  throw new Error(`No tool ${name}`);
}
