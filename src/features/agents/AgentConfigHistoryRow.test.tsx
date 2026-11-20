// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { AgentConfigHistoryRow } from "./AgentConfigHistoryRow";
import { ARTIFACT_KIND } from "./agent-config-artifacts";
import { HISTORY_PAGE } from "./agent-config-history";
import type { Agents, ConfigHistory } from "./service";

afterEach(cleanup);

function fixture(size = 2) {
  const revision = (side: "settings" | "instructions", n: number): RelayEvent =>
    ({
      id: `${side}-${n}`,
      pubkey: "a".repeat(64),
      sig: "b".repeat(128),
      kind: ARTIFACT_KIND,
      created_at: 1_700_000_000 + n,
      content: JSON.stringify(
        side === "instructions"
          ? { version: 1, text: `Instruction ${n}` }
          : { version: 1, agent_type: "test", settings: {} },
      ),
      tags: [
        ["ar", "1"],
        ["h", "c"],
        ["d", side],
        ["type", `buzz.agent.${side}`],
        ["op", n ? "update" : "create"],
        ...(n ? [["prev", `${side}-${n - 1}`]] : []),
      ],
    }) as RelayEvent;
  const revisions = {
    settings: [revision("settings", 0)],
    instructions: Array.from({ length: size }, (_, n) =>
      revision("instructions", n),
    ).reverse(),
  };
  const read = vi.fn<ConfigHistory["read"]>(async ([filter]) => {
    const side = filter?.["#d"]?.[0] as keyof typeof revisions;
    return revisions[side].slice(
      filter?.offset ?? 0,
      (filter?.offset ?? 0) + (filter?.limit ?? 0),
    );
  });
  const revise = vi.fn<ConfigHistory["revise"]>(async () => ({
    status: "refused",
    message: "Config changed. Reload and try again.",
  }));
  const history: ConfigHistory = {
    read,
    revise,
    sides: (["settings", "instructions"] as const).map((side) => ({
      side,
      expected: { channel: "c", d: side, type: `buzz.agent.${side}` },
      head: revisions[side][0],
      version: 0,
    })),
  };
  const snapshot = {} as ReturnType<Agents["snapshot"]>;
  const agents = {
    configHistory: () => history,
    snapshot: () => snapshot,
    subscribe: () => () => {},
  };
  return { agents, read, revise };
}

