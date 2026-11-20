import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  SidebarComponentSection,
  SidebarSectionSource,
} from "../../features/channel-navigation/sidebar-section-components";

type Sections = readonly SidebarComponentSection[];
const noSections: Sections = [];
const TeamSections = createContext({
  snapshot: () => noSections,
  subscribe: (_listener: () => void) => () => {},
});

/** The shell-mounted inventory remains the one owner of preferences and actions.
 * Its sections hold new elements on every render. A changing context value
 * would make React search each memoized sidebar subtree for consumers, so the
 * sections reach their source through a store that keeps its identity. */
export function TeamSidebarSections({
  value,
  children,
}: {
  value: Sections;
  children: ReactNode;
}) {
  const [store] = useState(() => {
    const listeners = new Set<() => void>();
    return {
      sections: value,
      snapshot: () => store.sections,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      notify() {
        for (const listener of listeners) listener();
      },
    };
  });
  // The source renders below this one, so it reads these sections in the same
  // commit as the rows' owners; only a source that skipped it needs the notice.
  store.sections = value;
  useLayoutEffect(() => store.notify());
  return <TeamSections value={store}>{children}</TeamSections>;
}

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
    const store = useContext(TeamSections);
    return render(useSyncExternalStore(store.subscribe, store.snapshot));
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
