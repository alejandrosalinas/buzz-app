import {
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  GlobeIcon,
  PlusIcon,
  UsersPlusIcon,
} from "../../shared/design-system/icons/index";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { SettingsCards } from "../settings/service";
import type { OpenTarget } from "../navigation/targets";
import { communityFromScope } from "../relay/gifs";
import { useRelayConnection } from "../relay/react";
import type { Communities, Membership } from "./service";
import {
  departCommunity,
  departedText,
  departureFailureText,
  type Departure,
  type DepartureIntent,
  leaveUnsettled,
} from "./departure";
import { CommunityDialog } from "./CommunityDialog";
import type { FederatedIdentity } from "../federated-identity/service";
import type { JoinRequest } from "./invite-intent";
import { CommunityPickerItem, MEMBERSHIP_SECTION } from "./CommunityPickerItem";
import { communityDestination } from "./destination";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./Communities.module.css";
import {
  communityName,
  communityDefaultName,
  communityActionLabel,
} from "./names";
import { useCommunityRole } from "./useCommunityRole";

const noSubscription = () => () => {};

/** Opens the shell's community switcher from a page. Absent where the shell
 * doesn't mount the switcher. */
export const OpenCommunitySwitcher = createContext<(() => void) | undefined>(
  undefined,
);

/** A host that opens the switcher from elsewhere owns its open state, so it
 * passes both props; otherwise the picker keeps the state itself. */
type SwitcherState =
  | { open: boolean; onOpenChange: (open: boolean) => void }
  | { open?: undefined; onOpenChange?: undefined };

