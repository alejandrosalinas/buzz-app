import { ActivityNavigationProvider } from "./ActivityNavigation";
import { PageNavigation } from "./PageNavigation";
import { navigationOwner, orderPages, pagePlacement } from "./presentation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SidebarIcon } from "../../shared/design-system/icons";
import { Panel } from "../../shared/design-system/ui/Panel";
import { isTauri } from "@tauri-apps/api/core";
import type { SettingsCards } from "../../features/settings/service";
import type { RegisteredPage } from "../../features/pages/service";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import type { JoinRequest } from "../../features/communities/invite-intent";
import type { OpenTarget } from "../../features/navigation/targets";
import {
  CommunityPicker,
  OpenCommunitySwitcher,
} from "../../features/communities/CommunityPicker";
import { ProfileButton } from "./ProfileButton";
import { CommunityShortcuts } from "./CommunityShortcuts";
import { MarkAllReadShortcut } from "./MarkAllReadShortcut";
import type { Appearance } from "../../shared/theme/service";
import { PageSearch, type SearchServices } from "./PageSearch";
import { BestieNavigationProvider } from "./BestieNavigation";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { useRelayConnection } from "../../features/relay/react";
import { macTitleBarDragHandlers } from "./title-bar";
import { hasIntegratedWindowControls, WindowControls } from "./WindowControls";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
const titleBarDragProps = macDesktop ? macTitleBarDragHandlers : {};

export function AppShell(props: ComponentProps<typeof AppShellContent>) {
  return (
    <BestieNavigationProvider
      pages={props.pages}
      relay={props.communities.relay}
    >
      <ActivityNavigationProvider
        pages={props.pages}
        relay={props.communities.relay}
      >
        <AppShellContent {...props} />
      </ActivityNavigationProvider>
    </BestieNavigationProvider>
  );
}

