import { useSoloRowActivation } from "./useSoloRowActivation";
import { useSpringLoaded } from "../messages/spring-loaded-drag";
import { SoloChatTitle } from "../solo/SoloChatTitle";
import {
  type ReactNode,
  type RefObject,
  type FocusEvent,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SoloChatMenuItems } from "../../bundled/channels/SoloChatMenu";
import { SoloChatName } from "../../bundled/channels/SoloChatName";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import { ChannelMembersDialog } from "../../bundled/channels/ChannelMembersDialog";
import { WorkspaceSettings } from "../solo/WorkspaceSettings";
import { useChannelNavigation } from "./ChannelNavigationState";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import type { Navigation } from "../navigation/controller";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { conversationTarget, matchesConversation } from "./routes";
import {
  captureSidebarDeparture,
  recoverSidebarFocus,
} from "./sidebar-focus-recovery";
import { soloSuccessor } from "./solo-successor";
import type {
  SoloCardProps,
  SoloConversationLinkProps,
  SoloConversationProps,
} from "./solo-navigation-contract";
import rowStyles from "../../bundled/channels/SoloWorkspaces.module.css";
import styles from "./SoloDestination.module.css";

export const RegionDestinationContext = createContext<
  | {
      channels: readonly ChannelSummary[];
      live: ReadonlySet<string>;
      session: RelaySession;
      navigator: Navigation;
      pendingClick: RefObject<ReturnType<typeof setTimeout> | undefined>;
      scope: string;
      current: string | undefined;
      active(): boolean;
      retryReveal(): void;
    }
  | undefined
>(undefined);

type ConversationState = Readonly<{
  channel: ChannelSummary;
  selected: boolean;
  menu: ReactNode;
  open(): void;
  canRename: boolean;
  rename(): boolean;
  finalFocus(): HTMLElement | false;
  closeMenu(popup: HTMLElement | null): void;
  openMenu(): void;
}>;
const ConversationContext = createContext<ConversationState | undefined>(
  undefined,
);