/** Shell navigation only: selecting a community remains owned by Communities. */
export function CommunityPicker({
  communities,
  federatedIdentity,
  invite,
  onInviteClose,
  onSelect,
  onOpenTarget,
  settingsCards,
  open,
  onOpenChange,
}: {
  communities: Communities;
  federatedIdentity?: FederatedIdentity | undefined;
  invite?: (JoinRequest & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: Pick<SettingsCards, "subscribe" | "has"> | undefined;
  onSelect?: ((id: string | null) => void) | undefined;
  /** Menu destinations (Invites, hosting) open through the host's navigation. */
  onOpenTarget?: ((target: OpenTarget) => void) | undefined;
} & SwitcherState) {
  const [localOpen, setLocalOpen] = useState(false);
  const switcherOpen = open ?? localOpen;
  const setSwitcherOpen = onOpenChange ?? setLocalOpen;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [joining, setJoining] = useState(false);
  const navigated = useRef(false);
  // However it opened, a fresh switcher returns focus to its trigger until a
  // choice navigates.
  useLayoutEffect(() => {
    if (switcherOpen) navigated.current = false;
  }, [switcherOpen]);
  const wasJoining = useRef(false);
  useEffect(() => {
    if (wasJoining.current && !joining) triggerRef.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  // The confirm dialog belongs to the picker so it outlives the item it removes.
  const [leaving, setLeaving] = useState<{
    membership: Membership;
    intent: DepartureIntent;
    pending: boolean;
  } | null>(null);
  const wasLeaving = useRef<Membership | null>(null);
  const notify = useToastNotification();
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  useEffect(() => {
    // The picker closes before confirmation. Its surviving trigger owns
    // return focus whether the community was retained or removed.
    if (wasLeaving.current && !leaving) triggerRef.current?.focus();
    wasLeaving.current = leaving?.membership ?? null;
  }, [leaving]);
  // The compatibility reader follows selection, so this is only ever the
  // selected community's session; inactive communities stay unacquired.
  const connection = useRelayConnection(communities.relay);
  const selectedOrigin = client.selected
    ? communityDestination(client.selected).url
    : null;
  const session =
    connection.status === "ready" &&
    connection.scope &&
    communityFromScope(connection.scope) === selectedOrigin
      ? connection.session
      : undefined;
  // Roles come from the relay-signed roster, as the Membership card derives
  // them, verified against the authority the selected session already holds
  // rather than a second session contract request. Skip the read where no
  // item could use it.
  const membershipAvailable = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscription,
    // Registration is not authorization: the picker refreshes the role on menu
    // open even if Settings last cached a non-admin role.
    () => settingsCards?.has(MEMBERSHIP_SECTION) ?? false,
  );
  const hostedAvailable = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscription,
    () => settingsCards?.has("block.builderlab/login") ?? false,
  );
  const invites = !!onOpenTarget && membershipAvailable;
  const role = useCommunityRole(invites ? session : undefined, client.viewer);
  useEffect(() => communities.retainPresentation(), [communities]);
  const select = (id: string | null) => {
    setSwitcherOpen(false);
    if (onSelect) onSelect(id);
    else communities.select(id);
  };
  const cancelRef = useRef<HTMLButtonElement>(null);
  const offeringRemoval = leaving?.intent === "remove" && !leaving.pending;
  useLayoutEffect(() => {
    // The confirm button kept focus through the failed leave; a repeated
    // Enter must not remove the community without a fresh choice, so focus
    // moves before the browser handles another key.
    if (offeringRemoval) cancelRef.current?.focus();
  }, [offeringRemoval]);
  /** A leave publishes first; the device forgets the community only once the
   * relay has released the membership, reports it never held one, or refuses
   * the viewer as banned. If the relay never settles it, for example because
   * its domain no longer resolves, the dialog offers to remove the community
   * from this device instead, which needs no relay. */
  const depart = async () => {
    if (!leaving || leaving.pending) return;
    const { membership, intent } = leaving;
    setLeaving({ membership, intent, pending: true });
    let result: Departure;
    try {
      result = await departCommunity(communities, membership, intent);
    } catch (error) {
      if (intent === "leave" && leaveUnsettled(error)) {
        setLeaving({ membership, intent: "remove", pending: false });
        return;
      }
      notify(
        departureFailureText(communityActionLabel(membership), intent, error),
        "error",
      );
      setLeaving(null);
      return;
    }
    // The community is gone from this device whatever happens next, so only
    // the service call above may read as a cleanup failure.
    if (result.wasSelected) {
      // The service already fell back to Personal space. Telling the host too
      // gives the departure the same navigation and ingress recovery as
      // clicking Personal space, instead of a page scoped to a gone community.
      try {
        onSelect?.(null);
      } catch (error) {
        // A host that cannot navigate is the host's failure, not the device's.
        console.error(
          `Couldn't select Personal space after removing ${communityName(membership)}`,
          error,
        );
      }
    }
    notify(...departedText(communityActionLabel(membership), result));
    setLeaving(null);
  };
  const active = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  return (
    <>
      <nav aria-label="Communities" className={styles.picker}>
        <PopoverRoot open={switcherOpen} onOpenChange={setSwitcherOpen}>
          <PopoverTrigger
            render={
              <IconButton
                ref={triggerRef}
                size="md"
                variant="avatar"
                shape="round"
                aria-label={`Community switcher: ${active ? communityName(active) : client.memberships.length === 0 ? "Communities" : "Personal space"}`}
                title={
                  active
                    ? communityName(active)
                    : client.memberships.length === 0
                      ? "Communities"
                      : "Personal space"
                }
                icon={
                  active ? (
                    <Avatar
                      size="small"
                      shape="squircle"
                      alt=""
                      fallback={communityName(active)}
                      src={active.publishedIcon ?? active.icon}
                    />
                  ) : (
                    <GlobeIcon size={22} aria-hidden="true" />
                  )
                }
              />
            }
          />
          <PopoverPopup
            aria-label="Switch community"
            onKeyDown={(event) => {
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
                return;
              const rows = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not([disabled])",
                ),
              );
              const index = rows.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        rows.length) %
                      rows.length;
              rows[next]?.focus();
            }}
            side="right"
            align="end"
            padding="list"
            finalFocus={() =>
              joining || leaving
                ? false
                : navigated.current
                  ? document.getElementById("main-content")
                  : triggerRef.current
            }
          >
            <NavigationItem
              label="Personal space"
              selected={client.selected === null}
              aria-current={client.selected === null ? "true" : undefined}
              icon={<GlobeIcon size={20} />}
              onClick={() => select(null)}
            />
            {client.memberships.map((membership) => {
              const selected = client.selected === membership.id;
              return (
                <CommunityPickerItem
                  key={membership.id}
                  membership={membership}
                  icon={membership.publishedIcon ?? membership.icon}
                  selected={selected}
                  viewer={client.viewer}
                  session={selected ? session : undefined}
                  manager={selected && invites && role.manager}
                  leaving={
                    leaving?.membership.id === membership.id && leaving.pending
                  }
                  onSelect={select}
                  onOpenTarget={
                    onOpenTarget
                      ? (target) => {
                          navigated.current = true;
                          setSwitcherOpen(false);
                          onOpenTarget(target);
                        }
                      : undefined
                  }
                  // Roles can change while the app runs; opening the selected
                  // community's menu re-reads the roster it gates on.
                  onMenuOpen={selected && invites ? role.refresh : undefined}
                  onLeave={(target) => {
                    setSwitcherOpen(false);
                    setLeaving({
                      membership: target,
                      intent: "leave",
                      pending: false,
                    });
                  }}
                />
              );
            })}
            <NavigationItem
              label="Join a community"
              icon={<UsersPlusIcon size={20} />}
              onClick={() => {
                setSwitcherOpen(false);
                setJoining(true);
              }}
            />
            {onOpenTarget && hostedAvailable && (
              <NavigationItem
                label="Create community"
                icon={<PlusIcon size={20} />}
                onClick={() => {
                  navigated.current = true;
                  setSwitcherOpen(false);
                  onOpenTarget({
                    version: 1,
                    kind: "settings",
                    section: "block.builderlab/login",
                  });
                }}
              />
            )}
          </PopoverPopup>
        </PopoverRoot>
      </nav>
      {(joining || invite) && (
        <CommunityDialog
          key={invite ? invite.requestId : "manual"}
          communities={communities}
          federatedIdentity={federatedIdentity}
          mode="join"
          invite={invite}
          submittedDestination={invite?.submitted === true}
          onJoined={(id) => select(id)}
          close={() => {
            setJoining(false);
            if (invite) onInviteClose?.(invite.requestId);
          }}
        />
      )}
      {leaving && (
        <AlertDialog
          title={
            leaving.intent === "leave"
              ? `Leave ${communityDefaultName(leaving.membership)}?`
              : `Couldn’t leave ${communityDefaultName(leaving.membership)}`
          }
          description={
            leaving.intent === "leave"
              ? `This sends a leave request to the community’s relay, then removes ${communityDefaultName(leaving.membership)} from this device along with its saved drafts and reading positions. Rejoining may need a new invite.`
              : `Its relay didn’t confirm the leave, so you may still be a member. You can remove ${communityDefaultName(leaving.membership)} from this device instead, along with its saved drafts and reading positions. This doesn’t change your membership.`
          }
          pending={leaving.pending}
          onClose={() => setLeaving(null)}
          // The picker's own effect places focus once the dialog is gone.
          finalFocus={false}
          actions={
            <>
              <Button
                ref={cancelRef}
                disabled={leaving.pending}
                onClick={() => setLeaving(null)}
              >
                Cancel
              </Button>
              <Button
                variant={
                  leaving.intent === "leave" ? "destructive" : "prominent"
                }
                loading={leaving.pending}
                onClick={() => void depart()}
              >
                {leaving.intent === "leave"
                  ? "Leave community"
                  : "Remove from this device"}
              </Button>
            </>
          }
        >
          <div className="min-w-0 space-y-2 text-body-sm">
            {leaving.membership.localName &&
              leaving.membership.localName !==
                communityDefaultName(leaving.membership) && (
                <p className="text-muted">
                  Shown as {leaving.membership.localName} on this device
                </p>
              )}
            <p className="break-all">
              {communityDestination(leaving.membership.id).url}
            </p>
          </div>
        </AlertDialog>
      )}
    </>
  );
}
