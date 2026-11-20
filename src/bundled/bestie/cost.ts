// The Bestie's cost for its tab: what the Usage plugin would show for this one
// agent over the last week, computed when the tab opens from the agent type's
// own `usage` read. Nothing is stored; it is an estimate, not a bill.
import type { Agent, Agents } from "../../features/agents/service";
import { loadPrices } from "../usage/pricing";
import { since, stats, sum, type Total } from "../usage/stats";

export const COST_DAYS = 7;

/** The week's cost, oldest day first. */
export type WeekCost = Readonly<{
  days: readonly Readonly<{ start: number; cost: Total }>[];
  total: Total;
}>;

/** Whether the agent's sessions can be read here: it runs on this device and
 * its type reports usage. */
export const readsUsage = (agents: Pick<Agents, "types">, agent: Agent) =>
  agent.place === "here" &&
  !!agents.types().find((type) => type.key === agent.type)?.usage;

/** The last `COST_DAYS` days of the agent's cost, today included. Rejects when
 * the read does; without price data, costs the harness did not record read as
 * unknown rather than wrong. */
export async function weekCost(
  agents: Pick<Agents, "types">,
  agent: Agent,
  signal: AbortSignal,
  now = Date.now(),
): Promise<WeekCost> {
  const read = agents.types().find((type) => type.key === agent.type)?.usage;
  if (!read || agent.place !== "here") throw new Error("No usage");
  // Usage's window, not just the week: a harness that shares one read
  // between concurrent callers keeps only what the first one asked for.
  const [sessions] = await Promise.all([
    read(agent, { since: since(now), signal }),
    loadPrices().catch(() => {}),
  ]);
  const week = stats(
    [{ agent, harness: agent.type, sessions }],
    now,
    COST_DAYS,
  );
  return {
    days: week.days.map((day) => ({
      start: day.start,
      cost: sum(day.costs.values()),
    })),
    total: week.cost,
  };
}
