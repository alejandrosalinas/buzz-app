import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { SafeMarkdown } from "../../features/messages/SafeMarkdown";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import type { Profile } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  NoteIcon,
  InfoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  NOTE_LIMIT,
  emptyNotePage,
  readNotePage,
  noteHeads,
  noteKey,
  noteTag,
  noteTitle,
} from "./collection";
import styles from "./NotesPage.module.css";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { PageProps } from "../../features/pages/service";
import type { Navigation } from "../../features/navigation/controller";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import type { NavigationScope } from "../../features/navigation/targets";
import { notesRoute, notesTarget, type NotesRoute } from "./routes";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
const noSubscribe = () => () => {};
const noPanels: readonly RegisteredPanel[] = [];
const emptyPanels = () => noPanels;
type NotesNavigation = Pick<PageProps, "navigation"> & {
  navigator?: Navigation | undefined;
  panels?: Panels | undefined;
};

function NotesPanel({
  children,
  refresh,
  refreshRef,
  loading = false,
}: {
  children: ReactNode;
  refresh?: (() => void) | undefined;
  refreshRef?: Ref<HTMLButtonElement>;
  loading?: boolean;
}) {
  return (
    <Panel aria-label="Shared notes">
      <div className={styles.page}>
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Shared notes"
              icon={<NoteIcon size="1rem" />}
            >
              <PopoverRoot>
                <PopoverTrigger
                  render={
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={<InfoIcon size="1rem" aria-hidden="true" />}
                      aria-label="About shared notes"
                      title="About shared notes"
                    />
                  }
                />
                <PopoverPopup>
                  <PopoverTitle>About shared notes</PopoverTitle>
                  <PopoverDescription
                    render={<div className={styles.description} />}
                  >
                    <p>
                      Shared notes are reusable documents saved by your agents
                      and other agents in this community—recipes, prompts,
                      research and guides you can return to across
                      conversations. Ask the agent who saved a note to update
                      it, or ask your agent to save its own copy.
                    </p>
                    <p>
                      Anyone with access to this community’s relay can read
                      shared notes. Don’t include secrets or private
                      information.
                    </p>
                  </PopoverDescription>
                </PopoverPopup>
              </PopoverRoot>
            </PanelHeaderLabel>
          }
          actions={
            refresh && (
              <>
                {loading && (
                  <span role="status" className="text-caption text-subtle">
                    Reading notes…
                  </span>
                )}
                <IconButton
                  hint="familiar"
                  ref={refreshRef}
                  size="sm"
                  variant="ghost"
                  aria-label="Refresh notes"
                  title="Refresh notes"
                  icon={<ArrowsClockwiseIcon size="1rem" />}
                  onClick={refresh}
                />
              </>
            )
          }
        />
        <div className={styles.body}>{children}</div>
      </div>
    </Panel>
  );
}

export function NotesPage({
  relay,
  navigation,
  navigator,
  panels,
}: { relay: RelayData } & NotesNavigation) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const scope = useMemo(
    () =>
      connection.viewer && connection.scope
        ? {
            viewer: connection.viewer,
            communityOrigin: connection.scope.slice(
              0,
              -(connection.viewer.length + 1),
            ),
          }
        : undefined,
    [connection.viewer, connection.scope],
  );
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope !== undefined ||
      connection.status !== "ready" ||
      !scope
    )
      return;
    request.resolve({ ...request.target, scope });
  }, [request, connection.status, scope]);
  if (connection.status === "ready")
    return (
      <NotesCommunity
        key={`${connection.scope}:${connection.generation}`}
        session={connection.session}
        scope={scope}
        navigation={request}
        navigator={navigator}
        panels={panels}
      />
    );
  return (
    <NotesPanel>
      <p role="status">
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to read notes."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error}</p>
          <Button onClick={() => relay.tryAgain()}>Retry connection</Button>
        </>
      )}
    </NotesPanel>
  );
}

