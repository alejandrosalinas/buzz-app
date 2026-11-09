import { useProfileGeneration } from "../../features/relay/react";
import { TeamMentionAvatars } from "./TeamMentionAvatars";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTeamMentions } from "./use-team-mentions";
import { MENTION_ROWS, useMentionChoices } from "./use-mention-choices";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  outsideMentionDetail,
  remoteMentionDetail,
} from "./mention-candidates";
import { matchesMentionQuery, pendingMentionQuery } from "./mention-query";
import { continuedMention, matchingMentions } from "./mention-ranking";
import { resolveSpaceMention } from "./resolve-space-mention";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
import { mentionTerminator } from "../../features/messages/mention-draft";
import { AgentsContext } from "../../features/agents/react";
import { avatarMedia } from "../../shared/avatar-source";
import {
  PROFILE_CACHE_BASE,
  profileRosterRoom,
} from "../../features/relay/budget";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
// `failed` outlives the per-keystroke mount: a failed read stays reported, with
// Retry, until a later read of those names succeeds or the demand resets.
type Demand = {
  generation: number;
  evictions: number;
  ids: Set<string>;
  failed: Set<string>;
};
const demands = new WeakMap<ComposerSession, Demand>();
const failureListeners = new WeakMap<ComposerSession, Set<() => void>>();
function settle(
  session: ComposerSession,
  demand: Demand,
  ids: readonly string[],
  failed: boolean,
) {
  // A reset demand (purge, eviction) starts over; its old outcome is stale.
  if (demands.get(session) !== demand) return;
  for (const id of ids) {
    // A batch that failed may still have answered for some of its names.
    if (failed && !session.profiles.snapshot().has(id)) demand.failed.add(id);
    else demand.failed.delete(id);
  }
  for (const listener of failureListeners.get(session) ?? []) listener();
}
export function MentionCompletion({
  session,
  scope,
  channelId,
  threadRootId,
  inviteAgents,
  query,
  publish,
}: ComposerCompletionProps) {
  // The host remounts this provider on every keystroke. One `@` token in one
  // composer is the chooser lifetime that keeps the last directory page.
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    query.query,
    JSON.stringify(["inline", scope, channelId, threadRootId, query.start]),
  );
  const { profiles, agents, channel, list, choices } = model;
  const teams = useTeamMentions(
    session,
    channelId,
    inviteAgents,
    query.query,
    model,
  );
  const selected = useContext(SelectedMentionContext);
  const roster = useContext(DraftMentionRoster);
  const community = useContext(AgentsContext);
  const draftRoster = roster?.recipients;
  const members = draftRoster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKey = members.join(":");
  const parentAdmission = !!channel && channel.channelType !== "solo";
  // The shared budget is append-only for this query, including late teams and
  // directory people. Neither source may displace an already displayed choice.
  const shown = useRef<{
    session: ComposerSession;
    key: string;
    ids: string[];
  }>(undefined);
  const [attempt, retry] = useState(0);
  // A failed read reports only names still unresolved: a member loaded since
  // (by any reader) or known unnamed, or one no longer in the roster, is not.
  const error = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const listeners = failureListeners.get(session) ?? new Set();
        failureListeners.set(session, listeners);
        listeners.add(listener);
        const unsubscribe = session.profiles.subscribe(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
      [session],
    ),
    () => {
      const failed = demands.get(session)?.failed;
      if (draftRoster || !failed?.size) return false;
      const loaded = session.profiles.snapshot();
      const unnamed = session.profiles.unnamed?.();
      return members.some(
        (key) => failed.has(key) && !loaded.has(key) && !unnamed?.has(key),
      );
    },
  );
  const profileGeneration = useProfileGeneration(session.profiles);
  // Evictions also count cancelled reads, so a shrink asks again for this roster.
  const readEvictions = () => session.profiles.evictions?.() ?? 0;
  const evictions = useSyncExternalStore(
    session.profiles.subscribe,
    readEvictions,
    readEvictions,
  );
  useEffect(() => {
    if (draftRoster) return;
    session.channels.ensureList();
    // An access purge, an eviction or a cancelled read drops names, so its
    // reads start a new budget. Names still loaded cost no read when requested
    // again.
    let demand = demands.get(session);
    if (
      demand?.generation !== profileGeneration ||
      demand.evictions !== evictions
    ) {
      demand = {
        generation: profileGeneration,
        evictions,
        ids: new Set(),
        failed: new Set(),
      };
      demands.set(session, demand);
      for (const listener of failureListeners.get(session) ?? []) listener();
    }
    const requested = demand.ids;
    // An open channel reserves room for its whole roster (ConversationChannel).
    // The base stays free for names outside this roster.
    const limit = profileRosterRoom(
      session.profiles.limit?.() ?? PROFILE_CACHE_BASE,
    );
    // A member a completed read found no profile for stays known unnamed, so
    // reopening the menu does not read it again; Retry does.
    const unnamed = session.profiles.unnamed?.();
    const roster = memberKey.split(":").filter(Boolean);
    // Only this roster's earlier requests use its allowance: another channel's
    // members must not stop this one from loading.
    const asked = roster.filter((id) => requested.has(id)).length;
    const ids = roster
      .filter((id) => attempt > 0 || (!requested.has(id) && !unnamed?.has(id)))
      .slice(0, attempt > 0 ? limit : Math.max(0, limit - asked));
    if (!ids.length) return;
    for (const id of ids) requested.add(id);
    // Retry is explicit: a foreground read rereads known absences. The
    // outcome belongs to the session's demand, not this keystroke's mount.
    const current = demand;
    void session.profiles
      .ensure(ids, attempt > 0 ? "foreground" : "background")
      .then(
        () => settle(session, current, ids, false),
        () => settle(session, current, ids, true),
      );
  }, [session, memberKey, attempt, draftRoster, profileGeneration, evictions]);
  useEffect(() => {
    const members = memberKey ? memberKey.split(":") : [];
    const admitted =
      matchesMentionQuery(
        query.query,
        // Both rules need a name that starts with the query.
        [
          ...matchingMentions(model.candidates, query.query),
          ...choices,
        ].flatMap((c) => [...c.aliases, c.label]),
      ) ||
      (teams.names.length > 0 && matchesMentionQuery(query.query, teams.names));
    const matching = admitted ? choices : [];
    const matchingTeams = admitted ? teams.choices : [];
    const membershipMissing =
      !draftRoster && (!inviteAgents || !!channel) && !channel?.members;
    const membershipError = !draftRoster && list.error;
    // A multi-word query that continues no known name is prose, not a search.
    if (
      !admitted &&
      !model.pending &&
      !model.directory.loading &&
      !model.directory.error
    ) {
      const withdraw = publish({ items: [] });
      return () => {
        if (withdraw) withdraw();
      };
    }
    // Each shown row asks; one pass instead of one scan per row.
    const memberKeys = new Set(members);
    const available = [
      ...matching.map(
        ({
          recipient,
          label,
          elsewhere,
          disabled,
          otherName,
          agent,
          execution,
        }) => {
          const detail =
            disabled ??
            // The other verified name sits beside the detail.
            ([
              otherName,
              remoteMentionDetail(execution),
              model.managedBy.get(recipient.pubkey),
              memberKeys.has(recipient.pubkey)
                ? undefined
                : inviteAgents
                  ? parentAdmission
                    ? "Adds to channel"
                    : "Adds to chat"
                  : outsideMentionDetail(channel, elsewhere),
            ]
              .filter(Boolean)
              .join(" · ") ||
              undefined);
          return {
            disabled,
            // Every key that ends a typed name selects only the exact name.
            canSelect: (key: string) =>
              (!mentionTerminator(key) || !teams.blocksSpace) &&
              model.canSelect(recipient.pubkey, mentionTerminator(key)),
            id: recipient.pubkey,
            label,
            agent,
            ...(detail ? { detail } : {}),
            preview: (
              <Avatar
                alt=""
                fallback={label}
                src={avatarMedia(
                  profiles.get(recipient.pubkey)?.picture ??
                    model.directory.people.find(
                      (person) => person.pubkey === recipient.pubkey,
                    )?.picture,
                  session.media,
                )}
                size="default"
                shape={agent ? "squircle" : "circle"}
              />
            ),
            edit: { mention: recipient },
          };
        },
      ),
      ...matchingTeams.map((team) => ({
        id: team.id,
        label: team.name,
        detail: team.detail,
        disabled: team.disabled,
        canSelect: team.canSelect,
        preview: (
          <TeamMentionAvatars session={session} recipients={team.recipients} />
        ),
        edit: team.disabled
          ? { text: `@${team.name}` }
          : { mentions: team.recipients },
      })),
    ];
    const key = JSON.stringify([
      channelId,
      inviteAgents,
      query.start,
      query.query,
    ]);
    const ids =
      shown.current?.session === session && shown.current.key === key
        ? shown.current.ids
        : [];
    const known = new Set(ids);
    // Reserve space for teams already ready at first publication. Once shown,
    // the budget is append-only, regardless of which source arrives next.
    const additions = ids.length
      ? available.filter((item) => !known.has(item.id))
      : [
          ...available.slice(
            0,
            Math.min(matching.length, MENTION_ROWS - matchingTeams.length),
          ),
          ...available.slice(matching.length),
        ];
    const next = [...ids, ...additions.map((item) => item.id)].slice(
      0,
      MENTION_ROWS,
    );
    shown.current = { session, key, ids: next };
    const byId = new Map(available.map((item) => [item.id, item]));
    // Space is undecided, not declined, only while evidence is still arriving:
    // members, names or agents loading, or the directory search waiting or
    // running. Then the host may hold the name and let the resolver apply
    // section 5 once the choice set is known. A name already known to continue
    // the query declines Space whatever else arrives: the next word may
    // complete that longer name, so Space stays prose and the query open. The
    // known set is every candidate the chooser has, not only the shown rows:
    // members or roster, offered agents and the directory rows received so
    // far, the same set `spaceId` is decided over. Anything else is prose.
    const undecided =
      admitted &&
      model.spaceId === undefined &&
      !teams.blocksSpace &&
      (model.pending || model.directory.loading) &&
      pendingMentionQuery(query.query) &&
      // A continuing name starts with the query: only indexed matches can have one.
      !continuedMention(
        matchingMentions(model.candidates, query.query),
        query.query,
      );
    const withdraw = publish({
      spaceId: teams.blocksSpace ? undefined : model.spaceId,
      ...(undecided
        ? {
            spacePending: {
              name: query.query,
              resolve: (signal: AbortSignal) =>
                resolveSpaceMention(
                  session,
                  {
                    channelId,
                    inviteAgents,
                    roster,
                    selected,
                    elsewhere: community?.joinable(),
                    teamNames: teams.readNames,
                  },
                  query.query,
                  signal,
                ),
            },
          }
        : {}),
      items: next.flatMap((id) => byId.get(id) ?? []),
      ...(model.pending
        ? { status: "Loading recipients…" }
        : model.directory.error
          ? { status: model.directory.error }
          : !admitted
            ? {}
            : model.archives.status === "error"
              ? { status: "Archive information unavailable. Retry to refresh." }
              : agents.status === "error" || agents.error
                ? { status: "Could not load agents. Retry to refresh." }
                : admitted && membershipMissing
                  ? { status: "Channel membership unavailable." }
                  : admitted && membershipError
                    ? { status: "Could not refresh channel membership." }
                    : // Only a failed read: a member who never set a name is
                      // a complete answer, not an error.
                      error
                      ? {
                          status:
                            "Could not load some names. Retry to refresh.",
                        }
                      : model.directory.loading
                        ? { status: "Searching community…" }
                        : teams.status
                          ? { status: teams.status }
                          : {}),
      ...((admitted && teams.canRetry) ||
      model.directory.error ||
      (admitted &&
        (model.archives.status === "error" ||
          agents.status === "error" ||
          agents.error ||
          membershipMissing ||
          membershipError ||
          error))
        ? {
            retry: () => {
              teams.retry();
              model.directory.retry();
              void session.agentChoices.refresh(
                !!inviteAgents || teams.includeLegacy,
              );
              void session.archives?.refresh();
              retry((value) => value + 1);
              if (membershipMissing || membershipError)
                session.channels.refreshList?.();
            },
          }
        : {}),
    });
    return () => {
      if (withdraw) withdraw();
    };
  }, [
    session,
    publish,
    query.query,
    query.start,
    channelId,
    memberKey,
    model,
    teams,
    profiles,
    list,
    agents,
    error,
    choices,
    channel,
    draftRoster,
    roster,
    inviteAgents,
    parentAdmission,
    selected,
    community,
  ]);
  return null;
}
