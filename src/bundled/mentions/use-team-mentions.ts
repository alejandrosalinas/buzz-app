import { AgentsContext, useAgentsSnapshot } from "../../features/agents/react";
import { visibleTeams } from "../../features/agents/visible-teams";
import { splitPartition } from "../../features/relay/partition";
import {
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  fullSession,
  type ComposerSession,
} from "../../features/messages/composer-session";
import type { useMentionChoices } from "./use-mention-choices";
import { mentionCandidates } from "./mention-candidates";
import { extendsName, normalizeName } from "../../features/search/person-match";
import type { RelaySession } from "../../features/relay/session";
import { mentionMatch } from "./mention-ranking";
import { typedPublicKey } from "../../shared/identity/public-key";

const empty = { status: "unavailable", entries: [] } as const;
type Catalog = Pick<
  ReturnType<NonNullable<RelaySession["channelKit"]>["snapshot"]>,
  "entries"
>;
/**
 * A saved team with the same or a longer name must not auto-select a person on
 * Space. An exact public key is not a name: no team name equals or continues it.
 */
export function teamBlocksSpace(
  catalog: Catalog,
  query: string,
  names: readonly string[] = [],
) {
  if (typedPublicKey(query) !== undefined) return false;
  const needle = normalizeName(query);
  const blocks = (name: string) =>
    normalizeName(name) === needle || extendsName(name, needle);
  return (
    names.some(blocks) ||
    catalog.entries.some(
      (entry) =>
        !entry.record.deleted &&
        entry.record.value.type === "team" &&
        blocks(entry.record.value.name),
    )
  );
}
const subscribeNone = () => () => {};
const snapshotNone = () => empty;

