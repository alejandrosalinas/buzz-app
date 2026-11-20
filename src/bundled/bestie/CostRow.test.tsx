// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { turnPrompt } from "../claude-code/prompt";
import { fakeSpawn } from "../goose/goose-testing";
import { GooseHistory } from "../goose/transcript";
import { readUsage } from "../goose/usage";
import { dayStart, since } from "../usage/stats";
import { CostRow } from "./CostRow";
import { weekCost } from "./cost";

// The rendered row reads its week back from now: hold now at NOW. Only Date
// is faked, so the row's reads and user events still run on real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date(2026, 10, 13, 15).getTime();
const agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  place: "here",
} as unknown as Agent;
/** A request the harness recorded the cost of, `ago` days before NOW. */
const request = (ago: number, usd: number): UsageObservation => ({
  at: dayStart(NOW, ago) + 60_000,
  model: "test-model",
  tokens: {},
  cost: { usd, source: "recorded" },
});
const session = (
  id: string,
  observations: UsageObservation[],
): SessionUsage => ({
  id,
  revision: id,
  gaps: [],
  startedAt: Math.min(...observations.map((entry) => entry.at)),
  lastAt: Math.max(...observations.map((entry) => entry.at)),
  observations,
});
/** Settings cards with Usage's registered while `usage.on`; `turn` changes
 * that and tells subscribers. */
const cards = (on: boolean) => {
  const listeners = new Set<() => void>();
  const usage = { on };
  return {
    has: (key: string) => usage.on && key === "buzz.usage/usage",
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    turn(next: boolean) {
      usage.on = next;
      for (const listener of listeners) listener();
    },
  };
};
const usageOn = cards(true);
/** Agents whose type reads `usage`, or none when it is left out. */
const agentsWith = (usage?: unknown) =>
  ({
    types: () => [{ key: "test/echo", ...(usage ? { usage } : {}) }],
  }) as unknown as Pick<Agents, "types">;

it("adds the last seven days up and ignores older requests", async () => {
  const usage = vi.fn(async () => [
    session("one", [request(0, 0.25), request(2, 1.5)]),
    session("two", [request(6, 0.5), request(8, 40)]),
  ]);
  const week = await weekCost(
    agentsWith(usage),
    agent,
    new AbortController().signal,
    NOW,
  );
  expect(week.days).toHaveLength(7);
  expect(week.days.map((day) => day.cost.value)).toEqual([
    0.5, 0, 0, 0, 1.5, 0, 0.25,
  ]);
  expect(week.total).toEqual({ value: 2.25, partial: false });
  // Usage's own window is read, so a read Usage joins misses nothing.
  expect(usage).toHaveBeenCalledWith(agent, {
    since: since(NOW),
    signal: expect.any(AbortSignal),
  });
});

it("leaves Usage's month whole when its read joins the week's", async () => {
  // goose shares one workspace read between every agent's concurrent reads.
  const mention = {
    id: "1".repeat(64),
    pubkey: "b".repeat(64),
    kind: 9,
    created_at: NOW / 1000,
    content: "@Ada fix the build",
    tags: [["h", "chan"]],
    sig: "",
  } as EventData;
  const ask = turnPrompt({
    agent: agent.pubkey,
    event: mention,
    channel: { id: "chan", name: "general" },
    scope: "thread",
    context: [],
    total: 1,
  });
  const saved = (sessionId: string, ago: number, cost: number) => {
    const at = dayStart(NOW, ago) + 60_000;
    return {
      sessionId,
      title: `Ada · #general · ${sessionId}`,
      cwd: "/home/test/.buzz",
      updatedAt: new Date(at).toISOString(),
      conversation: [
        {
          role: "user",
          created: at / 1000,
          content: [{ type: "text", text: ask }],
          metadata: { userVisible: true },
        },
        {
          role: "assistant",
          created: at / 1000,
          content: [{ type: "text", text: "Done." }],
          metadata: {
            userVisible: true,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cost,
              costSource: "estimated",
            },
          },
        },
      ],
    };
  };
  const goose = fakeSpawn({
    home: "/home/test",
    history: [saved("recent", 2, 0.25), saved("older", 20, 3)],
  });
  const history = new GooseHistory(goose);
  const read = (from: number) =>
    readUsage(
      history,
      agent.pubkey,
      "~/.buzz",
      from,
      new AbortController().signal,
    );
  const goosey = agentsWith((_: Agent, options: { since: number }) =>
    read(options.since),
  );
  const [week, month] = await Promise.all([
    weekCost(goosey, agent, new AbortController().signal, NOW),
    read(since(NOW)),
  ]);
  expect(goose.geese).toHaveLength(1);
  expect(month.map((session) => session.id).sort()).toEqual([
    "older",
    "recent",
  ]);
  expect(week.total).toEqual({ value: 0.25, partial: false });
});

