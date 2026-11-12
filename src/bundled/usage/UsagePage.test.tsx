// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  SessionUsage,
} from "../../features/agents/service";
import type { RelaySnapshot } from "../../features/relay/service";
import type { PluginModule } from "../../plugins/api";
import { readView, writeView } from "../../shared/view-state";
import { apply } from "./index";
import { loadPrices } from "./pricing";
import { since } from "./stats";
import { UsagePage } from "./UsagePage";

vi.mock("./pricing", async (actual) => {
  const pricing = await actual<typeof import("./pricing")>();
  return { ...pricing, loadPrices: vi.fn(pricing.loadPrices) };
});

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const owner = "f".repeat(64);
const root = "e".repeat(64);
const agent = (name: string, type = "buzz.claude-code/claude"): Agent =>
  ({
    key: name.padEnd(64, "0"),
    pubkey: name.padEnd(64, "0"),
    name,
    type,
    owner,
    relay: "wss://relay.example.com",
    place: "here",
    config: {},
  }) as unknown as Agent;
const session = (
  id: string,
  input: number,
  title?: string,
  model = "claude-opus-5-5",
): SessionUsage => {
  const at = new Date().setMinutes(0, 0, 0);
  return {
    id,
    revision: `${id}:${input}`,
    gaps: [],
    channelId: "chan",
    root,
    ...(title ? { title } : {}),
    startedAt: at,
    lastAt: at,
    observations: [
      {
        at,
        model,
        tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
};

/** Matches the summary sentence, which bolds its figures. */
const summary = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === "P" && element.textContent === text;

/** Agents whose Claude type reads usage through `usage`, and Codex type
 * through `codex` when given. */
function host(
  agents: Agent[],
  usage: RegisteredAgentType["usage"],
  codex?: RegisteredAgentType["usage"],
) {
  const snapshot = {
    status: "ready",
    agents,
    running: agents,
  } as unknown as AgentsSnapshot;
  const types = [
    {
      key: "buzz.claude-code/claude",
      title: "Claude",
      usage,
    },
    {
      key: "buzz.codex/codex",
      title: "Codex",
      ...(codex ? { usage: codex } : {}),
    },
  ] as unknown as RegisteredAgentType[];
  return {
    snapshot: () => snapshot,
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

/** Pixel's $3 session and Relay's $1, both today. */
const team = () =>
  host([agent("Pixel"), agent("Relay")], async (target) => [
    target.name === "Pixel"
      ? session("a", 750_000, "Port the scroll patch")
      : session("b", 250_000, "Tidy the docs"),
  ]);
/** Pixel's $3 Claude session and Sol's $1 Codex one, both today. */
const mixed = () =>
  host(
    [agent("Pixel"), agent("Sol", "buzz.codex/codex")],
    async () => [session("a", 750_000)],
    async () => [session("b", 250_000)],
  );
const everyone = summary(
  "Your 2 agents ran 2 sessions in the last 30 days. Pixel accounts for 75% of the cost, mostly on Claude Opus 5.5.",
);
const relayWeek = summary("Relay ran 1 session in the last 7 days.");
const solMonth = summary("Sol ran 1 session in the last 30 days.");

const one = `https://one.example:${owner}`;
const two = `https://two.example:${owner}`;
/** Usage as Settings shows it, through the plugin, beside a relay whose
 * snapshot `publish` replaces. */
function usageCard(
  agents: Agents,
  connection: Partial<RelaySnapshot> = { status: "ready", scope: one },
) {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  let snapshot = connection;
  const listeners = new Set<() => void>();
  let Card: ComponentType = () => null;
  apply({
    agents,
    navigation: { open },
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    settingsCards: {
      register: (card: { component: ComponentType }) => {
        Card = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  return {
    Card,
    open,
    publish: (next: Partial<RelaySnapshot>) =>
      act(() => {
        snapshot = next;
        for (const listener of listeners) listener();
      }),
  };
}
/** Chooses `option` from the menu labelled `label`. */
async function pick(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
/** What the menu labelled `label` shows. */
const chosen = (label: string) =>
  screen.getByRole("combobox", { name: label }).textContent;

it("summarises the agents' spend and opens a costly session's thread", async () => {
  const pixel = agent("Pixel");
  const relay = agent("Relay");
  const reads: Parameters<NonNullable<RegisteredAgentType["usage"]>>[1][] = [];
  const open = vi.fn(async () => ({ status: "opened" as const }));
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  render(
    <UsagePage
      agents={host(
        [pixel, relay, agent("Hosted", "buzz.codex/codex")],
        async (target, options) => {
          reads.push(options);
          await done;
          // $3 and $1 at Opus 5.5's $4 per million input tokens.
          return target === pixel
            ? [session("a", 750_000, "Port the scroll patch")]
            : [session("b", 250_000)];
        },
      )}
      open={open}
    />,
  );
  expect(screen.getByText("Reading your agents’ sessions…")).toBeTruthy();
  // Busy, yet it keeps its place for the keyboard.
  expect(
    screen
      .getByRole("button", { name: "Refresh usage" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  finish();
  expect(
    await screen.findByText(
      summary(
        "Your 2 agents ran 2 sessions in the last 30 days. Pixel accounts for 75% of the cost, mostly on Claude Opus 5.5.",
      ),
    ),
  ).toBeTruthy();
  expect(reads).toHaveLength(2);
  // 30 days back, what Claude Code keeps by default: local midnight 29 days
  // ago, which is not 29 × 24 h before now across a daylight-saving change.
  expect(reads[0]?.since).toBe(since(Date.now()));
  const hero = screen.getByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$4.00")).toBeTruthy();
  // The daily figures are in a table for assistive technology.
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(31);
  expect(rows.at(-1)?.textContent).toContain("$4.00");

  await userEvent.click(
    screen.getByRole("button", {
      name: /^Port the scroll patch, Pixel, \$3\.00/,
    }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope: { viewer: owner, communityOrigin: "https://relay.example.com" },
    channelId: "chan",
    messageId: root,
    threadRootId: root,
  });
});

it("opens an agent from By agent in Agents", async () => {
  const relay = agent("Relay");
  const open = vi.fn(async () => ({ status: "opened" as const }));
  render(
    <UsagePage
      agents={host([agent("Pixel"), relay], async (target) => [
        target === relay ? session("b", 250_000) : session("a", 750_000),
      ])}
      open={open}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Relay, Claude, $1.00. Open in Agents",
    }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    route: { version: 1, params: { agent: relay.pubkey } },
    scope: { viewer: owner, communityOrigin: "https://relay.example.com" },
  });
});

it("waits for every agent before its totals, and shows each agent read meanwhile", async () => {
  const pixel = agent("Pixel");
  let finish = () => {};
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  render(
    <UsagePage
      agents={host([pixel, agent("Relay")], async (target) => {
        if (target === pixel) return [session("a", 750_000)];
        await slow;
        return [session("b", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  // A quick read would show its result without a loading state first.
  expect(screen.getByText("Reading your agents’ sessions…")).toBeTruthy();
  expect(
    await screen.findByText(
      "Reading your agents’ sessions: 1 of 2 done…",
      {},
      { timeout: 2000 },
    ),
  ).toBeTruthy();
  const hero = screen.getByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("—")).toBeTruthy();
  expect(screen.getByText("Shown once every agent is read.")).toBeTruthy();
  const rows = screen
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "");
  expect(
    rows.some((row) => row.includes("Pixel") && row.includes("$3.00")),
  ).toBe(true);
  expect(
    rows.some((row) => row.includes("Relay") && row.includes("Reading…")),
  ).toBe(true);
  finish();
  expect(
    await screen.findByText(
      summary(
        "Your 2 agents ran 2 sessions in the last 30 days. Pixel accounts for 75% of the cost, mostly on Claude Opus 5.5.",
      ),
    ),
  ).toBeTruthy();
  expect(within(hero).getByText("$4.00")).toBeTruthy();
});

it("tries a failed read once more before reporting it", async () => {
  let reads = 0;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => {
        reads += 1;
        if (reads === 1) throw new Error("busy");
        return [session("a", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(
      summary("Pixel ran 1 session in the last 30 days."),
      {},
      { timeout: 2000 },
    ),
  ).toBeTruthy();
  expect(reads).toBe(2);
  expect(screen.queryByText(/Couldn’t read/)).toBeNull();
});

it("names the agents it could not read and reads them again", async () => {
  let fail = true;
  let reads = 0;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => {
        reads += 1;
        if (fail) throw new Error("no workspace");
        return [session("a", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "Couldn’t read the sessions of Pixel: no workspace.",
  );
  // Tried once more before it was reported, as each Try again is.
  expect(reads).toBe(2);
  // A failed read is no evidence of an empty period; filters stay reachable.
  expect(screen.getByText("No sessions read")).toBeTruthy();
  expect(screen.queryByText("No sessions in this period")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Period" })).toBeTruthy();
  // A retry that fails again keeps the keyboard on Try again.
  const user = userEvent.setup();
  const retry = screen.getByRole("button", { name: "Try again" });
  retry.focus();
  await user.keyboard("{Enter}");
  await vi.waitFor(() => expect(reads).toBe(4), { timeout: 2000 });
  await vi.waitFor(() => expect(retry.getAttribute("aria-busy")).toBeNull());
  expect(document.activeElement).toBe(retry);
  // One that succeeds removes it, and the keyboard moves to Refresh.
  fail = false;
  await user.keyboard("{Enter}");
  expect(
    await screen.findByText(
      summary("Pixel ran 1 session in the last 30 days."),
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Refresh usage" }),
  );
});

it("keeps the keyboard on Try again until every agent it reads again is read", async () => {
  const pixel = agent("Pixel");
  let fail = true;
  let held: Promise<void> | undefined;
  let finish = () => {};
  render(
    <UsagePage
      agents={host([pixel, agent("Relay")], async (target) => {
        if (target === pixel) {
          if (fail) throw new Error("no workspace");
          return [session("a", 750_000)];
        }
        await held;
        return [session("b", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  const retry = await screen.findByRole(
    "button",
    { name: "Try again" },
    { timeout: 2000 },
  );
  // Pixel now reads at once, while Relay is held.
  fail = false;
  held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  retry.focus();
  await userEvent.setup().keyboard("{Enter}");
  // Pixel's read is shown; it stays named as failed until Relay's ends.
  expect(
    await screen.findByText(
      summary(
        "Your 2 agents ran 2 sessions in the last 30 days. Pixel accounts for 75% of the counted cost, mostly on Claude Opus 5.5.",
      ),
    ),
  ).toBeTruthy();
  expect(retry.isConnected).toBe(true);
  expect(document.activeElement).toBe(retry);
  finish();
  await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Refresh usage" }),
  );
});

it("says when prices could not load, keeps the sessions shown and loads them again", async () => {
  vi.mocked(loadPrices).mockRejectedValueOnce(new Error("chunk failed"));
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => [session("a", 250_000)])}
      open={vi.fn()}
    />,
  );
  expect((await screen.findByRole("status")).textContent).toBe(
    "Couldn’t load prices to estimate costs. Try again",
  );
  expect(
    screen.getByText(summary("Pixel ran 1 session in the last 30 days.")),
  ).toBeTruthy();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(loadPrices).toHaveBeenCalledTimes(2);
});

it("reads again when an agent is renamed or reconfigured", async () => {
  const pixel = agent("Pixel");
  const names: string[] = [];
  let listeners: (() => void)[] = [];
  const agents = host([pixel], async (target) => {
    names.push(target.name);
    return [];
  });
  let snapshot = agents.snapshot();
  const live = {
    ...agents,
    snapshot: () => snapshot,
    types: agents.types,
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  } as unknown as Agents;
  render(<UsagePage agents={live} open={vi.fn()} />);
  await vi.waitFor(() => expect(names).toEqual(["Pixel"]));
  const renamed = { ...pixel, name: "Pix", config: { workspace: "~/pix" } };
  snapshot = { ...snapshot, agents: [renamed], running: [renamed] };
  act(() => {
    for (const listener of listeners) listener();
  });
  await vi.waitFor(() => expect(names).toEqual(["Pixel", "Pix"]));
});

it("reads the same agent apart in another community, without the first's sessions", async () => {
  const pixel = agent("Pixel");
  const there = {
    ...pixel,
    key: `${pixel.pubkey}@other.example.com`,
    relay: "wss://other.example.com",
  };
  const read: string[] = [];
  let listeners: (() => void)[] = [];
  const agents = host([pixel], async (target) => {
    read.push(target.key);
    // Its read in the other community is still under way.
    return target === pixel ? [session("a", 750_000)] : new Promise(() => {});
  });
  let snapshot = agents.snapshot();
  const live = {
    ...agents,
    snapshot: () => snapshot,
    types: agents.types,
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  } as unknown as Agents;
  render(<UsagePage agents={live} open={vi.fn()} />);
  expect(
    await screen.findByText(
      summary("Pixel ran 1 session in the last 30 days."),
    ),
  ).toBeTruthy();
  snapshot = { ...snapshot, agents: [there], running: [there] };
  act(() => {
    for (const listener of listeners) listener();
  });
  await vi.waitFor(() => expect(read).toEqual([pixel.key, there.key]));
  expect(
    screen.queryByText(summary("Pixel ran 1 session in the last 30 days.")),
  ).toBeNull();
});

it("drops a filter whose agent is gone", async () => {
  const pixel = agent("Pixel");
  const relay = agent("Relay");
  let listeners: (() => void)[] = [];
  const agents = host([pixel, relay], async (target) => [
    session(target === pixel ? "a" : "b", target === pixel ? 750_000 : 250_000),
  ]);
  let snapshot = agents.snapshot();
  const live = {
    ...agents,
    snapshot: () => snapshot,
    types: agents.types,
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  } as unknown as Agents;
  render(<UsagePage agents={live} open={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Agent" }));
  await user.click(await screen.findByRole("option", { name: "Relay" }));
  expect(
    await screen.findByText(
      summary("Relay ran 1 session in the last 30 days."),
    ),
  ).toBeTruthy();
  // Relay leaves, and the Agent menu with it: Pixel's usage shows.
  snapshot = { ...snapshot, agents: [pixel], running: [pixel] };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(
    await screen.findByText(
      summary("Pixel ran 1 session in the last 30 days."),
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
});

it("shows a community's filters again when Settings shows Usage again, as on Back from a session", async () => {
  const { Card, open, publish } = usageCard(team());
  const first = render(<Card />);
  await pick("Period", "Last 7 days");
  await pick("Agent", "Relay");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Tidy the docs, Relay/ }),
  );
  expect(open).toHaveBeenCalledOnce();
  // Settings unmounts the card as the conversation opens; Back mounts it again.
  first.unmount();
  render(<Card />);
  expect(await screen.findByText(relayWeek)).toBeTruthy();
  // Another community has its own filters, the defaults until chosen.
  publish({ status: "ready", scope: two });
  expect(await screen.findByText(everyone)).toBeTruthy();
  expect(chosen("Period")).toContain("Last 30 days");
  expect(chosen("Agent")).toContain("All agents");
  publish({ status: "ready", scope: one });
  expect(await screen.findByText(relayWeek)).toBeTruthy();
});

it("keeps the harness chosen too", async () => {
  const { Card } = usageCard(mixed());
  const first = render(<Card />);
  await pick("Harness", "Codex");
  expect(await screen.findByText(solMonth)).toBeTruthy();
  first.unmount();
  render(<Card />);
  expect(await screen.findByText(solMonth)).toBeTruthy();
  expect(chosen("Harness")).toContain("Codex");
});

it("saves nothing until a filter is chosen", async () => {
  const { Card } = usageCard(team());
  render(<Card />);
  expect(await screen.findByText(everyone)).toBeTruthy();
  expect(localStorage.length).toBe(0);
  await pick("Agent", "Relay");
  expect(readView(one, "usage:filters", undefined)).toEqual({
    days: 30,
    agent: agent("Relay").pubkey,
    harness: "all",
  });
});

it("filters nothing by a saved agent or harness that is gone, and keeps it saved", async () => {
  const saved = {
    days: 30,
    agent: agent("Gone").pubkey,
    harness: "buzz.goose/goose",
  };
  writeView(one, "usage:filters", saved);
  const { Card } = usageCard(mixed());
  render(<Card />);
  expect(
    await screen.findByText(
      summary(
        "Your 2 agents ran 2 sessions across 2 harnesses in the last 30 days. Pixel accounts for 75% of the cost, mostly on Claude Opus 5.5.",
      ),
    ),
  ).toBeTruthy();
  expect(chosen("Agent")).toContain("All agents");
  expect(chosen("Harness")).toContain("All harnesses");
  expect(readView(one, "usage:filters", undefined)).toEqual(saved);
});

it("uses the defaults in place of saved filters it can't read", async () => {
  const { Card } = usageCard(team());
  for (const saved of [{ days: "7", agent: 5 }, null, [7, "all", "all"]]) {
    writeView(one, "usage:filters", saved);
    const { unmount } = render(<Card />);
    expect(await screen.findByText(everyone)).toBeTruthy();
    expect(chosen("Period")).toContain("Last 30 days");
    expect(chosen("Agent")).toContain("All agents");
    unmount();
  }
});

it("starts from the defaults each time, saving nothing, where the relay has no scope", async () => {
  const { Card } = usageCard(team(), { status: "disconnected" });
  const first = render(<Card />);
  await pick("Period", "Last 7 days");
  expect(chosen("Period")).toContain("Last 7 days");
  expect(localStorage.length).toBe(0);
  first.unmount();
  render(<Card />);
  expect(await screen.findByText(everyone)).toBeTruthy();
  expect(chosen("Period")).toContain("Last 30 days");
});

it("switches periods without reading again, comparing only 7 days", async () => {
  const reads: unknown[] = [];
  const earlier = session("old", 500_000);
  const at = Date.now() - 10 * 86_400_000;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async (_, options) => {
        reads.push(options);
        const now = session("now", 250_000);
        return [
          // Active today, but begun before the 30 days read.
          {
            ...now,
            observations: [
              ...now.observations,
              { ...now.observations[0], at: Date.now() - 40 * 86_400_000 },
            ] as typeof now.observations,
          },
          {
            ...earlier,
            startedAt: at,
            lastAt: at,
            observations: earlier.observations.map((entry) => ({
              ...entry,
              at,
            })),
          },
        ];
      })}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  // Days 31–60 were not read, so 30 days are not compared.
  expect(within(hero).getByText("$3.00")).toBeTruthy();
  expect(hero.textContent).not.toContain("previous");
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Period" }));
  await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
  const week = screen.getByRole("region", { name: "Estimated cost" });
  expect(within(week).getByText("$1.00")).toBeTruthy();
  expect(week.textContent).toContain("50% less than the previous 7 days");
  expect(reads).toHaveLength(1);
});

it("keeps showing what it read before when a refresh fails", async () => {
  let fail = false;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => {
        if (fail) throw new Error("no workspace");
        return [session("a", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$1.00")).toBeTruthy();
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect((await screen.findByRole("status")).textContent).toContain(
    "Couldn’t read the sessions of Pixel: no workspace. Showing what was read before.",
  );
  expect(
    within(screen.getByRole("region", { name: "Estimated cost" })).getByText(
      "$1.00",
    ),
  ).toBeTruthy();
});

it("estimates Codex's cost, and says the estimate is best effort", async () => {
  render(
    <UsagePage
      agents={host(
        [agent("Sol", "buzz.codex/codex")],
        async () => [],
        // $0.50 at GPT-6.1 Sol's $2 per million input tokens.
        async () => [session("a", 250_000, "Fix the build", "gpt-6.1-sol")],
      )}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$0.50")).toBeTruthy();
  expect(within(hero).getByRole("note").textContent).toBe(
    "Best-effort estimate from local session files at published API prices, not your bill.",
  );
});

it("says what it could not count instead of counting it as zero", async () => {
  render(
    <UsagePage
      agents={host([agent("Sol")], async () => [
        session("a", 1000, "Fix the build", "acme-1"),
      ])}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("Unavailable")).toBeTruthy();
  expect(
    screen.getByText(summary("Sol ran 1 session in the last 30 days.")),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Fix the build, Sol, cost unavailable. Open conversation",
    }),
  ).toBeTruthy();
  // Nor does the chart: today's figure is unknown, not $0.
  const today = within(screen.getByRole("table")).getAllByRole("row").at(-1);
  expect(today?.textContent).toContain("Unavailable");
  expect(today?.textContent).not.toContain("$0.00");
  // The figures show for the keyboard too, not only to screen readers.
  const table = screen.getByRole("table");
  expect(table.className).toBe("sr-only");
  const toggle = screen.getByRole("button", { name: "Show daily figures" });
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Hide daily figures");
  expect(table.className).not.toBe("sr-only");
});

it("keeps a day unknown when the only harness active then is unpriced", async () => {
  render(
    <UsagePage
      agents={host(
        [agent("Pixel"), agent("Sol", "buzz.codex/codex")],
        async () => [],
        async () => [session("a", 1000, "Fix the build", "acme-1")],
      )}
      open={vi.fn()}
    />,
  );
  await screen.findByRole("region", { name: "Estimated cost" });
  // Claude spent nothing today, which leaves the unpriced cost unknown, not $0.
  const today = within(screen.getByRole("table")).getAllByRole("row").at(-1);
  expect(
    [...(today?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent),
  ).toEqual(["$0.00", "Unavailable", "Unavailable"]);
});

it("compares nothing while an agent it shows could not be read", async () => {
  const pixel = agent("Pixel");
  const week = Date.now() - 8 * 86_400_000;
  render(
    <UsagePage
      agents={host([pixel, agent("Relay")], async (target) => {
        if (target !== pixel) throw new Error("no workspace");
        const now = session("now", 250_000);
        return [
          {
            ...now,
            observations: [
              { ...now.observations[0], at: week },
              ...now.observations,
            ] as typeof now.observations,
          },
        ];
      })}
      open={vi.fn()}
    />,
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "Couldn’t read the sessions of Relay: no workspace.",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Period" }));
  await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
  const hero = screen.getByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$1.00")).toBeTruthy();
  // Relay's spend may be missing from either week.
  expect(hero.textContent).not.toContain("previous 7 days");
  expect(hero.textContent).toContain("Partial");
});

it("explains where usage comes from when no agent reports any, and opens Agents to add one", async () => {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  render(
    <UsagePage
      agents={host([agent("Hosted", "buzz.codex/codex")], async () => [])}
      open={open}
    />,
  );
  expect(screen.getByText("No agent usage to show")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh usage" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
  });
});

it("says it runs in the desktop app where agents can't run", () => {
  const snapshot = {
    status: "unavailable",
    agents: [],
    running: [],
  } as unknown as AgentsSnapshot;
  render(
    <UsagePage
      agents={{ ...host([], async () => []), snapshot: () => snapshot }}
      open={vi.fn()}
    />,
  );
  expect(screen.getByText("Usage runs in the desktop app")).toBeTruthy();
  expect(
    screen.getByText("It reads the sessions your agents run on your computer."),
  ).toBeTruthy();
  expect(screen.queryByText(/community/)).toBeNull();
});

it("says why agents aren't available when they fail to load", () => {
  const agents = host([], async () => []);
  const failed = (error: string) => {
    const snapshot = {
      status: "error",
      error,
      agents: [],
      running: [],
    } as unknown as AgentsSnapshot;
    return { ...agents, snapshot: () => snapshot };
  };
  const { rerender } = render(
    <UsagePage
      agents={failed("Agent keys couldn’t be read.")}
      open={vi.fn()}
    />,
  );
  expect(screen.getByText("Agents aren’t available")).toBeTruthy();
  expect(screen.getByText("Agent keys couldn’t be read.")).toBeTruthy();
  // An error with no message still says what to do.
  rerender(<UsagePage agents={failed("")} open={vi.fn()} />);
  expect(screen.getByText("Try again in a moment.")).toBeTruthy();
});