/** Saved teams are shortcuts to exact individual recipients, never new identities. */
export function useTeamMentions(
  session: ComposerSession,
  channelId: string,
  inviteAgents: boolean | undefined,
  query: string,
  model: ReturnType<typeof useMentionChoices>,
  open = true,
) {
  const roster = model.roster;
  const owner = useContext(AgentsContext);
  const snapshot = useAgentsSnapshot(owner);
  const origin =
    session.scope && splitPartition(session.scope)?.communityOrigin;
  const readSaved = useCallback(
    () => (owner ? visibleTeams(owner, origin || undefined) : []),
    [owner, origin],
  );
  const kit = fullSession(session)?.channelKit;
  const catalog = useSyncExternalStore(
    kit?.subscribe ?? subscribeNone,
    kit?.snapshot ?? snapshotNone,
  );
  useEffect(() => {
    if (open) kit?.ensure();
  }, [kit, open]);
  // readSaved is a live read at acceptance, not another subscribed store.
  const teams = useMemo(() => {
    // The service owns local persistence and confirmed synced copies. Neither
    // depends on the legacy catalog being available.
    void snapshot;
    return [
      ...readSaved().map((team) => ({
        ready: true,
        value: {
          id: `saved:${team.id}`,
          name: team.name,
          agents: team.members,
        },
        current: () => {
          const latest = readSaved().find((entry) => entry.id === team.id);
          return (
            !!latest &&
            latest.name === team.name &&
            latest.revision === team.revision &&
            latest.members.length === team.members.length &&
            latest.members.every((key, index) => key === team.members[index])
          );
        },
      })),
      ...catalog.entries.flatMap((entry) =>
        !entry.record.deleted && entry.record.value.type === "team"
          ? [
              {
                value: entry.record.value,
                ready: catalog.status === "ready",
                current: () => {
                  const fresh = kit?.snapshot();
                  return (
                    fresh?.status === "ready" &&
                    fresh.entries.some(
                      (next) =>
                        !next.record.deleted &&
                        next.record.value.type === "team" &&
                        next.record.value.id === entry.record.value.id &&
                        next.eventId === entry.eventId,
                    )
                  );
                },
              },
            ]
          : [],
      ),
    ];
  }, [readSaved, snapshot, catalog, kit]);
  const hasTeams = open && teams.length > 0;
  useEffect(() => {
    if (!hasTeams) return;
    const release = session.agentChoices.retain();
    session.agentChoices.ensure(true);
    return release;
  }, [session, hasTeams]);
  const key = JSON.stringify([
    session.scope,
    session.viewer,
    channelId,
    inviteAgents,
    query,
    open,
    !!roster,
  ]);
  const [installed, install] = useState<{
    session: ComposerSession;
    key: string;
    teams: ((typeof teams)[number] & { members: readonly string[] })[];
  }>();
  let rows =
    installed?.session === session && installed.key === key
      ? installed.teams
      : undefined;
  if (installed && !rows) install(undefined);
  if (open && !model.pending) {
    const members = new Set(
      roster?.map((person) => person.pubkey) ?? model.channel?.members ?? [],
    );
    const installedIds = new Set(rows?.map((team) => team.value.id));
    const added = teams
      .filter((team) => !installedIds.has(team.value.id) && team.ready)
      .filter(({ value }) =>
        Number.isFinite(
          mentionMatch(
            {
              label: value.name,
              aliases: [value.name],
              recipient: { pubkey: value.id, name: value.name },
              member: false,
              agent: true,
              owned: true,
              managed: false,
            },
            query,
          ),
        ),
      )
      .sort(
        (a, b) =>
          a.value.name.localeCompare(b.value.name) ||
          a.value.id.localeCompare(b.value.id),
      )
      .slice(0, 20 - (rows?.length ?? 0))
      .map((team) => ({
        ...team,
        members: team.value.agents.filter((key) => members.has(key)),
      }));
    if (!rows || added.length) {
      rows = [...(rows ?? []), ...added];
      install({ session, key, teams: rows });
    }
  }
  return useMemo(() => {
    void model; // Source revisions invalidate eligibility, not the installed row order.
    // Parent chooser subscribes to roster, profiles, agent choices and archives.
    // Read those same owners again at acceptance; saved keys grant no eligibility.
    const candidates = () =>
      mentionCandidates(
        session,
        channelId,
        inviteAgents,
        roster,
        session.agentChoices.snapshot().identities,
        owner?.joinable(),
      );
    // Only shown team rows read eligibility; a closed chooser builds none.
    const current = open && rows?.length ? candidates() : [];
    const eligible = new Map(current.map((c) => [c.recipient.pubkey, c]));
    const choices = (open ? (rows ?? []) : []).map(
      ({ value, current, members }) => {
        const recipients = value.agents.flatMap((key) => {
          const person = eligible.get(key)?.recipient;
          return person ? [{ pubkey: person.pubkey, name: person.name }] : [];
        });
        const disabled = !current()
          ? "Team changed or unavailable. Reopen to refresh."
          : members.some((key) => !eligible.get(key)?.member)
            ? "Channel membership changed. Reopen to review adding this team."
            : !value.agents.length
              ? "This team has no agents."
              : value.agents.length > 32
                ? "Teams can mention at most 32 agents."
                : recipients.length !== value.agents.length
                  ? "A team member is unavailable. Edit the team or refresh choices."
                  : undefined;
        const outside = recipients.filter(
          (person) => !eligible.get(person.pubkey)?.member,
        ).length;
        const channel = session.channels
          .list()
          .channels.find((channel) => channel.id === channelId);
        const consequence = !outside
          ? ""
          : channel?.channelType === "dm"
            ? `${outside} not in DM · Will not be notified`
            : inviteAgents
              ? `Adds ${outside} to ${channel && channel.channelType !== "solo" ? "channel" : "chat"} when you send`
              : `${outside} not in channel`;
        return {
          id: `team:${value.id}`,
          name: value.name,
          recipients,
          disabled,
          detail:
            disabled ??
            [`Saved team · ${recipients.length} agents`, consequence]
              .filter(Boolean)
              .join(" · "),
          canSelect: () => {
            if (disabled || !current()) return false;
            const now = new Map(
              candidates().map((c) => [c.recipient.pubkey, c]),
            );
            return recipients.every((person) => {
              const choice = now.get(person.pubkey);
              return (
                choice?.recipient.name === person.name &&
                (!members.includes(person.pubkey) || choice.member)
              );
            });
          },
        };
      },
    );
    // Keep an installed stale row recognizable (including multi-word queries)
    // until the person refreshes it, rather than making Enter fall through.
    const names = [
      ...new Set([...teams, ...(rows ?? [])].map(({ value }) => value.name)),
    ];
    return {
      choices,
      includeLegacy: hasTeams,
      names,
      blocksSpace: teamBlocksSpace(catalog, query, names),
      readNames: () => readSaved().map((team) => team.name),
      status:
        open && (catalog.status === "idle" || catalog.status === "loading")
          ? "Loading legacy teams…"
          : open && catalog.status === "error"
            ? "Could not load legacy teams. Retry to refresh."
            : undefined,
      canRetry: open && catalog.status === "error",
      retry: () => void kit?.refresh(),
    };
  }, [
    session,
    channelId,
    inviteAgents,
    roster,
    model,
    catalog,
    teams,
    rows,
    open,
    query,
    kit,
    hasTeams,
    readSaved,
    owner,
  ]);
}
