import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  canManageMember,
  canRemoveMember,
  canTransferOwnership,
  editableMemberRoles,
  type MemberChange,
  transferRefusal,
} from "../../features/channel-members/administration-protocol";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  createMenuHandle,
  type MenuHandle,
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import styles from "./ChannelMembersDialog.module.css";

export function memberAccessLabel(role: MemberChange["expectedRole"]) {
  return {
    owner: "Owner",
    admin: "Admin",
    member: "Participating",
    bot: "Participating",
    guest: "Viewing only",
    unknown: "Unconfirmed access",
    none: "No access",
    absent: "No access",
  }[role];
}

export function useMemberAdministration(
  session: RelaySession,
  channelId: string,
  memberKey: string,
  readable: boolean,
) {
  const capability = session.memberAdministration;
  const state = useSyncExternalStore(
    capability.subscribe,
    () => capability.snapshot(channelId),
    () => capability.snapshot(channelId),
  );
  // Membership changes (including ordinary invitations) invalidate role presentation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: memberKey refreshes the current roster's roles.
  useEffect(() => {
    if (readable) void capability.refresh(channelId).catch(() => {});
  }, [capability, channelId, memberKey, readable]);
  // Session access invalidation can clear roles without changing this roster.
  // Recover only an idle, readable snapshot; failed reads still need explicit retry.
  const idle = state.status === "idle";
  useEffect(() => {
    if (readable && idle && capability.snapshot(channelId).status === "idle")
      void capability.refresh(channelId).catch(() => {});
  }, [capability, channelId, idle, readable]);
  return state;
}

// A Base UI menu root on every member row made list renders and typing
// measurably slower, so a list hosts one context menu and one Actions menu
// for its rows. Each row registers what its menu needs by row ID, unique
// within the list; a menu opens for the row under the press or key, or the
// row whose Actions button opened it.
type RowMenu = {
  label: string;
  items: ReactNode;
  /** Where focus goes when the menu closes, given the control it opened from. */
  finalFocus(returnTo: HTMLElement | null): HTMLElement | false | null;
  /** The row's menu opened, and how, or closed. */
  shown(menu: "button" | "context" | undefined): void;
};
type MenuTarget = {
  id: string;
  anchor?: HTMLElement;
  returnTo: HTMLElement | null;
  trigger?: string;
};
type RowMenus = {
  rows: Map<string, RowMenu>;
  changed: (id: string) => void;
  close: () => void;
  buttons: MenuHandle;
};
const RowMenus = createContext<RowMenus | undefined>(undefined);

