import { SoloDisclosure } from "./SoloDisclosure";
import {
  RegionDestinationContext,
  RegionCard,
  RegionConversation,
  RecoveryDestination,
} from "./SoloDestination";
import {
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { NavigationSectionHeading } from "../../shared/design-system/ui/NavigationSection";
import { SidebarSection } from "../../bundled/channels/SidebarSection";
import styles from "../../bundled/channels/Channels.module.css";
import { orderContributedSidebarSections } from "../../bundled/channels/sidebar-sections";
import type { useSidebarView } from "../../bundled/channels/useSidebarView";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  SlidersHorizontalIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
} from "../../shared/design-system/ui/Menu";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { relayPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import { useSoloNavigation } from "./solo-navigation-react";
import {
  soloNavigationFor,
  type SoloNavigationService,
} from "./solo-navigation";
import type { SoloRegion } from "./solo-navigation-model";
import type {
  SoloRegionAction,
  SoloRegionProps,
} from "./solo-navigation-contract";

export function SoloRegions({
  session,
  navigator,
  target,
  sidebar,
  scope,
  ordinary,
  fallback,
  groupDisclosure,
  hidePrimaryHeading = false,
  pendingClick: sharedPendingClick,
}: {
  session: RelaySession;
  navigator: Navigation;
  target: OpenTarget;
  scope: string;
  sidebar: ReturnType<typeof useSidebarView>;
  ordinary?: ReactNode;
  fallback?: ReactNode;
  hidePrimaryHeading?: boolean;
  groupDisclosure?:
    | {
        sectionKey: string;
        title: string;
        open: boolean;
        onToggle(open: boolean): void;
      }
    | undefined;
  pendingClick?: RefObject<ReturnType<typeof setTimeout> | undefined>;
}) {
  const localPendingClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pendingClick = sharedPendingClick ?? localPendingClick;
  const snapshot = useSoloNavigation(session);
  const service = soloNavigationFor(session);
  const regions = orderContributedSidebarSections(
    snapshot.regions.map((region) => ({
      key: `solo-region:${region.key}`,
      region,
    })),
    sidebar.contributionOrder,
  ).map(({ region }) => region);
  const primary = regions.findIndex((region) => region.source);
  const current = target.kind === "conversation" ? target.channelId : undefined;
  const currentChannel = current
    ? session.channels.list().channels.find((channel) => channel.id === current)
    : undefined;
  const fallbackOwnsCurrent =
    primary < 0 &&
    currentChannel?.channelType === "solo" &&
    !snapshot.excluded.has(currentChannel.id);
  const fallbackSectionKey = groupDisclosure?.sectionKey;
  const fallbackOpen = groupDisclosure?.open;
  useLayoutEffect(
    () =>
      sidebar.beforeReveal((location) => {
        if (
          !fallbackSectionKey ||
          fallbackOpen ||
          !fallbackOwnsCurrent ||
          !current ||
          location !== `conversation:${current}`
        )
          return true;
        sidebar.toggle(fallbackSectionKey, true);
        return false;
      }),
    [
      current,
      fallbackOpen,
      fallbackOwnsCurrent,
      fallbackSectionKey,
      sidebar.beforeReveal,
      sidebar.toggle,
    ],
  );
  const fallbackContents = groupDisclosure ? (
    <SidebarSection
      sectionKey={groupDisclosure.sectionKey}
      title={groupDisclosure.title}
      open={groupDisclosure.open}
      onToggle={groupDisclosure.onToggle}
      hideMoreActions
      persistentChevron
    >
      {ordinary}
    </SidebarSection>
  ) : hidePrimaryHeading ? (
    // Like Team, the Solo tab names its list, so the rows sit directly in it.
    (ordinary ?? null)
  ) : (
    (fallback ?? null)
  );
  if (!service) return fallbackContents;
  return (
    <>
      {regions.map((region, index) => (
        <div
          key={`${region.key}:${snapshot.binding?.incarnation ?? "recovery"}`}
          hidden={
            !!groupDisclosure && !groupDisclosure.open && index !== primary
          }
        >
          <RegionFrame
            region={region}
            service={service}
            session={session}
            scope={scope}
            navigator={navigator}
            pendingClick={pendingClick}
            target={target}
            sidebar={sidebar}
            move={(offset) => {
              const ids = regions.map((item) => `solo-region:${item.key}`);
              ids.splice(index, 1);
              ids.splice(index + offset, 0, `solo-region:${region.key}`);
              sidebar.setContributionOrder([
                ...sidebar.contributionOrder.filter(
                  (key) => !ids.includes(key),
                ),
                ...ids,
              ]);
            }}
            first={index === 0}
            last={index === regions.length - 1}
            ordinary={index === primary ? ordinary : undefined}
            groupDisclosure={index === primary ? groupDisclosure : undefined}
            groupSectionKey={groupDisclosure?.sectionKey}
            hideHeading={hidePrimaryHeading && index === primary}
          />
        </div>
      ))}
      {primary < 0 ? fallbackContents : null}
    </>
  );
}

function RegionFrame({
  scope,
  region,
  service,
  session,
  navigator,
  target,
  sidebar,
  move,
  first,
  last,
  ordinary,
  groupDisclosure,
  groupSectionKey,
  hideHeading,
  pendingClick,
}: {
  scope: string;
  region: SoloRegion;
  service: SoloNavigationService;
  session: RelaySession;
  navigator: Navigation;
  pendingClick: RefObject<ReturnType<typeof setTimeout> | undefined>;
  target: OpenTarget;
  sidebar: ReturnType<typeof useSidebarView>;
  move(offset: number): void;
  first: boolean;
  last: boolean;
  ordinary?: ReactNode;
  groupDisclosure?:
    | {
        sectionKey: string;
        title: string;
        open: boolean;
        onToggle(open: boolean): void;
      }
    | undefined;
  groupSectionKey?: string | undefined;
  hideHeading?: boolean;
}) {
  const binding = service.snapshot().binding;
  const source = region.source;
  const [actionError, setActionError] = useState(false);
  const [revealRequest, setRevealRequest] = useState<{
    id: string;
    explicit: boolean;
  }>();
  const root = useRef<HTMLDivElement>(null);
  const current =
    target.kind === "conversation" &&
    relayPartition(target.scope.communityOrigin, target.scope.viewer) === scope
      ? target.channelId
      : undefined;
  const sectionKey = `solo-region:${region.key}`;
  useLayoutEffect(() => {
    const node = root.current;
    return () => {
      if (!node?.contains(document.activeElement)) return;
      // Destinations restore their own same-row/neighbor focus before a heading fallback.
      if (document.activeElement?.closest("[data-solo-destination-root]"))
        return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        const candidates = [
          document.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(sectionKey)}"] summary`,
          ),
          document.querySelector<HTMLElement>("[data-solo-heading]"),
          ...document.querySelectorAll<HTMLElement>(
            '[data-sidebar-section^="solo-region:"] summary',
          ),
        ];
        for (const candidate of candidates) {
          if (!candidate || candidate.closest("[hidden], [inert]")) continue;
          candidate.focus();
          if (document.activeElement === candidate) break;
        }
      });
    };
  }, [sectionKey]);
  const presentation = useMemo(
    () =>
      source && binding ? service.presentation(source, binding) : undefined,
    [service, source, binding],
  );
  const active = () =>
    !!binding &&
    service.snapshot().binding === binding &&
    !!source &&
    service.sources().includes(source);
  const { toggle, retryReveal, revealAgain } = sidebar;
  const ownsCurrent =
    !!current && region.channels.some((channel) => channel.id === current);
  useLayoutEffect(() => {
    let prepared = false;
    return sidebar.beforeReveal((location) => {
      if (
        prepared ||
        !current ||
        !ownsCurrent ||
        location !== `conversation:${current}`
      )
        return true;
      prepared = true;
      if (groupSectionKey) toggle(groupSectionKey, true);
      toggle(sectionKey, true);
      service.reveal(current, false);
      return false; // Retry against the expanded source path after its commit.
    });
  }, [
    sidebar.beforeReveal,
    current,
    ownsCurrent,
    sectionKey,
    toggle,
    service,
    groupSectionKey,
  ]);
  useLayoutEffect(() => {
    if (sidebar.collapsed.includes(sectionKey)) return;
    if (revealRequest?.explicit && revealRequest.id === current) revealAgain();
    else retryReveal();
    if (revealRequest) setRevealRequest(undefined);
  });
  const reveal = useEffectEvent((id: string, explicit: boolean) => {
    if (!region.channels.some((channel) => channel.id === id)) return false;
    if (groupSectionKey) toggle(groupSectionKey, true);
    toggle(sectionKey, true);
    setRevealRequest({ id, explicit });
    return true;
  });
  useLayoutEffect(() => service.subscribeReveal(reveal, true), [service]);
  let actions: readonly SoloRegionAction[] = [];
  try {
    if (binding && source?.actions)
      actions = source
        .actions(binding)
        .slice(0, 3)
        .filter(
          (action) =>
            action &&
            typeof action.label === "string" &&
            typeof action.onSelect === "function",
        );
  } catch {
    /* Actions do not fail the region body. */
  }
  const run = async (action: Pick<SoloRegionAction, "onSelect">) => {
    if (!active()) return;
    setActionError(false);
    try {
      await action.onSelect();
    } catch {
      if (active()) setActionError(true);
    }
  };
  const recovery = (
    <>
      <p role={region.reason === "failed" ? "alert" : "status"}>
        {region.reason === "not-installed"
          ? "The plugin for these chats is not installed."
          : region.reason === "off"
            ? "The plugin for these chats is off."
            : region.reason === "loading"
              ? `Loading ${region.title}…`
              : `${region.title} could not load`}
      </p>
      {source ? (
        <Button
          size="sm"
          onClick={() => {
            service.retry(region.key);
          }}
        >
          Retry
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() =>
            void navigator.open({
              version: 1,
              kind: "settings",
              section: "plugins",
            })
          }
        >
          Open plugin settings
        </Button>
      )}
      {region.channels.map((channel) => (
        <RecoveryDestination key={channel.id} channelId={channel.id} />
      ))}
    </>
  );
  // The region's own create action trails its other actions.
  const create = actions.find((action) => action.icon === "plus");
  const headerActions = (
    <>
      {actions
        .filter((action) => action.icon !== "plus")
        .map((action) => (
          <RegionAction key={action.id} action={action} run={run} />
        ))}
      {create && <RegionAction action={create} run={run} />}
    </>
  );
  const headerNotice = actionError && (
    <p className={styles.contributionFeedback} role="alert">
      The action could not run.
    </p>
  );
  const body = (
    <>
      {source &&
      binding &&
      presentation &&
      region.snapshot?.status === "ready" &&
      !region.reason ? (
        <OwnedContribution
          entry={source}
          registry={{ snapshot: service.sources }}
          fallback={recovery}
        >
          {(entry) => (
            <entry.component
              binding={binding}
              snapshot={region.snapshot as SoloRegionProps["snapshot"]}
              live={region.live}
              {...(current ? { current } : {})}
              {...presentation}
              ui={destinationUi}
            />
          )}
        </OwnedContribution>
      ) : (
        recovery
      )}
    </>
  );
  const hasActions = actions.length > 0;
  return (
    <RegionDestinationContext.Provider
      value={{
        region,
        session,
        navigator,
        pendingClick,
        scope,
        current,
        active,
        retryReveal,
      }}
    >
      <div ref={root}>
        {hideHeading ? (
          // The tab already names this region, so it has no title row. Its
          // actions, when it has any, take a headingless row in the flow.
          <>
            {hasActions && <NavigationSectionHeading actions={headerActions} />}
            {headerNotice}
            {body}
            {groupDisclosure ? ordinary : null}
          </>
        ) : (
          <SidebarSection
            sectionKey={sectionKey}
            title={groupDisclosure?.title ?? region.title}
            icon={source?.icon}
            open={
              groupDisclosure?.open ?? !sidebar.collapsed.includes(sectionKey)
            }
            onToggle={
              groupDisclosure?.onToggle ??
              ((open) => sidebar.toggle(sectionKey, open))
            }
            move={{
              ...(!first ? { up: () => move(-1) } : {}),
              ...(!last ? { down: () => move(1) } : {}),
            }}
            hideMoreActions={first && last}
            persistentChevron={!!groupDisclosure}
            headerActions={headerActions}
            headerNotice={headerNotice}
          >
            {body}
            {groupDisclosure ? ordinary : null}
          </SidebarSection>
        )}
        {groupDisclosure ? null : ordinary}
      </div>
    </RegionDestinationContext.Provider>
  );
}

