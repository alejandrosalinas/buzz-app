// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import {
  ARTIFACT_KIND,
  type Delivery,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  type AgentConfigHistory,
  AgentConfigVersionRow,
} from "./AgentConfigHistory";
import { AgentConfigHistoryRow } from "./AgentConfigHistoryRow";
import type { Agents, ConfigHistory } from "./service";
import type { HistorySelection } from "./history-presentation";
import { HISTORY_PAGE } from "./agent-config-history";

afterEach(cleanup);
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const d = "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e";
const expected = { channel, d, type: "buzz.agent.instructions" as const };
const rev = (
  id: string,
  prev: string | undefined,
  text: string,
  content = JSON.stringify({ version: 1, text }),
): RelayEvent =>
  ({
    id,
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    kind: ARTIFACT_KIND,
    created_at: 1_700_000_000,
    content,
    tags: [
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", "buzz.agent.instructions"],
      ["title", "Agent instructions"],
      ["op", prev ? "update" : "create"],
      ...(prev ? [["prev", prev]] : []),
    ],
  }) as RelayEvent;

/** Mount the production feed and its controlled version dialog together. */
function History(
  props: Pick<
    ComponentProps<typeof AgentConfigHistory>,
    "expected" | "head" | "read" | "onRevert" | "selected"
  >,
) {
  const [selected, select] = useState<HistorySelection | undefined>(
    props.selected ? { side: "instructions", id: props.selected } : undefined,
  );
  const snapshot = useMemo(() => ({}) as ReturnType<Agents["snapshot"]>, []);
  const history: ConfigHistory = {
    read: props.read,
    sides: [
      {
        side: "instructions",
        expected: props.expected,
        head: props.head,
        version: 0,
      },
    ],
    revise: (_side, template) => props.onRevert(template),
  };
  return (
    <AgentConfigHistoryRow
      agents={{
        configHistory: () => history,
        snapshot: () => snapshot,
        subscribe: () => () => {},
      }}
      pubkey="a"
      presentation={{ active: true, selected, select }}
    />
  );
}

it("shows recent versions relatively and older dates with an exact timestamp", () => {
  const now = Date.UTC(2026, 10, 3, 20);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const recent = {
    ...rev("recent", "old", "new"),
    created_at: now / 1000 - 7200,
  };
  const old = {
    ...rev("old", undefined, "old"),
    // Local noon keeps the calendar day "Oct 27" in every time zone.
    created_at: new Date(2025, 9, 27, 12).getTime() / 1000,
  };
  try {
    render(
      <ul>
        {[recent, old].map((event) => (
          <AgentConfigVersionRow
            key={event.id}
            event={event}
            head={recent}
            expected={expected}
            label="Instructions"
            onSelect={() => {}}
          />
        ))}
      </ul>,
    );
    const time = screen.getByText("2 hours ago");
    const current = screen.getByTitle("Current version");
    expect(screen.getAllByTitle("Current version")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /^Instructions · Current/ }),
    ).toContainElement(current);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-11-03T18:00:00.000Z");
    expect(time.getAttribute("title")).toMatch(/2026/);
    expect(time.getAttribute("title")).toMatch(/:00:00/);
    expect(screen.getByText("Oct 27, 2025")).toBeVisible();
  } finally {
    clock.mockRestore();
  }
});

it("pages older history, labels the gap, shows a diff and reverts on the head", async () => {
  // Newest first: r(n-1) … r0; one revision beyond the first page.
  const revisions = Array.from({ length: HISTORY_PAGE + 1 }, (_, i) => ({
    ...rev(`r${i}`, i ? `r${i - 1}` : undefined, `line ${i}`),
    created_at: 1_700_000_000 + i,
  })).reverse();
  let fail = false;
  const read: SnapshotRead = async ([filter]) => {
    if (fail) throw new Error("offline");
    if (!filter?.["#h"]?.includes(channel)) return [];
    const offset = filter?.offset ?? 0;
    return revisions.slice(offset, offset + (filter?.limit ?? 0));
  };
  const head = revisions[0] as RelayEvent;
  const onRevert = vi.fn(
    async (): Promise<Delivery> => ({ status: "accepted", event: head }),
  );
  render(
    <History expected={expected} head={head} read={read} onRevert={onRevert} />,
  );

  expect(
    await screen.findByText("Instructions: Older revisions aren't loaded yet."),
  ).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByText("Load older"));
  expect(
    await screen.findByText("Instructions: Couldn't load older revisions."),
  ).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Instructions / }),
    ).toHaveLength(HISTORY_PAGE + 1),
  );
  expect(screen.queryByText(/aren't loaded|Couldn't load/)).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: /^Instructions · Current/ }),
  );
  expect(
    within(within(screen.getByRole("dialog")).getByRole("heading")).getByText(
      "Current",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
  const diff = screen.getByRole("region", { name: "Changes" });
  expect(diff).toHaveTextContent(`− line ${HISTORY_PAGE - 1}`);
  expect(diff).toHaveTextContent(`+ line ${HISTORY_PAGE}`);

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(
    screen.getAllByRole("button", { name: /^Instructions / })[1] as HTMLElement,
  );
  expect(within(screen.getByRole("dialog")).queryByText("Current")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revert to this" }));
  expect(onRevert).toHaveBeenCalledOnce();
  const [template] = onRevert.mock.calls[0] as unknown as [
    { content: string; tags: string[][] },
  ];
  expect(template.content).toBe(revisions[1]?.content);
  expect(template.tags).toContainEqual(["op", "update"]);
  expect(template.tags).toContainEqual(["prev", head.id]);
});

it("labels a predecessor missing from complete history unavailable", async () => {
  const read: SnapshotRead = async () => [
    rev("r2", "r1", "b"),
    rev("r0", undefined, "a"),
  ];
  render(
    <History
      expected={expected}
      head={undefined}
      read={read}
      onRevert={async () => ({ status: "accepted", event: rev("x", "y", "") })}
    />,
  );
  expect(
    await screen.findByText(
      "Instructions: A revision here isn't available (removed or expired).",
    ),
  ).toBeInTheDocument();
  // The track reports its history in an effect; wait for the feed's commit too.
  expect(await screen.findByText("2 versions")).toBeVisible();
  expect(
    within(
      screen.getByRole("list", { name: "Previous versions" }),
    ).getAllByRole("listitem"),
  ).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
});

it("shows an invalid revision honestly and never offers to revert to it", async () => {
  const head = rev("r2", "r1", "fixed");
  const read: SnapshotRead = async () => [
    head,
    rev("r1", "r0", "", "not-json"),
    rev("r0", undefined, "first"),
  ];
  render(
    <History expected={expected} head={head} read={read} onRevert={vi.fn()} />,
  );
  expect(
    await screen.findByText(/^Instructions · Not valid/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /^Instructions · Not valid/ }),
  );
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
  expect(
    screen.getByText(
      /This revision isn't valid config \(Artifact content is not JSON\)/,
    ),
  ).toBeInTheDocument();
});

