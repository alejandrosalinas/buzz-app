// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { InterruptedNotice } from "./InterruptedNotice";
import type { RelayEvent } from "../relay/events";
import type { Agent, Agents, AgentsSnapshot, InterruptedTurn } from "./service";

afterEach(cleanup);

/** Agents as far as the notice uses it. */
function fake(
  names: readonly string[],
  turns: Readonly<Record<string, readonly InterruptedTurn[]>> = {},
  read: Agents["readInterrupted"] = async () => [],
) {
  let state: AgentsSnapshot = {
    status: "ready",
    classifier: "unavailable",
    agents: [],
    running: [],
    interrupted: names.map((name) => ({ name, key: name }) as Agent),
    teams: [],
  };
  const listeners = new Set<() => void>();
  const forget = () => {
    state = { ...state, interrupted: [] };
    for (const listener of listeners) listener();
  };
  const agents = {
    /** An unrelated update: the same agents in a new list. */
    rebuild: () => {
      state = { ...state, interrupted: [...state.interrupted] };
      for (const listener of listeners) listener();
    },
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resumeInterrupted: vi.fn(forget),
    dismissInterrupted: vi.fn(forget),
    interruptedTurns: (agent: Agent) => turns[agent.key] ?? [],
    readInterrupted: vi.fn(read),
  };
  render(
    <ToastProvider>
      <InterruptedNotice agents={agents as unknown as Agents} />
    </ToastProvider>,
  );
  return agents;
}

