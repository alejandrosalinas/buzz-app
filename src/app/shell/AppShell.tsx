import {
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
import { SidebarIcon, DotsThreeIcon } from "../../shared/design-system/icons";
import { Panel } from "../../shared/design-system/ui/Panel";
import { isTauri } from "@tauri-apps/api/core";
import type { SettingsCards } from "../../features/settings/service";
import type { RegisteredPage } from "../../features/pages/service";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import type { InviteLink } from "../../features/communities/invite-link";
import type { OpenTarget } from "../../features/navigation/targets";
import { CommunityPicker } from "../../features/communities/CommunityPicker";
import { ProfileButton } from "./ProfileButton";
import { CommunityShortcuts } from "./CommunityShortcuts";
import { MarkAllReadShortcut } from "./MarkAllReadShortcut";
import type { Appearance } from "../../shared/theme/service";
import { PageSearch, type SearchServices } from "./PageSearch";
import { headerPageSelection, pagePlacement, orderPages } from "./presentation";
import { PageNavigation } from "./PageNavigation";
import { BestieNavigationProvider } from "./BestieNavigation";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
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
      <AppShellContent {...props} />
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
  invite?: (InviteLink & { requestId: number }) | undefined;
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
  const fillsWorkspace = workspace || selected === "settings";
  const [creationContainer, setCreationContainer] =
    useState<HTMLDivElement | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const connection = useRelayConnection(communities.relay);
  const sidebarScope = connection.scope ?? "disconnected";
  const channelsNavigation = selected === "buzz.channels/channels";
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
  const visibleSidebar = narrow ? navigationOpen : sidebarOpen;
  useEffect(
    () =>
      searchServices?.shortcuts.registerHost({
        id: "new",
        title: "Open New menu",
        binding: { key: "n", mod: true },
        order: 75,
        allowInEditable: true,
        when: () =>
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
    [searchServices, creationAction, creationContainer],
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
    const sidebarPages = orderPages(
      pages.filter((page) => pagePlacement(page) === "sidebar"),
    );
    const pageNavigation = sidebarPages.length ? (
      <nav aria-label="Pages" className="shell-pages">
        <PageNavigation
          pages={sidebarPages}
          selected={selected}
          onSelect={onSelect}
          previews
        />
      </nav>
    ) : null;
    const content = sidebar ? (
      sidebar(
        pageNavigation,
        creationAction && creationInSidebar && (
          <div ref={setCreationContainer} />
        ),
      )
    ) : (
      <div className="shell-sidebar-default">
        <Panel as="aside" aria-label="Page sidebar">
          <div className="p-2">{pageNavigation}</div>
        </Panel>
      </div>
    );
    const selectedPageHasSidebar = pages.some(
      (page) => page.key === selected && !!page.sidebar,
    );
    return selectedPageHasSidebar ? (
      <ResizableSidebar scope={sidebarScope} className="shell-sidebar">
        {content}
      </ResizableSidebar>
    ) : (
      content
    );
  }, [
    pages,
    selected,
    onSelect,
    sidebar,
    sidebarScope,
    creationAction,
    creationInSidebar,
  ]);
  const headerPages = useMemo(
    () =>
      orderPages(
        pages.filter(
          (page) =>
            pagePlacement(page) === "topbar" ||
            pagePlacement(page) === "toolbar",
        ),
      ),
    [pages],
  );
  const topbarPages = headerPages.filter(
    (page) => pagePlacement(page) === "topbar",
  );
  const selectedHeader = headerPageSelection(pages, selected);
  const selectedTopbarPage = topbarPages.some(
    (page) => page.key === selectedHeader,
  );
  const panelKey = selectedTopbarPage ? selectedHeader : selected;
  const toolbarPages = headerPages.filter(
    (page) => pagePlacement(page) === "toolbar",
  );
  const headerRef = useRef<HTMLElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const overflowPages = useRef<HTMLElement>(null);
  const movingFocus = useRef(false);
  const [compactPages, setCompactPages] = useState(narrow);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Measure the real controls, including native insets and text scaling. Hidden
  // header groups retain intrinsic size, but are inert and absent from the a11y tree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Registrations can mount new nav elements; observe their refs after every contribution change.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap) || 0;
      const left =
        (historyRef.current?.offsetWidth ?? 0) + parseFloat(style.paddingLeft);
      const right =
        (actionsRef.current?.offsetWidth ?? 0) +
        (toolbarRef.current?.offsetWidth ?? 0) +
        parseFloat(style.paddingRight) +
        gap;
      const center =
        (topbarRef.current?.offsetWidth ?? 0) +
        (searchRef.current?.offsetWidth ?? 0) +
        gap;
      const compact =
        narrow ||
        2 * (Math.max(left, right) + gap) + center > header.clientWidth;
      // Do not strand keyboard focus inside a newly hidden group.
      if (
        compact &&
        !compactPages &&
        (topbarRef.current?.contains(document.activeElement) ||
          toolbarRef.current?.contains(document.activeElement))
      ) {
        movingFocus.current = true;
      }
      setCompactPages(compact);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [
      header,
      historyRef.current,
      actionsRef.current,
      topbarRef.current,
      searchRef.current,
      toolbarRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [narrow, compactPages, headerPages]);
  useLayoutEffect(() => {
    if (movingFocus.current) {
      movingFocus.current = false;
      overflowTrigger.current?.focus();
    }
    if (!compactPages) {
      if (
        document.activeElement === overflowTrigger.current ||
        overflowPages.current?.contains(document.activeElement)
      ) {
        (topbarRef.current ?? toolbarRef.current)
          ?.querySelector<HTMLButtonElement>("button")
          ?.focus();
      }
      setOverflowOpen(false);
    }
  }, [compactPages]);
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
        ref={headerRef}
        data-buzz-window-drag={
          macDesktop || hasIntegratedWindowControls() || undefined
        }
        data-compact-pages={compactPages || undefined}
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
          {(collapsibleSidebar || narrow) && (
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
          {creationAction && !creationInSidebar && (
            <div ref={setCreationContainer} />
          )}
        </div>
        <div className="shell-center-capsule shell-capsule">
          <div className="shell-page-switcher chrome-navigation">
            {headerPages.length > 0 && (
              <PopoverRoot
                open={overflowOpen && compactPages}
                onOpenChange={setOverflowOpen}
              >
                <PopoverTrigger
                  render={
                    <IconButton
                      hint="familiar"
                      ref={overflowTrigger}
                      data-shell-pages-overflow=""
                      aria-label="More pages"
                      title="More pages"
                      variant="ghost"
                      icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                    />
                  }
                />
                <PopoverPopup
                  size="compact"
                  padding="list"
                  align="end"
                  aria-label="More pages"
                  finalFocus={() =>
                    compactPages
                      ? overflowTrigger.current
                      : ((
                          topbarRef.current ?? toolbarRef.current
                        )?.querySelector<HTMLButtonElement>("button") ??
                        document.getElementById("main-content"))
                  }
                >
                  <nav
                    ref={overflowPages}
                    aria-label="Header pages"
                    className="shell-pages"
                  >
                    <PageNavigation
                      pages={headerPages}
                      selected={selectedHeader}
                      currentPage={selected}
                      onSelect={(key) => {
                        setOverflowOpen(false);
                        onSelect(key);
                      }}
                    />
                  </nav>
                </PopoverPopup>
              </PopoverRoot>
            )}
            {topbarPages.length > 0 && (
              <nav
                ref={topbarRef}
                aria-label="Topbar pages"
                className="shell-topbar-pages"
                aria-hidden={compactPages}
                inert={compactPages}
              >
                <PageNavigation
                  pages={topbarPages}
                  selected={selectedHeader}
                  currentPage={selected}
                  onSelect={onSelect}
                  placement="topbar"
                />
              </nav>
            )}
          </div>
          <div ref={searchRef} className="shell-search-action shell-capsule">
            <PageSearch
              pages={pages}
              onSelect={onSelect}
              services={searchServices}
            />
          </div>
        </div>
        <div
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {toolbarPages.length > 0 && (
            <nav
              ref={toolbarRef}
              aria-label="Toolbar pages"
              className="shell-toolbar-pages"
              aria-hidden={compactPages}
              inert={compactPages}
            >
              <PageNavigation
                pages={toolbarPages}
                selected={selected}
                onSelect={onSelect}
                placement="toolbar"
              />
            </nav>
          )}
          <div ref={actionsRef} className="shell-actions-fixed">
            {launchers}
            <div className="shell-community-switcher">
              <CommunityPicker
                communities={communities}
                invite={invite}
                onInviteClose={onInviteClose}
                settingsCards={settingsCards}
                federatedIdentity={federatedIdentity}
                onSelect={onCommunitySelect}
                onOpenTarget={onOpenTarget}
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
            <WindowControls />
          </div>
        </div>
      </header>

      <div className="shell-workspace">
        <div
          ref={workspaceRef}
          className="shell-dialog-frame"
          data-shell-dialog-frame=""
        />
        <div
          className={`shell-body ${selected === "settings" ? "shell-body-settings" : ""}`}
        >
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <div className="shell-content">
              <div
                id="shell-navigation"
                className="shell-navigation"
                data-sidebar-collapsible={
                  (collapsibleSidebar && !narrow) || undefined
                }
                data-sidebar-open={visibleSidebar || undefined}
                aria-hidden={(collapsibleSidebar || narrow) && !visibleSidebar}
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
                      id={`shell-page-${panelKey}`}
                      {...(!compactPages && selectedTopbarPage
                        ? {
                            role: "tabpanel",
                            "aria-labelledby": `shell-page-${panelKey}-tab`,
                            tabIndex: 0,
                            "data-focus-inset": "",
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
                        {children}
                      </div>
                    </div>
                  </PanelFrame>
                </Panel>
              </main>
            </div>
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
