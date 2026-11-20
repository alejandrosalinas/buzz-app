import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Agent, Agents } from "../../features/agents/service";
import { settingsTarget } from "../../features/navigation/buzz-links";
import type { Navigation } from "../../features/navigation/controller";
import type { SettingsCards } from "../../features/settings/service";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { costText } from "../usage/format";
import { COST_DAYS, readsUsage, type WeekCost, weekCost } from "./cost";

/** The Usage plugin's settings card, there only while Usage is on. */
const USAGE = "buzz.usage/usage";
const BAR = 4;
const GAP = 2;
const HEIGHT = 20;
const day = (start: number) =>
  new Date(start).toLocaleDateString(undefined, {
    weekday: "short",
  });

/** A bar per day, tallest the costliest day; the figures are in its label. */
function Sparkline({ week }: { week: WeekCost }) {
  const top = Math.max(...week.days.map((entry) => entry.cost.value ?? 0), 0);
  return (
    <svg
      role="img"
      aria-label={`Daily cost, oldest first: ${week.days
        .map((entry) => `${day(entry.start)} ${costText(entry.cost)}`)
        .join(", ")}`}
      width={COST_DAYS * (BAR + GAP) - GAP}
      height={HEIGHT}
    >
      {week.days.map((entry, index) => {
        const spent = entry.cost.value ?? 0;
        const height = spent > 0 ? Math.max(2, (spent / top) * HEIGHT) : 1;
        return (
          <rect
            key={entry.start}
            x={index * (BAR + GAP)}
            y={HEIGHT - height}
            width={BAR}
            height={height}
            rx={1}
            style={{ fill: "var(--chart-series-1)" }}
            opacity={spent > 0 ? 1 : 0.4}
          />
        );
      })}
    </svg>
  );
}

type Props = {
  agents: Pick<Agents, "types">;
  agent: Agent;
  open: Navigation["open"];
  settingsCards: Pick<SettingsCards, "subscribe" | "has">;
};

/** The agent's estimated cost over the last week, only while the Usage plugin
 * is on: with Usage off there is no row and nothing is read, and turning it
 * off stops a read under way. */
export function CostRow(props: Props) {
  const { settingsCards } = props;
  const usage = useSyncExternalStore(settingsCards.subscribe, () =>
    settingsCards.has(USAGE),
  );
  return usage ? <WeekCostRow {...props} /> : null;
}

/** The week's cost, read when the tab opens: a sparkline, the total and a way
 * to Usage. It says so when the agent's type reports no usage or the agent
 * isn't on this device, and when a read fails, with Retry; it never stands in
 * the way of the tab. */
function WeekCostRow({ agents, agent, open }: Props) {
  const readable = readsUsage(agents, agent);
  // A read is kept for the agent it was for; Retry keeps the failed one, and
  // its focused Retry, on screen until the next read settles.
  const key = `${agent.pubkey}:${agent.type}`;
  const [read, setRead] = useState<{ key: string; week: WeekCost | "error" }>();
  const week = read?.key === key ? read.week : undefined;
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reads again for another agent or a retry.
  useEffect(() => {
    if (!readable) return;
    setPending(true);
    const controller = new AbortController();
    const settle = (result: WeekCost | "error") => {
      if (controller.signal.aborted) return;
      setRead({ key, week: result });
      setPending(false);
    };
    weekCost(agents, agent, controller.signal).then(settle, () =>
      settle("error"),
    );
    return () => controller.abort();
  }, [key, readable, attempt]);
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);
  const openUsage = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    // A recovered Retry hands its focus to the week it read.
    if (week === "error" || document.activeElement !== document.body) return;
    openUsage.current?.focus({ preventScroll: true });
  }, [week]);
  const title = `Cost, last ${COST_DAYS} days`;
  if (!readable)
    return (
      <PreferenceRow
        title={title}
        subtitle={
          agent.place === "here"
            ? "Not available: this agent's type doesn't report its usage."
            : "Not available: usage is read from sessions on this device, and this agent runs elsewhere."
        }
      />
    );
  if (week === "error")
    return (
      <PreferenceRow
        title={title}
        subtitle="Couldn't read this agent's sessions."
        trailing={(label) => (
          <Button
            ref={retryButton}
            variant="outline"
            loading={pending}
            aria-describedby={label["aria-labelledby"]}
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </Button>
        )}
      />
    );
  if (!week)
    return <PreferenceRow title={title} subtitle="Reading its sessions…" />;
  return (
    <PreferenceRow
      title={title}
      subtitle="An estimate from its sessions on this device, not a bill."
      trailing={(label) => (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Sparkline week={week} />
          <span className="tabular-nums">{costText(week.total)}</span>
          <Button
            ref={openUsage}
            variant="outline"
            aria-describedby={label["aria-labelledby"]}
            onClick={() => void open(settingsTarget({ section: USAGE }))}
          >
            Open Usage
          </Button>
        </div>
      )}
    />
  );
}
