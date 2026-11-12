import type { ReactNode } from "react";
import type { PluginModule } from "../../plugins/api";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { useSavedAgentState } from "../../features/solo/default-agent";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { BestieChooser } from "./BestieChooser";
import { PinnedBestie } from "./PinnedBestie";
import { bestieRoute, bestieDetailRoute } from "./routes";
import { onBestieMade } from "../agents/BestieChoice";
import { bestieTab, formerBestieTab } from "./BestieTab";
import {
  readFormerHosted,
  rememberNewBestie,
  stopFormerCheckIns,
} from "./former";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "agents",
  "conversation",
  "panels",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.agents.registerTab(bestieTab(ctx.relay, ctx.agents));
  ctx.agents.registerTab(formerBestieTab(ctx.relay, ctx.agents));
  // Whoever is Bestie, on any device, only it checks in.
  ctx.effect(() => stopFormerCheckIns(ctx.relay, ctx.agents));
  // A hosted former Bestie's memory is on its provider, read here for its tab.
  ctx.effect(() => readFormerHosted(ctx.relay, ctx.agents));
  // A Bestie made on this device starts out remembering its owner. One made
  // elsewhere keeps what it has, so memory turned off stays off.
  ctx.effect(() =>
    onBestieMade((pubkey) => {
      rememberNewBestie(ctx.relay, ctx.agents, pubkey).catch((error) =>
        console.warn("Bestie's memory wasn't turned on", error),
      );
    }),
  );
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: (params) =>
        !!(bestieRoute(params) || bestieDetailRoute(params)),
    },
    component: ({ navigation: pageNavigation }) => (
      <BestieDestination
        relay={ctx.relay}
        navigation={ctx.navigation}
        extensions={ctx.conversation}
        host={ctx}
        agents={ctx.agents}
        pageNavigation={pageNavigation}
      />
    ),
  });
};

function BestieStatus({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Bestie"
                icon={<BestieIcon size="1rem" />}
              />
            }
          />
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
            <div className="w-full max-w-md">{children}</div>
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}

function BestieDestination({
  relay,
  ...props
}: {
  relay: RelayData;
  navigation: Navigation;
  extensions: ConversationExtensions;
  host: ConversationHostServices;
  agents: Agents;
  pageNavigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const saved = useSavedAgentState(connection.session, connection.scope ?? "");
  const established =
    connection.status === "ready" &&
    !!connection.viewer &&
    !!connection.scope?.endsWith(`:${connection.viewer}`);
  if (!established && !saved.agent)
    return (
      <BestieStatus>
        <EmptyState
          icon={<BestieIcon />}
          title={
            connection.status === "connecting"
              ? "Connecting…"
              : connection.status === "error"
                ? "This community is unavailable"
                : "No community selected"
          }
          description={
            connection.status === "connecting"
              ? "Your Bestie opens once this community is connected."
              : (connection.error ??
                "Choose a community to continue with your Bestie.")
          }
          action={
            connection.status === "error" ? (
              <Button onClick={relay.tryAgain}>Retry connection</Button>
            ) : undefined
          }
        />
      </BestieStatus>
    );
  if (!saved.read || saved.error)
    return (
      <BestieStatus>
        <EmptyState
          icon={<BestieIcon />}
          title={
            saved.error ? "Your Bestie is unavailable" : "Loading your Bestie…"
          }
          description={
            saved.error ? (
              <span role="alert">{saved.error}</span>
            ) : (
              <span role="status">Reading your saved choice.</span>
            )
          }
          action={
            saved.error ? (
              <Button onClick={saved.retry}>Try again</Button>
            ) : undefined
          }
        />
      </BestieStatus>
    );
  return saved.agent ? (
    <PinnedBestie
      relay={relay}
      host={props.host}
      extensions={props.extensions}
      navigator={props.navigation}
      agents={props.agents}
      navigation={props.pageNavigation}
    />
  ) : (
    <BestieStatus>
      <BestieChooser
        key={connection.scope}
        session={connection.session}
        scope={connection.scope ?? ""}
        community={connection.origin}
        agents={props.agents}
      />
    </BestieStatus>
  );
}
