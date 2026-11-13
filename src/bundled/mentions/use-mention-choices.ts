import { useNamePreference } from "../../features/profiles/name-preference";
import { useMentionDirectory } from "./useMentionDirectory";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import type { Agent } from "../../features/agents/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { AgentsContext, useAgentsSnapshot } from "../../features/agents/react";
import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import { archivedMention } from "../../features/messages/mention-admission";
import { mentionHistory } from "../../features/messages/mention-history";
import {
  directoryChanges,
  managedByDetail,
  mentionCandidates,
} from "./mention-candidates";
import { useListedChannel } from "../../features/relay/listed-channel";
import { useNamesRevision } from "../../features/identity-names/react";
import {
  useVerifiedNames,
  withVerifiedNames,
  type VerifiedPerson,
} from "../../features/profiles/useVerifiedNames";
import {
  exactMention,
  matchingMentions,
  rankMentions,
  type MentionChoice,
} from "./mention-ranking";
type Person = VerifiedPerson<
  ReturnType<typeof useMentionDirectory>["people"][number]
>;
/** The chooser shows at most this many member and agent rows. */
export const MENTION_ROWS = 50;
const activityFields = new Set(["preview", "lastActivityAt"]);
/** Equal but for the preview and activity time a new message changes. */
function sameMentionFields(a: ChannelSummary, b: ChannelSummary) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if (
      !activityFields.has(key) &&
      !Object.is(a[key as keyof ChannelSummary], b[key as keyof ChannelSummary])
    )
      return false;
  return true;
}
const none: readonly Person[] = [];
// Derived once per cached candidate list (see mentionCandidates), so a
// keystroke reuses labels and keys instead of renaming every member.
const labeled = new WeakMap<
  readonly unknown[],
  { sources: readonly unknown[]; choices: readonly MentionChoice[] }
>();
const keySets = new WeakMap<readonly unknown[], ReadonlySet<string>>();
const keyMaps = new WeakMap<readonly object[], ReadonlyMap<string, object>>();
const byKey = <T extends { recipient: { pubkey: string } }>(
  choices: readonly T[],
) => {
  const cached = keyMaps.get(choices) as ReadonlyMap<string, T> | undefined;
  if (cached) return cached;
  const map = new Map(choices.map((c) => [c.recipient.pubkey, c]));
  keyMaps.set(choices, map);
  return map;
};
// Directory people that change the choice set, interned by content: each
// settled page and each carried merge is a new array with the same people.
// Their order changes no choice (ranking and naming sort by key), so it is
// not part of the content.
// Directory people that change the choice set, interned by content: each
// settled page and each carried merge is a new array with the same people.
// Their order changes no choice (ranking and naming sort by key), so it is
// not part of the content.
const pages = new WeakMap<ComposerSession, Map<string, readonly Person[]>>();
function page(session: ComposerSession, people: readonly Person[]) {
  const key = JSON.stringify(
    [...people]
      .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0))
      .map(
        ({
          pubkey,
          name,
          isAgent,
          username,
          fullName,
          profileNames,
          ownerPubkey,
        }) => [
          pubkey,
          name,
          !!isAgent,
          username ?? "",
          fullName ?? "",
          profileNames ?? [],
          ownerPubkey,
        ],
      ),
  );
  const seen = pages.get(session) ?? new Map<string, readonly Person[]>();
  pages.set(session, seen);
  const kept = seen.get(key) ?? people;
  seen.delete(key);
  seen.set(key, kept);
  if (seen.size > 8) seen.delete(seen.keys().next().value ?? "");
  return kept;
}
/** The choice set under the labels users see: one naming scope per set, so
 * namesakes are qualified. Directory people name only keys no other source knows. */
