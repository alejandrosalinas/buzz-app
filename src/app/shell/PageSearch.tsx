import { useSearchSettings } from "./SearchSettings";
import { usePagePresentation } from "./BestieNavigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MagnifyingGlassIcon } from "../../shared/design-system/icons/index";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { RegisteredPage } from "../../features/pages/service";
import { communityDestination } from "../../features/communities/destination";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { ChannelQueries } from "../../features/relay/contracts";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import { KeyCombo } from "../../features/shortcuts/KeyCombo";
import type { ShortcutBindingsSnapshot } from "../../features/shortcuts/preferences";
import type { AppServices } from "../services";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import { conversationFocusTarget } from "../focus-navigation";
import { orderPages, shellPresentation } from "./presentation";
import { matchName } from "../../features/search/match";
import {
  SearchChoices,
  type SearchInputProps,
  type SearchDestination,
  type SearchPlace,
} from "./SearchChoices";
import { SearchResults } from "./SearchResults";
import { ChannelDirectoryResults } from "./ChannelDirectoryResults";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import { usageScope } from "../../features/search/usage";
import { unreadFirstPreference } from "../../features/search/unread-first-preference";

export type SearchServices = Pick<
  AppServices,
  "communities" | "shortcuts" | "shortcutBindings" | "navigation"
> &
  Partial<
    Pick<
      AppServices,
      | "appearance"
      | "notifications"
      | "plugins"
      | "adminAccess"
      | "settingsCards"
    >
  >;
const SEARCH_ID = "global-search";
const SEARCH_BINDING: KeyBinding = { key: "k", mod: true };
// Slack opens its ⌘K switcher from ⌘T too; the hint shows ⌘K.
const SEARCH_BINDINGS = [SEARCH_BINDING, { key: "t", mod: true }];
const CONVERSATION_SEARCH_ID = "conversation-search";
const CONVERSATION_SEARCH_BINDING: KeyBinding = { key: "f", mod: true };
const NO_OVERRIDES: ShortcutBindingsSnapshot = { overrides: {}, error: null };
const noSubscribe = () => () => {};
const noOverrides = () => NO_OVERRIDES;
type SearchView = "all" | "channels";
/** How long a closed search keeps its place for the next opening. */
const SEARCH_MEMORY = 5 * 60_000;
const SEARCH_VIEWS = [
  { value: "all", label: "All", panelId: "search-view-all" },
  { value: "channels", label: "Channels", panelId: "search-view-channels" },
] as const;