/** The member list: its rows share one context menu and one Actions menu. */
export function MemberMenus({
  scrollport,
  children,
  ...props
}: Omit<ComponentProps<"section">, "ref"> & {
  scrollport: RefObject<HTMLElement | null>;
}) {
  const [target, setTarget] = useState<MenuTarget>();
  const [open, setOpen] = useState<"button" | "context">();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const shown = useRef(target?.id);
  const isOpen = useRef(open);
  useLayoutEffect(() => {
    shown.current = target?.id;
    isOpen.current = open;
  });
  // The row a context gesture pressed, until Base UI decides to open.
  const pressed = useRef<MenuTarget>(undefined);
  // The open menu follows its row's items and closes when the row goes.
  const [menus] = useState<RowMenus>(() => ({
    rows: new Map(),
    changed: (id) => {
      if (id === shown.current) refresh();
    },
    close: () => setOpen(undefined),
    buttons: createMenuHandle(),
  }));
  const { rows } = menus;
  const menu = target && rows.get(target.id);
  if (open && !menu) setOpen(undefined);
  useEffect(() => {
    if (!open || !target) return;
    // A row re-registering in the closing commit has already left `rows`.
    const row = rows.get(target.id);
    row?.shown(open);
    return () => row?.shown(undefined);
  }, [open, target, rows]);
  useEffect(() => {
    const viewport = scrollport.current;
    if (!open || !viewport) return;
    // Revealing the trigger can queue a scroll event before this listener mounts.
    // Only subsequent movement should dismiss the newly opened menu.
    const top = viewport.scrollTop;
    const left = viewport.scrollLeft;
    const dismiss = () => {
      if (viewport.scrollTop !== top || viewport.scrollLeft !== left)
        setOpen(undefined);
    };
    viewport.addEventListener("scroll", dismiss, { passive: true });
    return () => viewport.removeEventListener("scroll", dismiss);
  }, [open, scrollport]);
  const rowAt = (element: Element) => {
    const row = element.closest<HTMLElement>("[data-member-row]");
    const id = row?.dataset.memberRow;
    if (row && id && rows.has(id)) return { row, id };
  };
  const press = (element: Element) => {
    const at = rowAt(element);
    pressed.current = at && {
      id: at.id,
      returnTo: at.row.querySelector("button"),
    };
    return at;
  };
  // Either menu may close while the other opens: keep the newer target.
  const closed = (opened: boolean) => {
    if (!opened && !isOpen.current) setTarget(undefined);
  };
  const finalFocus = () =>
    target && menu ? menu.finalFocus(target.returnTo) : false;
  return (
    <RowMenus value={menus}>
      <ContextMenuRoot
        open={open === "context"}
        onOpenChange={(next) => {
          if (next && pressed.current) setTarget(pressed.current);
          setOpen((current) =>
            next ? "context" : current === "context" ? undefined : current,
          );
        }}
        onOpenChangeComplete={closed}
      >
        <ContextMenuTrigger
          render={<section ref={scrollport} {...props} />}
          onContextMenu={(event) => {
            if (press(event.target as Element)) return;
            event.preventBaseUIHandler();
            // Base UI's document listener would cancel the native menu.
            event.stopPropagation();
          }}
          onTouchStart={(event) => {
            if (!press(event.target as Element)) event.preventBaseUIHandler();
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              const at = rowAt(event.target as Element);
              if (!at) return;
              event.preventDefault();
              setTarget({
                id: at.id,
                anchor: at.row,
                returnTo: event.target as HTMLElement,
              });
              setOpen("context");
            }
          }}
        >
          {children}
          <MenuPopup
            aria-label={menu?.label}
            anchor={target?.anchor}
            align={target?.anchor ? "end" : "start"}
            finalFocus={finalFocus}
          >
            {menu?.items}
          </MenuPopup>
        </ContextMenuTrigger>
      </ContextMenuRoot>
      {/* A regular trigger needs its own root: registering it on the context
          root replaces Base UI's context-menu interaction owner. */}
      <MenuRoot
        handle={menus.buttons}
        open={open === "button"}
        triggerId={open === "button" ? target?.trigger : null}
        onOpenChange={(next, details) => {
          const trigger =
            details.trigger instanceof HTMLElement ? details.trigger : null;
          const at = trigger && rowAt(trigger);
          if (next && at) {
            setTarget({ id: at.id, returnTo: trigger, trigger: trigger.id });
            setOpen("button");
          } else if (!next)
            setOpen((current) => (current === "button" ? undefined : current));
        }}
        onOpenChangeComplete={closed}
      >
        <MenuPopup aria-label={menu?.label} align="end" finalFocus={finalFocus}>
          {menu?.items}
        </MenuPopup>
      </MenuRoot>
    </RowMenus>
  );
}

