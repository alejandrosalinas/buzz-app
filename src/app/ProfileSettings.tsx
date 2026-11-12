import { useProfileGeneration } from "../features/relay/react";
import { ProfileBackdrop } from "../features/profiles/ProfileBackdrop";
import hero from "../features/profiles/ProfileHero.module.css";
import { useAvatarPreview } from "../features/profiles/use-avatar-preview";
import { LoadingRegion } from "../shared/design-system/ui/LoadingRegion";
import type { RelaySession } from "../features/relay/session";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header } from "../shared/design-system/ui/Header";
import { profileDefault } from "../features/communities/profile-default";
import { AvatarEditor } from "../features/profiles/AvatarEditor";
import { Button } from "../shared/design-system/ui/Button";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import styles from "./ProfileSettings.module.css";
import type {
  Communities,
  PersonalProfile,
} from "../features/communities/service";
import {
  canSaveProfile,
  ProfileFields,
  profilesEqual,
} from "../features/communities/ProfileFields";
import * as communityApi from "../features/communities/api";
import type { Membership } from "../features/communities/service";
import { communityName } from "../features/communities/names";

type LoadedProfile = Awaited<ReturnType<typeof communityApi.inspectProfile>>;

function selectedProfileSession(
  communities: Communities,
  communityId: string | undefined,
) {
  const client = communities.snapshot();
  const connection = communities.relay.snapshot();
  return communityId &&
    client.selected === communityId &&
    connection.viewer === client.viewer &&
    connection.status === "ready"
    ? connection.session
    : undefined;
}
function cachedProfile(session: RelaySession | undefined) {
  const event = session?.viewer
    ? session.profiles.event?.(session.viewer)
    : undefined;
  if (!event) return null;
  try {
    return communityApi.profileFromEvent(event);
  } catch {
    return null;
  }
}
function mergeRefreshedDraft(
  draft: PersonalProfile,
  before: PersonalProfile,
  after: PersonalProfile,
): PersonalProfile {
  return {
    name: draft.name === before.name ? after.name : draft.name,
    picture: draft.picture === before.picture ? after.picture : draft.picture,
    about:
      (draft.about ?? "") === (before.about ?? "")
        ? (after.about ?? "")
        : (draft.about ?? ""),
  };
}

const profileSaveGenerations = new WeakMap<Communities, number>();
function beginProfileSave(communities: Communities) {
  const generation = (profileSaveGenerations.get(communities) ?? 0) + 1;
  profileSaveGenerations.set(communities, generation);
  return generation;
}
function isCurrentProfileSave(communities: Communities, generation: number) {
  return profileSaveGenerations.get(communities) === generation;
}

