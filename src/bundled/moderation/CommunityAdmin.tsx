import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { communityFromScope } from "../../features/relay/gifs";
import {
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  formatPublicKey,
  publicKeyLabels,
  typedPublicKey,
} from "../../shared/identity/public-key";
import {
  CaretDownIcon,
  CrownIcon,
  DotsThreeIcon,
  ShieldIcon,
  MinusIcon,
  UserIcon,
} from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import {
  MenuItem,
  MenuIcon,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import {
  allowedActions,
  changeMember,
  mintInvite,
  type Action,
  type Member,
  type MemberChange,
} from "./api";
import {
  createCommunityMembership,
  type CommunityMembership,
} from "./membership";
import { avatarMedia } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";
import { nativeIdentityEnabled } from "../../features/identity/service";
import {
  QrCode,
  type QrVariant,
  renderQrCode,
  useQrVariant,
} from "../../shared/QrCode";
import styles from "./CommunityAdmin.module.css";
import { DIRECT_MEMBER_ADD_ENABLED } from "./features";
import { canShareInvite, shareInvite } from "./shareInvite";

const DAY = 24 * 60 * 60;
const EXPIRY = [1, 3, 7, 30].map((days) => ({
  value: String(days * DAY),
  label: days === 1 ? "1 day" : `${days} days`,
}));
const USES = [
  { value: "", label: "No limit" },
  ...[1, 5, 10, 25].map((uses) => ({
    value: String(uses),
    label: uses === 1 ? "1 use" : `${uses} uses`,
  })),
];
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const STALE = "The member list is out of date. Retry before making changes.";

export type MembershipMethod = "members" | "invite" | "direct";
type MembershipSelection = {
  selectedMethod?: MembershipMethod | undefined;
  onMethodChange?: ((method: MembershipMethod) => void) | undefined;
};

export function CommunityAdmin({
  relay,
  membership: suppliedMembership,
  communityName,
  active,
  selectedMethod,
  onMethodChange,
}: MembershipSelection & {
  relay: RelayData;
  membership?: CommunityMembership;
  communityName?: string;
  active(): boolean;
}) {
  const [fallbackMembership] = useState(() =>
    suppliedMembership ? null : createCommunityMembership(relay),
  );
  const membership = suppliedMembership ?? fallbackMembership;
  useEffect(() => () => fallbackMembership?.dispose(), [fallbackMembership]);
  useEffect(() => membership?.ensure(), [membership]);
  const connection = useRelayConnection(relay);
  if (!membership) return null;
  const community =
    connection.status === "ready" && connection.scope
      ? communityFromScope(connection.scope)
      : null;
  return (
    <section aria-labelledby="community-admin-title">
      <h2 id="community-admin-title" className="mt-0 mb-2 text-label">
        Membership
      </h2>
      <p className="mt-0 mb-6 text-body-sm text-muted">
        {communityName
          ? `Manage members and access to ${communityName}.`
          : "Manage members and community access."}
      </p>
      {community && connection.viewer ? (
        <Members
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          community={community}
          viewer={connection.viewer}
          membership={membership}
          active={active}
          selectedMethod={selectedMethod}
          onMethodChange={onMethodChange}
        />
      ) : (
        <p role="status">Choose a connected community to manage members.</p>
      )}
    </section>
  );
}

type Pending = { member: Member; action: Action };

function Members({
  session,
  community,
  viewer,
  membership,
  active,
  selectedMethod,
  onMethodChange,
}: MembershipSelection & {
  session: RelaySession;
  community: string;
  viewer: string;
  membership: CommunityMembership;
  active(): boolean;
}) {
  const membershipState = useSyncExternalStore(
    membership.subscribe,
    membership.snapshot,
  );
  const members = membershipState.members;
  const [error, setError] = useState("");
  const readError = membershipState.error ?? "";
  const [notice, setNotice] = useState("");
  const refreshing = membershipState.refreshing;
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const proceed = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (selectedMethod && selectedMethod !== "members" && !busy)
      setPending(null);
  }, [selectedMethod, busy]);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (members)
      void session.profiles
        .ensure(members.map((member) => member.pubkey))
        .catch(() => {});
  }, [members, session, profileGeneration]);
  const refresh = membership.refresh;
  const role = membershipState.role;
  const stale = !!readError;
  // No new command may start from a roster that is stale or being re-read.
  const locked = stale || refreshing;
  const baseName = (pubkey: string) =>
    profiles.get(pubkey)?.name || formatPublicKey(pubkey) || pubkey;
  // Every target gets a key qualifier: self-declared names can look identical
  // without being equal strings, so privileged actions must name one identity.
  const qualifiers = publicKeyLabels((members ?? []).map((m) => m.pubkey));
  const name = (pubkey: string) => {
    const base = baseName(pubkey);
    const qualifier = qualifiers.get(pubkey);
    if (!qualifier) return base;
    return profiles.get(pubkey)?.name ? `${base} · ${qualifier}` : qualifier;
  };
  /** Sends one command. Rejects only when the write itself is not confirmed. */
  async function apply(change: MemberChange) {
    if (!active()) return;
    if (locked) {
      setError(STALE);
      throw new Error(STALE);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      try {
        await changeMember(community, change);
      } catch (reason) {
        setError(message(reason));
        throw reason;
      }
      setNotice("Change accepted by the relay.");
      // Stay busy until the shared roster reflects the write, so no stale row acts.
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const refreshButton = readError ? (
    <Button
      loading={refreshing}
      disabled={refreshing || busy}
      onClick={() => void refresh()}
    >
      Retry
    </Button>
  ) : null;
  const status = (
    <>
      {notice && (
        <p role="status" className="m-0 text-body-sm">
          {notice}
        </p>
      )}
      {readError && (
        <p role="alert" className="m-0 text-body-sm">
          {readError}
          {members ? " The list below may be out of date." : ""}
        </p>
      )}
    </>
  );
  if (membershipState.status === "idle" || membershipState.status === "loading")
    return <p role="status">Loading members…</p>;
  if (members === null || (role !== "owner" && role !== "admin"))
    return (
      <div className="mt-4 flex flex-col items-start gap-3">
        {status}
        {!readError && (
          <p role="status" className="m-0">
            {members === null
              ? "This community does not publish a member list, so it has no member administration."
              : "Only community owners and admins can invite people or manage members."}
          </p>
        )}
        {refreshButton}
      </div>
    );
  const needle = query.trim().toLowerCase();
  const shown = members
    .filter(
      (m) =>
        !needle ||
        name(m.pubkey).toLowerCase().includes(needle) ||
        m.pubkey.includes(needle),
    )
    .sort(
      (a, b) =>
        ["owner", "admin", "member"].indexOf(a.role) -
          ["owner", "admin", "member"].indexOf(b.role) ||
        name(a.pubkey).localeCompare(name(b.pubkey)),
    );
  // Revalidate the captured intent against the current roster on every render.
  const target = pending
    ? members.find((m) => m.pubkey === pending.member.pubkey)
    : undefined;
  const confirmable =
    !!pending &&
    !!target &&
    !locked &&
    allowedActions(role, target, target.pubkey === viewer).includes(
      pending.action,
    );
  const verb = {
    promote: "Make admin",
    demote: "Make member",
    remove: "Remove",
  } as const;
  return (
    <MembershipContent
      selectedMethod={selectedMethod}
      onMethodChange={onMethodChange}
      busy={busy || !!pending}
      community={community}
      members={members}
      owner={role === "owner"}
      stale={stale}
      refreshing={refreshing}
      active={active}
      retry={() => void refresh()}
      add={(pubkey, next) => apply({ action: "add", pubkey, role: next })}
    >
      {status}
      {error && (
        <p role="alert" className="text-body-sm">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-4">
        <div className={styles.searchControls}>
          <div className="min-w-0 flex-1">
            <SearchField
              label="Search members"
              placeholder="Search members"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          {refreshButton}
        </div>
        <div>
          <h3 className="m-0 pb-2 text-caption text-subtle">
            Members · {members.length}
          </h3>
          <ul className={styles.members} aria-label="Members">
            {shown.map((member) => {
              // A stale list must not offer another destructive command.
              const actions = stale
                ? []
                : allowedActions(role, member, member.pubkey === viewer);
              const label = name(member.pubkey);
              const picture = profiles.get(member.pubkey)?.picture;
              return (
                <li key={member.pubkey} className={styles.member}>
                  <Avatar
                    src={avatarMedia(picture, session.media)}
                    alt=""
                    fallback={label}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 flex min-w-0 items-center gap-1.5 text-body-sm">
                      <span className="truncate">{label}</span>
                      {member.role === "owner" && (
                        <CrownIcon className="shrink-0 text-warning" />
                      )}
                      {member.role === "admin" && (
                        <ShieldIcon className="shrink-0 text-accent" />
                      )}
                    </p>
                  </div>
                  {actions.length > 0 && (
                    <div className={styles.memberAction}>
                      <MenuRoot>
                        <MenuTrigger
                          render={
                            <IconButton
                              aria-label={`Actions for ${label}`}
                              icon={<DotsThreeIcon />}
                              disabled={busy || refreshing}
                            />
                          }
                        />
                        <MenuPopup align="end">
                          {actions.map((action) => (
                            <MenuItem
                              key={action}
                              onClick={() => setPending({ member, action })}
                            >
                              <MenuIcon>
                                {action === "promote" ? (
                                  <ShieldIcon size={14} />
                                ) : action === "demote" ? (
                                  <UserIcon size={14} />
                                ) : (
                                  <MinusIcon size={14} />
                                )}
                              </MenuIcon>
                              {verb[action]}
                            </MenuItem>
                          ))}
                        </MenuPopup>
                      </MenuRoot>
                    </div>
                  )}
                  <span className="shrink-0 text-caption text-subtle">
                    {member.role[0]?.toUpperCase() + member.role.slice(1)}
                    {member.pubkey === viewer ? " · You" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {!shown.length && (
            <p role="status" className="text-body-sm text-muted">
              No members match.
            </p>
          )}
        </div>
      </div>
      {pending && (
        <AlertDialog
          title={`${verb[pending.action]}: ${name(pending.member.pubkey)}?`}
          description={
            stale
              ? STALE
              : pending.action === "remove"
                ? "They lose access to this community until they are invited again."
                : pending.action === "promote"
                  ? "Admins can invite people and remove members."
                  : "They will no longer be able to invite people or manage members."
          }
          pending={busy}
          initialFocus={pending.action === "remove" ? undefined : proceed}
          onClose={() => setPending(null)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                ref={proceed}
                variant={
                  pending.action === "remove" ? "destructive" : "primary"
                }
                loading={busy}
                disabled={busy || !confirmable}
                onClick={() =>
                  void apply(
                    pending.action === "remove"
                      ? { action: "remove", pubkey: pending.member.pubkey }
                      : {
                          action: "role",
                          pubkey: pending.member.pubkey,
                          role:
                            pending.action === "promote" ? "admin" : "member",
                        },
                  )
                    .then(() => setPending(null))
                    .catch(() => setPending(null))
                }
              >
                {verb[pending.action]}
              </Button>
            </>
          }
        />
      )}
    </MembershipContent>
  );
}

function publicKey(input: string) {
  const key = typedPublicKey(input);
  if (key) return key;
  throw new Error("Enter an npub or 64-character hex public key.");
}

/** Label-left, value-right choice row control, as in the Buzz desktop dialog. */
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button variant="ghost" size="sm" aria-label={label}>
            {options.find((option) => option.value === value)?.label}
            <CaretDownIcon
              size={14}
              className="buzz-dropdown-chevron"
              aria-hidden="true"
            />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(String(next))}
        >
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>
  );
}

const ROLES_OFFERED = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

function MembershipContent({
  children,
  busy,
  community,
  members,
  owner,
  stale,
  refreshing,
  active,
  retry,
  add,
  selectedMethod,
  onMethodChange,
}: MembershipSelection & {
  children: ReactNode;
  busy: boolean;
  community: string;
  members: readonly Member[];
  owner: boolean;
  stale: boolean;
  refreshing: boolean;
  active(): boolean;
  retry(): void;
  add(pubkey: string, role: "admin" | "member"): Promise<void>;
}) {
  const [localMethod, setMethod] = useState<MembershipMethod>("members");
  const requestedMethod = selectedMethod ?? localMethod;
  const method =
    !DIRECT_MEMBER_ADD_ENABLED && requestedMethod === "direct"
      ? "members"
      : requestedMethod;
  const open = method === "invite";
  const [ttl, setTtl] = useState(String(3 * DAY));
  const [uses, setUses] = useState("");
  const [identity, setIdentity] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  // The QR code drawn for one link, or no svg when it failed; it never shows
  // for another link.
  const [qr, setQr] = useState<{
    url: string;
    variant: QrVariant;
    svg?: string;
  } | null>(null);
  // One minted link per settings; a missing entry for these settings mints.
  const settings = `${ttl}:${uses}`;
  const [link, setLink] = useState<{
    settings: string;
    url?: string;
    failed?: boolean;
  } | null>(null);
  const minting = useRef(0);
  // StrictMode replays effects; never mint twice for the same settings.
  const requested = useRef("");
  const current = link?.settings === settings ? link : null;
  const locked = stale || refreshing;
  useEffect(() => {
    if (open) return;
    // A new visit needs a fresh link: the previous one may be exhausted.
    ++minting.current;
    requested.current = "";
    setLink(null);
    setQr(null);
    setCopied(false);
    setError("");
  }, [open]);
  useEffect(() => {
    // Visiting a sharing tab, or changing its settings, creates the link to share.
    if (!open || locked || current || requested.current === settings) return;
    if (!active()) return;
    requested.current = settings;
    const request = ++minting.current;
    setLink({ settings });
    setCopied(false);
    setError("");
    mintInvite(community, Number(ttl), uses ? Number(uses) : null).then(
      (invite) => {
        if (minting.current === request) setLink({ settings, url: invite.url });
      },
      (reason) => {
        if (minting.current !== request) return;
        requested.current = "";
        setLink({ settings, failed: true });
        setError(message(reason));
      },
    );
  }, [open, locked, current, active, community, settings, ttl, uses]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const url = current?.url;
  // New settings have no link until the effect mints one; count them as
  // pending so the code's place never collapses, which scrolled the dialog.
  const pending = current ? !url && !current.failed : !locked;
  const variant = useQrVariant();
  const drawn = url && qr?.url === url && qr.variant === variant ? qr : null;
  const showQr =
    nativeIdentityEnabled() && (pending || !!url) && !(drawn && !drawn.svg);
  useEffect(() => {
    if (!url || !nativeIdentityEnabled()) return;
    let live = true;
    renderQrCode(url, variant).then(
      (svg) => live && setQr({ url, variant, svg }),
      (reason) => {
        if (!live) return;
        setQr({ url, variant });
        setError(message(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [url, variant]);
  let directKey: string | null = null;
  let identityError = "";
  if (identity.trim()) {
    try {
      directKey = publicKey(identity);
      if (members.some((member) => member.pubkey === directKey))
        identityError = "This person is already a community member.";
    } catch (reason) {
      identityError = message(reason);
    }
  }
  async function addDirectly() {
    if (!directKey || identityError || !active() || locked || adding) return;
    setAdding(true);
    setError("");
    setNotice("");
    try {
      await add(directKey, owner ? role : "member");
      setIdentity("");
      setRole("member");
      setNotice("Member added directly.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setAdding(false);
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <div className={styles.tabs}>
        <Tabs
          value={method}
          onValueChange={onMethodChange ?? setMethod}
          label="Membership sections"
          variant="panel"
          items={[
            {
              value: "members",
              label: "Members",
              panelId: "invite-members-panel",
              disabled: adding || busy,
            },
            {
              value: "invite",
              label: "Invite",
              panelId: "invite-share-panel",
              disabled: adding || busy,
            },
            ...(DIRECT_MEMBER_ADD_ENABLED
              ? [
                  {
                    value: "direct" as const,
                    label: "Add directly",
                    panelId: "invite-direct-panel",
                    disabled: adding || busy,
                  },
                ]
              : []),
          ]}
        />
      </div>
      {method === "members" && (
        <section
          role="tabpanel"
          id="invite-members-panel"
          aria-labelledby="invite-members-panel-tab"
        >
          {children}
        </section>
      )}
      {open && (
        <section
          className={styles.invitePanel}
          role="tabpanel"
          id="invite-share-panel"
          aria-labelledby="invite-share-panel-tab"
        >
          <div className={styles.inviteQr}>
            {showQr && (
              <div className="flex justify-center">
                {drawn?.svg ? (
                  <QrCode
                    svg={drawn.svg}
                    alt="Scan this QR code to open the invite link"
                  />
                ) : (
                  // Holds the code's place while the link or its code is made.
                  <div
                    aria-hidden="true"
                    className="size-60 max-w-full shrink-0"
                  />
                )}
              </div>
            )}
            {showQr && drawn?.svg && canShareInvite() && (
              <div className={styles.qrShare}>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={!url || !drawn?.svg || locked}
                  loading={sharing}
                  onClick={async (event) => {
                    if (!url || sharing) return;
                    const anchor = event.currentTarget.getBoundingClientRect();
                    setSharing(true);
                    setError("");
                    try {
                      await shareInvite(url, anchor);
                    } catch {
                      setError(
                        "Could not open sharing. Try again or copy the link.",
                      );
                    } finally {
                      setSharing(false);
                    }
                  }}
                >
                  Share
                </Button>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <InputGroup
              trailing={
                <Button
                  size="sm"
                  loading={pending}
                  disabled={current?.failed ? locked : !url}
                  // Copying with a pointer should not move focus into the field.
                  // Keyboard activation keeps the shared visible-focus treatment.
                  onMouseDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onClick={() => {
                    if (current?.failed) {
                      setLink(null);
                      return;
                    }
                    if (!url) return;
                    writeClipboardText(url)
                      .then(() => {
                        setCopied(true);
                      })
                      .catch(() => setError("Could not copy the invite link."));
                  }}
                >
                  {current?.failed ? "Retry" : copied ? "Copied" : "Copy link"}
                </Button>
              }
            >
              <Input
                aria-label="Community invite link"
                readOnly
                value={url ?? ""}
                placeholder={
                  current?.failed
                    ? "Couldn’t create invite link"
                    : "Creating invite link…"
                }
              />
            </InputGroup>
            <SettingsGroup>
              <div className="flex items-center justify-between gap-4 py-3">
                <span className="text-body-sm">Expires after</span>
                <Choice
                  label="Choose invite expiry"
                  value={ttl}
                  options={EXPIRY}
                  onChange={setTtl}
                  // Stays usable while a link is made, so the closing menu can
                  // return focus to it; the newest choice's link wins.
                  disabled={locked}
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <span className="text-body-sm">Max uses</span>
                <Choice
                  label="Choose maximum invite uses"
                  value={uses}
                  options={USES}
                  onChange={setUses}
                  disabled={locked}
                />
              </div>
            </SettingsGroup>
          </div>
        </section>
      )}
      {DIRECT_MEMBER_ADD_ENABLED && method === "direct" && (
        <section
          role="tabpanel"
          id="invite-direct-panel"
          aria-labelledby="invite-direct-panel-tab"
        >
          <p className="mt-1 mb-3 text-body-sm text-muted">
            Paste the person’s npub or 64-character public key.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addDirectly();
            }}
          >
            <div className="min-w-0 flex-1">
              <InputGroup>
                <Input
                  aria-label="Public identity"
                  placeholder="npub1… or public key"
                  value={identity}
                  onChange={(event) => setIdentity(event.currentTarget.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={adding}
                />
                {owner && (
                  <Choice
                    label="Choose member role"
                    value={role}
                    options={ROLES_OFFERED}
                    onChange={(value) => setRole(value as "admin" | "member")}
                    disabled={adding}
                  />
                )}
              </InputGroup>
              {identityError && (
                <p role="alert" className="mt-2 mb-0 text-body-sm">
                  {identityError}
                </p>
              )}
            </div>
            <Button
              type="submit"
              variant="primary"
              loading={adding}
              disabled={adding || locked || !directKey || !!identityError}
            >
              Add member
            </Button>
          </form>
        </section>
      )}
      <div className="flex flex-col gap-2 empty:hidden">
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
        {method !== "members" && stale && !adding && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="m-0 text-body-sm">
              {STALE}
            </p>
            <Button
              size="sm"
              loading={refreshing}
              disabled={refreshing}
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        )}
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