export function MemberRow({
  session,
  channelId,
  pubkey,
  name,
  agent,
  profiled,
  verifiedOwner,
  onChange,
  returnFocus,
  onViewProfile,
  onViewOwnerProfile,
  onSendMessage,
  messagePending,
  place,
  invitationAction,
  highlight,
  children,
}: {
  session: RelaySession;
  channelId: string;
  pubkey: string;
  name: string;
  agent: boolean;
  /** Only a loaded profile shows the heir isn't an agent. */
  profiled: boolean;
  verifiedOwner?: string | undefined;
  onChange(change: MemberChange): void;
  returnFocus: React.RefObject<HTMLElement | null>;
  onViewProfile?: (() => boolean) | undefined;
  onViewOwnerProfile?: (() => boolean) | undefined;
  onSendMessage?: (() => void) | undefined;
  messagePending?: boolean | undefined;
  /** Names the conversation in actions: Remove from chat or channel. */
  place: "chat" | "channel";
  invitationAction?: ReactNode;
  /** The search highlight, for rows a picker can choose with Enter. */
  highlight?:
    | {
        id: string;
        active: boolean;
        onPointerMove(event: React.PointerEvent): void;
      }
    | undefined;
  children: ReactNode;
}) {
  const capability = session.memberAdministration;
  const state = useSyncExternalStore(
    capability.subscribe,
    () => capability.snapshot(channelId),
    () => capability.snapshot(channelId),
  );
  const openingConfirmation = useRef(false);
  const [menuOpen, setMenuOpen] = useState<"button" | "context">();
  const rowId = useId();
  const transferReason = useId();
  const menus = useContext(RowMenus);
  if (!menus) throw new Error("MemberRow renders inside MemberMenus");
  const openingProfile = useRef(false);
  const role = state.authority.roles[pubkey] ?? "unknown";
  const permitted =
    !invitationAction && capability.available && state.status === "ready";
  const canEdit =
    permitted && canManageMember(state.authority, session.viewer ?? "", pubkey);
  const canTransfer =
    permitted &&
    canTransferOwnership(state.authority, session.viewer ?? "", pubkey, agent);
  const canRemove =
    permitted &&
    canRemoveMember(
      state.authority,
      session.viewer ?? "",
      pubkey,
      verifiedOwner,
    );
  const roleCaption =
    role === "unknown" || role === "member" || role === "bot"
      ? undefined
      : memberAccessLabel(role);
  const locked =
    state.operation?.status === "pending" ||
    state.operation?.status === "uncertain";
  const choose = (next: MemberChange["role"]) => {
    openingConfirmation.current = true;
    onChange({ pubkey, expectedRole: role, role: next });
  };
  const menuItems = (
    <>
      <MenuItem
        disabled={!onViewProfile}
        onClick={() => {
          // The destination panel takes focus; neither closing layer may
          // restore focus to a row in the dialog that is being unmounted.
          openingProfile.current = onViewProfile?.() ?? false;
        }}
      >
        View profile
      </MenuItem>
      {onViewOwnerProfile && (
        <MenuItem
          onClick={() => {
            openingProfile.current = onViewOwnerProfile();
          }}
        >
          View owner profile
        </MenuItem>
      )}
      {onSendMessage && (
        <MenuItem disabled={messagePending} onClick={onSendMessage}>
          Send message
        </MenuItem>
      )}
      {(canEdit || canTransfer || canRemove) && !locked && (
        <>
          <MenuSeparator />
          {canEdit && (
            <MenuRadioGroup
              value={role === "bot" ? "member" : role}
              onValueChange={(next) => {
                const target = editableMemberRoles.find(
                  (value) => value === next,
                );
                if (target && target !== role) {
                  // The shared popup outlives the choice; the confirmation takes over.
                  menus.close();
                  choose(target);
                }
              }}
            >
              {editableMemberRoles.map((next) => (
                <MenuRadioItem key={next} value={next}>
                  {memberAccessLabel(next)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
          {canEdit && <MenuSeparator />}
          {canTransfer && (
            <>
              <MenuItem
                disabled={!profiled}
                aria-describedby={profiled ? undefined : transferReason}
                onClick={() => choose("owner")}
              >
                Transfer ownership
              </MenuItem>
              {!profiled && (
                <MenuNote id={transferReason}>{transferRefusal}</MenuNote>
              )}
              {canRemove && <MenuSeparator />}
            </>
          )}
          {canRemove && (
            <MenuItem tone="danger" onClick={() => choose("remove")}>
              Remove from {place}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  const label = `Actions for ${name}`;
  const menu: RowMenu = {
    label,
    items: menuItems,
    finalFocus: (returnTo) =>
      openingConfirmation.current || openingProfile.current
        ? false
        : (returnTo ?? returnFocus.current),
    shown: (opened) => {
      if (opened) {
        openingProfile.current = false;
        openingConfirmation.current = false;
      }
      setMenuOpen(opened);
    },
  };
  // Every render registers its latest items, as the open menu follows them.
  useEffect(() => {
    menus.rows.set(rowId, menu);
    menus.changed(rowId);
    return () => {
      menus.rows.delete(rowId);
      menus.changed(rowId);
    };
  });
  const Row = invitationAction ? "div" : "li";
  return (
    <Row
      className={styles.member}
      id={highlight?.id}
      data-member-row={rowId}
      data-highlighted={highlight?.active || undefined}
      onPointerMove={highlight?.onPointerMove}
      data-menu-open={menuOpen || undefined}
    >
      <div className={styles.profile}>{children}</div>
      {invitationAction}
      {!invitationAction && (
        <span className={styles.memberActions}>
          {roleCaption && (
            <span className="self-center px-2 text-body-sm text-subtle">
              {roleCaption}
            </span>
          )}
          <MenuTrigger
            handle={menus.buttons}
            render={
              <IconButton
                variant="bare"
                size="sm"
                shape="row-end"
                aria-label={label}
                data-member={pubkey}
                icon={<DotsThreeIcon size={18} aria-hidden="true" />}
              />
            }
          />
        </span>
      )}
    </Row>
  );
}
