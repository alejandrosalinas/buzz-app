import type { PluginModule } from "../plugins/api";
import { PluginRequestCard } from "./PluginRequestCard";

export const inject = [
  "conversation",
  "relay",
  "pluginManagement",
  "pluginReviewHold",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const plugins = ctx.pluginManagement.manager();
  const authorizeGit = async (repository: string) => {
    const connection = ctx.relay.snapshot();
    return connection.status === "ready"
      ? ((await connection.session.authorizeGit?.(repository)) ?? null)
      : null;
  };
  ctx.conversation.registerMessage({
    id: "plugin-request",
    title: "Plugin request",
    matches: (message) => !!message.pluginRequest,
    component: ({ message }) => (
      <PluginRequestCard
        message={message}
        plugins={plugins}
        authorizeGit={authorizeGit}
        holdReview={() => ctx.pluginReviewHold.hold()}
      />
    ),
  });
};
