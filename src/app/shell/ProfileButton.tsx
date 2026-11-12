import { PluginUpdatesMenu } from "../PluginUpdates";
import { formatPublicKey } from "../../shared/identity/public-key";
import { usePresenceStatus } from "../../features/presence/react";
import { useRelayConnection } from "../../features/relay/react";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";
import { useUserStatus } from "../../features/user-status/useUserStatus";
import { useStatusEditor } from "../../features/user-status/useStatusEditor";
import { statusShortcut } from "../../features/user-status/status-shortcut";
import { StatusEmoji } from "../../features/user-status/StatusEmoji";
import { Button } from "../../shared/design-system/ui/Button";
import { StatusEditor } from "../../features/user-status/StatusEditor";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CircleNotchIcon,
  SmileyIcon,
  CheckIcon,
  GearIcon,
  UserIcon,
  PlugIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from "../../shared/design-system/icons/index";
import type {
  Appearance,
  ColorModePreference,
} from "../../shared/theme/service";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuItem,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
  MenuNote,
} from "../../shared/design-system/ui/Menu";
import type {
  AccountActionsService,
  RegisteredAccountAction,
} from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import styles from "./ProfileButton.module.css";

const noSubscription = () => () => {};
// The parent row retains the icon for the saved appearance preference.
const colorModes = {
  light: { label: "Light", Icon: SunIcon },
  dark: { label: "Dark", Icon: MoonIcon },
  system: { label: "System", Icon: MonitorIcon },
} as const satisfies Record<
  ColorModePreference,
  { label: string; Icon: typeof SunIcon }
>;

