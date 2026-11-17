import {
  createContext,
  useContext,
  useCallback,
  useState,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { contributionKey } from "../../features/conversation/ContributionBoundary";
import { resolveSidebarContext } from "../../features/sidebar/contracts";
import { SidebarContextFrame } from "../../features/sidebar/SidebarContextFrame";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import {
  SidebarSectionSources,
  SidebarSectionSlotView,
} from "../../features/channel-navigation/SidebarSectionSources";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import type { RegisteredSidebarContext } from "../../features/sidebar/contracts";
import type {
  RegisteredSidebarSectionSource,
  SidebarSectionSource,
} from "../../features/channel-navigation/sidebar-section-components";
import type { PagesReader, RegisteredPage } from "../../features/pages/service";
import type { OpenTarget } from "../../features/navigation/targets";

const emptyContexts: readonly RegisteredSidebarContext[] = [];
const emptySources: readonly RegisteredSidebarSectionSource[] = [];
const noSubscription = () => () => {};
const noContexts = () => emptyContexts;
type PageSidebar = {
  page: RegisteredPage;
  registry: PagesReader;
  children: ReactNode;
  resetIdentity?: unknown;
};
const PageSidebarState = createContext<PageSidebar | undefined>(undefined);

/** The legacy page contract participates as one opaque slot in the same host. */
const pageSource: SidebarSectionSource["component"] = ({ target, render }) => {
  const state = useContext(PageSidebarState);
  const Sidebar = state?.page.sidebar;
  if (!state || !Sidebar) return null;
  return render([
    {
      id: state.page.id,
      defaultPosition: 0,
      element: (
        <OwnedContribution
          entry={state.page}
          registry={state.registry}
          resetIdentity={state.resetIdentity}
          fallback={
            <div className="shell-sidebar-default">
              <SidebarFrame label={`${state.page.title} sidebar`}>
                <SidebarList>
                  <p role="alert">This page’s sidebar is unavailable.</p>
                  {state.children}
                </SidebarList>
              </SidebarFrame>
            </div>
          }
        >
          {() => <Sidebar target={target}>{state.children}</Sidebar>}
        </OwnedContribution>
      ),
    },
  ]);
};

export function PrimarySidebar({
  registry,
  target,
  scope,
  children,
  creationAction,
  replacement,
  pendingReplacement = false,
  owner,
}: {
  registry: SidebarSections;
  owner?: string;
  target: OpenTarget;
  scope: string;
  children: ReactNode;
  creationAction?: ReactNode;
  replacement?: Omit<PageSidebar, "children"> | undefined;
  pendingReplacement?: boolean;
}) {
  const contexts = useSyncExternalStore(
    registry.contextSubscribe ?? noSubscription,
    registry.contextSnapshot ?? noContexts,
  );
  const matched = resolveSidebarContext(contexts, target, owner);
  // AppShell hides navigation on standalone pages while retaining its subtree.
  const [previous, setPrevious] = useState(matched);
  if (matched && matched !== previous) setPrevious(matched);
  const context =
    matched ?? (previous && contexts.includes(previous) ? previous : undefined);
  const page = replacement?.page;
  const adapted = useMemo<RegisteredSidebarSectionSource | undefined>(
    () =>
      page && {
        version: 2,
        id: page.id,
        key: page.key,
        pluginId: page.pluginId,
        revision: page.revision,
        component: pageSource,
        context: page.key,
      },
    [page],
  );
  const sections = useMemo<SidebarSections>(() => {
    let previous: readonly RegisteredSidebarSectionSource[] | undefined;
    let filtered: readonly RegisteredSidebarSectionSource[] = adapted
      ? [adapted]
      : emptySources;
    return {
      ...registry,
      sourceSnapshot: () => {
        if (adapted) return filtered;
        const current = registry.sourceSnapshot?.() ?? emptySources;
        if (current !== previous) {
          previous = current;
          filtered = current.filter(
            (source) => source.context === context?.key,
          );
        }
        return filtered;
      },
    };
  }, [registry, context, adapted]);
  const fallback = (
    <SidebarContextFrame label="Page navigation">
      <SidebarList>{children}</SidebarList>
    </SidebarContextFrame>
  );
  if (replacement && adapted)
    return (
      <PageContext
        key={contributionKey(replacement.page)}
        scope={scope}
        target={target}
        sections={sections}
        replacement={replacement}
      >
        {children}
      </PageContext>
    );
  if (pendingReplacement)
    return (
      <ResizableSidebar scope={scope} className="shell-sidebar">
        {fallback}
      </ResizableSidebar>
    );
  if (!context) return fallback;
  const Component = context.component;
  return (
    <OwnedContribution
      key={contributionKey(context)}
      entry={context}
      registry={{ snapshot: registry.contextSnapshot ?? noContexts }}
      fallback={fallback}
    >
      {() => (
        <Component
          target={target}
          creationAction={creationAction}
          Frame={SidebarContextFrame}
          renderSections={(props) => (
            <SidebarSectionSources
              {...props}
              registry={sections}
              environment={{ target, active: () => true }}
            />
          )}
        >
          {children}
        </Component>
      )}
    </OwnedContribution>
  );
}

function PageContext({
  scope,
  target,
  sections,
  replacement,
  children,
}: {
  scope: string;
  target: OpenTarget;
  sections: SidebarSections;
  replacement: Omit<PageSidebar, "children">;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const committed = useCallback((value: boolean) => setReady(value), []);
  return (
    <ResizableSidebar scope={scope} className="shell-sidebar">
      <div
        style={{ display: "contents" }}
        data-buzz-launch-pending={ready ? undefined : "required"}
      >
        <PageSidebarState value={{ ...replacement, children }}>
          <SidebarSectionSources
            registry={sections}
            environment={{ target, active: () => true }}
            settled
            onReady={committed}
          >
            {(slots, sources) => (
              <>
                {sources()}
                {slots.map((slot) => (
                  <SidebarSectionSlotView key={slot.key} slot={slot} />
                ))}
              </>
            )}
          </SidebarSectionSources>
        </PageSidebarState>
      </div>
    </ResizableSidebar>
  );
}
