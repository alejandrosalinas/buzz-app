import { createContext, type ReactNode, type RefObject } from "react";
import type { useSidebarView } from "./useSidebarView";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RelaySession } from "../../features/relay/session";
import type { SidebarRows } from "../../features/channel-navigation/sidebar-rows-service";

/** The existing navigation environment, shared without another data owner. */
export type WorkspaceSidebarComposition = Readonly<{
  sections: ReadonlySet<string>;
  pendingChatClick: RefObject<ReturnType<typeof setTimeout> | undefined>;
  collapsed: readonly string[];
  toggle(section: string, open: boolean): void;
  registerFrame(section: string): () => void;
  newAction(
    workspace: string,
    name: string,
    menuAnchor?: RefObject<HTMLButtonElement | null>,
  ): ReactNode;
}>;

export type MessagesSidebarState = Readonly<{
  active(): boolean;
  session: RelaySession;
  scope: string;
  navigator: Navigation;
  target: OpenTarget;
  sidebar: ReturnType<typeof useSidebarView>;
  workspaceComposition: WorkspaceSidebarComposition;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  sidebarRows?: SidebarRows | undefined;
}>;

export const MessagesSidebarEnvironment = createContext<
  MessagesSidebarState | undefined
>(undefined);
