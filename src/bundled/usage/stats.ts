// What Usage shows, from the session snapshots each agent's type reports: the
// period's cost, tokens and sessions, and the previous period's cost. A count
// the harness did not record is unknown, never zero: totals add what is known
// and say when something went uncounted.
import type {
  Agent,
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { claudeModel, estimateCost } from "./pricing";

/** One agent's sessions, as its type's `usage` read them. */
export type AgentUsage = Readonly<{
  agent: Agent;
  /** The agent type's key. */
  harness: string;
  sessions: readonly SessionUsage[];
}>;
/** The sum of the known values: `partial` when some went uncounted, without
 * a `value` when none was known. */
export type Total = Readonly<{ value?: number; partial: boolean }>;
export type Day = Readonly<{
  start: number;
  /** Known cost by harness. */
  costs: ReadonlyMap<string, Total>;
}>;
export type Stats = Readonly<{
  cost: Total;
  /** The previous `days`' cost, when they were read. */
  previousCost?: Total;
  /** Input, output and cache tokens together. */
  tokens: Total;
  output: Total;
  /** Cache reads as a share of the prompt tokens; undefined before any. */
  cacheHit?: Total;
  /** Sessions active in the period, whether or not they recorded usage. */
  sessions: number;
  days: readonly Day[];
  /** Agents with sessions in the period, costliest first. */
  agents: readonly Readonly<{
    agent: Agent;
    harness: string;
    /** The model most of its known cost went to. */
    model?: string;
    cost: Total;
    sessions: number;
  }>[];
  /** The period's cost by the agent and the timer or watch of its that
   * started each session, costliest first; the sessions that none started or
   * whose harness does not say last, with no `agent` or `wake`. Empty when no
   * session says. */
  routines: readonly Readonly<{
    agent?: Agent;
    wake?: string;
    cost: Total;
    sessions: number;
  }>[];
  /** The period's costliest sessions. */
  costliest: readonly Readonly<{
    agent: Agent;
    harness: string;
    session: SessionUsage;
    cost: Total;
    tokens: number;
  }>[];
}>;

const COSTLIEST = 5;
const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** A `Total` being added up. */
class Sum {
  value = 0;
  known = false;
  partial = false;
  add(value: number | undefined, partial = false) {
    if (value === undefined) this.partial = true;
    else {
      this.value += value;
      this.known = true;
      this.partial ||= partial;
    }
  }
  /** Adds another sum as it stands, its unknowns too. */
  include(other: Sum) {
    this.value += other.value;
    this.known ||= other.known;
    this.partial ||= other.partial;
  }
  total(): Total {
    return this.known || !this.partial
      ? { value: this.value, partial: this.partial }
      : { partial: true };
  }
}
const known = (total: Total) => total.value ?? 0;

/** The totals added up, unknown when none was known. */
export function sum(totals: Iterable<Total>): Total {
  const result = new Sum();
  for (const total of totals) result.add(total.value, total.partial);
  return result.total();
}

/** The request's cost as the harness recorded it, else as estimated. */
const price = (observation: UsageObservation) =>
  observation.cost
    ? { usd: observation.cost.usd, partial: false }
    : estimateCost(observation.model, observation.tokens);

/** Local midnight `days` days before `at`'s. */
export function dayStart(at: number, days = 0) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/** The days of history read once for every period: Claude Code keeps 30
 * days of transcripts by default, so older history undercounts. */
export const READ_DAYS = 30;
/** Where reads start: the `READ_DAYS` days ending today. */
export const since = (now: number) => dayStart(now, READ_DAYS - 1);
/** Whether the `days` before a period of `days` were read too. */
export const comparable = (days: number) => 2 * days <= READ_DAYS;

/** A new read's snapshots over those kept from earlier, as `SessionUsage`
 * says: a complete snapshot replaces the session's earlier one; an incomplete
 * one leaves it, with the new read's gaps; sessions the read missed stay. */
export function merge(
  kept: readonly SessionUsage[],
  read: readonly SessionUsage[],
): SessionUsage[] {
  const sessions = new Map(kept.map((session) => [session.id, session]));
  for (const session of read) {
    const earlier = sessions.get(session.id);
    sessions.set(
      session.id,
      earlier && session.gaps.length
        ? { ...earlier, gaps: session.gaps }
        : session,
    );
  }
  return [...sessions.values()];
}

/** `unread` names the harnesses of agents whose latest read failed, so their
 * usage may be missing. */
export function stats(
  usage: readonly AgentUsage[],
  now: number,
  days: number,
  unread: ReadonlySet<string> = new Set(),
): Stats {
  const start = dayStart(now, days - 1);
  const previous = dayStart(now, 2 * days - 1);
  const dayStarts = Array.from({ length: days }, (_, index) =>
    dayStart(now, days - 1 - index),
  );
  const dayCosts = dayStarts.map(() => new Map<string, Sum>());
  const dayIndex = (at: number) => {
    let index = dayStarts.length - 1;
    while (index > 0 && (dayStarts[index] ?? 0) > at) index -= 1;
    return index;
  };
  const dayOf = (at: number) => dayCosts[dayIndex(at)];
  /** Marks `harness`'s cost partial on each day from the one `at` is in. */
  const uncertain = (harness: string, at = start) => {
    for (const day of dayCosts.slice(dayIndex(at))) {
      const spent = day.get(harness) ?? new Sum();
      spent.partial = true;
      day.set(harness, spent);
    }
  };
  const cost = new Sum();
  const previousCost = new Sum();
  const tokens = new Sum();
  const output = new Sum();
  const read = new Sum();
  const prompt = new Sum();
  const agents: Stats["agents"][number][] = [];
  const sessions: Stats["costliest"][number][] = [];
  // Keyed by agent and wake: each agent names its own timers and watches.
  const routines = new Map<string, Routine>();
  for (const { agent, harness, sessions: list } of usage) {
    const models = new Map<string, number>();
    const agentCost = new Sum();
    let agentSessions = 0;
    for (const session of list) {
      const active = session.lastAt >= start;
      const gap = session.gaps.length > 0;
      const sessionCost = new Sum();
      let count = 0;
      for (const observation of session.observations) {
        if (observation.at < previous) continue;
        const spent = price(observation);
        if (observation.at < start) {
          previousCost.add(spent?.usd, spent?.partial || gap);
          continue;
        }
        sessionCost.add(spent?.usd, spent?.partial);
        if (spent?.usd !== undefined)
          models.set(
            observation.model,
            (models.get(observation.model) ?? 0) + spent.usd,
          );
        const day = dayOf(observation.at);
        if (day) {
          const spentThatDay = day.get(harness) ?? new Sum();
          spentThatDay.add(spent?.usd, spent?.partial);
          day.set(harness, spentThatDay);
        }
        for (const kind of KINDS) {
          tokens.add(observation.tokens[kind]);
          count += observation.tokens[kind] ?? 0;
        }
        output.add(observation.tokens.output);
        const { input, cacheRead, cacheWrite } = observation.tokens;
        if (
          input === undefined ||
          cacheRead === undefined ||
          cacheWrite === undefined
        ) {
          read.add(undefined);
          continue;
        }
        read.add(cacheRead);
        prompt.add(input + cacheRead + cacheWrite);
      }
      // Or in the period before, when the session began then.
      if (gap && session.startedAt < start && session.lastAt >= previous)
        previousCost.partial = true;
      if (!active) continue;
      if (gap) {
        // What the read missed may be in the period.
        for (const sum of [sessionCost, tokens, output, read])
          sum.partial = true;
        uncertain(harness, session.startedAt);
      }
      agentSessions += 1;
      agentCost.include(sessionCost);
      // A watch's catch-up turn is that watch's work too.
      const wake = session.wake?.replace(/^catch-up\//, "watch/");
      const id = wake === undefined ? "" : JSON.stringify([agent.pubkey, wake]);
      const routine = routines.get(id) ?? {
        ...(wake !== undefined && { agent, wake }),
        cost: new Sum(),
        sessions: 0,
      };
      routine.cost.include(sessionCost);
      routine.sessions += 1;
      routines.set(id, routine);
      sessions.push({
        agent,
        harness,
        session,
        cost: sessionCost.total(),
        tokens: count,
      });
    }
    if (!agentSessions) continue;
    const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0];
    cost.include(agentCost);
    agents.push({
      agent,
      harness,
      ...(model ? { model } : {}),
      cost: agentCost.total(),
      sessions: agentSessions,
    });
  }
  if (unread.size)
    for (const sum of [
      cost,
      previousCost,
      tokens,
      output,
      read,
      ...[...routines.values()].map((routine) => routine.cost),
    ])
      sum.partial = true;
  for (const harness of unread) uncertain(harness);
  const hit = read.total();
  return {
    cost: cost.total(),
    ...(comparable(days) ? { previousCost: previousCost.total() } : {}),
    tokens: tokens.total(),
    output: output.total(),
    // Every prompt token is uncached input, a cache read or a cache write.
    ...(prompt.value
      ? {
          cacheHit: {
            value: known(hit) / prompt.value,
            partial: hit.partial,
          },
        }
      : read.partial
        ? { cacheHit: { partial: true } }
        : {}),
    sessions: sessions.length,
    days: dayStarts.map((day, index) => ({
      start: day,
      costs: new Map(
        [...(dayCosts[index] ?? [])].map(([key, spent]) => [
          key,
          spent.total(),
        ]),
      ),
    })),
    agents: agents.sort(
      (a, b) => known(b.cost) - known(a.cost) || b.sessions - a.sessions,
    ),
    routines: routined(routines),
    costliest: sessions
      .sort((a, b) => known(b.cost) - known(a.cost) || b.tokens - a.tokens)
      .slice(0, COSTLIEST),
  };
}

type Routine = { agent?: Agent; wake?: string; cost: Sum; sessions: number };

/** The routines, those a timer or watch started costliest first, then the
 * rest; none when no session says which started it. */
function routined(routines: ReadonlyMap<string, Routine>): Stats["routines"] {
  if (![...routines.values()].some(({ wake }) => wake !== undefined)) return [];
  return [...routines.values()]
    .map(({ cost, ...routine }) => ({ ...routine, cost: cost.total() }))
    .sort(
      (a, b) =>
        Number(a.wake === undefined) - Number(b.wake === undefined) ||
        known(b.cost) - known(a.cost) ||
        b.sessions - a.sessions,
    );
}

/** A Claude model id as its name, e.g. `claude-opus-5-5` as Claude Opus 5.5;
 * other ids unchanged. */
export function modelName(model: string) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(claudeModel(model));
  if (!match?.[1] || !match[2]) return model;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `Claude ${family} ${match[2].replace("-", ".")}`;
}