export function namedCandidates(
  session: ComposerSession,
  channelId: string,
  invite: boolean | undefined,
  roster: readonly MentionRecipient[] | undefined,
  selected: readonly MentionRecipient[],
  people: readonly Person[],
  elsewhere?: readonly Pick<Agent, "pubkey" | "name" | "relay">[],
): readonly MentionChoice[] {
  const local = mentionCandidates(
    session,
    channelId,
    invite,
    roster,
    undefined,
    elsewhere,
  );
  // Only directory people that change the choice set; a page of members rebuilds nothing.
  const known = session.names?.scope();
  const changed = directoryChanges(
    byKey(local),
    people,
    session.profiles.snapshot(),
    (key) => !!known?.(key),
  );
  const outside = changed.length ? page(session, changed) : none;
  const candidates = outside.length
    ? mentionCandidates(session, channelId, invite, roster, outside, elsewhere)
    : local;
  // Drafts recreate their recipient array on every edit; its names and keys
  // are the naming fact, not its identity or positions.
  const sources = [
    JSON.stringify(selected.map(({ pubkey, name }) => [pubkey, name])),
    outside,
    session.names?.snapshot(),
  ];
  const hit = labeled.get(candidates);
  if (hit?.sources.every((source, i) => source === sources[i]))
    return hit.choices;
  const keys = [
    ...new Set([
      ...candidates.map((c) => c.recipient.pubkey),
      ...selected.map((p) => p.pubkey),
    ]),
  ];
  // Directory pages are menu-local, not cached profiles. Name them only when no
  // other source knows the key, so namesakes in this choice set are qualified,
  // or when a verified name replaced the one the shared profiles show: the
  // label must be the name the mention inserts.
  const shared = session.profiles.snapshot();
  const pageVerified = new Set(
    outside
      .filter(
        (person) =>
          !!person.profileNames && !shared.get(person.pubkey)?.verified,
      )
      .map((person) => person.pubkey),
  );
  const facts = [
    ...outside
      .filter(
        (person) => !known?.(person.pubkey) || pageVerified.has(person.pubkey),
      )
      .map(({ pubkey, name, isAgent, ownerPubkey }) => ({
        pubkey,
        name,
        ...(isAgent ? { isAgent } : {}),
        ...(ownerPubkey ? { ownerPubkey } : {}),
      })),
    ...selected,
  ];
  // One naming scope per choice set, not one normalization per row.
  const name = session.names?.scope(keys, facts);
  const choices: readonly MentionChoice[] = candidates.map((choice) => {
    const key = choice.recipient.pubkey;
    // Without a naming policy the scope falls back to the public profile,
    // which must not outrank the verified name the mention inserts.
    const found = name?.(key);
    const named =
      found?.source === "public-profile" && pageVerified.has(key)
        ? undefined
        : found;
    return {
      ...choice,
      label: named?.name ?? choice.recipient.name,
      qualifier: named?.qualifier,
    };
  });
  labeled.set(candidates, { sources, choices });
  return choices;
}
/** What the chooser knows about the choice set's completeness. */
export type SpaceEvidence = {
  /** Members or offered agents are still loading. */
  pending: boolean;
  /**
   * A member's name is neither known nor known to be absent, or the member
   * list is still loading.
   */
  missingNames: boolean | undefined;
  /** The directory search for this query settled with no more pages. */
  complete: boolean;
};
/**
 * Space (README section 5): once every member is named, an exact local name
 * selects at once. Any other exact name needs the full choice set: while the
 * directory search runs, failed, or has more pages, a namesake may be missing.
 */
export function spaceMention(
  all: readonly MentionChoice[],
  local: ReadonlySet<string>,
  query: string,
  { pending, missingNames, complete }: SpaceEvidence,
) {
  if (pending) return undefined;
  const choices = matchingMentions(all, query);
  return (
    (missingNames
      ? undefined
      : exactMention(choices, query, (c) => local.has(c.recipient.pubkey))) ??
    (complete ? exactMention(choices, query) : undefined)
  );
}
/**
 * One installed key list per opening/query. Evidence stays live, order does not.
 * Local rows install first; directory rows only append after them.
 */