it("shows the total and a daily sparkline, and opens Usage", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <CostRow
      agents={agentsWith(async () => [
        session("one", [request(0, 0.25), request(1, 1.5)]),
      ])}
      agent={agent}
      open={open}
      settingsCards={usageOn}
    />,
  );
  expect(await screen.findByText("$1.75")).toBeVisible();
  expect(screen.getByText("Cost, last 7 days")).toBeVisible();
  expect(screen.getByRole("img", { name: /Daily cost.*\$1\.50.*\$0\.25/ }));
  await user.click(screen.getByRole("button", { name: "Open Usage" }));
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "buzz.usage/usage",
  });
});

it("shows nothing and reads nothing while Usage is off, until it is on", async () => {
  const usage = vi.fn(async () => [session("one", [request(0, 0.25)])]);
  const settingsCards = cards(false);
  const { container } = render(
    <CostRow
      agents={agentsWith(usage)}
      agent={agent}
      open={vi.fn()}
      settingsCards={settingsCards}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(usage).not.toHaveBeenCalled();
  act(() => settingsCards.turn(true));
  expect(await screen.findByText("$0.25")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open Usage" })).toBeVisible();
  expect(usage).toHaveBeenCalledTimes(1);
  act(() => settingsCards.turn(false));
  expect(container).toBeEmptyDOMElement();
});

it("stops its read when Usage turns off", async () => {
  let signal: AbortSignal | undefined;
  const usage = vi.fn(
    (_: Agent, options: { signal: AbortSignal }) =>
      new Promise<SessionUsage[]>(() => {
        signal = options.signal;
      }),
  );
  const settingsCards = cards(true);
  render(
    <CostRow
      agents={agentsWith(usage)}
      agent={agent}
      open={vi.fn()}
      settingsCards={settingsCards}
    />,
  );
  await vi.waitFor(() => expect(signal).toBeDefined());
  act(() => settingsCards.turn(false));
  expect(signal?.aborted).toBe(true);
});

it("says so when the agent type reports no usage", () => {
  render(
    <CostRow
      agents={agentsWith()}
      agent={agent}
      open={vi.fn()}
      settingsCards={usageOn}
    />,
  );
  expect(
    screen.getByText(/this agent's type doesn't report its usage/),
  ).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("says so, without reading, for an agent that runs elsewhere", () => {
  const usage = vi.fn();
  render(
    <CostRow
      agents={agentsWith(usage)}
      agent={{ ...agent, place: "hosted" } as Agent}
      open={vi.fn()}
      settingsCards={usageOn}
    />,
  );
  expect(screen.getByText(/this agent runs elsewhere/)).toBeVisible();
  expect(usage).not.toHaveBeenCalled();
});

it("shows a quiet error when the read rejects, and reads again on Retry", async () => {
  const user = userEvent.setup();
  const usage = vi
    .fn()
    .mockRejectedValueOnce(new Error("a transcript was too large"))
    .mockResolvedValue([session("one", [request(0, 0.4)])]);
  render(
    <CostRow
      agents={agentsWith(usage)}
      agent={agent}
      open={vi.fn()}
      settingsCards={usageOn}
    />,
  );
  expect(
    await screen.findByText("Couldn't read this agent's sessions."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("$0.40")).toBeVisible();
  expect(usage).toHaveBeenCalledTimes(2);
});

it.each([
  ["Open Usage", usageOn, { role: "button", name: "Open Usage" }],
] as const)(
  "keeps a focused Retry while it reads, then hands focus to %s",
  async (_, settingsCards, target) => {
    const user = userEvent.setup();
    const reads: ((result: SessionUsage[] | Error) => void)[] = [];
    const usage = vi.fn(
      () =>
        new Promise<SessionUsage[]>((resolve, reject) =>
          reads.push((result) =>
            result instanceof Error ? reject(result) : resolve(result),
          ),
        ),
    );
    render(
      <CostRow
        agents={agentsWith(usage)}
        agent={agent}
        open={vi.fn()}
        settingsCards={settingsCards}
      />,
    );
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    act(() => reads[0]?.(new Error("first")));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await user.click(retry);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    // The read is pending: the same Retry stays, busy and focused.
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
    // A failed retry leaves it focused for another.
    await act(async () => reads[1]?.(new Error("second")));
    await vi.waitFor(() => expect(retry).not.toHaveAttribute("aria-busy"));
    expect(retry).toHaveFocus();
    await user.click(retry);
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    await act(async () => reads[2]?.([session("one", [request(0, 0.4)])]));
    expect(await screen.findByText("$0.40")).toBeVisible();
    expect(screen.getByRole(target.role, { name: target.name })).toHaveFocus();
  },
);

it("stops reading when the tab closes", async () => {
  let signal: AbortSignal | undefined;
  const usage = vi.fn(
    (_: Agent, options: { signal: AbortSignal }) =>
      new Promise<SessionUsage[]>(() => {
        signal = options.signal;
      }),
  );
  const { unmount } = render(
    <CostRow
      agents={agentsWith(usage)}
      agent={agent}
      open={vi.fn()}
      settingsCards={usageOn}
    />,
  );
  expect(screen.getByText("Reading its sessions…")).toBeVisible();
  await vi.waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});
