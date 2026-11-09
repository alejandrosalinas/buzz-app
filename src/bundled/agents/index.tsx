import type { PluginModule } from "../../plugins/api";
import { registerAttention } from "../../features/agents/attention-command";
import { registerDiscovery } from "../../features/agents/attention-discovery";
import { registerDecideTool } from "../../features/decisions/agent-tool";
import { AgentsPage } from "./AgentsPage";
import { AgentCardAttachment, isAgentCard } from "./AgentCardAttachment";
import {
  AgentCardLink,
  agentCardLinkId,
  createAgentCardReads,
} from "./AgentCardLink";
import { availableAgentProviderRoute } from "./routes";
import { developerMode } from "../../features/developer/mode";
import { withImportScenario } from "../../features/developer/agent-import-scenario";
import { isTauri } from "@tauri-apps/api/core";
import type {} from "../../features/agents/external-connection";
import { ExternalConnectionSettings } from "./ExternalConnectionSettings";
import { externalMcpEnabled } from "../../features/agents/external-connection";
import { forgetMemoryListingsOnSelection } from "../../features/agents/memory";
import inlineStyles from "../../shared/InlineReference.module.css";

export const inject = [
  "pages",
  "agents",
  "relay",
  "navigation",
  "communityReader",
  "host",
  "conversation",
  "decisions",
  "settingsCards",
  "externalApps",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerAttention(ctx);
  registerDiscovery(ctx.agents);
  registerDecideTool(ctx.agents, ctx.decisions);
  ctx.effect(() => forgetMemoryListingsOnSelection(ctx.communityReader));
  const { relay, navigation: navigator } = ctx;
  const agents = developerMode ? withImportScenario(ctx.agents) : ctx.agents;
  if (isTauri()) {
    const connection = ctx.externalApps;
    ctx.effect(() =>
      connection.bind({
        connect: ctx.agents.connectExternal.bind(ctx.agents),
        pairing: (operation, request) => {
          if (!ctx.host.externalMcpPairing)
            throw new Error("Saved approval is unavailable");
          return ctx.host.externalMcpPairing(operation, request);
        },
        deny: (request) => {
          if (!ctx.host.denyMcpAuthorization)
            throw new Error("External authorization is unavailable");
          return ctx.host.denyMcpAuthorization(request);
        },
      }),
    );
    ctx.settingsCards.register({
      id: "external-apps",
      title: "External apps",
      visibility: {
        snapshot: () =>
          externalMcpEnabled(ctx.communityReader.snapshot().selected),
        subscribe: (listener) => ctx.communityReader.subscribe(listener),
        ensure: () => () => {},
      },
      component: () => <ExternalConnectionSettings connection={connection} />,
    });
  }
  ctx.conversation.registerAttachment({
    id: "agent-card",
    title: "Agent card",
    matches: isAgentCard,
    component: (props) => (
      <AgentCardAttachment
        {...props}
        agents={agents}
        relay={relay}
        navigator={navigator}
      />
    ),
  });
  const cardReads = createAgentCardReads();
  ctx.conversation.registerLink({
    id: "agent-card",
    title: "Agent card links",
    matches: (url) => agentCardLinkId(url) !== null,
    className: inlineStyles.link,
    component: ({ url }) => <AgentCardLink url={url} reads={cardReads} />,
  });
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        linkRenderers={ctx.conversation.links}
        agents={agents}
        relay={relay}
        communities={ctx.communityReader}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