export function useMentionChoices(
  session: ComposerSession,
  channelId: string,
  invite: boolean | undefined,
  query: string,
  /** One chooser opening; see useMentionDirectory. */
  lifetime: string,
  open = true,
  /** Toolbar audience at opening; toggles must not reorder installed rows. */
  addressed?: ReadonlySet<string>,
) {
  const draft = useContext(DraftMentionRoster);
  const roster = draft?.recipients;
  const selected = useContext(SelectedMentionContext);
  const agents = useAgentChoices(session, !!invite && open);
  // The owner's agents in their other communities; the snapshot is the revision.
  const community = useContext(AgentsContext);
  const revision = useAgentsSnapshot(community);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const unnamed = useSyncExternalStore(
    session.profiles.subscribe,
    () => session.profiles.unnamed?.(),
    () => session.profiles.unnamed?.(),
  );
  // Previews replace the list on every message; read this channel and the
  // roster's state, not the whole list. A message also replaces this channel's
  // summary with a new preview and activity time, which mentions never read:
  // keep the previous summary while every other field is unchanged.
  const kept = useRef<ChannelSummary>(undefined);
  const channel = useListedChannel(session.channels, channelId, (c) => {
    if (!c || !kept.current || !sameMentionFields(kept.current, c))
      kept.current = c;
    return kept.current;
  });
  const listStatus = useSyncExternalStore(
    session.channels.subscribeList,
    () => session.channels.list().status,
    () => session.channels.list().status,
  );
  const listError = useSyncExternalStore(
    session.channels.subscribeList,
    () => session.channels.list().error,
    () => session.channels.list().error,
  );
  const list = useMemo(
    () => ({ status: listStatus, error: listError }),
    [listStatus, listError],
  );
  const directory = useMentionDirectory(
    session,
    channel,
    query,
    open && !roster && !invite,
    lifetime,
  );
  const archives = useMentionArchives(session, open);
  // Labels come from names scopes directly: watch every name change while open.
  const names = useNamesRevision(session.names, open);
  const [installed, install] = useState<{
    session: ComposerSession;
    key: string;
    rows: MentionChoice[];
    /** Directory people behind installed outside rows, kept while later pages load. */
    people: readonly Person[];
  }>();
  const key = JSON.stringify([channelId, invite, query, open, !!roster]);
  const same = installed?.session === session && installed.key === key;
  const carried = same ? installed.people : none;
  // Searched people the community verified carry their verified names.
  const verified = useVerifiedNames(session, directory.people, {
    key: query,
    settled: !directory.loading,
  });
  const preference = useNamePreference();
  const searched = useMemo(
    () => withVerifiedNames(directory.people, verified, profiles, preference),
    [directory.people, verified, profiles, preference],
  );
  const people = useMemo(() => {
    if (!carried.length) return searched;
    const known = new Set(searched.map((person) => person.pubkey));
    return [
      ...searched,
      ...carried.filter((person) => !known.has(person.pubkey)),
    ];
  }, [searched, carried]);
  const current = useCallback(
    () =>
      namedCandidates(
        session,
        channelId,
        invite,
        roster,
        selected,
        people,
        community?.joinable(),
      ),
    [session, channelId, invite, roster, selected, people, community],
  );
  // Keys known without the directory search: members and agent choices.
  const localKeys = useCallback(() => {
    const local = mentionCandidates(
      session,
      channelId,
      invite,
      roster,
      undefined,
      community?.joinable(),
    );
    const cached = keySets.get(local);
    if (cached) return cached;
    const keys = new Set(local.map((c) => c.recipient.pubkey));
    keySets.set(local, keys);
    return keys;
  }, [session, channelId, invite, roster, community]);
  const { candidates, local } = useMemo(() => {
    // Source revisions invalidate the projection; selection reads them again synchronously.
    void profiles;
    void list;
    void channel;
    void agents;
    void archives;
    void names;
    void revision;
    // A closed or disabled chooser shows nothing, so it names nothing.
    if (!open)
      return {
        candidates: [] as readonly MentionChoice[],
        local: new Set<string>() as ReadonlySet<string>,
      };
    return { candidates: current(), local: localKeys() };
  }, [
    open,
    current,
    localKeys,
    profiles,
    list,
    channel,
    agents,
    archives,
    names,
    revision,
  ]);
  // Install membership first; agent discovery must not hide known members.
  const membersPending =
    !roster &&
    (list.status === "idle" || list.status === "loading") &&
    !channel?.members;
  const pending =
    membersPending ||
    !!draft?.pending ||
    (!roster && !!invite && agents.pending && agents.status !== "ready");
  let rows = same ? installed.rows : undefined;
  if (!same && installed) install(undefined);
  // Only choices the query can match; ranking reads no others.
  // "Managed by" names only an attested owner. Attestation settles after the
  // profile lands and notifies without a new snapshot, so read it here, not
  // in the cached candidates.
  const agentKeys = candidates.flatMap((c) =>
    c.agent ? [c.recipient.pubkey] : [],
  );
  const attested = useSyncExternalStore(session.profiles.subscribe, () =>
    agentKeys
      .flatMap((key) => {
        const owner = session.profiles.owner?.(key);
        return owner && owner !== session.viewer ? [`${key}=${owner}`] : [];
      })
      .join(","),
  );
  const owners = useMemo(
    () =>
      new Map(
        attested
          ? attested
              .split(",")
              .map((pair) => pair.split("=") as [string, string])
          : [],
      ),
    [attested],
  );
  const ownerKeys = [...new Set(owners.values())].sort().join(":");
  useEffect(() => {
    if (ownerKeys)
      void session.profiles
        .ensure(ownerKeys.split(":"), "background")
        .catch(() => {});
  }, [session, ownerKeys]);
  const managedBy = useMemo(
    () =>
      new Map(
        [...owners].flatMap(([key, owner]) => {
          const label = managedByDetail(owner, session.viewer, profiles);
          return label ? [[key, label] as const] : [];
        }),
      ),
    [owners, profiles, session.viewer],
  );
  const matches = matchingMentions(candidates, query);
  // Ranking needs only the rows that can show.
  const normalRank = (choices: readonly MentionChoice[]) =>
    rankMentions(
      choices,
      query,
      mentionHistory(session, channelId),
      (key) => session.presence?.status(key) ?? "unknown",
      MENTION_ROWS,
    );
  // Browse addressed agents before the cap; typed searches keep match quality first.
  const rank = (choices: readonly MentionChoice[]) =>
    addressed?.size && !query.trim()
      ? [
          ...normalRank(
            choices.filter((c) => addressed.has(c.recipient.pubkey)),
          ),
          ...normalRank(
            choices.filter((c) => !addressed.has(c.recipient.pubkey)),
          ),
        ].slice(0, MENTION_ROWS)
      : normalRank(choices);
  // Ranked only when read: a full set of installed rows never needs outside choices.
  let outsideRows: readonly MentionChoice[] | undefined;
  const outside = () =>
    (outsideRows ??= open
      ? rank(matches.filter((c) => !local.has(c.recipient.pubkey)))
      : []);
  // A member a completed read found no profile for has no name to be a namesake.
  // While the member list loads, no member's name is known.
  const missingNames =
    open &&
    (membersPending ||
      channel?.members?.some(
        (key) => !profiles.has(key) && !unnamed?.has(key),
      ));
  if (open && !rows && !membersPending) {
    const ranked = rank(matches.filter((c) => local.has(c.recipient.pubkey)));
    if (
      ranked.length ||
      outside().length ||
      (!pending &&
        !missingNames &&
        (!invite || !agents.pending) &&
        list.status === "ready" &&
        !agents.error &&
        agents.status !== "error")
    ) {
      rows = ranked;
      install({ session, key, rows, people: none });
    }
  }
  if (rows && rows.length < MENTION_ROWS) {
    // Append-only: late invited agents and directory pages never move shown rows.
    // Member-list changes keep their installed set until the query changes.
    const shown = new Set(rows.map((row) => row.recipient.pubkey));
    const added = (invite ? rank(matches.filter((c) => c.agent)) : outside())
      .filter((c) => !shown.has(c.recipient.pubkey))
      .slice(0, MENTION_ROWS - rows.length);
    if (added.length) {
      const addedKeys = new Set(added.map((c) => c.recipient.pubkey));
      rows = [...rows, ...added];
      install({
        session,
        key,
        rows,
        people: [
          ...carried,
          ...people.filter(
            (person) =>
              addedKeys.has(person.pubkey) &&
              !carried.some((kept) => kept.pubkey === person.pubkey),
          ),
        ],
      });
    }
  }
  const complete =
    !directory.loading &&
    !directory.error &&
    !directory.more &&
    !directory.tooShort;
  return useMemo(() => {
    const evidence = { pending, missingNames, complete };
    const live = byKey(candidates);
    const choices = (rows ?? []).map((row) => {
      const now = live.get(row.recipient.pubkey);
      const reason = now
        ? row.member && !now.member
          ? "Channel membership changed. Reopen to review adding this recipient."
          : undefined
        : archivedMention(session, row.recipient.pubkey)
          ? "Archived"
          : "No longer available. Change your search to refresh choices.";
      return {
        ...(now ?? row),
        disabled: reason,
        member: now?.member ?? row.member,
      };
    });
    return {
      choices,
      directory: { ...directory, people },
      profiles,
      managedBy,
      list,
      agents,
      channel,
      roster,
      candidates,
      pending,
      missingNames,
      archives,
      spaceId: spaceMention(candidates, local, query, evidence),
      canSelect: (pubkey: string, space = false) => {
        const fresh = current();
        return (
          fresh.some(
            (c) =>
              c.recipient.pubkey === pubkey &&
              (!rows?.find((row) => row.recipient.pubkey === pubkey)?.member ||
                c.member),
          ) &&
          (!space ||
            spaceMention(fresh, localKeys(), query, evidence) === pubkey)
        );
      },
    };
  }, [
    session,
    rows,
    directory,
    people,
    candidates,
    local,
    localKeys,
    missingNames,
    archives,
    profiles,
    managedBy,
    list,
    agents,
    channel,
    roster,
    pending,
    query,
    current,
    complete,
  ]);
}
