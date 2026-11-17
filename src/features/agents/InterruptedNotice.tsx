import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { messagePreview } from "../notifications/content";
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import styles from "./InterruptedNotice.module.css";
import { useAgentsSnapshot } from "./react";
import type { Agent, Agents } from "./service";

/** Asks the owner whether agents that were working when the app last closed
 * or reloaded carry on; nothing resumes until they choose. */
export function InterruptedNotice({ agents }: { agents: Agents }) {
  const interrupted = useAgentsSnapshot(agents)?.interrupted ?? [];
  if (!interrupted.length) return null;
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
    interrupted.map((agent) => agent.name),
  );
  return (
    <ToastNotice
      title={
        interrupted.length === 1
          ? "Resume interrupted agent?"
          : "Resume interrupted agents?"
      }
      description={`${names} ${interrupted.length === 1 ? "was" : "were"} working when Buzz closed or reloaded.`}
      details={<InterruptedDetails agents={agents} interrupted={interrupted} />}
      tone="info"
    >
      <Button
        type="button"
        size="sm"
        variant="prominent"
        onClick={agents.resumeInterrupted}
      >
        Resume
      </Button>
      <Button type="button" size="sm" onClick={agents.dismissInterrupted}>
        Don’t resume
      </Button>
    </ToastNotice>
  );
}

/** Where the agents were working, read from the relay only once opened.
 * Resume reads the mentions again, so this is a preview, not a promise. */
function InterruptedDetails({
  agents,
  interrupted,
}: {
  agents: Agents;
  interrupted: readonly Agent[];
}) {
  const [open, setOpen] = useState(false);
  // Each agent's read once settled: its events, or "failed", read again on the
  // next open. Keyed by agent, so snapshot rebuilds neither cancel nor repeat it.
  const [read, setRead] = useState<
    Readonly<Record<string, readonly RelayEvent[] | "failed">>
  >({});
  const reading = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const current = reading.current;
    return () => {
      for (const controller of current.values()) controller.abort();
      current.clear();
    };
  }, []);
  const start = useEffectEvent(() => {
    for (const agent of interrupted) {
      const settled = read[agent.key];
      if ((settled && settled !== "failed") || reading.current.has(agent.key))
        continue;
      if (settled === "failed") setRead(({ [agent.key]: _, ...rest }) => rest);
      const controller = new AbortController();
      reading.current.set(agent.key, controller);
      const settle = (result: readonly RelayEvent[] | "failed") => {
        if (reading.current.get(agent.key) !== controller) return;
        reading.current.delete(agent.key);
        setRead((prior) => ({ ...prior, [agent.key]: result }));
      };
      agents
        .readInterrupted(agent, controller.signal)
        .then(settle, () => settle("failed"));
    }
  });
  const keys = interrupted.map((agent) => agent.key).join(" ");
  useEffect(() => {
    if (open && keys) start();
  }, [open, keys]);
  const groups = interrupted.map((agent) => ({
    agent,
    turns: agents.interruptedTurns(agent),
  }));
  const count = groups.reduce((sum, { turns }) => sum + turns.length, 0);
  return (
    <Accordion
      variant="activity"
      value={open ? ["details"] : []}
      onValueChange={(value) => setOpen(value.includes("details"))}
      items={[
        {
          value: "details",
          title: `${count} ${count === 1 ? "mention" : "mentions"}`,
          content: (
            <section
              aria-label="Interrupted conversations"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard access to the overflowing list.
              tabIndex={0}
              className={`grid max-h-48 gap-3 overflow-y-auto ${styles.conversations}`}
            >
              {groups.map(({ agent, turns }) => (
                <div key={agent.key} className="grid gap-2">
                  {interrupted.length > 1 && (
                    <h4 className="m-0 text-label-sm text-subtle">
                      {agent.name}
                    </h4>
                  )}
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {conversations(turns, read[agent.key]).map((row) => (
                      <li key={row.key} className="min-w-0">
                        <div className="truncate text-label-sm">
                          {row.channel}
                        </div>
                        <div className="truncate text-body-sm text-subtle">
                          {row.place}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ),
        },
      ]}
    />
  );
}

/** One row per conversation once its mentions are read; until then, or when
 * a mention was not found, one per mention. */
function conversations(
  turns: ReturnType<Agents["interruptedTurns"]>,
  events: readonly RelayEvent[] | "failed" | undefined,
) {
  const rows = new Map<
    string,
    { key: string; channel: string; detail: string; count: number }
  >();
  for (const turn of turns) {
    const channel = turn.channel?.name ?? "Unknown channel";
    const event =
      events === "failed"
        ? undefined
        : events?.find((item) => item.id === turn.id);
    if (!event) {
      const detail =
        events === undefined
          ? "Checking…"
          : events === "failed"
            ? "Couldn’t load details"
            : "Details unavailable";
      rows.set(turn.id, { key: turn.id, channel, detail, count: 1 });
      continue;
    }
    const reply = threadReference(event);
    const key = `${turn.channelId}:${reply?.rootId ?? event.id}`;
    const row = rows.get(key);
    if (row) row.count++;
    else
      rows.set(key, {
        key,
        channel,
        detail: `${reply ? "Thread" : "In channel"} · “${messagePreview(event.content)}”`,
        count: 1,
      });
  }
  return [...rows.values()].map(({ key, channel, detail, count }) => ({
    key,
    channel,
    place: count > 1 ? `${detail} · ${count} mentions` : detail,
  }));
}
