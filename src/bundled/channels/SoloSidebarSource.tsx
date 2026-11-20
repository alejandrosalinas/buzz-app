import { useContext } from "react";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import {
  MessagesSidebarEnvironment,
  type MessagesSidebarState,
} from "./sidebar-environment";
import type { SidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import { SoloInventory } from "./SoloInventory";
import { SoloRegions } from "./SoloRegions";

function SoloSidebarContents(props: MessagesSidebarState) {
  const { regions } = useSoloNavigation(props.session);
  if (!regions.length) return null;
  if (!props.workspaceComposition.sections.size)
    return (
      <SoloRegions
        session={props.session}
        scope={props.scope}
        navigator={props.navigator}
        target={props.target}
        sidebar={props.sidebar}
        pendingClick={props.workspaceComposition.pendingChatClick}
      />
    );
  return (
    <SoloInventory
      session={props.session}
      scope={props.scope}
      navigator={props.navigator}
      target={props.target}
      chatIcons={props.chatIcons}
      chatMenus={props.chatMenus}
      sidebarRows={props.sidebarRows}
      workspaceComposition={props.workspaceComposition}
      renderContents={(_ordinary, _header, pendingClick, composeOrdinary) => (
        <SoloRegions
          session={props.session}
          scope={props.scope}
          navigator={props.navigator}
          target={props.target}
          sidebar={props.sidebar}
          composeOrdinary={composeOrdinary}
          pendingClick={pendingClick}
        />
      )}
    />
  );
}
export const soloSidebarSource: SidebarSectionSource = {
  version: 2,
  id: "solo",
  context: "buzz.channels/messages",
  scope: "solo",
  component: function SoloSidebarSource({ render }) {
    const environment = useContext(MessagesSidebarEnvironment);
    if (!environment)
      throw new Error("Solo navigation requires its Messages context");
    return render([
      {
        id: "solo-regions",
        defaultPosition: 0,
        element: <SoloSidebarContents {...environment} />,
      },
    ]);
  },
};