function RegionAction({
  action,
  run,
}: {
  action: SoloRegionAction;
  run(action: Pick<SoloRegionAction, "onSelect">): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const afterClose = useRef<Pick<SoloRegionAction, "onSelect"> | undefined>(
    undefined,
  );
  const choose = (item: Pick<SoloRegionAction, "onSelect">) => {
    afterClose.current = item;
    setOpen(false);
  };
  let items: ReturnType<NonNullable<SoloRegionAction["menu"]>> | undefined;
  try {
    items = action
      .menu?.()
      .slice(0, 32)
      .filter(
        (item) =>
          item &&
          typeof item.label === "string" &&
          typeof item.onSelect === "function",
      );
  } catch {
    return null;
  }
  const icon =
    action.icon === "plus" ? (
      <PlusIcon size={15} strokeWidth={2.5} />
    ) : action.icon === "view" ? (
      <SlidersHorizontalIcon size={15} />
    ) : (
      action.icon
    );
  const trigger = (
    <IconButton
      ref={anchor}
      size="compact"
      icon={icon}
      aria-label={action.label}
      title={action.label}
    />
  );
  if (!items)
    return (
      <IconButton
        size="compact"
        icon={icon}
        aria-label={action.label}
        title={action.label}
        onClick={() => void run(action)}
      />
    );
  items ??= [{ id: action.id, label: action.label, onSelect: action.onSelect }];
  if (!items.length) return null;
  const groups = [...new Set(items.map((item) => item.group ?? ""))];
  return (
    <MenuRoot
      open={open}
      onOpenChange={(next) => {
        if (next) afterClose.current = undefined;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const item = afterClose.current;
        afterClose.current = undefined;
        if (!item) return;
        // Like tab-menu rename, wait for the menu's focus scope before opening a dialog.
        anchor.current?.focus({ preventScroll: true });
        void run(item);
      }}
    >
      <MenuTrigger render={trigger} />
      <MenuPopup align="end" size="compact" aria-label={action.label}>
        {groups.map((name) => {
          const group = items.filter((item) => (item.group ?? "") === name);
          return (
            <MenuGroup key={name}>
              {name && <MenuGroupLabel>{name}</MenuGroupLabel>}
              {group.some((item) => typeof item.checked === "boolean") && (
                <MenuRadioGroup
                  value={group.find((item) => item.checked)?.id ?? ""}
                >
                  {group
                    .filter((item) => typeof item.checked === "boolean")
                    .map((item) => (
                      <MenuRadioItem
                        key={item.id}
                        value={item.id}
                        onClick={() => choose(item)}
                      >
                        {item.label}
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
              )}
              {group
                .filter((item) => typeof item.checked !== "boolean")
                .map((item) => (
                  <MenuItem key={item.id} onClick={() => choose(item)}>
                    {item.label}
                  </MenuItem>
                ))}
            </MenuGroup>
          );
        })}
      </MenuPopup>
    </MenuRoot>
  );
}

const destinationUi = {
  Conversation: RegionConversation,
  Card: RegionCard,
  Disclosure: SoloDisclosure,
};