it("counts both tracks while collapsed and preserves changes and conflict feedback across collapse", async () => {
  const { agents, read, revise } = fixture();
  const user = userEvent.setup();
  render(<AgentConfigHistoryRow agents={agents} pubkey="a" />);
  const row = screen.getByRole("button", { name: "Previous versions" });
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(await screen.findByText("3 versions")).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("region", { name: "Instructions" }),
  ).not.toBeInTheDocument();
  await user.click(row);
  const feed = within(screen.getByRole("list", { name: "Previous versions" }));
  expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Instructions" })).toBeNull();
  const entries = feed.getAllByRole("button");
  expect(entries).toHaveLength(3);
  expect(feed.queryByText(/\b(create|update)\b/)).toBeNull();
  expect(entries[0]).toHaveTextContent("Instructions · Current");
  expect(entries[1]).toHaveTextContent("Instructions");
  expect(entries[2]).toHaveTextContent("Settings · Current");
  await user.click(feed.getByRole("button", { name: /^Instructions (?!·)/ }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Instructions version" }),
  );
  expect(dialog.getByRole("region", { name: "Changes" })).toHaveTextContent(
    "+ Instruction 0",
  );
  await user.click(dialog.getByRole("button", { name: "Revert to this" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "Not reverted: Config changed.",
  );
  expect(revise).toHaveBeenCalledWith(
    "instructions",
    expect.objectContaining({
      tags: expect.arrayContaining([["prev", "instructions-1"]]),
    }),
  );
  await user.click(dialog.getByRole("button", { name: "Close" }));
  await user.click(row);
  await user.click(row);
  await user.click(feed.getByRole("button", { name: /^Instructions (?!·)/ }));
  expect(screen.getByRole("region", { name: "Changes" })).toBeVisible();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
});

it("marks paginated counts as incomplete and updates the count after Load older", async () => {
  const { agents } = fixture(HISTORY_PAGE + 1);
  const user = userEvent.setup();
  render(<AgentConfigHistoryRow agents={agents} pubkey="a" />);
  expect(await screen.findByText("101+ versions")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Previous versions" }));
  await user.click(screen.getByRole("button", { name: "Load older" }));
  expect(await screen.findByText("102 versions")).toBeInTheDocument();
});

it("restores an expanded history address on the first commit and keeps it expanded across dialog selection", async () => {
  const { agents } = fixture();
  const commits: string[] = [];
  const select = vi.fn();
  function Probe({
    selected,
  }: {
    selected?: { side: "instructions"; id: string };
  }) {
    useLayoutEffect(() => {
      commits.push(
        screen
          .getByRole("button", { name: "Previous versions", hidden: true })
          .getAttribute("aria-expanded") ?? "missing",
      );
    });
    return (
      <AgentConfigHistoryRow
        agents={agents}
        pubkey="a"
        presentation={{ active: true, selected, select }}
      />
    );
  }
  const view = render(<Probe />);
  expect(commits[0]).toBe("true");
  await screen.findByText("3 versions");
  view.rerender(
    <Probe selected={{ side: "instructions", id: "instructions-1" }} />,
  );
  expect(
    await screen.findByRole("dialog", { name: "Instructions version Current" }),
  ).toBeVisible();
  view.rerender(<Probe />);
  expect(commits.every((value) => value === "true")).toBe(true);
});

it("keeps loaded pages in the feed's first commit after a dialog-route remount", async () => {
  const { agents, read } = fixture(HISTORY_PAGE + 1);
  const user = userEvent.setup();
  const view = render(
    <AgentConfigHistoryRow
      agents={agents}
      pubkey="a"
      presentation={{ active: true, select: vi.fn() }}
    />,
  );
  await screen.findByText("101+ versions");
  await user.click(screen.getByRole("button", { name: "Load older" }));
  await screen.findByText("102 versions");
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
  const firstCommit: number[] = [];
  function Probe() {
    useLayoutEffect(() => {
      firstCommit.push(
        within(
          screen.getByRole("list", { name: "Previous versions", hidden: true }),
        ).getAllByRole("listitem", { hidden: true }).length,
      );
    }, []);
    return (
      <AgentConfigHistoryRow
        agents={agents}
        pubkey="a"
        presentation={{
          active: true,
          selected: { side: "instructions", id: "instructions-0" },
          select: vi.fn(),
        }}
      />
    );
  }
  render(<Probe />);
  expect(firstCommit).toEqual([102]);
  expect(
    await screen.findByRole("dialog", { name: "Instructions version" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Revert to this" })).toBeVisible();
  expect(read).toHaveBeenCalledTimes(3);
});

it("preserves no-schema validity markers while opening and closing history", async () => {
  const { agents } = fixture();
  render(<AgentConfigHistoryRow agents={agents} pubkey="a" />);
  await screen.findByText("3 versions");
  const user = userEvent.setup();
  const disclosure = screen.getByRole("button", { name: "Previous versions" });
  const settings = () =>
    screen.getByRole("button", {
      name: /Settings · Current · Not valid/,
      hidden: true,
    });
  expect(settings()).toBeInTheDocument();
  await user.click(disclosure);
  expect(settings()).toBeVisible();
  await user.click(settings());
  expect(screen.getByText(/No settings schema to check against/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(disclosure);
  expect(settings()).toBeInTheDocument();
});

it.each([
  ["not-json", "· Not valid"],
  [
    JSON.stringify({
      version: 1,
      agentType: "test",
      settings: { future: "on" },
    }),
    "Incompatible",
  ],
])(
  "keeps the settings revision label when history collapses (%s)",
  async (content, label) => {
    const { agents } = fixture();
    const history = agents.configHistory();
    Object.assign(
      history.sides.find(({ side }) => side === "settings")?.head ?? {},
      { content },
    );
    const checked = {
      ...agents,
      configHistory: () => ({
        ...history,
        settings: { agentType: "test", schema: {} },
      }),
    };
    render(<AgentConfigHistoryRow agents={checked} pubkey="a" />);
    await screen.findByText("3 versions");
    const user = userEvent.setup();
    const disclosure = screen.getByRole("button", {
      name: "Previous versions",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const row = () =>
      screen.getByRole("button", {
        name: new RegExp(`Settings · Current\\s*${label}`),
        hidden: true,
      });
    expect(row()).toBeVisible();
    await user.click(disclosure);
    expect(row()).toBeInTheDocument();
  },
);