export function ProfileSettings({
  communities,
  community,
  onUnsavedChange,
}: {
  communities: Communities;
  community?: Membership | undefined;
  onUnsavedChange?: ((unsaved: boolean) => void) | undefined;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const pendingFocus = useRef<HTMLInputElement | null>(null);
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Capture focus before the conditional actions leave the DOM.
    return () => {
      if (node.contains(document.activeElement))
        pendingFocus.current =
          node.closest("form")?.querySelector<HTMLInputElement>("input") ??
          null;
    };
  }, []);
  useLayoutEffect(() => {
    // The form fields may still be disabled during ref cleanup. Wait until
    // React has committed their enabled state; unmounting runs no handoff.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const communityId = community?.id;
  const [loaded, setLoaded] = useState<LoadedProfile | null>(() =>
    cachedProfile(selectedProfileSession(communities, communityId)),
  );
  const [loadStatus, setLoadStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >(community ? "idle" : "ready");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const latestPersisted = useRef<PersonalProfile>(client.profile);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Publication has been sent, so the save finishes even if Settings closes.
  const [dispatched, setDispatched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  // A scope change discards drafts; Retry keeps the same scope's useful content.
  const profileScope = `${client.viewer ?? ""}:${communityId ?? "local"}`;
  const previousScope = useRef(profileScope);
  useLayoutEffect(() => {
    if (previousScope.current === profileScope) return;
    previousScope.current = profileScope;
    setDraft(null);
    setLoaded(cachedProfile(selectedProfileSession(communities, communityId)));
    setLoadStatus(communityId ? "idle" : "ready");
    setSaved(false);
    setLoadError("");
    setError("");
  }, [communities, communityId, profileScope]);
  useEffect(() => {
    void loadAttempt;
    if (!communityId) {
      setLoadStatus("ready");
      return;
    }
    if (!client.relayAvailable || !client.viewer) return;
    let current = true;
    const session = selectedProfileSession(communities, communityId);
    const seed = cachedProfile(session);
    if (seed) setLoaded(seed);
    setLoadStatus("loading");
    setLoadError("");
    const read = session
      ? communityApi.inspectProfile(communityId, session)
      : communityApi.inspectProfile(communityId);
    void read.then(
      (result) => {
        if (!current) return;
        // An avatar upload may finish before React commits this fresh read.
        const fresh = result.exists
          ? result.profile
          : communities.snapshot().profile;
        latestPersisted.current = fresh;
        if (seed)
          setDraft((draft) =>
            draft ? mergeRefreshedDraft(draft, seed.profile, fresh) : null,
          );
        setLoaded(result);
        setLoadStatus("ready");
      },
      (reason) => {
        if (!current) return;
        setLoadStatus("error");
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [
    communities,
    communityId,
    loadAttempt,
    client.relayAvailable,
    client.viewer,
  ]);
  const profilePending =
    client.status === "loading" ||
    (!!community && loadStatus !== "ready" && loadStatus !== "error");
  const previewReady =
    client.status === "ready" && (!community || loaded !== null);
  const persisted =
    community && loaded?.exists ? loaded.profile : client.profile;
  latestPersisted.current = persisted;
  const session = selectedProfileSession(communities, communityId);
  const thumbnailMedia = session?.media;
  const viewer = session?.viewer;
  const verified = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        session?.profiles.subscribe(listener) ?? (() => {}),
      [session],
    ),
    () =>
      viewer ? session?.profiles.snapshot().get(viewer)?.verified : undefined,
  );
  const profileGeneration = useProfileGeneration(session?.profiles);
  useEffect(() => {
    void profileGeneration;
    if (viewer) void session?.profiles.ensure([viewer]).catch(() => {});
  }, [session, viewer, profileGeneration]);
  const verifiedName = verified
    ? {
        name: verified.fullName ?? verified.displayName,
        username: verified.username,
        issuerLabel: verified.issuerLabel,
        status: verified.status,
      }
    : undefined;
  // Lock the name only over a valid signed name, which every save keeps;
  // an empty signed name stays editable so it can be repaired.
  const lockedName = persisted.name.trim() ? verifiedName : undefined;
  const edited = lockedName
    ? { ...(draft ?? persisted), name: persisted.name }
    : (draft ?? persisted);
  const profile = previewReady ? edited : { name: "", picture: "", about: "" };
  const hasChanges = draft !== null && !profilesEqual(edited, persisted);
  // A dispatched save continues after Settings closes, so it is not
  // discardable. Before then (the fresh read), closing would drop the edit.
  const discardable = hasChanges && !dispatched;
  useEffect(() => {
    if (!discardable) return;
    onUnsavedChange?.(true);
    return () => onUnsavedChange?.(false);
  }, [discardable, onUnsavedChange]);
  const backdrop = useAvatarPreview(
    profile.picture,
    community?.id,
    "small",
    thumbnailMedia,
  );
  return (
    <section aria-labelledby="profile-settings-title">
      <Header
        id="profile-settings-title"
        title="Profile"
        subtitle={
          community
            ? "Update this community’s profile. Other community profiles stay unchanged."
            : "Used for new communities. Existing community profiles stay unchanged."
        }
      />
      <div>
        {client.status === "unavailable" ? (
          <p role="status">
            Your local identity is unavailable. Connect your identity to edit
            your profile.
          </p>
        ) : community && !client.relayAvailable ? (
          <p role="status">
            Community profiles are not available in this build yet.
          </p>
        ) : (
          <LoadingRegion
            pending={profilePending}
            label={
              client.status === "loading"
                ? "Opening your local identity…"
                : `Loading your profile in ${community ? communityName(community) : "this community"}…`
            }
            feedback={
              loadStatus === "error" && community ? (
                <div>
                  <p role="alert" className="error">
                    Your profile in {communityName(community)} couldn’t be
                    loaded. {loadError}
                  </p>
                  <Button
                    type="button"
                    onClick={() => setLoadAttempt((value) => value + 1)}
                  >
                    Retry loading profile
                  </Button>
                </div>
              ) : undefined
            }
          >
            <div
              className={styles.editor}
              data-placeholder={!previewReady || undefined}
              inert={!previewReady}
              aria-hidden={!previewReady || undefined}
            >
              <section aria-label="Profile preview" className={hero.hero}>
                <ProfileBackdrop src={backdrop} />
                <div>
                  <AvatarEditor
                    personal
                    size="compact"
                    value={profile.picture}
                    name={verifiedName?.name ?? profile.name}
                    community={community?.id}
                    {...(thumbnailMedia ? { thumbnailMedia } : {})}
                    disabled={saving || !previewReady}
                    onBusyChange={setUploading}
                    onChange={(picture) => {
                      // Apply only the completed picture, never the upload's old name/bio.
                      setDraft((current) => ({
                        ...(current ?? latestPersisted.current),
                        picture,
                      }));
                      setSaved(false);
                      setError("");
                    }}
                  />
                </div>
                <div className={styles.previewCopy}>
                  <h3 className="text-body-lg">
                    {verifiedName?.name ??
                      (profile.name.trim() || "Your profile")}
                  </h3>
                  {profile.about?.trim() ? (
                    <p className={`${styles.about} text-body-sm text-muted`}>
                      {profile.about.trim()}
                    </p>
                  ) : null}
                </div>
              </section>
              <SettingsGroup layout="form">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      saving ||
                      uploading ||
                      !hasChanges ||
                      !canSaveProfile(profile) ||
                      (community && (!loaded || loadStatus !== "ready"))
                    )
                      return;
                    const next = {
                      ...profile,
                      name: profile.name.trim(),
                      about: profile.about?.trim() ?? "",
                    };
                    // Capture once before async work: selection may change during Save.
                    const session = selectedProfileSession(
                      communities,
                      community?.id,
                    );
                    const inspect = (id: string) =>
                      session
                        ? communityApi.inspectProfile(id, session)
                        : communityApi.inspectProfile(id);
                    const saveGeneration = beginProfileSave(communities);
                    setSaving(true);
                    setSaved(false);
                    setError("");
                    void (async () => {
                      try {
                        if (community && loaded) {
                          // Preserve fields outside this editor even if another client edited them.
                          const latest = await inspect(community.id);
                          if (!mounted.current) return;
                          setDispatched(true);
                          await communityApi.publishProfile(
                            community.id,
                            next,
                            latest.existing,
                          );
                          // Once dispatched, finish on this session even if Settings closes.
                          const confirmed = await inspect(community.id);
                          if (
                            !confirmed.exists ||
                            !profilesEqual(confirmed.profile, next)
                          )
                            throw new Error(
                              "Your profile change is not current. Your edits are retained; save again to retry.",
                            );
                          setLoaded(confirmed);
                        }
                        if (isCurrentProfileSave(communities, saveGeneration))
                          communities.saveProfile(
                            profileDefault(
                              next,
                              communities.snapshot().profile,
                              community?.id,
                            ),
                          );
                        setDraft(null);
                        setSaved(true);
                      } catch (reason) {
                        if (mounted.current)
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : String(reason),
                          );
                      } finally {
                        if (mounted.current) {
                          setSaving(false);
                          setDispatched(false);
                        }
                      }
                    })();
                  }}
                >
                  <ProfileFields
                    profile={profile}
                    showAvatar={false}
                    disabled={saving || !previewReady}
                    verifiedName={lockedName}
                    onChange={(next) => {
                      setDraft(next);
                      setSaved(false);
                      setError("");
                    }}
                  />
                  {error && (
                    <p role="alert" className="error">
                      {error}
                    </p>
                  )}
                  {hasChanges && (
                    <div
                      ref={actionsRef}
                      className="mt-6 flex flex-wrap items-center justify-end gap-3"
                    >
                      <Button
                        type="button"
                        disabled={saving || uploading}
                        onClick={() => {
                          setDraft(null);
                          setSaved(false);
                          setError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        loading={saving}
                        disabled={
                          uploading ||
                          !canSaveProfile(profile) ||
                          (!!community && loadStatus !== "ready")
                        }
                        variant="primary"
                      >
                        Save
                      </Button>
                    </div>
                  )}
                  {saved && (
                    <ToastNotice
                      title="Profile updated"
                      tone="success"
                      timeout={5000}
                      onDismiss={() => setSaved(false)}
                    />
                  )}
                </form>
              </SettingsGroup>
            </div>
          </LoadingRegion>
        )}
      </div>
    </section>
  );
}
