import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import { createContext, useContext, type ReactNode } from "react";
import type {
  SidebarComponentSection,
  SidebarSectionSource,
} from "../../features/channel-navigation/sidebar-section-components";

/** The shell-mounted inventory remains the one owner of preferences and actions. */
export const TeamSidebarSections = createContext<
  readonly SidebarComponentSection[]
>([]);

/** Construct each section's rows below its own error boundary. */
export function TeamSidebarSection({ render }: { render(): ReactNode }) {
  return render();
}

export const teamSidebarSource: SidebarSectionSource = {
  version: 2,
  id: "team",
  context: "buzz.channels/messages",
  scope: "team",
  component: function TeamSidebarSource({ render }) {
    return render(useContext(TeamSidebarSections));
  },
};

/** Keep the bundled source's identity out of the shell's restoration policy. */
export function teamSidebarSlotsReady(
  registry: SidebarSections | undefined,
  committed:
    | { keys: readonly string[]; unavailable: readonly string[] }
    | undefined,
  ids: readonly string[],
) {
  const source = registry
    ?.sourceSnapshot?.()
    .find((entry) => entry.component === teamSidebarSource.component);
  return (
    !source ||
    !!committed?.unavailable.includes(source.key) ||
    ids.every((id) => committed?.keys.includes(`${source.pluginId}/${id}`))
  );
}