it("asks before resuming the agents the app stopped, and goes once answered", async () => {
  const agents = fake(["Echo", "Claude"]);
  await screen.findByRole("dialog", { name: "Resume interrupted agents?" });
  expect(
    screen.getByText(
      "Echo and Claude were working when Buzz closed or reloaded.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /dismiss/i }),
  ).not.toBeInTheDocument();
  act(() => fireEvent.click(screen.getByRole("button", { name: "Resume" })));
  expect(agents.resumeInterrupted).toHaveBeenCalledOnce();
  expect(agents.dismissInterrupted).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("forgets them when the owner does not resume", async () => {
  const agents = fake(["Echo"]);
  await screen.findByRole("dialog", { name: "Resume interrupted agent?" });
  expect(
    screen.getByText("Echo was working when Buzz closed or reloaded."),
  ).toBeVisible();
  act(() =>
    fireEvent.click(screen.getByRole("button", { name: "Don’t resume" })),
  );
  expect(agents.dismissInterrupted).toHaveBeenCalledOnce();
  expect(agents.resumeInterrupted).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("shows nothing when no agent was stopped", () => {
  fake([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

const id = (n: number) => n.toString(16).padStart(64, "0");
const mention = (n: number, content: string, root?: number): RelayEvent =>
  ({
    id: id(n),
    content,
    created_at: n,
    tags: root
      ? [
          ["e", id(root), "", "root"],
          ["e", id(root), "", "reply"],
        ]
      : [],
  }) as unknown as RelayEvent;

it("shows where each agent was working only once opened, one row per conversation", async () => {
  let release!: (events: RelayEvent[]) => void;
  const general = { id: "c1", name: "general" } as InterruptedTurn["channel"];
  const agents = fake(
    ["Echo", "Claude"],
    {
      Echo: [
        { id: id(1), channelId: "c1", channel: general },
        { id: id(2), channelId: "c1", channel: general },
      ],
      Claude: [{ id: id(3), channelId: "c9" }],
    },
    (agent) =>
      agent.key === "Echo"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve([]),
  );
  const trigger = await screen.findByRole("button", { name: "3 mentions" });
  expect(agents.readInterrupted).not.toHaveBeenCalled();
  act(() => fireEvent.click(trigger));
  expect(agents.readInterrupted).toHaveBeenCalledTimes(2);
  expect(await screen.findByText("Details unavailable")).toBeVisible();
  expect(screen.getAllByText("Checking…")).toHaveLength(2);
  expect(screen.getByText("Unknown channel")).toBeVisible();
  act(() =>
    release([mention(1, "Fix the build"), mention(2, "and the tests", 1)]),
  );
  expect(
    await screen.findByText("In channel · “Fix the build” · 2 mentions"),
  ).toBeVisible();
  expect(screen.getAllByText("general")).toHaveLength(1);
  expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Echo" })).toBeVisible();
});

it("offers details for a single mention, without naming its agent again", async () => {
  fake(["Echo"], { Echo: [{ id: id(4), channelId: "c1" }] }, async () => [
    mention(4, "Review this", 7),
  ]);
  const trigger = await screen.findByRole("button", { name: "1 mention" });
  act(() => fireEvent.click(trigger));
  expect(await screen.findByText("Thread · “Review this”")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Echo" }),
  ).not.toBeInTheDocument();
});

it("keeps one read per agent across unrelated snapshot updates", async () => {
  let signal!: AbortSignal;
  let release!: (events: RelayEvent[]) => void;
  const agents = fake(
    ["Echo"],
    { Echo: [{ id: id(5), channelId: "c1" }] },
    (_agent, given) => {
      signal = given;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  const trigger = await screen.findByRole("button", { name: "1 mention" });
  act(() => fireEvent.click(trigger));
  await screen.findByText("Checking…");
  act(() => agents.rebuild());
  act(() => agents.rebuild());
  expect(agents.readInterrupted).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(false);
  act(() => release([mention(5, "Ship it")]));
  expect(await screen.findByText("In channel · “Ship it”")).toBeVisible();
  act(() => agents.rebuild());
  expect(agents.readInterrupted).toHaveBeenCalledOnce();
  expect(screen.getByText("In channel · “Ship it”")).toBeVisible();
});

it("reads a failed preview again when reopened, keeping one that worked", async () => {
  let fail = true;
  const agents = fake(
    ["Echo"],
    { Echo: [{ id: id(6), channelId: "c1" }] },
    async () => {
      if (fail) throw new Error("offline");
      return [mention(6, "Try again")];
    },
  );
  const trigger = await screen.findByRole("button", { name: "1 mention" });
  act(() => fireEvent.click(trigger));
  expect(await screen.findByText("Couldn’t load details")).toBeVisible();
  fail = false;
  act(() => fireEvent.click(trigger));
  act(() => fireEvent.click(trigger));
  expect(await screen.findByText("In channel · “Try again”")).toBeVisible();
  expect(agents.readInterrupted).toHaveBeenCalledTimes(2);
  act(() => fireEvent.click(trigger));
  act(() => fireEvent.click(trigger));
  await screen.findByText("In channel · “Try again”");
  expect(agents.readInterrupted).toHaveBeenCalledTimes(2);
});

it("puts the details list in the tab order, so a long one scrolls by keyboard", async () => {
  fake(["Echo"], { Echo: [{ id: id(8), channelId: "c1" }] });
  const trigger = await screen.findByRole("button", { name: "1 mention" });
  act(() => fireEvent.click(trigger));
  const list = await screen.findByRole("region", {
    name: "Interrupted conversations",
  });
  expect(list).toHaveAttribute("tabindex", "0");
});

it("stops its reads when the notice goes", async () => {
  let signal!: AbortSignal;
  const agents = fake(
    ["Echo"],
    { Echo: [{ id: id(9), channelId: "c1" }] },
    (_agent, given) => {
      signal = given;
      return new Promise(() => {});
    },
  );
  const trigger = await screen.findByRole("button", { name: "1 mention" });
  act(() => fireEvent.click(trigger));
  await screen.findByText("Checking…");
  act(() =>
    fireEvent.click(screen.getByRole("button", { name: "Don’t resume" })),
  );
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(agents.dismissInterrupted).toHaveBeenCalledOnce();
});