export function ProfileButton({
  communities,
  accountActions,
  appearance,
  settingsSelected,
  pluginRecommendations = 0,
  onSettings,
}: {
  communities: Communities;
  accountActions: AccountActionsService;
  appearance: Appearance;
  settingsSelected: boolean;
  pluginRecommendations?: number;
  /** Opens Settings, optionally at one of its own sections. */
  onSettings(section?: "profile" | "plugins"): void;
}) {
  const {
    profile: localProfile,
    viewer,
    selected,
  } = useSyncExternalStore(communities.subscribe, communities.snapshot);
  const presence = useSyncExternalStore(
    communities.presence.subscribe,
    communities.presence.snapshot,
  );
  const { preference, error: appearanceError } = useSyncExternalStore(
    appearance.subscribe,
    appearance.snapshot,
  );
  const colorMode = colorModes[preference];
  const ColorModeIcon = colorMode.Icon;
  const connection = useRelayConnection(communities.relay);
  const session = connection.session;
  const observed = usePresenceStatus(
    selected && connection.viewer === viewer ? session?.presence : undefined,
    viewer ?? undefined,
  );
  const label = {
    online: "Online",
    away: "Away",
    offline: "Offline",
    unknown: "Status unavailable",
  }[observed];
  const [statusChange, setStatusChange] = useState<{
    target: "online" | "away" | "offline";
    session: typeof session;
    viewer: typeof viewer;
    community: typeof selected;
    failed?: boolean;
  }>();
  const currentChange =
    statusChange?.session === session &&
    statusChange?.viewer === viewer &&
    statusChange?.community === selected
      ? statusChange
      : undefined;
  const pending =
    currentChange && !currentChange.failed && observed !== currentChange.target;
  useEffect(() => {
    if (!statusChange) return;
    if (!currentChange || observed === currentChange.target)
      setStatusChange(undefined);
  }, [statusChange, currentChange, observed]);
  useEffect(() => {
    if (!statusChange || statusChange.failed) return;
    // One deadline per click; intermediate observations must not extend it.
    // This is confirmation feedback, not a publication retry or optimistic evidence.
    const timer = setTimeout(() => {
      setStatusChange((current) =>
        current === statusChange ? { ...current, failed: true } : current,
      );
    }, 15000);
    return () => clearTimeout(timer);
  }, [statusChange]);
  // The selected session owns community identity; never copy it into local defaults.
  const profiles =
    selected && connection.viewer === viewer ? session?.profiles : undefined;
  const readProfile = useCallback(
    () => (viewer ? profiles?.snapshot().get(viewer) : undefined),
    [profiles, viewer],
  );
  const communityProfile = useSyncExternalStore(
    profiles?.subscribe ?? noSubscription,
    readProfile,
    readProfile,
  );
  // Only the refresh inputs: live heads change on every message and prefetch.
  const readRoster = () => session?.live.snapshot()?.roster;
  const readLiveStatus = () => session?.live.snapshot()?.status;
  const roster = useSyncExternalStore(
    session?.live.subscribe ?? noSubscription,
    readRoster,
    readRoster,
  );
  const liveStatus = useSyncExternalStore(
    session?.live.subscribe ?? noSubscription,
    readLiveStatus,
    readLiveStatus,
  );
  useEffect(() => {
    if (
      !profiles ||
      !viewer ||
      connection.status !== "ready" ||
      roster?.state !== "verified" ||
      (liveStatus !== "connected" && liveStatus !== "unavailable")
    )
      return;
    // Roster setup can cancel earlier reads, and disk hydration can hold an old
    // profile. Refresh once at this authority boundary through the same session.
    const controller = new AbortController();
    void session
      .read([{ kinds: [0], authors: [viewer], limit: 5 }], {
        priority: "background",
        fresh: true,
        signal: controller.signal,
      })
      .catch(() => {});
    return () => controller.abort();
  }, [profiles, viewer, connection.status, session, roster, liveStatus]);
  const profile = selected ? communityProfile : localProfile;
  const displayName = profile?.name.trim();
  const name =
    displayName ||
    (viewer ? formatPublicKey(viewer) : undefined) ||
    "Your profile";
  const source = avatarSource(profile?.picture);
  const picture = selected ? avatarMedia(source, session?.media) : source;
  const status = useUserStatus(session?.statuses, viewer ?? "");
  const statusEditor = useStatusEditor(session, viewer ?? undefined);
  // The Set status shortcut follows the menu item's availability.
  const statusAvailable =
    !!viewer && !!session?.statuses?.writable && !!connection.scope;
  const openStatus = useEffectEvent(() => statusEditor.open());
  useEffect(() => {
    if (!statusAvailable) return;
    const open = () => openStatus();
    statusShortcut.current = open;
    return () => {
      if (statusShortcut.current === open) statusShortcut.current = undefined;
    };
  }, [statusAvailable]);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const appearanceTrigger = useRef<HTMLDivElement>(null);
  const openingStatus = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Settings takes focus once the menu has closed.
  const handoff = useRef(false);
  const actions = useSyncExternalStore(
    accountActions.subscribe,
    accountActions.snapshot,
  );
  const [selectedAction, setSelectedAction] =
    useState<RegisteredAccountAction | null>(null);
  const ActionDialog = actions.find(
    (action) => action === selectedAction,
  )?.component;
  const renderAction = (action: RegisteredAccountAction) => (
    <MenuItem key={action.key} onClick={() => setSelectedAction(action)}>
      <MenuIcon>{action.icon ?? <PlugIcon size={17} />}</MenuIcon>
      {action.title}
    </MenuItem>
  );
  const accountLabel = useId();
  const statusUnavailable = useId();
  const avatar = (
    <Avatar
      src={picture}
      alt=""
      fallback={name}
      fallbackContent={displayName ? undefined : <UserIcon size={19} />}
      size="fill"
      statusBadge={viewer && observed !== "unknown" ? observed : undefined}
    />
  );
  return (
    <>
      <MenuRoot
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) {
            handoff.current = false;
            openingStatus.current = false;
          } else {
            openingStatus.current = false;
          }
        }}
        onOpenChangeComplete={(open) => {
          // Let the menu finish its keyboard handling before handing focus to
          // the page. Other dismissals retain the shared menu's focus behavior.
          if (!open && handoff.current) {
            const main = document.getElementById("main-content");
            // A user may already be editing Settings, or the profile panel may
            // have focused itself, while the menu animates out.
            if (
              !document.querySelector('[aria-modal="true"]') &&
              !main?.contains(document.activeElement)
            )
              main?.focus();
          }
        }}
      >
        <MenuTrigger
          render={
            <IconButton
              type="button"
              aria-label="Your profile"
              ref={profileTrigger}
              title={name}
              variant="avatar"
              shape="round"
              icon={
                <span
                  className={styles.triggerAvatar}
                  role="img"
                  aria-label={
                    viewer
                      ? observed === "unknown"
                        ? "Your status is unavailable"
                        : `Your status: ${label}`
                      : "Your avatar"
                  }
                >
                  {avatar}
                </span>
              }
            />
          }
        />
        <MenuPopup
          data-profile-menu=""
          side="right"
          collisionAvoidance={{ fallbackAxisSide: "start" }}
          align="end"
          sideOffset={8}
          aria-labelledby={accountLabel}
          finalFocus={() => !handoff.current && !openingStatus.current}
        >
          <span id={accountLabel} className="sr-only">
            {name}
          </span>
          <div className={styles.profileHeader}>
            <span className={styles.profileAvatar}>
              <MenuItem
                nativeButton
                onClick={() => {
                  handoff.current = true;
                  onSettings("profile");
                }}
                render={
                  <IconButton
                    type="button"
                    aria-label={`${name}, edit profile`}
                    variant="avatar"
                    shape="round"
                    icon={avatar}
                  />
                }
              />
            </span>
            <div className={styles.profileDetails}>
              <p className="m-0 truncate text-body">{name}</p>
              {viewer && (
                <MenuRoot modal={false}>
                  <span className={styles.availability} data-status={observed}>
                    <MenuTrigger
                      aria-label={`Availability: ${label}${pending ? `, updating to ${currentChange.target}` : ""}`}
                      render={
                        <Button variant="subtle" size="xs">
                          {pending && (
                            <CircleNotchIcon
                              size={12}
                              aria-hidden="true"
                              className="motion-safe:animate-spin"
                            />
                          )}
                          {label}
                          {pending && (
                            <span role="status" className="sr-only">
                              Updating to {currentChange?.target}…
                            </span>
                          )}
                        </Button>
                      }
                    />
                  </span>
                  <MenuPopup align="start" size="compact">
                    <MenuRadioGroup
                      value={observed === "unknown" ? "" : observed}
                      onValueChange={(value) => {
                        if (
                          value !== "online" &&
                          value !== "away" &&
                          value !== "offline"
                        )
                          return;
                        setStatusChange({
                          target: value,
                          session,
                          viewer,
                          community: selected,
                        });
                        communities.presence.setPreference(value);
                      }}
                      aria-label="Availability"
                    >
                      {(
                        [
                          ["online", "Online"],
                          ["away", "Away"],
                          ["offline", "Offline"],
                        ] as const
                      ).map(([value, name]) => (
                        <MenuRadioItem
                          key={value}
                          value={value}
                          closeOnClick={false}
                        >
                          {name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </MenuRoot>
              )}
            </div>
          </div>
          {currentChange?.failed && (
            <p
              role="alert"
              className="mx-3 my-2 max-w-56 text-body-sm text-danger"
            >
              Could not confirm your status. Try again.
            </p>
          )}
          {presence.error && (
            <p
              role="alert"
              className="mx-3 my-2 max-w-56 text-body-sm text-danger"
            >
              {presence.error}
            </p>
          )}
          {viewer && session?.statuses && (
            <div className={styles.statusAction}>
              <MenuItem
                aria-label={
                  status
                    ? `Set a status: ${[status.emoji, status.text].filter(Boolean).join(" ")}`
                    : "Set a status"
                }
                aria-describedby={
                  !session.statuses.writable ? statusUnavailable : undefined
                }
                closeOnClick={false}
                disabled={!session.statuses.writable}
                onClick={() => {
                  if (statusEditor.open()) {
                    openingStatus.current = true;
                    setMenuOpen(false);
                  }
                }}
              >
                {status ? (
                  <>
                    <StatusEmoji
                      session={session}
                      value={status.emoji}
                      url={status.emojiUrl}
                      hint
                    />
                    <span className="min-w-0 truncate text-body-sm">
                      {status.text}
                    </span>
                  </>
                ) : (
                  <>
                    <MenuIcon>
                      <SmileyIcon size={16} aria-hidden="true" />
                    </MenuIcon>
                    Set a status
                  </>
                )}
              </MenuItem>
            </div>
          )}
          {session?.statuses && !session.statuses.writable && (
            <p
              id={statusUnavailable}
              className="mx-3 my-2 max-w-56 text-body-sm text-muted"
            >
              Status updates are unavailable in this community.
            </p>
          )}
          <MenuSeparator />
          <MenuSubmenu>
            <MenuSubmenuTrigger ref={appearanceTrigger}>
              <MenuIcon>
                <ColorModeIcon size={16} aria-hidden="true" />
              </MenuIcon>
              Appearance
            </MenuSubmenuTrigger>
            <MenuSubmenuPopup
              aria-label="Appearance"
              finalFocus={appearanceTrigger}
            >
              <MenuRadioGroup
                value={preference}
                onValueChange={(value) => {
                  if (
                    value === "light" ||
                    value === "dark" ||
                    value === "system"
                  )
                    appearance.setMode(value);
                }}
              >
                {(["light", "dark", "system"] as const).map((value) => {
                  const { label, Icon } = colorModes[value];
                  return (
                    <MenuRadioItem
                      key={value}
                      value={value}
                      closeOnClick={false}
                    >
                      <MenuIcon>
                        <Icon size={16} aria-hidden="true" />
                      </MenuIcon>
                      {label}
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
              {appearanceError && (
                <MenuNote role="alert">{appearanceError}</MenuNote>
              )}
            </MenuSubmenuPopup>
          </MenuSubmenu>
          <PluginUpdatesMenu
            recommendations={pluginRecommendations}
            onManage={() => {
              handoff.current = true;
              onSettings("plugins");
            }}
          />
          {actions
            .filter((action) => action.placement === "before-settings")
            .map(renderAction)}
          <MenuItem
            aria-current={settingsSelected ? "page" : undefined}
            onClick={() => {
              handoff.current = true;
              onSettings();
            }}
          >
            <MenuIcon>
              <GearIcon aria-hidden="true" size={16} />
            </MenuIcon>
            Settings
            {settingsSelected && (
              <MenuTrailing>
                <CheckIcon aria-hidden="true" size={14} />
              </MenuTrailing>
            )}
          </MenuItem>
          {actions.some((action) => action.placement !== "before-settings") && (
            <MenuSeparator />
          )}
          {actions
            .filter((action) => action.placement !== "before-settings")
            .map(renderAction)}
        </MenuPopup>
      </MenuRoot>
      {ActionDialog && (
        <ActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedAction(null);
          }}
        />
      )}
      {statusEditor.editor && session && connection.scope && (
        <StatusEditor
          session={session}
          scope={connection.scope}
          current={statusEditor.editor.current}
          viewer={statusEditor.editor.viewer}
          close={statusEditor.close}
          finalFocus={profileTrigger}
        />
      )}
    </>
  );
}