it("shows a failed revert beside the revision, keeps history and allows retry", async () => {
  const head = rev("r1", "r0", "new");
  const read: SnapshotRead = async () => [head, rev("r0", undefined, "old")];
  let settle: (delivery: Delivery) => void = () => {};
  const onRevert = vi.fn(
    () =>
      new Promise<Delivery>((resolve) => {
        settle = resolve;
      }),
  );
  render(
    <History expected={expected} head={head} read={read} onRevert={onRevert} />,
  );
  const button = () => screen.getByRole("button", { name: "Revert to this" });
  fireEvent.click(
    await screen.findByRole("button", { name: /^Instructions (?!·)/ }),
  );
  fireEvent.click(button());
  await waitFor(() => expect(button()).toHaveAttribute("aria-busy", "true"));
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeVisible();
  settle({
    status: "refused",
    event: head,
    refusal: "permission",
    message: "restricted: no longer allowed",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not reverted: restricted: no longer allowed",
  );
  expect(button()).not.toHaveAttribute("aria-busy", "true");
  expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(2);

  fireEvent.click(button());
  settle({ status: "uncertain", event: head, message: "connection lost" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't confirm the revert was saved (connection lost)",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("Not reverted");

  onRevert.mockRejectedValueOnce(new Error("signer unavailable"));
  fireEvent.click(button());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't confirm the revert was saved (signer unavailable)",
  );

  fireEvent.click(button());
  settle({ status: "accepted", event: head });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onRevert).toHaveBeenCalledTimes(4);
});

it("opens a version by keyboard, shows a missing predecessor honestly, and restores focus on Escape", async () => {
  const user = userEvent.setup();
  const head = rev("r2", "r1", "new");
  render(
    <History
      expected={expected}
      head={head}
      read={async () => [head]}
      onRevert={vi.fn()}
    />,
  );
  const row = await screen.findByRole("button", {
    name: /^Instructions · Current/,
  });
  row.focus();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", {
    name: "Instructions version Current",
  });
  expect(
    within(dialog).getByText(/previous revision isn't loaded/),
  ).toBeVisible();
  expect(screen.queryByText("Show changes")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(row).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not mark a missing revision current when the track has no head", async () => {
  render(
    <History
      expected={expected}
      head={undefined}
      selected="missing"
      read={async () => []}
      onRevert={vi.fn()}
    />,
  );
  expect(
    await screen.findByText("This version isn't in the loaded history."),
  ).toBeVisible();
  expect(
    screen.getByRole("dialog", { name: "Instructions version" }),
  ).toBeVisible();
  expect(within(screen.getByRole("dialog")).queryByText("Current")).toBeNull();
});

it("shows deletion details without offering to restore the deletion itself", async () => {
  const deleted = {
    ...rev("r1", "r0", ""),
    content: "",
    tags: [
      ...rev("r1", "r0", "").tags.filter(([key]) => key !== "op"),
      ["op", "delete"],
    ],
  };
  render(
    <History
      expected={expected}
      head={deleted}
      read={async () => [deleted, rev("r0", undefined, "old")]}
      onRevert={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: /^Instructions · Deleted · Current/,
    }),
  );
  expect(
    screen.getByText("This version removed this configuration."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Restore this" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: /^Instructions (?!·)/ }));
  expect(screen.getByRole("button", { name: "Restore this" })).toBeVisible();
});

it("loads an older page from a cold version dialog before offering its restore action", async () => {
  const revisions = Array.from({ length: HISTORY_PAGE + 1 }, (_, i) => ({
    ...rev(`r${i}`, i ? `r${i - 1}` : undefined, `line ${i}`),
    created_at: 1_700_000_000 + i,
  })).reverse();
  const read: SnapshotRead = async ([filter]) =>
    revisions.slice(
      filter?.offset ?? 0,
      (filter?.offset ?? 0) + (filter?.limit ?? 0),
    );
  render(
    <History
      expected={expected}
      head={revisions[0]}
      read={read}
      onRevert={vi.fn()}
      selected="r0"
    />,
  );
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(await dialog.findByRole("button", { name: "Load older" }));
  expect(
    await dialog.findByRole("region", { name: "Changes" }),
  ).toHaveTextContent("+ line 0");
  expect(dialog.getByRole("button", { name: "Revert to this" })).toBeVisible();
});