export function PageSearch({
  pages,
  onSelect,
  services,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string, options?: { section?: string }) => void;
  services?: SearchServices | undefined;
}) {
  const pagePresentation = usePagePresentation();
  const [open, setOpen] = useState(false);
  const [contentPresent, setContentPresent] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchView>("all");
  const [scopedChannelId, setScopedChannelId] = useState<string>();
  // Search reopens where it was left, so someone checking channels one by
  // one returns to the same list. Escape, or a while away, starts fresh, as
  // does an empty All view while it leads with unread: it shows what is
  // unread now.
  const place = useRef<SearchPlace>({ top: 0, key: "" });
  const escaped = useRef(false);
  const remembered = useRef<{
    query: string;
    tab: SearchView;
    place: SearchPlace;
    at: number;
  }>(undefined);
  // Kept text opens selected, so typing something new replaces it.
  const selectKept = useRef(false);
  const latest = useRef({ query, tab, scopedChannelId });
  latest.current = { query, tab, scopedChannelId };
  const currentTarget = useSyncExternalStore(
    services?.navigation?.subscribe ?? noSubscribe,
    () => services?.navigation?.snapshot().entry.target ?? null,
  );
  const input = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const composerChannel = useRef<string | undefined>(undefined);
  const trigger = useRef<HTMLElement>(null);
  const openRef = useRef(false);
  const setSearchOpen = useCallback((next: boolean) => {
    if (!next && openRef.current) {
      const { query, tab, scopedChannelId } = latest.current;
      remembered.current =
        escaped.current || scopedChannelId
          ? undefined
          : { query, tab, place: { ...place.current }, at: Date.now() };
      escaped.current = false;
    }
    openRef.current = next;
    if (next) setContentPresent(true);
    setOpen(next);
  }, []);
  const changeTab = useCallback((next: SearchView) => {
    place.current = { top: 0, key: "" };
    setTab(next);
  }, []);
  const begin = useCallback(() => {
    composerChannel.current = undefined;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    const memory = remembered.current;
    const kept =
      memory &&
      Date.now() - memory.at < SEARCH_MEMORY &&
      (memory.query.trim() || memory.tab !== "all" || !unreadFirstPreference());
    setQuery(kept ? memory.query : "");
    selectKept.current = !!kept && !!memory.query;
    setTab(kept ? memory.tab : "all");
    place.current = kept ? { ...memory.place } : { top: 0, key: "" };
    setScopedChannelId(undefined);
    setSearchOpen(true);
  }, [setSearchOpen]);
  useEffect(() => {
    if (!open || !selectKept.current) return;
    selectKept.current = false;
    const field = input.current;
    if (field instanceof HTMLInputElement && document.activeElement === field)
      return void field.select();
    // The field usually mounts and takes focus after the dialog opens.
    const focused = ({ target }: FocusEvent) => {
      if (target !== input.current || !(target instanceof HTMLInputElement))
        return;
      target.select();
      document.removeEventListener("focusin", focused);
    };
    document.addEventListener("focusin", focused);
    return () => document.removeEventListener("focusin", focused);
  }, [open]);
  const beginScoped = useCallback(() => {
    if (currentTarget?.kind !== "conversation") return;
    composerChannel.current = undefined;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setQuery("");
    setTab("all");
    place.current = { top: 0, key: "" };
    setScopedChannelId(currentTarget.channelId);
    setSearchOpen(true);
  }, [currentTarget, setSearchOpen]);
  useEffect(
    () =>
      services?.shortcuts.registerHost({
        id: SEARCH_ID,
        title: "Search Buzz",
        binding: SEARCH_BINDINGS,
        order: HOST_SHORTCUT_ORDER.search,
        allowInEditable: true,
        run: begin,
      }),
    [services, begin],
  );
  useEffect(
    () =>
      services?.shortcuts.registerHost({
        id: CONVERSATION_SEARCH_ID,
        title: "Search this conversation",
        binding: CONVERSATION_SEARCH_BINDING,
        order: HOST_SHORTCUT_ORDER.search + 1,
        allowInEditable: true,
        when: () => currentTarget?.kind === "conversation",
        run: beginScoped,
      }),
    [services, currentTarget, beginScoped],
  );
  // The hint follows the person's rebind, derived from the same binding object.
  const { overrides } = useSyncExternalStore(
    services?.shortcutBindings.subscribe ?? noSubscribe,
    services?.shortcutBindings.snapshot ?? noOverrides,
  );
  const binding = overrides[SEARCH_ID] ?? SEARCH_BINDING;
  const apple = isApplePlatform(navigator.platform);
  // Every search surface reads pages from here, so rank and underline them
  // here too: the disconnected and personal-space views show this list as is.
  const needle = query.trim().toLowerCase();
  const searchPages: (Omit<SearchDestination, "run"> & { open: () => void })[] =
    [
      ...orderPages(pages).map((page) => ({
        key: page.key,
        ...pagePresentation(page),
        open: () => onSelect(page.key),
      })),
      {
        key: "settings",
        ...shellPresentation.settings,
        open: () => onSelect("settings"),
      },
    ];
  const destinations: SearchDestination[] = searchPages
    .flatMap((page) => {
      if (!needle) return [{ page, rank: 0 }];
      const labelMatch = matchName(page.label, needle);
      const detailMatch = page.detail
        ? matchName(page.detail, needle)
        : undefined;
      const rank = Math.min(
        labelMatch?.rank ?? Infinity,
        detailMatch?.rank ?? Infinity,
      );
      return Number.isFinite(rank)
        ? [
            {
              page: {
                ...page,
                ...(labelMatch ? { matches: labelMatch.positions } : {}),
              },
              rank,
            },
          ]
        : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ page }) => ({
      ...page,
      run: () => {
        returnFocus.current = document.getElementById("main-content");
        page.open();
        setSearchOpen(false);
      },
    }));
  return (
    <>
      <Button
        ref={trigger}
        variant="inverted"
        size="sm"
        shape="capsule"
        aria-label="Search Buzz"
        title={`Search Buzz (${formatBinding(binding, apple).text})`}
        onClick={() => {
          trigger.current?.focus();
          begin();
        }}
      >
        <span className="shell-search-content">
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <span className="shell-search-label">Search</span>
          <span className="shell-search-shortcut">
            <KeyCombo binding={binding} apple={apple} />
          </span>
        </span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={setSearchOpen}
        onEscape={() => {
          escaped.current = true;
          return false;
        }}
        title={scopedChannelId ? "Search this conversation" : "Search Buzz"}
        footerGap="none"
        motion="default"
        dismissOnOutsideClick
        presentation="search"
        initialFocus={input}
        finalFocus={() =>
          returnFocus.current?.id === "main-content"
            ? (composerChannel.current &&
                conversationFocusTarget(composerChannel.current)) ||
              false
            : returnFocus.current
        }
        onOpenChangeComplete={(open) => {
          if (!open && !openRef.current) setContentPresent(false);
          // Base UI otherwise chooses main's first tabbable child. Preserve a
          // destination's own focus target if it already presented one, in
          // main or in a modal destination such as Settings.
          const main = returnFocus.current;
          const destination =
            document.activeElement?.closest('[role="dialog"]');
          if (
            !open &&
            !openRef.current &&
            main?.id === "main-content" &&
            !main.contains(document.activeElement) &&
            !(destination && !destination.contains(input.current))
          )
            (
              (composerChannel.current &&
                conversationFocusTarget(composerChannel.current)) ||
              main
            ).focus({ preventScroll: true });
        }}
      >
        {contentPresent &&
          (services ? (
            <CommunitySearch
              tab={tab}
              onTabChange={changeTab}
              place={place.current}
              services={services}
              pages={destinations}
              query={query}
              onQueryChange={setQuery}
              input={input}
              enabled={pages.some(
                (page) => page.key === "buzz.channels/channels",
              )}
              scopedChannelId={scopedChannelId}
              currentChannelId={
                currentTarget?.kind === "conversation"
                  ? currentTarget.channelId
                  : undefined
              }
              onScopeChange={(channelId) => {
                setScopedChannelId(channelId);
                input.current?.focus();
              }}
              open={open}
              isOpen={() => openRef.current}
              close={(channelId) => {
                composerChannel.current = channelId;
                returnFocus.current = document.getElementById("main-content");
                setSearchOpen(false);
              }}
              openSection={(section) => {
                returnFocus.current = document.getElementById("main-content");
                onSelect("settings", { section });
                setSearchOpen(false);
              }}
            />
          ) : (
            <SearchChoices
              query={query}
              onQueryChange={setQuery}
              input={input}
              groups={[{ label: "Pages", destinations }]}
            />
          ))}
      </Dialog>
    </>
  );
}

