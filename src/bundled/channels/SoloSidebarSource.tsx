import { useContext } from "react";
import {
  MessagesSidebarEnvironment,
  type MessagesSidebarState,
} from "./sidebar-environment";
import type { SidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import { SoloInventory } from "./SoloInventory";
import { SoloRegions } from "./SoloRegions";

function SoloSidebarContents(props: MessagesSidebarState) {
  return (
    <SoloInventory
      session={props.session}
      scope={props.scope}
      navigator={props.navigator}
      target={props.target}
      chatIcons={props.chatIcons}
      chatMenus={props.chatMenus}
      sidebarRows={props.sidebarRows}
      renderContents={(ordinary, header, pendingClick, composeOrdinary) => (
        <SoloRegions
          session={props.session}
          scope={props.scope}
          navigator={props.navigator}
          target={props.target}
          sidebar={props.sidebar}
          ordinary={ordinary}
          composeOrdinary={composeOrdinary}
          pendingClick={pendingClick}
          groupDisclosure={
            props.filter === "all"
              ? {
                  sectionKey: "scope:solo",
                  title: props.soloTitle,
                  open: !props.sidebar.collapsed.includes("scope:solo"),
                  onToggle: (open) => props.sidebar.toggle("scope:solo", open),
                }
              : undefined
          }
          hidePrimaryHeading={props.filter === "solo"}
          fallback={
            <>
              {header}
              {ordinary}
            </>
          }
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
        id: "solo",
        defaultPosition: 0,
        element: <SoloSidebarContents {...environment} />,
      },
    ]);
  },
};
