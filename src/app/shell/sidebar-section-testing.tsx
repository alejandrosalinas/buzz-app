/** Real bundled registrations for standalone fixtures without the app runtime. */
import { Context } from "@deepseek-ai/cordis";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
} from "react";
import { bundledOwner } from "../../plugins/provenance";
import { SidebarSectionsService } from "../../features/channel-navigation/sidebar-sections-service";
import { teamSidebarSource } from "../../bundled/channels/TeamSidebarSource";
import { soloSidebarSource } from "../../bundled/channels/SoloSidebarSource";
import { MessagesSidebar } from "../../bundled/channels/MessagesSidebar";
import { useRelayConnection } from "../../features/relay/react";
import type { SidebarContextProps } from "../../features/sidebar/contracts";
import { PrimarySidebar as Shell } from "./PrimarySidebar";

type Props = Omit<
  ComponentProps<typeof MessagesSidebar>,
  "Frame" | "renderSections"
>;
const FixtureProps = createContext<Props | undefined>(undefined);
function FixtureMessages(props: SidebarContextProps) {
  const fixture = useContext(FixtureProps);
  if (!fixture) throw new Error("Messages fixture requires its provider");
  return (
    <MessagesSidebar {...fixture} {...props}>
      {props.children}
    </MessagesSidebar>
  );
}

export function PrimarySidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const [registry] = useState(() => {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const registry = new SidebarSectionsService(root);
    const owner = root.extend({
      pluginOwner: bundledOwner({ id: "buzz.channels", revision: "bundled" }),
    });
    owner.sidebarSections?.registerSource?.(soloSidebarSource);
    owner.sidebarSections?.registerSource?.(teamSidebarSource);
    owner.sidebarSections?.registerContext?.({
      id: "messages",
      matches: () => true,
      component: FixtureMessages,
    });
    return registry;
  });
  const sections = {
    ...registry,
    version: 1 as const,
    register: () => {},
    snapshot: registry.snapshot,
    subscribe: registry.subscribe,
    ...props.sidebarSections,
    sourceSnapshot:
      props.sidebarSections?.sourceSnapshot ?? registry.sourceSnapshot,
    sourceSubscribe:
      props.sidebarSections?.sourceSubscribe ?? registry.sourceSubscribe,
  };
  return (
    <FixtureProps value={{ ...props, sidebarSections: sections }}>
      <Shell
        registry={sections}
        target={props.target}
        scope={connection.scope ?? "disconnected"}
        creationAction={props.creationAction}
      >
        {props.children}
      </Shell>
    </FixtureProps>
  );
}