function CommunitySearch({
  tab,
  onTabChange,
  place,
  services,
  pages,
  query,
  onQueryChange,
  input,
  open,
  enabled,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  isOpen,
  close,
  openSection,
}: {
  tab: SearchView;
  onTabChange: (tab: SearchView) => void;
  /** Where the results were, kept for the next opening. */
  place: SearchPlace;
  services: SearchServices;
  pages: readonly SearchDestination[];
  enabled: boolean;
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange: (channelId?: string) => void;
  /** Whether the palette is still open. A choice that resolves after it
   * closed, such as a DM still opening, must not navigate. */
  isOpen: () => boolean;
  close: (channelId?: string) => void;
  openSection: (section: string) => void;
} & SearchInputProps) {
  const inlineSettings = useSearchSettings({
    query: scopedChannelId ? "" : query,
    appearance: services.appearance,
    notifications: services.notifications,
    plugins: services.plugins,
    adminAccess: services.adminAccess,
    settingsCards: services.settingsCards,
    communities: services.communities,
    navigation: services.navigation,
    close,
    openSection,
  });
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const connection = useRelayConnection(services.communities.relay);
  // A conversation scope has only All.
  const view = scopedChannelId ? "all" : tab;
  // Switching views remounts the results and their tab row. A switch made on
  // the row keeps focus there; any other switch returns it to the field.
  const pointer = useRef(false);
  const focusTab = useRef(false);
  // Keystrokes re-render the palette; the tab row depends only on the view.
  const tabs = useMemo(
    () => (
      // A pointer switch returns to the field: typing usually follows.
      <div
        onPointerDown={() => {
          pointer.current = true;
        }}
      >
        <Tabs
          variant="panel"
          label="Search in"
          value={view}
          items={SEARCH_VIEWS}
          onValueChange={(next) => {
            focusTab.current =
              !pointer.current &&
              document.activeElement?.getAttribute("role") === "tab";
            pointer.current = false;
            onTabChange(next);
          }}
          onReselect={() => {
            pointer.current = false;
            input.current?.focus();
          }}
        />
      </div>
    ),
    [view, onTabChange, input],
  );
  const switchView = (delta: 1 | -1) => {
    focusTab.current = false;
    const index = SEARCH_VIEWS.findIndex(({ value }) => value === view);
    onTabChange(
      SEARCH_VIEWS[(index + delta + SEARCH_VIEWS.length) % SEARCH_VIEWS.length]
        ?.value ?? "all",
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs after each switch's remount.
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    document
      .querySelector<HTMLElement>(
        '[data-search-palette] [role="tab"][aria-selected="true"]',
      )
      ?.focus();
  }, [view]);
  // Saved conversations stay searchable while the community connects or is
  // unreachable; message, people and open-channel search wait for the relay.
  const saved = !!connection.cached && !scopedChannelId;
  const connecting = connection.status === "connecting";
  const notice =
    !enabled || !client.selected || connection.status === "ready"
      ? undefined
      : saved
        ? `Only saved conversations are searched ${connecting ? "until this community connects" : "while this community is disconnected"}.`
        : !connecting
          ? "Message search is unavailable while this community is disconnected."
          : query.trim() && !scopedChannelId
            ? "Connecting to this community…"
            : undefined;
  const offline = notice && (
    <div className="px-3 text-body-sm text-subtle" aria-live="polite">
      <p>{notice}</p>
      {!connecting && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            // Retrying removes this focused button; the field owns keyboard
            // navigation, so focus returns there before the retry starts.
            input.current?.focus();
            services.communities.relay.retry();
          }}
        >
          Retry connection
        </Button>
      )}
    </div>
  );
  if (
    !enabled ||
    !client.selected ||
    !client.viewer ||
    (connection.status !== "ready" && !saved)
  ) {
    return (
      <SearchChoices
        inlineSettings={inlineSettings}
        query={query}
        onQueryChange={onQueryChange}
        input={input}
        label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
        scope={
          scopedChannelId
            ? { label: "This conversation", onRemove: () => onScopeChange() }
            : undefined
        }
        groups={
          scopedChannelId
            ? [
                {
                  label: "Most relevant",
                  destinations: [],
                  empty: "Connect to this community to search messages.",
                },
              ]
            : query.trim()
              ? [
                  {
                    label: "Pages",
                    destinations: pages,
                    empty: "No matching pages.",
                  },
                ]
              : [
                  {
                    label: "Recent activity",
                    destinations: [],
                    empty: !enabled
                      ? "Enable Messages to see conversations."
                      : !client.selected
                        ? "Choose a community to see recent conversations."
                        : "Connecting to this community…",
                  },
                ]
        }
        footer={offline}
      />
    );
  }
  const scope = {
    viewer: client.viewer,
    communityOrigin: communityDestination(client.selected).url,
  };
  const current = () => {
    const now = services.communities.snapshot();
    return (
      isOpen() &&
      now.viewer === scope.viewer &&
      now.selected === client.selected &&
      services.communities.relay.snapshot().session === connection.session
    );
  };
  const openConversation = (
    channelId: string,
    messageId?: string,
    threadRootId?: string,
  ) => {
    if (!current() || !connection.session.channels.get?.(channelId)) return;
    close(messageId ? undefined : channelId);
    void services.navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(messageId ? { messageId } : {}),
      ...(threadRootId ? { threadRootId } : {}),
    });
  };
  const views =
    !scopedChannelId && !saved && connection.session.channels.readDirectory
      ? {
          resultsLabel: view === "channels" ? "Channels" : "Search results",
          panelId: `search-view-${view}`,
          onSwitch: switchView,
          place,
          tabs,
        }
      : undefined;
  if (views && view === "channels")
    return (
      <ChannelDirectoryResults
        key={`${client.selected}:${connection.scope}:${connection.generation}`}
        session={connection.session}
        query={query}
        onQueryChange={onQueryChange}
        input={input}
        open={open}
        views={views}
        openConversation={openConversation}
        openPreview={(channelId) => {
          // Not a joined channel yet: its preview resolves it.
          if (!current()) return;
          close();
          void services.navigation.open({
            version: 1,
            kind: "conversation",
            scope,
            channelId,
          });
        }}
      />
    );
  return (
    <>
      {views && <PreloadDirectory channels={connection.session.channels} />}
      <SearchResults
        inlineSettings={inlineSettings}
        key={`${client.selected}:${connection.scope}:${connection.generation}`}
        session={connection.session}
        query={query}
        onQueryChange={onQueryChange}
        input={input}
        open={open}
        pages={pages}
        scopedChannelId={scopedChannelId}
        currentChannelId={currentChannelId}
        onScopeChange={onScopeChange}
        usageScope={usageScope(scope)}
        sidebarScope={connection.scope}
        views={views}
        offline={saved ? offline : undefined}
        openConversation={openConversation}
        openAgentSession={(pubkey) => {
          const current = services.communities.snapshot();
          const relay = services.communities.relay.snapshot();
          if (
            !isOpen() ||
            current.viewer !== scope.viewer ||
            current.selected !== client.selected ||
            relay.session !== connection.session ||
            !relay.scope
          )
            return;
          close();
          void services.navigation.open(
            soloDraftTarget(relay.scope, { agent: pubkey }),
          );
        }}
      />
    </>
  );
}

/** Starts the open-channel directory read as search opens, so the Channels
 * tab usually has it by the time it's chosen. The store shares one read, and
 * leaving search lets it finish for next time. */
function PreloadDirectory({ channels }: { channels: ChannelQueries }) {
  const ready = useChannelList(channels).status === "ready";
  useEffect(() => {
    if (ready) channels.readDirectory?.().catch(() => {});
  }, [ready, channels]);
  return null;
}