function AppShellContent({
  pages,
  selected,
  navigationAttempt,
  onSelect,
  tone,
  workspace,
  workspaceRef,
  sidebar,
  communities,
  invite,
  onInviteClose,
  settingsCards,
  federatedIdentity,
  accountActions,
  appearance,
  pluginRecommendations = 0,
  searchServices,
  navigationControls,
  onCommunitySelect,
  onOpenTarget,
  launchers,
  backdrop,
  companion,
  creationAction,
  creationInSidebar = true,
  children,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  navigationAttempt: string;
  onSelect: (
    key: string,
    options?: Pick<NavigationOpenOptions, "focus"> & { section?: string },
  ) => void;
  tone: string;
  workspace?: boolean;
  /** Centered modal frame below window chrome. */
  workspaceRef?: Ref<HTMLDivElement>;
  sidebar?: (pages: ReactNode, creationAction: ReactNode) => ReactNode;
  communities: Communities;
  invite?: (JoinRequest & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: SettingsCards | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  accountActions: AccountActionsService;
  appearance: Appearance;
  /** Managed plugin recommendations awaiting review, pointed out beside Plugins. */
  pluginRecommendations?: number;
  searchServices?: SearchServices;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  /** Community menu destinations, opened through the host's navigation. */
  onOpenTarget?: (target: OpenTarget) => void;
  launchers?: ReactNode;
  /** Plugin-painted layers behind the shell; absent by default. */
  backdrop?: ReactNode;
  companion?: ReactNode;
  creationAction?: (
    open: boolean,
    onOpenChange: (open: boolean) => void,
    triggerContainer: HTMLElement | null,
  ) => ReactNode;
  creationInSidebar?: boolean;
  children: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const history = historyRef.current;
    const actions = actionsRef.current;
    const search = searchRef.current;
    if (!element || !history || !actions || !search) return;
    const measure = () => {
      // Equal wings keep Search centered even when the native controls or launchers differ.
      const wing = Math.max(history.offsetWidth, actions.offsetWidth);
      const style = getComputedStyle(element);
      const available =
        element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const searchStyle = getComputedStyle(search);
      const controls =
        history.offsetWidth +
        actions.offsetWidth +
        2 * parseFloat(style.columnGap);
      element.dataset.searchFluid = String(
        available < controls + parseFloat(searchStyle.maxWidth),
      );
      element.style.setProperty("--shell-header-wing", `${wing}px`);
      element.dataset.searchWrapped = String(
        available < controls + parseFloat(searchStyle.minWidth),
      );
    };
    // Header wrapping resizes the workspace below it. Apply it outside resize
    // delivery so timeline observers do not receive a second layout mid-cycle.
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    });
    for (const target of [element, history, actions]) observer.observe(target);
    measure();
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  const fillsWorkspace = workspace || selected === "settings";
  const [creationContainer, setCreationContainer] =
    useState<HTMLDivElement | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const connection = useRelayConnection(communities.relay);
  const sidebarScope = connection.scope ?? "disconnected";
  const owner = navigationOwner(pages, selected);
  const channelsNavigation = owner === "buzz.channels/channels";
  const hasNavigation =
    channelsNavigation ||
    pages.some((page) => page.key === selected && !!page.sidebar);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 650px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 650px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const collapsibleSidebar =
    channelsNavigation ||
    selected === "settings" ||
    pages.some(
      (page) => page.key === selected && (page.primary || !!page.sidebar),
    );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const visibleSidebar =
    hasNavigation && (narrow ? navigationOpen : sidebarOpen);
  const creationInNavigation = !!creationAction && creationInSidebar;
  useEffect(
    () =>
      searchServices?.shortcuts.registerHost({
        id: "new",
        title: "Open New menu",
        binding: { key: "n", mod: true },
        order: 75,
        allowInEditable: true,
        when: () =>
          hasNavigation &&
          !!creationAction &&
          !!creationContainer?.querySelector("button:not(:disabled)") &&
          (isApplePlatform(navigator.platform) ||
            !document.activeElement?.closest(".xterm")),
        run: () => {
          setSidebarOpen(true);
          setNavigationOpen(true);
          setCreationOpen(true);
        },
      }),
    [searchServices, creationAction, creationContainer, hasNavigation],
  );
  const toggleLabel = narrow
    ? navigationOpen
      ? "Hide navigation"
      : "Show navigation"
    : `${sidebarOpen ? "Hide" : "Show"} sidebar`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a navigation attempt closes the drawer.
  useEffect(() => {
    if (navigationOpen && navigationToggle.current?.getClientRects().length) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    setNavigationOpen(false);
  }, [navigationAttempt]);
  // Toggling the sidebar changes only this shell's own state. Keep the
  // navigation element stable across those renders so React skips the whole
  // sidebar subtree instead of re-rendering every row on each click.
  const navigation = useMemo(() => {
    const selectedPageHasSidebar = pages.some(
      (page) => page.key === selected && !!page.sidebar,
    );
    // Sidebars retain their documented app-link and creation slots.
    const content = sidebar
      ? sidebar(
          <nav aria-label="Pages" className="shell-pages">
            <PageNavigation
              pages={orderPages(
                pages.filter((page) => pagePlacement(page) === "sidebar"),
              )}
              selected={selected}
              onSelect={onSelect}
              previews
            />
          </nav>,
          creationInNavigation ? <div ref={setCreationContainer} /> : null,
        )
      : null;
    return selectedPageHasSidebar ? (
      <ResizableSidebar scope={sidebarScope} className="shell-sidebar">
        {content}
      </ResizableSidebar>
    ) : (
      content
    );
  }, [pages, selected, sidebar, sidebarScope, onSelect, creationInNavigation]);
  const dockPages = orderPages(
    pages.filter((page) => page.primary && pagePlacement(page) !== "sidebar"),
    "dock",
  );
  const selectedDockPage = dockPages.some((page) => page.key === owner);
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden text-ink"
    >
      {backdrop}
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        ref={header}
        data-buzz-window-drag={
          macDesktop || hasIntegratedWindowControls() || undefined
        }
        data-tauri-drag-region={macDesktop ? undefined : true}
        {...titleBarDragProps}
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div
          ref={historyRef}
          className="shell-history"
          data-buzz-window-drag={
            macDesktop || hasIntegratedWindowControls() || undefined
          }
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {hasNavigation && (collapsibleSidebar || narrow) && (
            <IconButton
              hint="familiar"
              ref={navigationToggle}
              data-shell-sidebar-toggle=""
              data-highlight-expanded="false"
              type="button"
              variant="ghost"
              aria-label={toggleLabel}
              aria-expanded={visibleSidebar}
              aria-controls="shell-navigation"
              title={toggleLabel}
              onClick={() => {
                if (narrow) setNavigationOpen((open) => !open);
                else setSidebarOpen((open) => !open);
              }}
              icon={<SidebarIcon aria-hidden="true" size={16} />}
            />
          )}
          {navigationControls}
        </div>
        <div ref={searchRef} className="shell-menu-search">
          <PageSearch
            pages={pages}
            onSelect={onSelect}
            services={searchServices}
          />
        </div>
        <div
          ref={actionsRef}
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          <div className="shell-actions-fixed">
            {launchers}
            <WindowControls />
          </div>
        </div>
      </header>

      <div className="shell-workspace">
        <nav className="shell-side-dock" aria-label="Apps dock">
          <div className="shell-dock-pages">
            <PageNavigation
              pages={dockPages}
              selected={owner}
              currentPage={selected}
              onSelect={onSelect}
              placement="dock"
              previews
            />
          </div>
          <div className="shell-community-switcher">
            <CommunityPicker
              communities={communities}
              invite={invite}
              onInviteClose={onInviteClose}
              settingsCards={settingsCards}
              federatedIdentity={federatedIdentity}
              onSelect={onCommunitySelect}
              onOpenTarget={onOpenTarget}
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
            />
            <ProfileButton
              communities={communities}
              accountActions={accountActions}
              settingsSelected={selected === "settings"}
              appearance={appearance}
              pluginRecommendations={pluginRecommendations}
              onSettings={(section) =>
                onSelect("settings", section ? { section } : undefined)
              }
            />
          </div>
        </nav>
        <div
          ref={workspaceRef}
          className="shell-dialog-frame"
          data-shell-dialog-frame=""
        />
        <div
          className={`shell-body ${selected === "settings" ? "shell-body-settings" : ""}`}
        >
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <Panel as="div" joined>
              <div className="shell-content">
                <div
                  id="shell-navigation"
                  hidden={!hasNavigation}
                  className="shell-navigation"
                  data-sidebar-collapsible={
                    (collapsibleSidebar && !narrow) || undefined
                  }
                  data-sidebar-open={visibleSidebar || undefined}
                  aria-hidden={
                    (collapsibleSidebar || narrow) && !visibleSidebar
                  }
                  inert={(collapsibleSidebar || narrow) && !visibleSidebar}
                  data-expanded={navigationOpen}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" &&
                      !event.shiftKey &&
                      navigationOpen &&
                      !event.defaultPrevented
                    ) {
                      // Closing the drawer consumes Escape, so it marks nothing read.
                      event.preventDefault();
                      setNavigationOpen(false);
                      navigationToggle.current?.focus();
                    }
                  }}
                >
                  <div className="shell-navigation-content">{navigation}</div>
                </div>
                <main
                  id="main-content"
                  tabIndex={-1}
                  className="min-h-0 min-w-0 flex-1"
                >
                  <Panel as="div" joined>
                    <PanelFrame scope={connection.scope} companion={companion}>
                      <div
                        id={`shell-page-${owner}`}
                        {...(selectedDockPage
                          ? {
                              role: "tabpanel",
                              "data-focus-inset": "",
                              "aria-labelledby": `shell-page-${owner}-tab`,
                              tabIndex: 0,
                            }
                          : {})}
                        className={
                          fillsWorkspace
                            ? "buzz-tabs-panel h-full min-h-0"
                            : "buzz-tabs-panel h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
                        }
                      >
                        <div
                          className={
                            fillsWorkspace
                              ? "h-full min-h-0"
                              : "mx-auto w-full max-w-4xl"
                          }
                        >
                          <OpenCommunitySwitcher value={openSwitcher}>
                            {children}
                          </OpenCommunitySwitcher>
                        </div>
                      </div>
                    </PanelFrame>
                  </Panel>
                </main>
              </div>
            </Panel>
          </div>
        </div>
      </div>
      {creationAction?.(creationOpen, setCreationOpen, creationContainer)}
      {searchServices && (
        <>
          <MarkAllReadShortcut
            communities={communities}
            shortcuts={searchServices.shortcuts}
          />
          <CommunityShortcuts
            communities={communities}
            shortcuts={searchServices.shortcuts}
            onSelect={onCommunitySelect}
          />
        </>
      )}
    </div>
  );
}