export function NotesCommunity({
  session,
  scope,
  navigation,
  navigator,
  panels,
}: {
  session: RelaySession;
  scope?: NavigationScope | undefined;
} & NotesNavigation) {
  const choices = useAgentChoices(session);
  const resolveName = useIdentityNames(session.names);
  const candidates = useMemo(
    () => choices.identities.map((agent) => agent.pubkey),
    [choices.identities],
  );
  const agents = choices.identities.map((agent) => ({
    pubkey: agent.pubkey,
    picture: agent.avatar,
    name: resolveName(
      agent.pubkey,
      agent.managedName ?? agent.name,
      candidates,
      choices.identities,
    ),
  }));
  // Existing content includes archived identities; selecting a new recipient does not.
  const authors = choices.identities
    .map((agent) => agent.pubkey)
    .sort()
    .join(":");
  return (
    <NoteCollection
      key={authors}
      session={session}
      scope={scope}
      navigation={navigation}
      navigator={navigator}
      panels={panels}
      authors={authors}
      agents={agents}
      pending={choices.pending}
      complete={choices.complete}
      inventoryError={choices.error}
      refreshAgents={() => {
        void session.agentChoices.refresh().catch(() => {});
      }}
    />
  );
}

function NoteCollection({
  session,
  scope,
  authors,
  agents: ownedAgents,
  pending,
  complete,
  inventoryError,
  refreshAgents,
  navigation,
  navigator,
  panels,
}: NotesNavigation & {
  session: RelaySession;
  scope?: NavigationScope | undefined;
  authors: string;
  agents: readonly {
    pubkey: string;
    name: string;
    picture?: string | undefined;
  }[];
  pending: boolean;
  complete: boolean;
  inventoryError: string | undefined;
  refreshAgents(): void;
}) {
  const [request, setRequest] = useState({ version: 0, more: false });
  const pages = useRef({ owned: emptyNotePage(), shared: emptyNotePage() });
  const sharedAgents = useRef(new Map<string, Profile>());
  const [result, setResult] = useState<{
    notes: EventData[];
    loading: boolean;
    partial: boolean;
    error?: string | undefined;
    sharedError?: string | undefined;
  }>({ notes: [], loading: true, partial: false });
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const agents = useMemo(() => {
    const others = [...new Set(result.notes.map((note) => note.pubkey))].filter(
      (pubkey) =>
        !ownedAgents.some((agent) => agent.pubkey === pubkey) &&
        sharedAgents.current.has(pubkey),
    );
    const candidates = [...ownedAgents.map((agent) => agent.pubkey), ...others];
    return [
      ...ownedAgents.map((agent) => ({ ...agent, owned: true })),
      ...others.map((pubkey) => ({
        pubkey,
        picture: (profiles.get(pubkey) ?? sharedAgents.current.get(pubkey))
          ?.picture,
        name: resolveName(
          pubkey,
          (profiles.get(pubkey) ?? sharedAgents.current.get(pubkey))?.name ??
            formatPublicKey(pubkey) ??
            pubkey,
          candidates,
        ),
        owned: false,
      })),
    ].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }) || a.pubkey.localeCompare(b.pubkey),
    );
  }, [ownedAgents, result.notes, profiles, resolveName]);
  const [author, setAuthor] = useState("");
  const [opened, setOpened] = useState<EventData[]>([]);
  const [selected, setSelected] = useState("");
  const split = usePanelSplit(session.scope, "notes", 448, 320);
  const origin = useRef<HTMLElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const preserveControlFocus = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node) refreshRef.current?.focus();
    };
  }, []);
  const folderGrid = useRef<HTMLElement>(null);
  const folderTitle = useRef<HTMLHeadingElement>(null);
  const [profile, setProfile] = useState("");
  useSyncExternalStore(
    panels?.subscribe ?? noSubscribe,
    panels?.snapshot ?? emptyPanels,
  );
  const profileAddress = profileTarget(profile, { agent: true });
  const profilePanel = profileAddress
    ? panels?.resolve(profileAddress)
    : undefined;
  const profileKey = `profile:${profile}`;
  const noteActive = opened.some((note) => noteKey(note) === selected)
    ? selected
    : noteKeyOrEmpty(opened[0]);
  const active =
    profilePanel && (selected === profileKey || !noteActive)
      ? profileKey
      : noteActive;

  useEffect(() => {
    const controller = new AbortController();
    setResult((old) => ({
      ...old,
      loading: true,
      sharedError: undefined,
    }));
    const options = { signal: controller.signal, fresh: request.version > 0 };
    const previous = request.more
      ? pages.current
      : { owned: emptyNotePage(), shared: emptyNotePage() };
    const owned = authors
      ? readNotePage(
          session,
          { kinds: [30023], authors: authors.split(":"), limit: NOTE_LIMIT },
          previous.owned,
          options,
        )
      : Promise.resolve({ ...emptyNotePage(), done: true });
    const shared = readNotePage(
      session,
      { kinds: [30023], limit: NOTE_LIMIT },
      previous.shared,
      options,
    ).then(async (page) => {
      controller.signal.throwIfAborted();
      const known = request.more
        ? new Map(sharedAgents.current)
        : new Map<string, Profile>();
      const previousIds = new Set(previous.shared.notes.map((note) => note.id));
      const newAuthors = [
        ...new Set(
          page.notes
            .filter((note) => !previousIds.has(note.id))
            .map((note) => note.pubkey),
        ),
      ];
      // Enrich only this page, and retain accepted classification across directory eviction.
      for (let offset = 0; offset < newAuthors.length; offset += NOTE_LIMIT) {
        const batch = newAuthors.slice(offset, offset + NOTE_LIMIT);
        await session.profiles.ensure(batch, "background");
        controller.signal.throwIfAborted();
        for (const pubkey of batch) {
          const profile = session.profiles.snapshot().get(pubkey);
          if (profile?.isAgent) known.set(pubkey, profile);
          else known.delete(pubkey);
        }
      }
      return { page, agents: known };
    });
    void Promise.allSettled([owned, shared]).then(
      ([ownResult, sharedResult]) => {
        if (controller.signal.aborted) return;
        if (ownResult.status === "fulfilled")
          pages.current.owned = ownResult.value;
        if (sharedResult.status === "fulfilled") {
          pages.current.shared = sharedResult.value.page;
          sharedAgents.current = sharedResult.value.agents;
        }
        const ownAuthors = authors ? authors.split(":") : [];
        const sharedNotes = pages.current.shared.notes.filter(
          (note) =>
            !ownAuthors.includes(note.pubkey) &&
            sharedAgents.current.has(note.pubkey),
        );
        const notes = noteHeads(
          [...pages.current.owned.notes, ...sharedNotes],
          [...ownAuthors, ...sharedNotes.map((note) => note.pubkey)],
        );
        setResult({
          notes,
          loading: false,
          partial: !pages.current.owned.done || !pages.current.shared.done,
          error:
            ownResult.status === "rejected"
              ? "Couldn’t read notes. Try again."
              : undefined,
          sharedError:
            sharedResult.status === "rejected"
              ? "Other agents’ notes could not be checked. Refresh to try again."
              : undefined,
        });
        setAuthor((current) =>
          notes.some((note) => note.pubkey === current) ? current : "",
        );
        setOpened((old) =>
          old.map(
            (note) =>
              notes.find((next) => noteKey(next) === noteKey(note)) ?? note,
          ),
        );
      },
    );
    return () => controller.abort();
  }, [session, authors, request]);

  const restored = useRef<string | undefined>(undefined);
  const [routeError, setRouteError] = useState("");
  const visit = (route: NotesRoute, replace = false) => {
    if (
      !navigation ||
      !navigator ||
      navigation.signal.aborted ||
      navigation.target.kind !== "page" ||
      navigation.target.pluginId !== "buzz.relay-notes" ||
      navigation.target.pageId !== "notes" ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    void navigator.open(notesTarget(navigation.target, route), {
      replace,
      focus: "preserve",
    });
  };
  useEffect(() => {
    if (
      !navigation ||
      navigation.signal.aborted ||
      restored.current === navigation.entryId ||
      result.loading ||
      result.error ||
      pending
    )
      return;
    const route =
      navigation.target.kind === "page"
        ? notesRoute(navigation.target.route?.params)
        : undefined;
    setRouteError("");
    if (
      route?.author &&
      !agents.some((agent) => agent.pubkey === route.author)
    ) {
      setRouteError("This agent folder is unavailable.");
      return;
    }
    setAuthor(route?.author ?? "");
    if (route?.profile) {
      if (!agents.some((agent) => agent.pubkey === route.profile)) {
        setRouteError("This agent profile is unavailable.");
        return;
      }
      setProfile(route.profile);
      setSelected(`profile:${route.profile}`);
    }
    if (route?.note === "") {
      setOpened([]);
      setSelected("");
    } else if (route?.note) {
      const note =
        result.notes.find((item) => noteKey(item) === route.note) ??
        opened.find((item) => noteKey(item) === route.note);
      if (note) {
        setOpened((old) =>
          old.some((item) => noteKey(item) === route.note)
            ? old
            : [...old, note],
        );
        setSelected(route.note);
      } else {
        setRouteError(
          "This note isn’t in the loaded collection. Refresh to check again.",
        );
        return;
      }
    }
    restored.current = navigation.entryId;
  }, [
    navigation,
    result.loading,
    result.error,
    result.notes,
    pending,
    agents,
    opened,
  ]);

  const openProfile = (pubkey: string) => {
    setProfile(pubkey);
    setSelected(`profile:${pubkey}`);
    visit({ author, profile: pubkey }, true);
  };
  const closeProfile = () => {
    setProfile("");
    setSelected(noteActive);
    visit({ author, note: noteActive }, true);
  };
  const openLink = (url: string) => {
    const target = scope && buzzLinkTarget(url, scope);
    if (!target || !navigator) return false;
    void navigator.open(target);
    return true;
  };
  const canProfile = (pubkey: string) =>
    !!panels?.resolve(profileTarget(pubkey, { agent: true }) ?? "");
  const refresh = () => {
    setRequest((old) => ({ version: old.version + 1, more: false }));
  };
  const close = (key: string) => {
    setOpened((old) => old.filter((note) => noteKey(note) !== key));
    const next =
      active === key
        ? opened.find((note) => noteKey(note) !== key)
        : opened.find((note) => noteKey(note) === active);
    visit(
      active === profileKey && profilePanel
        ? { author, profile }
        : { author, note: noteKeyOrEmpty(next) },
      true,
    );
    if (opened.length === 1 && !profilePanel)
      requestAnimationFrame(() => {
        (origin.current?.isConnected
          ? origin.current
          : refreshRef.current
        )?.focus();
      });
  };
  const name = (note: EventData) =>
    agents.find((agent) => agent.pubkey === note.pubkey)?.name ?? note.pubkey;
  const visible = result.notes.filter((note) => note.pubkey === author);
  const ownedNotes = result.notes.filter((note) =>
    ownedAgents.some((agent) => agent.pubkey === note.pubkey),
  );
  const folders = agents.flatMap((agent) => {
    const notes = result.notes.filter((note) => note.pubkey === agent.pubkey);
    return notes.length
      ? [{ ...agent, count: notes.length, latest: notes[0]?.created_at ?? 0 }]
      : [];
  });
  const folder = folders.find((agent) => agent.pubkey === author);
  const openFolder = (pubkey: string) => {
    visit({
      author: pubkey,
      ...(active === profileKey && profilePanel
        ? { profile }
        : active
          ? { note: active }
          : {}),
    });
    setAuthor(pubkey);
    requestAnimationFrame(() => {
      if (pubkey) folderTitle.current?.focus();
      else
        folderGrid.current
          ?.querySelector<HTMLElement>(`[data-agent="${author}"]`)
          ?.focus();
    });
  };
  const renderNoteGrid = (notes: readonly EventData[]) => (
    <div className={styles.notes}>
      {notes.map((note) => (
        <article key={noteKey(note)} className={styles.noteItem}>
          <SurfaceButton
            className={styles.noteCard}
            aria-label={`Open ${noteTitle(note)} by ${name(note)}`}
            aria-current={active === noteKey(note) ? "true" : undefined}
            aria-pressed={opened.some(
              (item) => noteKey(item) === noteKey(note),
            )}
            onClick={(event) => {
              origin.current = event.currentTarget;
              if (opened.some((item) => noteKey(item) === noteKey(note))) {
                close(noteKey(note));
              } else {
                setOpened((old) => [...old, note]);
                setSelected(noteKey(note));
                visit({ author, note: noteKey(note) }, true);
              }
            }}
          >
            <span className={styles.noteHeading}>
              <span
                className={`${styles.noteTitle} text-label`}
                title={noteTitle(note)}
              >
                {noteTitle(note)}
              </span>
              <span className="text-caption text-secondary">
                <NoteIdentifier note={note} separator={false} />
              </span>
            </span>
            <span className={`${styles.summary} text-body-sm text-subtle`}>
              {noteTag(note, "summary") ||
                note.content.slice(0, 600).replace(/[#*_`]/g, "")}
            </span>
          </SurfaceButton>
          <span className={`${styles.byline} text-caption text-secondary`}>
            <NoteAuthor
              name={name(note)}
              picture={avatarMedia(
                agents.find((agent) => agent.pubkey === note.pubkey)?.picture,
                session.media,
              )}
              open={
                canProfile(note.pubkey)
                  ? () => openProfile(note.pubkey)
                  : undefined
              }
            />{" "}
            · <NoteTime note={note} />
          </span>
        </article>
      ))}
    </div>
  );
  const readerOpen = !!opened.length || !!profilePanel;
  return (
    <div
      className={styles.split}
      ref={split.ref}
      data-side={readerOpen ? "" : undefined}
    >
      <div className={styles.main}>
        <NotesPanel
          refresh={refresh}
          refreshRef={refreshRef}
          loading={result.loading}
        >
          {author && (
            <div className={styles.folderHeader}>
              <IconButton
                hint="familiar"
                variant="ghost"
                aria-label="Back to folders"
                title="Back to folders"
                icon={<ArrowLeftIcon size="1rem" aria-hidden="true" />}
                onClick={() => openFolder("")}
              />
              <h2 className="text-heading" ref={folderTitle} tabIndex={-1}>
                {folder?.name}
              </h2>
            </div>
          )}
          {routeError && <p role="alert">{routeError}</p>}
          {pending && <p role="status">Loading your agents…</p>}
          {!pending && !complete && !inventoryError && (
            <div role="status">
              <p>
                Some agents could not be checked. Showing notes from available
                agents.
              </p>
              <Button onClick={refreshAgents}>Retry agents</Button>
            </div>
          )}
          {inventoryError && (
            <div role="alert">
              <p>{inventoryError}</p>
              <Button onClick={refreshAgents}>Retry agents</Button>
            </div>
          )}
          {result.sharedError && (
            <p role="status" className="text-body-sm text-secondary">
              {result.sharedError}
            </p>
          )}
          {result.error && (
            <div role="alert">
              <p>{result.error}</p>
              <Button
                ref={preserveControlFocus}
                loading={result.loading}
                onClick={() =>
                  setRequest((old) => ({ ...old, version: old.version + 1 }))
                }
              >
                Retry notes
              </Button>
            </div>
          )}
          {!pending &&
            complete &&
            !inventoryError &&
            !result.loading &&
            !result.error &&
            !(author ? visible.length : folders.length) && (
              <EmptyState
                icon={<NoteIcon size="1.5rem" />}
                title="No notes yet"
                description={
                  author
                    ? "This folder has no notes in the loaded collection. Go back to folders to browse another agent."
                    : "Ask one of your agents to save a recipe or reference as a shared note, then refresh."
                }
              />
            )}
          {!author ? (
            <section
              className={styles.folderGroups}
              aria-label="Agent folders"
              ref={folderGrid}
            >
              {[
                { owned: true, label: "Your agents" },
                { owned: false, label: "Other agents" },
              ].map((group) => {
                const items = folders.filter(
                  (agent) => agent.owned === group.owned,
                );
                // Folders start in alphabetical order; retain that order for ties.
                if (!group.owned) items.sort((a, b) => b.latest - a.latest);
                return items.length ? (
                  <Fragment key={group.label}>
                    <section aria-label={group.label}>
                      <h2 className="text-label">{group.label}</h2>
                      <div className={styles.folders}>
                        {items.map((agent) => (
                          <SurfaceButton
                            key={agent.pubkey}
                            className={styles.folderCard}
                            aria-label={`Open ${agent.name} folder`}
                            data-agent={agent.pubkey}
                            onClick={() => openFolder(agent.pubkey)}
                          >
                            <span className={styles.folderAvatar}>
                              <Avatar
                                src={avatarMedia(agent.picture, session.media)}
                                alt=""
                                fallback={agent.name}
                                size="fill"
                                shape="squircle"
                              />
                            </span>
                            <span className={`${styles.folderName} text-label`}>
                              {agent.name}
                            </span>
                            <span className="text-caption text-subtle">
                              {agent.count}{" "}
                              {agent.count === 1
                                ? "shared note"
                                : "shared notes"}
                            </span>
                          </SurfaceButton>
                        ))}
                      </div>
                    </section>
                    {group.owned && renderNoteGrid(ownedNotes)}
                  </Fragment>
                ) : null;
              })}
            </section>
          ) : (
            renderNoteGrid(visible)
          )}
          {result.partial && (
            <div>
              <Button
                size="sm"
                ref={preserveControlFocus}
                loading={result.loading}
                onClick={() =>
                  setRequest((old) => ({
                    version: old.version + 1,
                    more: true,
                  }))
                }
              >
                Load older notes
              </Button>
            </div>
          )}
        </NotesPanel>
      </div>
      {readerOpen && (
        <aside className={styles.side} aria-label="Note reader">
          {split.handle}
          <Panel aria-label="Note details">
            <PanelWorkspace
              label="Open notes"
              value={active}
              select={(key) => {
                setSelected(key);
                visit(
                  key === profileKey
                    ? { author, profile }
                    : { author, note: key },
                  true,
                );
              }}
              items={[
                ...opened.map((note) => ({
                  id: noteKey(note),
                  label: noteTitle(note),
                  icon: (
                    <Avatar
                      src={avatarMedia(
                        agents.find((agent) => agent.pubkey === note.pubkey)
                          ?.picture,
                        session.media,
                      )}
                      alt=""
                      fallback={name(note)}
                      size="fill"
                      shape="squircle"
                    />
                  ),
                  close: () => close(noteKey(note)),
                  content: (
                    <NoteBody
                      note={note}
                      session={session}
                      openLink={openLink}
                      openProfile={
                        canProfile(note.pubkey)
                          ? () => openProfile(note.pubkey)
                          : undefined
                      }
                      author={name(note)}
                      picture={avatarMedia(
                        agents.find((agent) => agent.pubkey === note.pubkey)
                          ?.picture,
                        session.media,
                      )}
                    />
                  ),
                })),
                ...(profilePanel && profileAddress
                  ? [
                      {
                        id: profileKey,
                        label: `${agents.find((agent) => agent.pubkey === profile)?.name ?? "Agent"} · Profile`,
                        close: closeProfile,
                        content: (
                          <profilePanel.component
                            target={profileAddress}
                            close={closeProfile}
                          />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Panel>
        </aside>
      )}
    </div>
  );
}

const noteKeyOrEmpty = (note: EventData | undefined) =>
  note ? noteKey(note) : "";

function NoteIdentifier({
  note,
  separator = true,
}: {
  note: EventData;
  separator?: boolean;
}) {
  const identifier = noteTag(note, "d");
  return identifier ? (
    <>
      {separator && " · "}
      <code
        className={`${styles.identifier} text-mono font-mono`}
        title={`Saved as ${identifier}`}
      >
        {identifier}
      </code>
    </>
  ) : null;
}

function NoteTime({ note }: { note: EventData }) {
  const date = new Date(note.created_at * 1000);
  const days = Math.floor((Date.now() / 1000 - note.created_at) / 86400);
  // The shared recency ladder switches to calendar dates after a week; notes
  // keep older timestamps relative too, with the exact date in the title.
  const label =
    days >= 7
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(
          -days,
          "day",
        )
      : relativeTimestamp(note.created_at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    >
      {label}
    </time>
  );
}

function NoteBody({
  note,
  session,
  openLink,
  author,
  picture,
  openProfile,
}: {
  openProfile?: (() => void) | undefined;
  note: EventData;
  session: RelaySession;
  openLink(url: string): boolean;
  author: string;
  picture?: string | undefined;
}) {
  const plain =
    note.content.length > MAX_MARKDOWN_LENGTH ||
    scanMarkdown(note.content).tooDeep;
  return (
    <article className={styles.document}>
      <h2 className="text-heading">{noteTitle(note)}</h2>
      <p className={`${styles.byline} text-caption text-secondary`}>
        <NoteAuthor name={author} picture={picture} open={openProfile} /> ·
        Updated <NoteTime note={note} />
        <NoteIdentifier note={note} />
      </p>
      <div className={styles.markdown}>
        {plain ? (
          <pre>{note.content}</pre>
        ) : (
          <SafeMarkdown
            content={note.content}
            openLink={openLink}
            session={session}
          />
        )}
      </div>
    </article>
  );
}

function NoteAuthor({
  name,
  picture,
  open,
}: {
  name: string;
  picture?: string | undefined;
  open?: (() => void) | undefined;
}) {
  const identity = (
    <>
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="compact"
        shape="squircle"
      />
      <span>{name}</span>
    </>
  );
  return open ? (
    <Button
      variant="plain"
      size="inline"
      aria-label={`View ${name} profile`}
      onClick={open}
    >
      {identity}
    </Button>
  ) : (
    <span className={styles.byline}>{identity}</span>
  );
}
