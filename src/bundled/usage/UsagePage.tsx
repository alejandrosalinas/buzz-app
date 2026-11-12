import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Agent,
  Agents,
  SessionUsage,
} from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ChartBarIcon,
  InfoIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Select } from "../../shared/design-system/ui/Select";
import { readView, writeView } from "../../shared/view-state";
import { agentTarget } from "../agents/routes";
import styles from "./Usage.module.css";
import { DailyCostChart, type Series } from "./DailyCostChart";
import { amount, cost, count, percent } from "./format";
import { loadPrices } from "./pricing";
import {
  type AgentUsage,
  merge,
  modelName,
  since,
  stats,
  type Total,
} from "./stats";

const RANGES = [7, 30];
/** The period shown until another is chosen. */
const DEFAULT_DAYS = 30;
/** How long after a failed read it is tried once more, before it is reported:
 * a read can fail while the computer is busy, as when the app starts. */
const RETRY_MS = 500;
/** The chart's series colors. */
const SERIES = 4;
const ALL = "all";

type Filters = { days: number; agent: string; harness: string };
const filtersKey = "usage:filters";
/** Saved choices are per device/viewer/community; a field that is missing or
 * not one of its kind uses its default. Without a scope, none are kept. */
function readFilters(scope: string | undefined): Filters {
  const saved = scope ? readView<unknown>(scope, filtersKey, undefined) : {};
  const field = (key: keyof Filters): unknown =>
    saved && typeof saved === "object"
      ? (saved as Record<string, unknown>)[key]
      : undefined;
  const agent = field("agent");
  const harness = field("harness");
  return {
    days: RANGES.find((range) => range === field("days")) ?? DEFAULT_DAYS,
    agent: typeof agent === "string" ? agent : ALL,
    harness: typeof harness === "string" ? harness : ALL,
  };
}

type Load = Readonly<{
  /** When the shown usage was read. */
  now: number;
  usage: readonly AgentUsage[];
  /** Agents whose sessions could not be read this time. */
  failed: readonly Agent[];
  /** Why each agent that failed could not be read, by `keyOf`. */
  reasons: ReadonlyMap<string, string>;
  /** Agents whose sessions are still being read. */
  pending: readonly Agent[];
  /** Whether the price data failed to load, so costs are not estimated. */
  unpriced: boolean;
}>;
/** Each membership's own: the same agent in another community reads apart. */
const keyOf = (agent: Agent) => `${agent.key}:${agent.type}`;
/** The agent as a read sees it: a rename or new configuration reads again. */
const readKey = (agent: Agent) =>
  JSON.stringify([keyOf(agent), agent.name, agent.config]);

/** Where an agent's own things open: as its owner, in its community. */
const scopeOf = (agent: Agent) => ({
  viewer: agent.owner,
  communityOrigin: relayOrigin(agent.relay),
});

/** Reads each agent's sessions from its type, `READ_DAYS` back for every
 * period, again when the agents or `reload` change; earlier results stay shown
 * meanwhile. Each agent's read is shown as it finishes, merged over what
 * earlier ones found, so a slow harness holds up only its own agents; an agent
 * that cannot be read keeps what was found before. */
