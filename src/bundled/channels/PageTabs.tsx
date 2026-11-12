import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { RelaySession } from "../../features/relay/session";
import type {
  ConversationExtensions,
  PageTabOptions,
  PageTabsProps,
  PageTabTarget,
} from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { LinkThreadTabContext } from "../../features/conversation/LinkLabelContext";
import { useChannelList } from "../../features/relay/react";
import { channelIcon } from "../../features/channels/channel-icon";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { PanelDock } from "../../features/panels/PanelDock";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SidebarRightIcon } from "../../shared/design-system/icons";
import panelStyles from "../../features/panels/Panels.module.css";
import { useChannelLabels } from "./useChannelLabels";
import {
  tabPane,
  threadTab,
  useChannelTabState,
  type ConversationTab,
} from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";
import { useCoveredByDock } from "./useCoveredByDock";
import styles from "./Channels.module.css";

export type { PageTabOptions, PageTabsProps, PageTabTarget };

// The tab each page's next plain open replaces, for as long as its tabs last.
const previews = new WeakMap<RelaySession, Map<string, string>>();

/** A page's content as the first tab, with conversations it opens beside it. */
export function PageTabs({
  id,
  session,
  scope,
  label,
  icon,
  children,
  host,
  extensions,
  visits,
}: PageTabsProps & {
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
}) {
  const tabState = useChannelTabState(session, undefined, `page:${id}`);
  const list = useChannelList(session.channels);
  const { channels, profiles } = useChannelLabels(
    // As in Channels, a Huddle room's tabs show the unavailable placeholder.
    list.channels.filter(
      (channel) => !channel.huddle && !channel.metadataPending,
    ),
    session.profiles,
    session.names,
  );
  const mounted = useRef(false);
  const continuing = useRef(false);
  useLayoutEffect(() => {
    mounted.current = continuing.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fallbackFocus = useRef<HTMLDivElement>(null);
  const secondary = useConversationTabs({
    state: tabState,
    relay: host.relay,
    session,
    panels: host.panels,
    current: undefined,
    scope,
    channels,
    profiles,
    extensions,
    leadingIds: [],
    continuingVisit: continuing.current,
    isLive: () => true,
    openLink(url) {
      const viewer = session.viewer;
      const target =
        viewer &&
        isBuzzLink(url) &&
        buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
      if (!target) return false;
      void host.navigation.open(target);
      return true;
    },
    fallbackFocus,
    mainPane: true,
    anyMainThread: true,
    // The page stays in view; a thread reaches the main pane only when moved.
    threadPane: "side",
    visits,
    navigation: host.navigation,
    conversationIcon: (item) => {
      const Icon = channelIcon(item);
      return <Icon size="1rem" />;
    },
  });
  // One stable opener, so a page's effects can depend on it; it reads the
  // live workspace when called.
  const opening = useRef<
    (target: PageTabTarget, options?: PageTabOptions) => boolean
  >(() => false);
  const closing = useRef<(target: PageTabTarget) => boolean>(() => false);
  // A page's own close leaves focus to the page, so the workspaces adopt the
  // selection it leaves without focusing it; an open in the same update, as
  // when Archive advances, focuses its tab as usual.
  const [closes, setCloses] = useState(0);
  const committedCloses = useRef(closes);
  useLayoutEffect(() => {
    committedCloses.current = closes;
  });
  // A thread opened at a reply keeps its tab once its root resolves.
  const tabOf = ({ channelId, threadId }: PageTabTarget) =>
    (threadId && threadTab(tabState.tabs, channelId, threadId)) ||
    tabState.tabs.find(
      (item) =>
        item.id ===
        (threadId
          ? `thread:${channelId}:${threadId}`
          : `conversation:${channelId}`),
    );
  const isOpen = (target: PageTabTarget) => !!tabOf(target);
  useLayoutEffect(() => {
    closing.current = (target) => {
      const tab = tabOf(target);
      if (!mounted.current || !tab) return false;
      tabState.setTabs((tabs) => tabs.filter((item) => item.id !== tab.id));
      setCloses(committedCloses.current + 1);
      return true;
    };
    opening.current = (
      { channelId, threadId, messageId },
      { keep, markRead } = {},
    ) => {
      if (!mounted.current || !secondary.canOpenConversation(channelId))
        return false;
      setCloses(committedCloses.current);
      const known = new Set(tabState.tabs.map((tab) => tab.id));
      // An open thread keeps its tab in whichever pane it was moved to, and
      // under its verified root.
      const existing = threadId ? tabOf({ channelId, threadId }) : undefined;
      // Each open at a message asks the reader to show it again; any other
      // open focuses the composer.
      if (threadId)
        secondary.openConversationThread(
          channelId,
          messageId ?? threadId,
          (existing?.kind === "thread" && existing.rootId) || threadId,
          messageId ? "reveal" : "focus",
        );
      else {
        const tab = `conversation:${channelId}`;
        tabState.setTabs((tabs) => {
          const previous = tabs.find((item) => item.id === tab);
          const prior =
            previous?.kind === "conversation" ? previous : undefined;
          const next: ConversationTab = {
            id: tab,
            kind: "conversation",
            channelId,
            ...(messageId && { messageId }),
            revealRequest: (prior?.revealRequest ?? 0) + (messageId ? 1 : 0),
            focusRequest: (prior?.focusRequest ?? 0) + (messageId ? 0 : 1),
            ...(markRead === false && { markRead: false }),
          };
          return previous
            ? tabs.map((item) => (item === previous ? next : item))
            : [...tabs, next];
        });
        tabState.select(tab);
      }
      // A plain open replaces the tab the last one added; a kept, moved or
      // already-open tab stays.
      const page = previews.get(session) ?? new Map<string, string>();
      previews.set(session, page);
      const opened = existing?.id || tabState.getSelected();
      const preview = page.get(id);
      if (known.has(opened)) {
        if (keep && opened === preview) page.delete(id);
      } else if (!keep) {
        if (preview && known.has(preview))
          tabState.setTabs((tabs) =>
            tabs.filter((tab) => tab.id !== preview || tabPane(tab) === "main"),
          );
        page.set(id, opened);
      }
      return true;
    };
  });
  const open = useCallback(
    (target: PageTabTarget, options?: PageTabOptions) =>
      opening.current(target, options),
    [],
  );
  const close = useCallback(
    (target: PageTabTarget) => closing.current(target),
    [],
  );
  const focusPage = useRef(false);
  const closeAll = () => {
    if (!secondary.closeAllTabs()) return false;
    focusPage.current = true;
    return true;
  };
  // The page owns the close-all command while its workspace is shown, even
  // while a floating pane covers the page.
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const workspace = split.ref.current;
      if (
        event.defaultPrevented ||
        !workspace?.isConnected ||
        workspace.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !workspace.getClientRects().length ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      flushSync(() => {
        if (closeAll()) event.preventDefault();
      });
    };
    window.addEventListener("buzz:close-all-tabs", close);
    return () => window.removeEventListener("buzz:close-all-tabs", close);
  });
  // Surviving content keeps focus; a removed tab or closing menu returns it
  // to the page's own tab.
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected &&
      !focused.closest('[inert], [hidden], [aria-hidden="true"], [role="menu"]')
    )
      return;
    (
      fallbackFocus.current?.querySelector<HTMLElement>(
        '[role="tab"][data-tab-value="conversation"]',
      ) ?? fallbackFocus.current
    )?.focus({ preventScroll: true });
  });
  // An update that removes the control in use, such as a reader whose room
  // became a Huddle, returns focus to the tab that showed it.
  const focused = useRef<{ node: Element; tab: string | null | undefined }>(
    undefined,
  );
  useLayoutEffect(() => {
    const last = focused.current;
    if (
      !last ||
      last.node.isConnected ||
      document.activeElement !== document.body
    )
      return;
    focused.current = undefined;
    (
      (last.tab && document.getElementById(last.tab)) ||
      fallbackFocus.current
    )?.focus({ preventScroll: true });
  });
  const split = usePanelSplit(scope, `page:${id}`);
  const hasTabs = secondary.items.length > 0;
  const showingPanel = tabState.paneOpen && hasTabs;
  const covered = useCoveredByDock(split.ref, fallbackFocus, showingPanel);
  // As in a plain channel visit, the page reads its visible selected side tab
  // while focus stays anywhere on the page, such as the row that opened it.
  // A conversation moved to the main pane still reads only by its own focus.
  const readingTab =
    showingPanel &&
    secondary.selectedMain === "conversation" &&
    !!secondary.selectedTab;
  const tabMenu = {
    key: JSON.stringify([scope, id]),
    closeAll,
  };
  const paneToggle = (
    onClick: () => void,
    ref?: typeof secondary.splitTrigger,
  ) => (
    <IconButton
      hint="familiar"
      ref={ref}
      data-tab-pane-toggle=""
      size="toolbar"
      aria-label="Toggle tab pane"
      title={showingPanel ? "Close tab pane" : "Open tab pane"}
      aria-expanded={showingPanel}
      onClick={onClick}
      icon={<SidebarRightIcon size="1rem" aria-hidden="true" />}
    />
  );
  return (
    <LinkThreadTabContext value={secondary.openLinkedThread}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Focus within records the control in use, restored if an update removes it. */}
      <div
        className={styles.root}
        onFocus={({ target }) => {
          const panel = target.closest('[role="tabpanel"]');
          focused.current = {
            node: target,
            // A portalled dialog sits outside its tab's panel; it belongs to
            // the tab focus came from.
            tab: panel
              ? panel.getAttribute("aria-labelledby")
              : focused.current?.tab,
          };
        }}
      >
        <div
          ref={split.ref}
          style={split.style}
          data-reading-thread={readingTab ? "" : undefined}
          className={`${styles.board} ${panelStyles.splitMotion}`}
        >
          <div
            ref={fallbackFocus}
            tabIndex={-1}
            className={styles.conversation}
            inert={covered}
            aria-hidden={covered || undefined}
          >
            <PanelWorkspace
              main
              tabMenu={tabMenu}
              drag={secondary.drag.main}
              label={`${label} tabs`}
              focusOnMount={false}
              adoptSelection={closes}
              value={secondary.selectedMain}
              select={(tab) =>
                tabState.selectMain(tab === "conversation" ? undefined : tab)
              }
              actions={
                hasTabs &&
                !showingPanel && (
                  <span className={panelStyles.paneToggle}>
                    {paneToggle(
                      () => tabState.setPaneOpen(true),
                      secondary.splitTrigger,
                    )}
                  </span>
                )
              }
              items={[
                {
                  id: "conversation",
                  label,
                  icon,
                  content: children(open, close, isOpen),
                },
                ...secondary.mainItems,
              ]}
            />
          </div>
          {secondary.drag.feedback}
          {secondary.hosts}
          <p role="status" className="sr-only">
            {secondary.announcement}
          </p>
          <PanelDock
            open={showingPanel}
            keepMounted={
              tabState.entries.length > 0 || (hasTabs && !tabState.paneOpen)
            }
            className={styles.panelStack}
            resizeHandle={split.handle}
          >
            {hasTabs && (
              <div className={styles.retainedPanel}>
                <PanelWorkspace
                  drag={secondary.drag.side}
                  actions={paneToggle(secondary.closePane)}
                  tabMenu={tabMenu}
                  value={secondary.selectedTab}
                  select={secondary.selectPanelTab}
                  items={secondary.items}
                  focusOnMount={continuing.current}
                  adoptSelection={closes}
                />
              </div>
            )}
          </PanelDock>
        </div>
      </div>
    </LinkThreadTabContext>
  );
}