/** Stable component identity: a source update never remounts every destination. */
export function RegionConversation(props: SoloConversationProps) {
  const context = useContext(RegionDestinationContext);
  const handoff = useChannelNavigation();
  const root = useRef<HTMLDivElement>(null);
  const restoreRename = useRef(false);
  const afterClose = useRef<() => void>(undefined);
  const chosen = useRef(false);
  const chosenItem = useRef<HTMLElement>(null);
  const openMenu = useCallback(() => {
    afterClose.current = undefined;
    chosen.current = false;
    chosenItem.current = null;
  }, []);
  useLayoutEffect(() => openMenu, [openMenu]);
  const channel = context?.channels.find(
    (channel) => channel.id === props.channelId,
  );
  const visible = !!channel && !!context?.live.has(channel.id);
  const [dialog, setDialog] = useState<"rename" | "settings" | "share">();
  const [error, setError] = useState<string>();
  const focusProps = useDestinationFocus(root, props.channelId, visible);
  const focusTarget = () =>
    root.current?.querySelector<HTMLElement>("[data-solo-destination-id]") ??
    false;
  useLayoutEffect(() => {
    if (context?.current === props.channelId) context.retryReveal();
    if (restoreRename.current) {
      restoreRename.current = false;
      (focusTarget() || undefined)?.focus();
    }
  });
  if (!context || !channel || !visible) return null;
  const { session, navigator, scope, current, active } = context;
  const menu = (
    <>
      <SoloChatMenuItems
        session={session}
        channel={channel}
        onShare={() => active() && setDialog("share")}
        onSettings={() => active() && setDialog("settings")}
        onReadResult={setError}
        onLifecycle={
          handoff
            ? (action) => {
                if (!active()) return;
                const visit = navigator.snapshot();
                const leavesOpenChat =
                  action !== "unarchive" &&
                  visit.entry.target.kind === "conversation" &&
                  visit.entry.target.channelId === channel.id;
                const neighbors =
                  handoff.soloNeighbors.current?.(channel.id) ?? [];
                const trigger = focusTarget() || undefined;
                handoff.openLifecycle(channel, action, trigger, undefined, {
                  close() {
                    if (trigger?.isConnected)
                      trigger.focus({ preventScroll: true });
                  },
                  depart(check) {
                    // The row can unmount before completion, or the user can
                    // reopen its chat while the session-owned deletion runs.
                    const active =
                      check === "current"
                        ? matchesConversation(
                            navigator.snapshot().entry.target,
                            scope,
                            channel.id,
                          )
                        : leavesOpenChat && !visit.attempt.signal.aborted;
                    if (active)
                      void navigator.open(
                        soloSuccessor(
                          scope,
                          session.channels.list().channels,
                          neighbors,
                          channel.id,
                        ),
                      );
                  },
                });
              }
            : undefined
        }
      />
      {!!props.menuActions?.length && (
        <>
          <MenuSeparator />
          <MenuGroup>
            {props.menuActions.map((action) => (
              <MenuItem
                key={action.id}
                onClick={(event) => {
                  chosen.current = true;
                  chosenItem.current = event.currentTarget;
                  afterClose.current = () => {
                    if (!active()) return;
                    try {
                      void Promise.resolve(action.onSelect()).catch(() => {
                        if (active()) setError("The action could not run.");
                      });
                    } catch {
                      setError("The action could not run.");
                    }
                  };
                }}
              >
                <MenuIcon>{action.icon}</MenuIcon>
                {action.label}
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      )}
    </>
  );
  const state: ConversationState = {
    channel,
    selected: props.selected ?? current === channel.id,
    menu,
    open() {
      if (!active()) return;
      if (props.onOpen) props.onOpen();
      else void navigator.open(conversationTarget(scope, channel.id));
    },
    canRename:
      session.channelDetails.available && !channel.readOnly && !channel.cached,
    rename() {
      if (
        !active() ||
        !session.channelDetails.available ||
        channel.readOnly ||
        channel.cached
      )
        return false;
      setDialog("rename");
      return true;
    },
    finalFocus: () => (chosen.current ? false : focusTarget()),
    openMenu,
    closeMenu(popup) {
      if (!popup?.contains(chosenItem.current)) return;
      const action = afterClose.current;
      afterClose.current = undefined;
      if (!action || !root.current?.isConnected || !active()) return;
      const current = document.activeElement;
      if (
        current !== document.body &&
        current !== focusTarget() &&
        !popup?.contains(current)
      )
        return;
      (focusTarget() || undefined)?.focus({ preventScroll: true });
      action();
    },
  };
  return (
    <div
      data-solo-destination-root={channel.id}
      {...focusProps}
      className={`${styles.destination} ${rowStyles.sidebarContents}`}
    >
      {dialog === "rename" ? (
        <SoloChatName
          session={session}
          id={channel.id}
          title={channel.name}
          close={(restore) => {
            restoreRename.current = restore;
            setDialog(undefined);
          }}
        />
      ) : (
        <ConversationContext.Provider value={state}>
          {props.children({
            name: channel.name,
            ...(channel.preview ? { preview: channel.preview } : {}),
            selected: state.selected,
            ...conversationParts,
          })}
        </ConversationContext.Provider>
      )}
      {dialog === "settings" && (
        <WorkspaceSettings
          session={session}
          scope={scope}
          target={{ kind: "chat", id: channel.id, name: channel.name }}
          close={() => setDialog(undefined)}
        />
      )}
      {dialog === "share" && (
        <ChannelMembersDialog
          session={session}
          channelId={channel.id}
          trigger={root}
          navigator={navigator}
          close={() => setDialog(undefined)}
        />
      )}
      {error && (
        <ToastNotice title={error} onDismiss={() => setError(undefined)} />
      )}
    </div>
  );
}

function ConversationLink(props: SoloConversationLinkProps) {
  const state = useContext(ConversationContext);
  const context = useContext(RegionDestinationContext);
  const primary = !props.secondary;
  const activation = useSoloRowActivation(
    context?.navigator,
    context?.pendingClick,
    () => state?.open(),
    primary && props.rename !== false && state?.canRename
      ? state.rename
      : undefined,
  );
  const springLoaded = useSpringLoaded(() => state?.open(), state?.selected);
  if (!state) return null;
  return (
    <NavigationItem
      {...(primary ? { "data-solo-destination-id": state.channel.id } : {})}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
      label={
        !props.multiline && props.label === state.channel.name ? (
          <SoloChatTitle
            key={state.channel.id}
            channelId={state.channel.id}
            title={state.channel.name}
            details={context?.session.channelDetails}
          />
        ) : (
          props.label
        )
      }
      icon={props.icon}
      trailing={props.trailing}
      multiline={!!props.multiline}
      selected={primary && state.selected}
      {...activation}
      {...springLoaded}
    />
  );
}

function ConversationMenu({ children }: { children: ReactNode }) {
  const state = useContext(ConversationContext);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const popup = useRef<HTMLDivElement>(null);
  if (!state) return null;
  if (state.channel.cached)
    return <div className={styles.menu}>{children}</div>;
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        if (next) state.openMenu();
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) state.closeMenu(popup.current);
      }}
    >
      <ContextMenuTrigger
        render={<div className={styles.menu} />}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            event.stopPropagation();
            state.openMenu();
            setAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      >
        {children}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${state.channel.name}`}
        anchor={anchor}
        ref={(element) => {
          if (element) popup.current = element;
        }}
        finalFocus={state.finalFocus}
      >
        {state.menu}
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function ConversationActions() {
  const state = useContext(ConversationContext);
  const popup = useRef<HTMLDivElement>(null);
  if (!state || state.channel.cached) return null;
  return (
    <MenuRoot
      onOpenChange={(next) => {
        if (next) state.openMenu();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) state.closeMenu(popup.current);
      }}
    >
      <MenuTrigger
        render={(props) => (
          <IconButton
            {...props}
            data-solo-row-action=""
            variant="bare"
            size="compact"
            aria-label={`Actions for ${state.channel.name}`}
            icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
          />
        )}
      />
      <MenuPopup
        aria-label={`Actions for ${state.channel.name}`}
        align="end"
        ref={(element) => {
          if (element) popup.current = element;
        }}
        finalFocus={state.finalFocus}
      >
        {state.menu}
      </MenuPopup>
    </MenuRoot>
  );
}

function ConversationReveal({
  on,
  children,
}: {
  on: "rest" | "active";
  children: ReactNode;
}) {
  return (
    <span className={on === "rest" ? styles.rest : styles.active}>
      {children}
    </span>
  );
}

function ConversationUnread() {
  const context = useContext(RegionDestinationContext);
  const state = useContext(ConversationContext);
  if (!context || !state) return null;
  return (
    <UnreadBadge
      session={context.session}
      channelId={state.channel.id}
      preserveUnread
    />
  );
}

/** The shared card; drag-target paint stays a host-owned state. */
export function RegionCard({ dropTarget, ...props }: SoloCardProps) {
  return (
    <NavigationCard {...props} data-drop-target={dropTarget || undefined} />
  );
}

const conversationParts = {
  Link: ConversationLink,
  Menu: ConversationMenu,
  Actions: ConversationActions,
  Reveal: ConversationReveal,
  Unread: ConversationUnread,
};

/** Recovery rows use the same focus contract without source actions. */
export function RecoveryDestination({ channelId }: { channelId: string }) {
  const context = useContext(RegionDestinationContext);
  const root = useRef<HTMLDivElement>(null);
  const focusProps = useDestinationFocus(root, channelId, true);
  useLayoutEffect(() => {
    if (context?.current === channelId) context.retryReveal();
  });
  const channel = context?.channels.find((channel) => channel.id === channelId);
  const open = () => {
    if (context)
      void context.navigator.open(conversationTarget(context.scope, channelId));
  };
  const springLoaded = useSpringLoaded(open, context?.current === channelId);
  if (!context || !channel) return null;
  return (
    <div data-solo-destination-root={channelId} {...focusProps}>
      <NavigationItem
        data-solo-destination-id={channelId}
        label={channel.name}
        selected={context.current === channelId}
        trailing={
          <UnreadBadge
            session={context.session}
            channelId={channelId}
            preserveUnread
          />
        }
        onClick={open}
        {...springLoaded}
      />
    </div>
  );
}

function useDestinationFocus(
  root: RefObject<HTMLDivElement | null>,
  channelId: string,
  visible: boolean,
) {
  const focused = useRef(false);
  const neighbors = useRef<string[]>([]);
  const departure =
    useRef<ReturnType<typeof captureSidebarDeparture>>(undefined);
  const rememberNeighbors = useCallback(() => {
    const region = root.current?.closest("[data-sidebar-section]");
    if (region)
      neighbors.current = [
        ...region.querySelectorAll<HTMLElement>("[data-solo-destination-id]"),
      ].map((row) => row.dataset.soloDestinationId ?? "");
  }, [root]);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      // The source can reorder siblings without rendering this destination.
      if (!node && focused.current && root.current) {
        rememberNeighbors();
        // A roster change can detach the row before its effect cleans up.
        const active = root.current.ownerDocument.activeElement;
        departure.current = captureSidebarDeparture(
          active instanceof HTMLElement && root.current.contains(active)
            ? active
            : root.current,
        );
      } else if (node) {
        departure.current = undefined;
      }
      root.current = node;
    },
    [rememberNeighbors, root],
  );
  useLayoutEffect(() => {
    if (!visible) return;
    const node = root.current;
    const region = node?.closest("[data-sidebar-section]");
    return () => {
      const active = document.activeElement;
      const owner = active?.closest("[data-solo-destination-root]");
      if (!node || (owner ? owner !== node : !focused.current)) return;
      const departing =
        owner === node && active instanceof HTMLElement ? active : node;
      const position = departure.current ?? captureSidebarDeparture(departing);
      const candidates = () => {
        if (document.activeElement !== document.body) return;
        // The ref can capture the final order after this effect cleans up.
        const rows = neighbors.current;
        const index = rows.indexOf(channelId);
        const ids = [
          channelId,
          ...rows.slice(index + 1),
          ...rows.slice(0, index).reverse(),
        ];
        const section = document.querySelector(
          `[data-sidebar-section="${CSS.escape(region?.getAttribute("data-sidebar-section") ?? "")}"]`,
        );
        return [
          ...ids.map((id) =>
            id
              ? document.querySelector<HTMLElement>(
                  `[data-solo-destination-id="${CSS.escape(id)}"]`,
                )
              : null,
          ),
          ...(section?.querySelectorAll<HTMLElement>(
            "[data-solo-destination-id]",
          ) ?? []),
          section?.querySelector<HTMLElement>("summary"),
          document.querySelector<HTMLElement>("[data-solo-heading]"),
          ...document.querySelectorAll<HTMLElement>(
            '[data-sidebar-section^="solo-region:"] summary',
          ),
        ];
      };
      recoverSidebarFocus(position, candidates, { preferVisibleRows: true });
    };
  }, [root, channelId, visible]);
  return {
    ref: attach,
    onFocusCapture() {
      focused.current = true;
      rememberNeighbors();
    },
    onBlurCapture(event: FocusEvent<HTMLDivElement>) {
      if (
        event.currentTarget.isConnected &&
        !event.currentTarget.contains(event.relatedTarget as Node)
      )
        focused.current = false;
    },
  };
}