function useUsage(agents: Agents, keys: string, reload: number) {
  const [load, setLoad] = useState<Load>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh reads the same agents again.
  useEffect(() => {
    const wanted = new Set(keys.split("\n"));
    const types = agents.types();
    const targets = agents
      .snapshot()
      .agents.filter((agent) => wanted.has(readKey(agent)));
    const controller = new AbortController();
    const now = Date.now();
    const pending = new Set(targets.map(keyOf));
    const failed = new Map<string, string>();
    const read = new Set(targets.map(keyOf));
    // What agents no longer here found goes, as on a switch of community.
    setLoad(
      (current) =>
        current && {
          ...current,
          usage: current.usage.filter((entry) => read.has(keyOf(entry.agent))),
          failed: current.failed.filter((agent) => read.has(keyOf(agent))),
          pending: targets,
        },
    );
    // Without price data, estimates show as unknown rates rather than wrong.
    const prices = loadPrices().then(
      () => false,
      () => true,
    );
    const settle = (
      agent: Agent,
      sessions?: readonly SessionUsage[],
      error?: unknown,
    ) => {
      const key = keyOf(agent);
      pending.delete(key);
      if (!sessions)
        failed.set(
          key,
          error instanceof Error ? error.message : String(error ?? ""),
        );
      return prices.then((unpriced) => {
        if (controller.signal.aborted) return;
        setLoad((current) => ({
          now,
          usage: targets.flatMap((target) => {
            const kept = current?.usage.find(
              (entry) => keyOf(entry.agent) === keyOf(target),
            );
            if (keyOf(target) !== key || !sessions) return kept ? [kept] : [];
            return [
              {
                agent: target,
                harness: target.type,
                sessions: merge(kept?.sessions ?? [], sessions),
              },
            ];
          }),
          // Earlier failures stay named until every read ends, so the Try
          // again that started them stays put.
          failed: targets.filter(
            (target) =>
              failed.has(keyOf(target)) ||
              (pending.size > 0 &&
                !!current?.failed.some(
                  (agent) => keyOf(agent) === keyOf(target),
                )),
          ),
          reasons: new Map([...(current?.reasons ?? []), ...failed]),
          pending: targets.filter((target) => pending.has(keyOf(target))),
          unpriced,
        }));
      });
    };
    // Nothing to read, as while the agents load: what was shown stays.
    if (!targets.length)
      setLoad(
        (current) =>
          current ?? {
            now,
            usage: [],
            failed: [],
            reasons: new Map(),
            pending: [],
            unpriced: false,
          },
      );
    const attempt = (agent: Agent, retry: boolean) => {
      const read = types.find((type) => type.key === agent.type)?.usage;
      (read
        ? read(agent, { since: since(now), signal: controller.signal })
        : Promise.reject(new Error("No usage"))
      ).then(
        (sessions) => settle(agent, sessions),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (!read || !retry) return settle(agent, undefined, error);
          const again = setTimeout(() => attempt(agent, false), RETRY_MS);
          controller.signal.addEventListener(
            "abort",
            () => clearTimeout(again),
            { once: true },
          );
        },
      );
    };
    for (const agent of targets) attempt(agent, true);
    return () => controller.abort();
  }, [agents, keys, reload]);
  return load;
}

/** Whether `active` has held for a second: loading feedback waits that long,
 * so a quick read shows its result without a loading state first. */
function useLasted(active: boolean) {
  const [lasted, setLasted] = useState(false);
  useEffect(() => {
    setLasted(false);
    if (!active) return;
    const timer = setTimeout(() => setLasted(true), 1000);
    return () => clearTimeout(timer);
  }, [active]);
  return active && lasted;
}

