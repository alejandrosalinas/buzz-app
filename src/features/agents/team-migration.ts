// Moving teams saved only on this device into their members' community, once
// its config channels are up. The move itself is an import (`adopt`) of the
// team under a deterministic id, so a rerun after a crash or disconnect lands
// in the same channel. The journal saves each move's community before its
// first write, whether its last try failed, and whether this device's own
// create of the relay team landed: only then may the move write over what is
// there.
import type { AgentStore } from "./store";
import type { TeamSent } from "./team-ops";

export const TEAM_MOVES_KEY = "buzz.agents.teams.migration.v1";

/** A move under way: its community, fixed before the first write.
 * `attempted`: what a try sent in its first save, which may have created the
 * relay team; none once that save was definitely refused. `created` once this
 * device's create is confirmed. */
export type TeamMove = Readonly<{
  community: string;
  failed?: true;
  attempted?: TeamSent;
  created?: true;
}>;

/** Why a team stays on this device. */
export type LocalReason = "communities" | "unsupported" | "failed";

/** Where a team or agent's config lives, for its sync status line.
 * `conflict`: a different copy of the team is already in that community. */
export type SyncState =
  | Readonly<{ synced: string }>
  | Readonly<{ local: LocalReason | undefined }>
  | Readonly<{ conflict: string }>;

/** Where a team of `members` moves: the one community every member is the
 * owner's agent in, unless the team's move began in another. Staying, the
 * community it would move to, if any. */
export function moveHome(
  members: readonly string[],
  homesOf: (pubkey: string) => readonly string[],
  move: TeamMove | undefined,
):
  | Readonly<{ home: string }>
  | Readonly<{ stay: "communities" }>
  | Readonly<{ stay: "none"; home?: string }> {
  const each = members.map(homesOf);
  const homes = new Set(each.flat());
  if (homes.size > 1) return { stay: "communities" };
  const [found] = homes;
  const home = move?.community ?? found;
  if (!found || found !== home || each.some((h) => !h.includes(found)))
    return { stay: "none", ...(home && { home }) };
  return { home };
}

/** The moves under way, by local team id. Writes run one at a time, each
 * saving what memory holds then; a refused one puts back only its own
 * entry, as last saved. */
export class TeamMoves {
  private moves: Record<string, TeamMove> = {};
  private saved: Record<string, TeamMove> = {};
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: AgentStore) {
    try {
      const stored = JSON.parse(storage.get(TEAM_MOVES_KEY) ?? "null") as {
        version?: unknown;
        moves?: Record<string, unknown>;
      } | null;
      if (stored?.version === 1 && stored.moves)
        for (const [id, move] of Object.entries(stored.moves))
          if (typeof (move as TeamMove | null)?.community === "string")
            this.moves[id] = move as TeamMove;
    } catch {
      /* Malformed local data: moves start again from their teams. */
    }
    this.saved = this.moves;
  }
  get = (id: string): TeamMove | undefined => this.moves[id];
  /** Saves `move` for team `id`, or that it is done; settles once saved. */
  set(id: string, move: TeamMove | undefined) {
    this.moves = withMove(this.moves, id, move);
    const write = this.writing.then(async () => {
      const next = this.moves;
      try {
        await this.storage.set(
          TEAM_MOVES_KEY,
          JSON.stringify({ version: 1, moves: next }),
        );
        this.saved = next;
      } catch (error) {
        // Memory never trusts what storage didn't take.
        this.moves = withMove(this.moves, id, this.saved[id]);
        throw error;
      }
    });
    this.writing = write.catch(() => {});
    return write;
  }
}

const withMove = (
  moves: Record<string, TeamMove>,
  id: string,
  move: TeamMove | undefined,
) => {
  const { [id]: _, ...rest } = moves;
  return move ? { ...rest, [id]: move } : rest;
};

const REASONS = {
  team: {
    communities: "Its agents are in different communities.",
    unsupported: "This community's relay doesn't sync teams.",
    failed: "Moving it to the community failed; Buzz will try again.",
  },
  agent: {
    unsupported: "This community's relay doesn't sync agent settings.",
    failed: "Copying it to the community failed; Buzz will try again.",
  },
} satisfies {
  team: Record<LocalReason, string>;
  agent: Record<Exclude<LocalReason, "communities">, string>;
};

/** A sync status line: where it lives, and why it is only here. */
export function syncText(
  state: SyncState | undefined,
  of: "team" | "agent",
): SyncLine | undefined {
  if (!state) return undefined;
  const host = (relay: string) => relay.replace(/^\w+:\/\//, "");
  if ("synced" in state) return { title: `Synced in ${host(state.synced)}` };
  const reason =
    "conflict" in state
      ? `A different copy of this team is already in ${host(state.conflict)}.`
      : state.local &&
        (REASONS[of] as Partial<Record<LocalReason, string>>)[state.local];
  return { title: "Only on this Mac", ...(reason && { reason }) };
}
export type SyncLine = Readonly<{ title: string; reason?: string }>;