export function UsagePage({
  agents,
  open,
  viewScope,
}: {
  agents: Agents;
  open: Navigation["open"];
  /** Where the filters are kept, per viewer and community. */
  viewScope?: string | undefined;
}) {
  const snapshot = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const types = useSyncExternalStore(
    agents.subscribe,
    agents.types,
    agents.types,
  );
  const [filters, setFilters] = useState(() => readFilters(viewScope));
  const { days, agent: chosenAgent, harness: chosenHarness } = filters;
  // Only a choice is saved. One that is gone, filtering nothing, stays saved
  // for when it applies again.
  function choose(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    if (viewScope) writeView(viewScope, filtersKey, next);
  }
  const [reload, setReload] = useState(0);
  const harnesses = types.filter((type) => type.usage);
  // Only agents here run sessions on this computer.
  const targets = snapshot.agents.filter(
    (agent) =>
      agent.place === "here" &&
      harnesses.some((type) => type.key === agent.type),
  );
  const keys = targets.map(readKey).join("\n");
  const load = useUsage(
    agents,
    snapshot.status === "ready" ? keys : "",
    reload,
  );
  const usedHarnesses = harnesses.filter((type) =>
    targets.some((agent) => agent.type === type.key),
  );
  // A choice that is gone, with its menu perhaps, filters nothing.
  const agentFilter = targets.some((agent) => agent.pubkey === chosenAgent)
    ? chosenAgent
    : ALL;
  const harnessFilter = usedHarnesses.some((type) => type.key === chosenHarness)
    ? chosenHarness
    : ALL;
  // Colors follow the harness, not its rank or the filters; harnesses past
  // the chart's colors share the last as Other.
  const own =
    usedHarnesses.length > SERIES
      ? usedHarnesses.slice(0, SERIES - 1)
      : usedHarnesses;
  const rest = usedHarnesses.slice(own.length);
  const series: Series[] = [
    ...own.map((type, index) => ({
      key: type.key,
      label: type.title,
      color: `var(--chart-series-${index + 1})`,
      harnesses: [type.key],
    })),
    ...(rest.length
      ? [
          {
            key: "other",
            label: "Other",
            color: `var(--chart-series-${SERIES})`,
            harnesses: rest.map((type) => type.key),
          },
        ]
      : []),
  ];
  const colorOf = (harness: string) =>
    series.find((entry) => entry.harnesses.includes(harness))?.color ??
    `var(--chart-series-${SERIES})`;
  const titleOf = (harness: string) =>
    harnesses.find((type) => type.key === harness)?.title ?? harness;
  const shown = useMemo(() => {
    if (!load) return undefined;
    const included = (agent: Agent) =>
      (agentFilter === ALL || agent.pubkey === agentFilter) &&
      (harnessFilter === ALL || agent.type === harnessFilter);
    const failed = load.failed.filter(included);
    const reading = load.pending.filter(included);
    return {
      reading,
      // Agents not yet read, with nothing read before to show meanwhile.
      missing: reading.filter(
        (agent) =>
          !load.usage.some((entry) => keyOf(entry.agent) === keyOf(agent)),
      ),
      result: stats(
        load.usage.filter((entry) => included(entry.agent)),
        load.now,
        days,
        new Set(failed.map((agent) => agent.type)),
      ),
      unread: failed.length > 0,
    };
  }, [load, agentFilter, harnessFilter, days]);
  const result = shown?.result;
  const loading = !load || load.pending.length > 0;
  const refresh = useRef<HTMLButtonElement>(null);
  const retrying = useRef(false);
  // A retry that succeeds removes its button: focus moves to Refresh, unless
  // it moved elsewhere.
  useEffect(() => {
    if (!retrying.current || loading) return;
    retrying.current = false;
    if (
      !load?.failed.length &&
      !load?.unpriced &&
      document.activeElement === document.body
    )
      refresh.current?.focus();
  }, [load, loading]);

  const reading = shown?.reading ?? [];
  const missing = shown?.missing ?? [];
  // Totals wait for every agent; after a moment, what was read shows, with
  // the totals marked as still coming.
  const partial = missing.length > 0;
  const waited = useLasted(partial);
  const [revealed, setRevealed] = useState(false);
  const ready = !!result && (!partial || waited || revealed);
  // Once shown, the dashboard stays while later reads run.
  useEffect(() => {
    if (ready) setRevealed(true);
  }, [ready]);
  const total = targets.filter(
    (agent) =>
      (agentFilter === ALL || agent.pubkey === agentFilter) &&
      (harnessFilter === ALL || agent.type === harnessFilter),
  ).length;
  const failed = load?.failed ?? [];
  const reason =
    failed.length === 1 && failed[0]
      ? load?.reasons.get(keyOf(failed[0]))
      : undefined;
  const failure =
    failed.length || load?.unpriced ? (
      <p className={styles.notice} role="status">
        {failed.length > 0 && (
          <>
            Couldn’t read the sessions of{" "}
            {failed.length > 3
              ? `${failed.length} agents`
              : failed.map((agent) => agent.name).join(", ")}
            {reason ? `: ${reason.replace(/\.$/, "")}. ` : ". "}
            {failed.some((agent) =>
              load?.usage.some((entry) => keyOf(entry.agent) === keyOf(agent)),
            ) && "Showing what was read before. "}
          </>
        )}
        {load?.unpriced && "Couldn’t load prices to estimate costs. "}
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          onClick={() => {
            retrying.current = true;
            setReload((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </p>
    ) : undefined;

  let body: ReactNode;
  // Only the desktop app runs agents, and reads their sessions.
  if (snapshot.status === "unavailable")
    body = (
      <EmptyState
        icon={<ChartBarIcon size="1.5rem" />}
        title="Usage runs in the desktop app"
        description="It reads the sessions your agents run on your computer."
      />
    );
  else if (snapshot.status === "error")
    body = (
      <EmptyState
        icon={<ChartBarIcon size="1.5rem" />}
        title="Agents aren’t available"
        description={snapshot.error || "Try again in a moment."}
      />
    );
  else if (snapshot.status !== "ready" || (targets.length && !ready))
    body = <p className={styles.status}>Reading your agents’ sessions…</p>;
  else if (!targets.length || !result)
    body = (
      <EmptyState
        icon={<ChartBarIcon size="1.5rem" />}
        title="No agent usage to show"
        description="Usage reads the sessions your Claude Code, Codex and goose agents run on this computer. Add one from Agents to see what it spends."
        action={
          <Button
            onClick={() =>
              void open({
                version: 1,
                kind: "page",
                pluginId: "buzz.agents",
                pageId: "agents",
              })
            }
          >
            Open Agents
          </Button>
        }
      />
    );
  else
    body = (
      <Dashboard
        days={days}
        result={result}
        unread={shown?.unread ?? false}
        series={
          harnessFilter === ALL
            ? series
            : series.filter((entry) => entry.harnesses.includes(harnessFilter))
        }
        colorOf={colorOf}
        titleOf={titleOf}
        open={open}
        filters={
          <div className={styles.filters}>
            <Select
              label="Period"
              size="sm"
              value={String(days)}
              groups={[
                {
                  label: "Period",
                  options: RANGES.map((range) => ({
                    value: String(range),
                    label: `Last ${range} days`,
                  })),
                },
              ]}
              onValueChange={(value) => choose({ days: Number(value) })}
            />
            {targets.length > 1 && (
              <Select
                label="Agent"
                size="sm"
                value={agentFilter}
                groups={[
                  {
                    label: "Agent",
                    options: [
                      { value: ALL, label: "All agents" },
                      ...targets.map((agent) => ({
                        value: agent.pubkey,
                        label: agent.name,
                      })),
                    ],
                  },
                ]}
                onValueChange={(agent) => choose({ agent })}
              />
            )}
            {usedHarnesses.length > 1 && (
              <Select
                label="Harness"
                size="sm"
                value={harnessFilter}
                groups={[
                  {
                    label: "Harness",
                    options: [
                      { value: ALL, label: "All harnesses" },
                      ...usedHarnesses.map((type) => ({
                        value: type.key,
                        label: type.title,
                      })),
                    ],
                  },
                ]}
                onValueChange={(harness) => choose({ harness })}
              />
            )}
          </div>
        }
        notice={failure}
        progress={partial ? { done: total - reading.length, total } : undefined}
        waiting={missing}
      />
    );

  return (
    <section aria-label="Usage">
      <Header
        title="Usage"
        subtitle="Estimated cost of your agents’ sessions on this computer."
        actions={
          targets.length > 0 && (
            <IconButton
              hint="familiar"
              ref={refresh}
              size="sm"
              variant="ghost"
              icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
              aria-label="Refresh usage"
              title="Refresh usage"
              loading={loading}
              onClick={() => setReload((value) => value + 1)}
            />
          )
        }
      />
      <div aria-busy={loading}>{body}</div>
    </section>
  );
}

function Dashboard({
  days,
  result,
  unread,
  series,
  colorOf,
  titleOf,
  open,
  filters,
  notice,
  progress,
  waiting,
}: {
  days: number;
  result: ReturnType<typeof stats>;
  /** Whether a read of an agent shown failed. */
  unread: boolean;
  series: readonly Series[];
  colorOf(harness: string): string;
  titleOf(harness: string): string;
  open: Navigation["open"];
  filters: ReactNode;
  notice: ReactNode;
  /** While agents with nothing to show yet are read: how many are done. The
   * totals wait for them; the chart and each agent read show meanwhile. */
  progress: { done: number; total: number } | undefined;
  /** The agents still read, with nothing to show yet. */
  waiting: readonly Agent[];
}) {
  const period = `last ${days} days`;
  const top = result.agents[0];
  const spent = result.cost.value ?? 0;
  const before = result.previousCost?.value ?? 0;
  // Compared only when both periods were read and fully counted.
  const change =
    before > 0 && !result.cost.partial && !result.previousCost?.partial
      ? (spent - before) / before
      : undefined;
  const maxAgent = Math.max(
    ...result.agents.map((entry) => entry.cost.value ?? 0),
    0,
  );
  const harnessCount = new Set(result.agents.map((entry) => entry.harness))
    .size;
  return (
    <div className={styles.body}>
      {filters}
      {notice}
      {!result.sessions && !progress && unread ? (
        <EmptyState
          icon={<ChartBarIcon size="1.5rem" />}
          title="No sessions read"
          description="The sessions that couldn’t be read may include some from this period. Try again to read them."
        />
      ) : !result.sessions && !progress ? (
        <EmptyState
          icon={<ChartBarIcon size="1.5rem" />}
          title="No sessions in this period"
          description="Your agents ran no sessions here in the selected period. Choose a longer period or another agent."
        />
      ) : (
        <>
          {progress ? (
            <p className={styles.summary} role="status">
              Reading your agents’ sessions: {progress.done} of {progress.total}{" "}
              done…
            </p>
          ) : (
            <p className={styles.summary}>
              {result.agents.length === 1 && top ? (
                <>
                  <b>{top.agent.name}</b> ran{" "}
                  <b>{count(result.sessions, "session")}</b>
                </>
              ) : (
                <>
                  Your <b>{result.agents.length} agents</b> ran{" "}
                  <b>{count(result.sessions, "session")}</b>
                </>
              )}
              {harnessCount > 1 && (
                <>
                  {" "}
                  across <b>{harnessCount} harnesses</b>
                </>
              )}{" "}
              in the {period}.
              {top && result.agents.length > 1 && spent > 0 && (
                <>
                  {" "}
                  <b>{top.agent.name}</b> accounts for{" "}
                  <b>{percent((top.cost.value ?? 0) / spent)}</b> of the{" "}
                  {result.cost.partial ? "counted cost" : "cost"}
                  {top.model && (
                    <>
                      , mostly on <b>{modelName(top.model)}</b>
                    </>
                  )}
                  .
                </>
              )}
            </p>
          )}
          <section className={styles.hero} aria-label="Estimated cost">
            <p className={styles.label}>Estimated cost · {period}</p>
            <p className={styles.heroValue}>
              {progress ? "—" : amount(result.cost, cost)}
            </p>
            <p className={styles.meta}>
              {progress ? (
                <span>Waiting for every agent</span>
              ) : change === undefined ? null : Math.abs(change) < 0.005 ? (
                <span>No change from the previous {days} days</span>
              ) : (
                <span className={styles.delta}>
                  {change > 0 ? (
                    <ArrowUpIcon size="0.875rem" aria-hidden="true" />
                  ) : (
                    <ArrowDownIcon size="0.875rem" aria-hidden="true" />
                  )}
                  {percent(Math.abs(change))} {change > 0 ? "more" : "less"}{" "}
                  than the previous {days} days
                </span>
              )}
              {!progress && result.cost.value !== undefined && (
                <span>{cost(spent / days)} a day</span>
              )}
              {!progress && result.cost.partial && <span>Partial</span>}
            </p>
            <p className={styles.footnote} role="note">
              <InfoIcon size="0.875rem" aria-hidden="true" />
              Best-effort estimate from local session files at published API
              prices, not your bill.
            </p>
          </section>
          <div className={styles.tiles}>
            <Tile
              label="Tokens"
              value={progress ? "—" : amount(result.tokens, count)}
              detail={
                progress
                  ? "Reading…"
                  : partly(
                      result.tokens,
                      `${amount(result.output, count)} output`,
                    )
              }
            />
            <Tile
              label="Cache hit rate"
              value={
                !progress && result.cacheHit
                  ? amount(result.cacheHit, percent)
                  : "—"
              }
              detail={
                progress
                  ? "Reading…"
                  : result.cacheHit?.partial
                    ? "Of the prompts with cache counts"
                    : "Prompt tokens read from cache"
              }
            />
            <Tile
              label="Sessions"
              value={progress ? "—" : String(result.sessions)}
              detail={
                progress
                  ? "Reading…"
                  : `By ${count(result.agents.length, "agent")}`
              }
            />
          </div>
          <section className={styles.section}>
            <InlineHeader
              title="Daily cost"
              {...(progress && {
                subtitle: `Filling in as agents finish: ${progress.done} of ${progress.total}`,
              })}
            />
            <DailyCostChart days={result.days} series={series} />
          </section>
          <div className={styles.columns}>
            <section className={styles.section}>
              <InlineHeader title="By agent" />
              <ul className={styles.list}>
                {result.agents.map((entry) => (
                  <li key={entry.agent.pubkey}>
                    <NavigationItem
                      icon={
                        <Avatar
                          src={entry.agent.picture}
                          alt=""
                          fallback={entry.agent.name}
                          size="small"
                        />
                      }
                      label={
                        <span className={styles.agentText}>
                          <span className={styles.name}>
                            {entry.agent.name}
                          </span>
                          <span className={styles.label}>
                            {[
                              titleOf(entry.harness),
                              entry.model && modelName(entry.model),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <span className={styles.track} aria-hidden="true">
                            <span
                              className={styles.bar}
                              style={{
                                inlineSize: `${maxAgent ? ((entry.cost.value ?? 0) / maxAgent) * 100 : 0}%`,
                                background: colorOf(entry.harness),
                              }}
                            />
                          </span>
                        </span>
                      }
                      trailing={<Amount total={entry.cost} />}
                      aria-label={`${entry.agent.name}, ${titleOf(entry.harness)}, ${costLabel(entry.cost)}. Open in Agents`}
                      onClick={() =>
                        void open({
                          ...agentTarget(entry.agent.pubkey),
                          scope: scopeOf(entry.agent),
                        })
                      }
                    />
                  </li>
                ))}
                {waiting.map((agent) => (
                  <li key={agent.pubkey} className={styles.agentRow}>
                    <Avatar
                      src={agent.picture}
                      alt=""
                      fallback={agent.name}
                      size="small"
                    />
                    <div className={styles.agentText}>
                      <span className={styles.name}>{agent.name}</span>
                      <span className={styles.label}>
                        {titleOf(agent.type)} · Reading…
                      </span>
                      <span className={styles.track} aria-hidden="true" />
                    </div>
                    <span className={styles.value}>—</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className={styles.section}>
              <InlineHeader title="Costliest sessions" />
              {progress ? (
                <p className={styles.label}>Shown once every agent is read.</p>
              ) : (
                <ul className={styles.list}>
                  {result.costliest.map(({ agent, session, cost: total }) => {
                    const label = (
                      <span className={styles.sessionText}>
                        <span className={styles.name}>
                          {session.title ?? "Untitled session"}
                        </span>
                        <span className={styles.label}>
                          {[
                            agent.name,
                            new Date(session.lastAt).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            ),
                            session.gaps.length > 0 && "partly read",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    );
                    const channelId = session.channelId;
                    return (
                      <li key={`${agent.pubkey}:${session.id}`}>
                        {channelId ? (
                          <NavigationItem
                            label={label}
                            trailing={<Amount total={total} />}
                            aria-label={`${session.title ?? "Untitled session"}, ${agent.name}, ${costLabel(total)}. Open conversation`}
                            onClick={() =>
                              void open({
                                version: 1,
                                kind: "conversation",
                                scope: scopeOf(agent),
                                channelId,
                                ...(session.root
                                  ? {
                                      messageId: session.root,
                                      threadRootId: session.root,
                                    }
                                  : {}),
                              })
                            }
                          />
                        ) : (
                          <div className={styles.staticRow}>
                            {label}
                            <Amount total={total} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

const partly = (total: Total, text: string) =>
  total.partial ? `${text} · partial` : text;
const costLabel = (total: Total) =>
  total.value === undefined
    ? "cost unavailable"
    : partly(total, cost(total.value));

/** A cost in a list row: `—` when unknown, marked when partial. */
function Amount({ total }: { total: Total }) {
  return (
    <span className={styles.value} title={costLabel(total)}>
      {total.value === undefined
        ? "—"
        : `${cost(total.value)}${total.partial ? "+" : ""}`}
    </span>
  );
}

function Tile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.tile}>
      <p className={styles.label}>{label}</p>
      <p className={styles.tileValue}>{value}</p>
      <p className={styles.label}>{detail}</p>
    </div>
  );
}
