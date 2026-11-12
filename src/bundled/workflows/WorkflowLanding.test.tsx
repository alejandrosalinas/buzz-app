// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useCallback, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import { createWorkflows } from "../../features/workflows/capability";
import { WorkflowLanding, workflowOperationLocked } from "./WorkflowLanding";
import type {
  WorkflowDefinition,
  WorkflowOperation,
} from "../../features/workflows/types";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
  fixtureYaml,
} from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const channel = (index: number): ChannelSummary => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Channel ${index}`,
  channelType: index % 2 ? "stream" : "dm",
});
const author = keypair();
function event(id: string, createdAt = 123): RelayEvent {
  return signed(author, {
    created_at: createdAt,
    kind: 30620,
    tags: [
      ["h", id],
      ["d", fixtureDefinition.id],
    ],
    content: fixtureYaml,
  });
}
function mount(
  initial = [channel(1), channel(2), channel(3)],
  prepare?: (owner: ReturnType<typeof createWorkflows>) => void,
) {
  let channels = initial;
  const reads: {
    ids: readonly string[];
    filters: readonly ReadFilter[];
    signal: AbortSignal | undefined;
    resolve(events: readonly RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const owner = createWorkflows({
    viewer: author.pubkey,
    outbox: undefined,
    local: undefined,
    host: undefined,
    canAccess: (id) => channels.some((item) => item.id === id),
    reader: {
      read(filters, options) {
        return new Promise((resolve, reject) => {
          reads.push({
            ids: filters.flatMap((filter) => filter["#h"] ?? []),
            filters,
            signal: options?.signal,
            resolve,
            reject,
          });
        });
      },
    },
  });
  prepare?.(owner);
  let refresh = 0;
  let mountKey = 0;
  let saveReadback:
    | Pick<WorkflowDefinition, "channelId" | "revision">
    | undefined;
  const element = () => (
    <StrictMode>
      <WorkflowLanding
        filter={[]}
        onFilterChange={() => {}}
        key={mountKey}
        capability={owner.capability}
        channels={channels}
        refreshRequest={refresh}
        saveReadback={saveReadback}
        viewer={author.pubkey}
        detailTarget={null}
        selected={undefined}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
      />
    </StrictMode>
  );
  const rendered = render(element());
  return {
    owner,
    reads,
    change(next: ChannelSummary[], revoke = false) {
      channels = next;
      act(() => {
        if (revoke) owner.clear();
        rendered.rerender(element());
      });
    },
    remount() {
      mountKey++;
      rendered.rerender(element());
    },
    refresh() {
      refresh++;
      rendered.rerender(element());
    },
    readback(channelId: string, revision: string) {
      saveReadback = { channelId, revision };
      rendered.rerender(element());
    },
    async finish(index: number, events: readonly RelayEvent[] = []) {
      await waitFor(() => expect(reads.length).toBeGreaterThan(index));
      await act(async () => {
        reads[index]?.resolve(events);
      });
    },
    close() {
      rendered.unmount();
      owner.dispose();
      for (const read of reads) read.resolve([]);
    },
  };
}

it("shows a joined channel's workflows after its read completes in Recently updated", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a]);
  const user = userEvent.setup();
  try {
    await fixture.finish(0, [event(a.id)]);
    screen.getByRole("button", { name: "Sort workflows" }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Recently updated" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const recentSurvivor = screen.getByRole("button", {
      name: /^Open Message helper:/,
    });
    fixture.change([a, b]);
    await fixture.finish(1, [event(b.id)]);
    expect(fixture.reads[1]?.ids).toEqual([b.id]);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
    expect(recentSurvivor).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    fixture.close();
  }
});

it("groups repeated workflows by channel identity in channel-name order", async () => {
  const first = { ...channel(1), name: "Zulu" };
  const second = { ...channel(2), name: "Alpha" };
  const sameName = { ...channel(3), name: "Alpha" };
  const fixture = mount([first, sameName, second]);
  try {
    await fixture.finish(0, [
      event(first.id),
      event(second.id),
      signed(author, {
        created_at: 124,
        kind: 30620,
        tags: [
          ["h", second.id],
          ["d", "00000000-0000-4000-8000-000000000999"],
        ],
        content: fixtureYaml,
      }),
      event(sameName.id),
    ]);
    const groups = screen.getAllByRole("region");
    expect(
      groups.map((group) => within(group).getByRole("heading").textContent),
    ).toEqual(["Alpha", "Alpha", "Zulu"]);
    expect(
      groups.map(
        (group) =>
          within(group).getAllByRole("button", {
            name: /^Open Message helper:/,
          }).length,
      ),
    ).toEqual([2, 1, 1]);
  } finally {
    fixture.close();
  }
});

it("reads 500 mixed member channels in four serial batches and never rereads on metadata reorder", async () => {
  const channels = Array.from({ length: 500 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    expect(fixture.reads[0]?.ids).toHaveLength(128);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    fixture.change(
      [...channels].reverse().map((c) => ({ ...c, name: `Renamed ${c.name}` })),
    );
    for (let i = 0; i < 4; i++) {
      expect(fixture.reads).toHaveLength(i + 1);
      await fixture.finish(i);
    }
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(fixture.reads.map((r) => r.ids.length)).toEqual([
      128, 128, 128, 116,
    ]);
    expect(fixture.reads.flatMap((r) => r.ids)).toEqual(
      channels.map((c) => c.id),
    );
    fixture.change(channels);
    expect(fixture.reads).toHaveLength(4);
  } finally {
    fixture.close();
  }
});

it("adds only new IDs, cancels removed batches, ignores late completion, and refreshes deliberately", async () => {
  const [a, b, c, d] = [channel(1), channel(2), channel(3), channel(4)];
  const fixture = mount([a, b]);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    fixture.change([c, a, b]);
    fixture.change([a, c, d]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    expect(fixture.reads[0]?.signal?.aborted).toBe(true);
    await fixture.finish(0, [event(b.id)]);
    await fixture.finish(1, [event(a.id)]);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(1);
    expect(fixture.reads.map((r) => r.ids)).toEqual([
      [a.id, b.id],
      [a.id, c.id, d.id],
    ]);
    fixture.refresh();
    await fixture.finish(2);
    expect(fixture.reads[2]?.ids).toEqual([a.id, c.id, d.id]);
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("purges globally without automatic reads and recovers remaining channels on membership removal", async () => {
  const [a, b, c] = [channel(1), channel(2), channel(3)];
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^Status(?::|$)/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Enabled" }));
    // The filter exit is still mounted, even though role queries hide it.
    expect(screen.getAllByText("Message helper")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    fixture.change([a, c], true);
    expect(screen.queryByText("Message helper")).toBeNull();
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    await fixture.finish(1, [event(b.id)]);
    await fixture.finish(2, [event(a.id)]);
    expect(fixture.reads[2]?.ids).toEqual([a.id, c.id]);
    fireEvent.click(
      screen.getByRole("button", { name: "Clear status filter" }),
    );
    expect(screen.getByText("Message helper")).toBeInTheDocument();
    act(() => fixture.owner.clear());
    expect(screen.queryByText("Message helper")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "cleared or unavailable",
    );
    fixture.change([c, a]);
    expect(fixture.reads).toHaveLength(3);
    fixture.refresh();
    await fixture.finish(3);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    fixture.close();
  }
});

it("purges a pending filter exit immediately when session access clears", async () => {
  const fixture = mount([channel(1)]);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^Status(?::|$)/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Enabled" }));
    expect(screen.getByText("Message helper")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    act(() => fixture.owner.clear());
    expect(screen.queryByText("Message helper")).toBeNull();
  } finally {
    fixture.close();
  }
});

for (const sort of ["By channel", "Recently updated"]) {
  it(`purges only removed-channel content during a pending filter exit in ${sort}`, async () => {
    const [a, b] = [channel(1), channel(2)];
    const fixture = mount([a, b]);
    try {
      await fixture.finish(0, [event(a.id), event(b.id)]);
      if (sort === "Recently updated") {
        const user = userEvent.setup();
        screen.getByRole("button", { name: "Sort workflows" }).focus();
        await user.keyboard("{Enter}");
        await user.click(
          await screen.findByRole("menuitemradio", { name: sort }),
        );
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      }
      const [survivor, removed] = screen.getAllByRole("button", {
        name: /^Open Message helper:/,
      });
      expect(survivor).toBeInTheDocument();
      expect(removed).toBeInTheDocument();
      fixture.refresh();
      await waitFor(() => expect(fixture.reads).toHaveLength(2));
      fireEvent.click(screen.getByRole("button", { name: /^Status(?::|$)/ }));
      fireEvent.click(screen.getByRole("radio", { name: "Enabled" }));
      expect(screen.getAllByText("Message helper")).toHaveLength(2);
      expect(
        screen.queryByRole("button", { name: /^Open Message helper:/ }),
      ).toBeNull();
      fixture.change([a]);
      expect(removed).not.toBeInTheDocument();
      expect(survivor).toBeInTheDocument();
      expect(screen.getAllByText("Message helper")).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });
}

it("purges again during partial recovery while cleared channels remain", async () => {
  // Three batches keep idle channels after the first recovery batch completes.
  const channels = Array.from({ length: 257 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    act(() => fixture.owner.clear());
    expect(screen.queryByText("Message helper")).toBeNull();
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);

    fixture.refresh();
    await fixture.finish(2, [event(channel(1).id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(4));
    expect(fixture.reads[3]?.ids).toHaveLength(128);
    expect(screen.getByText("Message helper")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Reading workflows");

    act(() => fixture.owner.clear());
    // Hidden exit DOM also contains revoked content and must disappear now.
    expect(screen.queryByText("Message helper")).toBeNull();
    expect(fixture.reads[3]?.signal?.aborted).toBe(true);
    await fixture.finish(3, [event(channel(129).id)]);
    expect(screen.queryByText("Message helper")).toBeNull();
    expect(fixture.reads).toHaveLength(4);
    expect(screen.getByRole("status")).toHaveTextContent(
      "cleared or unavailable",
    );

    fixture.refresh();
    for (let index = 4; index < 7; index++)
      await fixture.finish(index, index === 4 ? [event(channel(1).id)] : []);
    expect(screen.getByText("Message helper")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    fixture.close();
  }
});

it("finishes paging before the next batch, resets its cursor, and retains loaded cards on retry", async () => {
  const channels = Array.from({ length: 129 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    const page = Array.from({ length: 100 }, (_, i) =>
      event(channel(1).id, 100 + i),
    );
    await fixture.finish(0, page);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    expect(fixture.reads[1]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": channels.slice(0, 128).map((c) => c.id),
        limit: 100,
        until: 100,
        before_id: page[0]?.id,
      },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Reading workflows");
    await fixture.finish(1, [event(channel(2).id, 99)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(fixture.reads[2]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": [channel(129).id],
        limit: 100,
      },
    ]);
    await act(async () => fixture.reads[2]?.reject(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.reads).toHaveLength(4));
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
    const nextPage = Array.from({ length: 100 }, (_, i) =>
      event(channel(129).id, 200 + i),
    );
    await fixture.finish(3, nextPage);
    await waitFor(() => expect(fixture.reads).toHaveLength(5));
    expect(fixture.reads[4]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": [channel(129).id],
        limit: 100,
        until: 200,
        before_id: nextPage[0]?.id,
      },
    ]);
    await fixture.finish(4);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(3);
    expect(screen.queryByText(/returned a partial workflow list/)).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    fixture.close();
  }
});

it("stops queued batches on interruption, retains cards and resumes on refresh", async () => {
  const channels = Array.from({ length: 257 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    act(() => fixture.owner.interrupt());
    await fixture.finish(1, [event(channel(129).id)]);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    expect(fixture.reads).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(1);
    expect(screen.queryByText("Reading workflows…")).toBeNull();
    fixture.refresh();
    for (let i = 2; i < 5; i++) await fixture.finish(i);
    expect(fixture.reads.slice(2).flatMap((r) => r.ids)).toEqual(
      channels.map((c) => c.id),
    );
  } finally {
    fixture.close();
  }
});

it("keeps session purge coverage after removing a completed batch member without rereading", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    fixture.change([a]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    expect(fixture.reads).toHaveLength(1);
    fixture.refresh();
    await fixture.finish(1, [event(a.id)]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
  } finally {
    fixture.close();
  }
});

it("retains cards and explicit retry after removing a completed batch member then interrupting", async () => {
  const [a, b, c] = [channel(1), channel(2), channel(3)];
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id), event(c.id)]);
    fixture.change([a, c]);
    expect(fixture.reads).toHaveLength(1);
    act(() => fixture.owner.interrupt());
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery paused.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await fixture.finish(1, [event(a.id)]);
    expect(fixture.reads[1]?.ids).toEqual([a.id]);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    expect(fixture.reads).toHaveLength(2);
  } finally {
    fixture.close();
  }
});

it("retains a batch's loaded cards when its refresh fails", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    fixture.refresh();
    await fixture.finish(2);
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("does not reread recovered channels when a membership is added after explicit recovery", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a]);
  try {
    await fixture.finish(0);
    act(() => fixture.owner.clear());
    fixture.refresh();
    await fixture.finish(1);
    fixture.change([a, b]);
    await fixture.finish(2);
    expect(fixture.reads.map((r) => r.ids)).toEqual([[a.id], [a.id], [b.id]]);
  } finally {
    fixture.close();
  }
});

for (const interrupt of [false, true]) {
  it(`pauses honestly on ${interrupt ? "interruption" : "read failure"} and retries only unfinished batches`, async () => {
    const channels = Array.from({ length: 300 }, (_, i) => channel(i + 1));
    const fixture = mount(channels);
    try {
      await fixture.finish(0, [event(channel(1).id)]);
      await waitFor(() => expect(fixture.reads).toHaveLength(2));
      await act(async () => {
        if (interrupt) fixture.owner.interrupt();
        else fixture.reads[1]?.reject(new Error("offline"));
      });
      if (interrupt) await fixture.finish(1);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow discovery paused.",
      );
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(
        document.querySelectorAll(".workflow-collection > *"),
      ).toHaveLength(1);
      const remaining = [...channels.filter((_, i) => i !== 130), channel(301)];
      fixture.change([...remaining].reverse());
      expect(fixture.reads).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const expected = remaining.filter(
        (c) =>
          interrupt || !channels.slice(0, 128).some((old) => old.id === c.id),
      );
      for (let i = 0; i < Math.ceil(expected.length / 128); i++)
        await fixture.finish(
          2 + i,
          interrupt && i === 0 ? [event(channel(1).id)] : [],
        );
      expect(fixture.reads.slice(2).flatMap((r) => r.ids)).toEqual(
        expected.map((c) => c.id),
      );
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^Open Message helper:/ }),
        ).toBeVisible(),
      );
    } finally {
      fixture.close();
    }
  });
}

it("reports synchronous view admission failure once and retries its unread roster", async () => {
  const blockers: { dispose(): void }[] = [];
  const fixture = mount([channel(1), channel(2)], (owner) => {
    for (let i = 0; i < 16; i++)
      blockers.push(owner.capability.definitions(channel(1).id));
  });
  try {
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery paused.",
    );
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(fixture.reads).toHaveLength(0);
    for (const view of blockers) view.dispose();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await fixture.finish(0);
    expect(fixture.reads.map((r) => r.ids)).toEqual([
      [channel(1).id, channel(2).id],
    ]);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    for (const view of blockers) view.dispose();
    fixture.close();
  }
});

it("queues verified readback after an older pending read and rereads only the saved channel", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.readback(a.id, "first-revision");
    expect(fixture.reads).toHaveLength(2);
    expect(fixture.reads[1]?.signal?.aborted).toBe(false);
    await fixture.finish(1);
    await fixture.finish(2, [event(a.id)]);
    expect(fixture.reads.map((read) => read.ids)).toEqual([
      [a.id, b.id],
      [a.id, b.id],
      [a.id],
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
    fixture.change([b, a]);
    expect(fixture.reads).toHaveLength(3);
    fixture.readback(a.id, "second-revision");
    await fixture.finish(3, [event(a.id, 124)]);
    expect(fixture.reads[3]?.ids).toEqual([a.id]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    fixture.change([a, b]);
    expect(fixture.reads).toHaveLength(4);
  } finally {
    fixture.close();
  }
});

it("drops queued readback for a removed membership without restoring its card", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.readback(a.id, "saved-revision");
    fixture.change([b], true);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    await fixture.finish(1, [event(a.id)]);
    await fixture.finish(2);
    expect(fixture.reads[2]?.ids).toEqual([b.id]);
    fixture.readback(a.id, "late-revision");
    expect(fixture.reads).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    fixture.close();
  }
});

it("reuses fresh session cache and does not replay readback on landing remount", async () => {
  const [a, b] = [channel(1), channel(2)];
  const saved = event(a.id);
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [saved]);
    fixture.readback(a.id, saved.id);
    expect(fixture.reads).toHaveLength(1);
    fixture.remount();
    await waitFor(() =>
      expect(screen.getByRole("status")).toBeEmptyDOMElement(),
    );
    expect(fixture.reads).toHaveLength(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
  } finally {
    fixture.close();
  }
});

it("rereads an overlapping landing batch after queued verified readback", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => 0);
  const [a, b] = [channel(1), channel(2)];
  const saved = event(a.id);
  const fixture = mount([a, b]);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    fixture.readback(a.id, saved.id);
    expect(fixture.reads).toHaveLength(1);
    await fixture.finish(0);
    await fixture.finish(1, [saved]);
    expect(fixture.reads.map((read) => read.ids)).toEqual([
      [a.id, b.id],
      [a.id],
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );

    fixture.remount();
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(fixture.reads[2]?.ids).toEqual([a.id, b.id]);
    await fixture.finish(2, [saved]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
  } finally {
    fixture.close();
  }
});

it("reuses fresh cached results for every completed batch after navigation", async () => {
  const channels = Array.from({ length: 129 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    await fixture.finish(1, [event(channel(129).id)]);
    await waitFor(() =>
      expect(screen.getByRole("status")).toBeEmptyDOMElement(),
    );
    expect(fixture.reads.map((read) => read.ids.length)).toEqual([128, 1]);
    fixture.remount();
    await waitFor(() =>
      expect(screen.getByRole("status")).toBeEmptyDOMElement(),
    );
    expect(fixture.reads).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /^Open Message helper:/ }),
    ).toHaveLength(2);
  } finally {
    fixture.close();
  }
});

it("shows stale cached cards on remount while refreshing and retrying", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    now = 10_001;
    fixture.remount();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      ).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  } finally {
    fixture.close();
  }
});

it("locks configuration only for in-flight writes, deletions and unconfirmed newest saves", () => {
  const op = (
    action: WorkflowOperation["action"],
    outcome: WorkflowOperation["outcome"],
    eventId = "cc".repeat(32),
    createdAt = fixtureDefinition.createdAt,
  ): WorkflowOperation => ({
    eventId,
    workflow: fixtureDefinition,
    action,
    createdAt,
    delivery: outcome === "pending" ? "sending" : "accepted",
    outcome,
  });
  const locked = (...operations: WorkflowOperation[]) =>
    workflowOperationLocked(operations, fixtureDefinition);
  // Journaled run requests lose their receipt across restarts; they never lock.
  expect(locked(op("trigger", "unknown"), op("trigger", "succeeded"))).toBe(
    false,
  );
  expect(locked(op("trigger", "rejected"), op("save", "rejected"))).toBe(false);
  expect(locked(op("trigger", "pending"))).toBe(true);
  expect(locked(op("delete", "unknown"))).toBe(true);
  expect(locked(op("delete", "succeeded"))).toBe(true);
  // A save awaiting readback locks until its revision, or a newer head, is read.
  expect(locked(op("save", "succeeded"))).toBe(true);
  expect(locked(op("save", "unknown", fixtureDefinition.revision))).toBe(false);
  expect(
    locked(
      op("save", "unknown", "cc".repeat(32), fixtureDefinition.createdAt - 1),
    ),
  ).toBe(false);
  // Only the newest save matters, and other workflows never lock this one.
  expect(
    locked(
      op("save", "succeeded"),
      op("save", "succeeded", fixtureDefinition.revision),
    ),
  ).toBe(false);
  expect(
    locked({
      ...op("save", "pending"),
      workflow: { ...fixtureDefinition, id: "other" },
    }),
  ).toBe(false);
});

function landing(
  initialChannels: readonly ChannelSummary[] = [
    { id: fixtureChannel, name: "General", channelType: "stream" },
  ],
) {
  let channels = initialChannels;
  let filter: readonly string[] = [];
  const fixture = createWorkflowFixture();
  const target = document.body.appendChild(document.createElement("div"));
  const selections: [string | undefined, string | undefined][] = [];
  function Harness() {
    const [selected, setSelected] = useState<string>();
    const onSelect = useCallback((key: string | undefined, name?: string) => {
      selections.push([key, name]);
      setSelected(key);
    }, []);
    return (
      <WorkflowLanding
        filter={filter}
        onFilterChange={() => {}}
        capability={fixture.capability}
        channels={channels}
        refreshRequest={0}
        viewer={fixtureViewer}
        detailTarget={target}
        selected={selected}
        onSelect={onSelect}
        onCreate={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
      />
    );
  }
  const element = () => (
    <StrictMode>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </StrictMode>
  );
  const rendered = render(element());
  return {
    fixture,
    target,
    selections,
    filterTo(next: readonly string[]) {
      filter = next;
      act(() => rendered.rerender(element()));
    },
    changeChannels(next: readonly ChannelSummary[]) {
      channels = next;
      act(() => rendered.rerender(element()));
    },
  };
}
const fixtureKey = `${fixtureChannel}:${fixtureViewer}:${fixtureDefinition.id}`;

for (const sort of ["By channel", "Recently updated"]) {
  it(`preserves a focused detail across unrelated membership changes in ${sort}`, async () => {
    const own: ChannelSummary = {
      id: fixtureChannel,
      name: "General",
      channelType: "stream",
    };
    const unrelated = channel(2);
    const added = channel(3);
    const { fixture, target, changeChannels } = landing([own, unrelated]);
    const user = userEvent.setup();
    try {
      if (sort === "Recently updated") {
        screen.getByRole("button", { name: "Sort workflows" }).focus();
        await user.keyboard("{Enter}");
        await user.click(
          await screen.findByRole("menuitemradio", { name: sort }),
        );
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      }
      await user.click(
        await screen.findByRole("button", { name: /^Open Message helper:/ }),
      );
      const detail = within(target).getByRole("region", {
        name: "Message helper",
      });
      const run = within(detail).getByRole("button", { name: "Run now" });
      run.focus();
      const historyReads = fixture.calls.runs;
      act(() =>
        fixture.definitions.update({
          status: "ready",
          data: {
            items: [
              fixtureDefinition,
              {
                ...fixtureDefinition,
                channelId: added.id,
                yaml: fixtureYaml.replace("Message helper", "Joined helper"),
              },
            ],
            partial: true,
            partialChannelIds: [added.id],
          },
        }),
      );
      for (const channels of [
        [own, unrelated, added],
        [own, added],
      ]) {
        changeChannels(channels);
        expect(
          await screen.findByRole("button", { name: /^Open Joined helper:/ }),
        ).toBeInTheDocument();
        expect(
          screen.getByText(`#${added.name} returned a partial workflow list.`),
        ).toBeInTheDocument();
        expect(
          within(target).getByRole("region", { name: "Message helper" }),
        ).toBe(detail);
        expect(run).toHaveFocus();
        expect(fixture.calls.runs).toBe(historyReads);
      }
      changeChannels([added]);
      expect(target).toBeEmptyDOMElement();
      expect(screen.queryByText("Message helper")).toBeNull();
    } finally {
      target.remove();
    }
  });
}

for (const filter of ["Owner", "Status"] as const) {
  it(`closes a ${filter.toLowerCase()}-filtered selection while a read is still pending`, async () => {
    const { fixture, target, selections } = landing();
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Clear owner filter" }),
      );
      act(() =>
        fixture.definitions.update({
          status: "ready",
          data: {
            partial: false,
            items: [{ ...fixtureDefinition, owner: "b".repeat(64) }],
          },
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /^Open Message helper:/ }),
      );
      expect(
        within(target).getByRole("region", { name: "Message helper" }),
      ).toBeVisible();
      act(() =>
        fixture.definitions.update({
          status: "loading",
          data: { partial: false, items: [] },
        }),
      );
      expect(screen.getByRole("status")).toHaveTextContent("Reading workflows");
      fireEvent.click(
        screen.getByRole("button", { name: new RegExp(`^${filter}(?::|$)`) }),
      );
      fireEvent.click(
        screen.getByRole("radio", {
          name: filter === "Owner" ? "My workflows" : "Enabled",
        }),
      );
      expect(selections.at(-1)).toEqual([undefined, undefined]);
      expect(target).toBeEmptyDOMElement();
      expect(screen.getByRole("status")).toHaveTextContent("Reading workflows");
    } finally {
      target.remove();
    }
  });
}

for (const status of ["loading", "error"] as const) {
  it(`omits an empty recent group when filtered results are ${status}`, async () => {
    const { fixture, target } = landing();
    const user = userEvent.setup();
    try {
      await screen.findByRole("button", { name: /^Open Message helper:/ });
      act(() =>
        fixture.definitions.update({
          status,
          data: { partial: false, items: [] },
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: /^Status(?::|$)/ }));
      fireEvent.click(screen.getByRole("radio", { name: "Enabled" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull(),
      );
      screen.getByRole("button", { name: "Sort workflows" }).focus();
      await user.keyboard("{Enter}");
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Recently updated" }),
      );
      expect(
        screen.getByRole("button", { name: "Sort workflows" }),
      ).toHaveAccessibleDescription("Recently updated");
      expect(
        screen.queryByRole("region", {
          name: "Recent workflows",
          hidden: true,
        }),
      ).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(
        status === "loading"
          ? "Reading workflows"
          : "Workflow discovery paused.",
      );
    } finally {
      target.remove();
    }
  });
}

it.each(["rejected", "unknown"] as const)(
  "durably dismisses a %s run and retains recovery after a persistence failure",
  async (outcome) => {
    const { fixture, target } = landing();
    const user = userEvent.setup();
    try {
      await user.click(
        await screen.findByRole("button", { name: "Run now: Message helper" }),
      );
      act(() => fixture.finish(outcome));
      const [operation] = fixture.capability.operations.snapshot();
      expect(operation).toBeDefined();
      fixture.setDismissError("Journal unavailable");
      await user.click(
        await screen.findByRole("button", { name: "Dismiss notice" }),
      );
      expect(await screen.findByText("Journal unavailable")).toBeVisible();
      expect(fixture.capability.operations.snapshot()).toEqual([operation]);
      fixture.setDismissError(undefined);
      fixture.holdDismiss();
      await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
      expect(
        screen.getByRole("button", { name: "Dismiss notice" }),
      ).toBeDisabled();
      expect(fixture.capability.operations.snapshot()).toEqual([operation]);
      await act(async () => fixture.releaseDismiss());
      await waitFor(() =>
        expect(fixture.capability.operations.snapshot()).toEqual([]),
      );
      expect(
        screen.queryByRole("button", { name: "Dismiss notice" }),
      ).toBeNull();
      expect(fixture.calls.trigger).toBe(1);
    } finally {
      fixture.releaseDismiss();
      target.remove();
    }
  },
);

it("runs a card once without confirmation and announces the settled request", async () => {
  const { fixture, target } = landing();
  try {
    const run = await screen.findByRole("button", {
      name: "Run now: Message helper",
    });
    fireEvent.click(run);
    expect(fixture.calls.trigger).toBe(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(fixture.calls.trigger).toBe(1);
    expect(
      screen.queryByText("Run requested. Inspect run history for its result."),
    ).toBeNull();
    act(() => fixture.finish("succeeded"));
    expect(
      await screen.findByText(
        "Run requested. Inspect run history for its result.",
      ),
    ).toBeVisible();
    expect(fixture.calls.trigger).toBe(1);
  } finally {
    target.remove();
  }
});

it("renders the selected card's detail into the target and toggles the selection", async () => {
  const { target, selections } = landing();
  try {
    const open = await screen.findByRole("button", {
      name: /^Open Message helper:/,
    });
    expect(target).toBeEmptyDOMElement();
    fireEvent.click(open);
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    expect(
      within(detail).getByRole("button", { name: "Run now" }),
    ).toBeEnabled();
    expect(
      within(detail).getByRole("button", { name: "Edit workflow" }),
    ).toBeEnabled();
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(
      within(detail).getByRole("switch", { name: "Enabled in configuration" }),
    ).toHaveAccessibleDescription(
      "Saved configuration only. Turning off does not confirm runs have stopped or cancel active runs.",
    );
    fireEvent.click(within(detail).getByRole("button", { name: "Run now" }));
    expect(
      within(detail).getByRole("switch", { name: "Enabled in configuration" }),
    ).toHaveAccessibleDescription(
      "Waiting for the submitted change to be resolved.",
    );
    expect(selections.at(-1)).toEqual([fixtureKey, "Message helper"]);
    fireEvent.click(open);
    await waitFor(() => expect(target).toBeEmptyDOMElement());
    expect(selections.at(-1)).toEqual([undefined, undefined]);
    expect(open).toHaveAttribute("aria-pressed", "false");
  } finally {
    target.remove();
  }
});

it("clears the selection on Escape from the card or its detail", async () => {
  const { target, selections } = landing();
  try {
    const open = await screen.findByRole("button", {
      name: /^Open Message helper:/,
    });
    fireEvent.click(open);
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    fireEvent.keyDown(within(detail).getByRole("button", { name: "Run now" }), {
      key: "Escape",
    });
    await waitFor(() => expect(target).toBeEmptyDOMElement());
    expect(selections.at(-1)).toEqual([undefined, undefined]);
    fireEvent.click(open);
    await within(target).findByRole("region", { name: "Message helper" });
    fireEvent.keyDown(open, { key: "Escape" });
    await waitFor(() => expect(target).toBeEmptyDOMElement());
  } finally {
    target.remove();
  }
});

it("rereads the selected workflow's history after a created run", async () => {
  const { fixture, target } = landing();
  try {
    fireEvent.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    await waitFor(() => expect(fixture.calls.runs).toBeGreaterThan(0));
    const reads = fixture.calls.runs;
    const current = fixture.runViews.at(-1);
    fireEvent.click(within(detail).getByRole("button", { name: "Run now" }));
    expect(fixture.calls.trigger).toBe(1);
    expect(fixture.calls.runs).toBe(reads);
    act(() => fixture.finish("succeeded"));
    await waitFor(() => expect(fixture.calls.runs).toBeGreaterThan(reads));
    expect(current?.disposed()).toBe(true);
    expect(fixture.runViews.at(-1)?.disposed()).toBe(false);
  } finally {
    target.remove();
  }
});

it("keeps run feedback after the card leaves the filtered view", async () => {
  const fixture = createWorkflowFixture();
  const channels = [
    { id: fixtureChannel, name: "General", channelType: "stream" as const },
    { id: "other-channel", name: "Other", channelType: "stream" as const },
  ];
  fixture.definitions.update({
    status: "ready",
    data: {
      partial: false,
      items: [
        fixtureDefinition,
        {
          ...fixtureDefinition,
          channelId: "other-channel",
          yaml: fixtureDefinition.yaml.replace(
            "Message helper",
            "Other helper",
          ),
        },
      ],
    },
  });
  const element = (filter: readonly string[]) => (
    <ToastProvider>
      <WorkflowLanding
        onFilterChange={() => {}}
        capability={fixture.capability}
        channels={channels}
        filter={filter}
        refreshRequest={0}
        viewer={fixtureViewer}
        detailTarget={null}
        selected={undefined}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
      />
    </ToastProvider>
  );
  const { rerender } = render(element([]));
  fireEvent.click(
    await screen.findByRole("button", { name: "Run now: Message helper" }),
  );
  expect(fixture.calls.trigger).toBe(1);
  rerender(element(["other-channel"]));
  expect(
    screen.queryByRole("button", { name: "Run now: Message helper" }),
  ).toBeNull();
  act(() => fixture.finish("rejected"));
  expect(await screen.findByText("Failed to trigger workflow")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  await waitFor(() =>
    expect(fixture.capability.operations.snapshot()).toEqual([]),
  );
  expect(fixture.calls.dismiss).toHaveLength(1);
});

it("shows a synchronous detail action failure outside the card grid", async () => {
  const { fixture, target } = landing();
  try {
    vi.spyOn(fixture.capability, "trigger").mockImplementation(() => {
      throw new Error("Refresh channel membership before running.");
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Run now" }));
    const notice = await screen.findByText(
      "Refresh channel membership before running.",
    );
    expect(notice).toBeVisible();
    expect(notice.closest(".workflow-collection")).toBeNull();
  } finally {
    target.remove();
  }
});

it("keeps the detail mounted and focused across a revision readback", async () => {
  const { fixture, target } = landing();
  try {
    fireEvent.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    const toggle = within(detail).getByRole("switch", {
      name: "Enabled in configuration",
    });
    expect(toggle).not.toBeChecked();
    expect(
      within(detail).getByText(/Turning off does not confirm runs/),
    ).toBeVisible();
    toggle.focus();
    const user = userEvent.setup();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(fixture.calls.save).toBe(1);
    await waitFor(() => expect(toggle).toHaveFocus());
    act(() => fixture.finish("succeeded"));
    await waitFor(() => expect(toggle).toBeChecked());
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
    expect(detail.isConnected).toBe(true);
    expect(toggle).toHaveFocus();
  } finally {
    target.remove();
  }
});

it("rereads history only once a later run is created", async () => {
  const { fixture, target } = landing();
  try {
    fireEvent.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    const detail = await within(target).findByRole("region", {
      name: "Message helper",
    });
    const run = () =>
      fireEvent.click(within(detail).getByRole("button", { name: "Run now" }));
    run();
    act(() => fixture.finish("succeeded"));
    await waitFor(() =>
      expect(
        within(detail).getByRole("button", { name: "Run now" }),
      ).toBeEnabled(),
    );
    const reads = fixture.calls.runs;
    const current = fixture.runViews.at(-1);
    run();
    expect(fixture.calls.trigger).toBe(2);
    expect(fixture.calls.runs).toBe(reads);
    expect(current?.disposed()).toBe(false);
    act(() => fixture.finish("succeeded"));
    await waitFor(() => expect(fixture.calls.runs).toBeGreaterThan(reads));
    expect(current?.disposed()).toBe(true);
  } finally {
    target.remove();
  }
});

function filterLanding(save = true) {
  const fixture = createWorkflowFixture();
  const capability = {
    ...fixture.capability,
    availability: { ...fixture.capability.availability, save },
  };
  const onCreate = vi.fn();
  // WorkflowsPage owns New workflow's availability and omits onCreate without save.
  const create = save ? onCreate : undefined;
  const channels = [
    { id: fixtureChannel, name: "General", channelType: "stream" as const },
    { id: "other-channel", name: "Other", channelType: "stream" as const },
  ];
  const definition = (
    name: string,
    owner: string,
    channelId: string,
    enabled: boolean,
  ) => ({
    ...fixtureDefinition,
    owner,
    channelId,
    id: name,
    yaml: fixtureYaml
      .replace("Message helper", name)
      .replace("enabled: false", `enabled: ${enabled}`),
  });
  fixture.definitions.update({
    status: "ready",
    data: {
      partial: false,
      items: [
        definition("Mine disabled", fixtureViewer, fixtureChannel, false),
        definition("Other enabled", "b".repeat(64), fixtureChannel, true),
        definition("Mine enabled", fixtureViewer, "other-channel", true),
      ],
    },
  });
  function Harness() {
    const [filter, setFilter] = useState<readonly string[]>([]);
    return (
      <ToastProvider>
        <WorkflowLanding
          capability={capability}
          channels={channels}
          filter={filter}
          onFilterChange={setFilter}
          refreshRequest={0}
          viewer={fixtureViewer}
          detailTarget={null}
          selected={undefined}
          onSelect={() => {}}
          onCreate={create}
          onDelete={() => {}}
          onOpen={() => {}}
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  const user = userEvent.setup();
  const choose = async (menu: string, option: string) => {
    screen.getByRole("button", { name: new RegExp(`^${menu}(?::|$)`) }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("radio", { name: option }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: menu })).toBeNull(),
    );
  };
  const chooseTrigger = async (option: string) => {
    screen.getByRole("button", { name: /^Trigger(?::|$)/ }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("checkbox", { name: option }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Trigger" })).toBeNull(),
    );
  };
  const chooseChannel = async () => {
    screen.getByRole("button", { name: /^Channels(?::|$)/ }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("checkbox", { name: "General" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
    );
  };
  return {
    fixture,
    user,
    choose,
    chooseTrigger,
    chooseChannel,
    definition,
    onCreate,
  };
}

it("starts with My workflows and offers All channel workflows explicitly", async () => {
  const { fixture, choose, user, onCreate } = filterLanding();
  expect(
    screen.getByRole("button", { name: "Owner: My workflows" }),
  ).toBeVisible();
  await screen.findByRole("button", { name: /^Open Mine disabled:/ });
  expect(
    screen.queryByRole("button", { name: /^Open Other enabled:/ }),
  ).toBeNull();
  await choose("Owner", "All channel workflows");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Other enabled:/ }),
    ).toBeVisible(),
  );
  await choose("Owner", "My workflows");
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [] },
    }),
  );
  await user.click(await screen.findByRole("button", { name: "New workflow" }));
  expect(onCreate).toHaveBeenCalledOnce();
});

it("explains an empty My workflows view and shows all channel workflows", async () => {
  const { fixture, user } = filterLanding();
  await screen.findByRole("button", { name: /^Open Mine disabled:/ });
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: {
        partial: false,
        items: [{ ...fixtureDefinition, owner: "b".repeat(64) }],
      },
    }),
  );
  expect(
    await screen.findByText("You don’t have any workflows yet"),
  ).toBeVisible();
  expect(screen.queryByText("No matching workflows")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Show all channel workflows" }),
  );
  expect(
    screen.getByRole("button", { name: "Owner: All channel workflows" }),
  ).toHaveFocus();
  expect(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  ).toBeVisible();
});

it.each(["status", "trigger"] as const)(
  "keeps the filtered empty state when My workflows plus %s hides the viewer's workflows",
  async (extra) => {
    const { fixture, choose, chooseTrigger, definition } = filterLanding();
    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: {
          partial: false,
          items: [
            definition("Mine disabled", fixtureViewer, fixtureChannel, false),
            definition("Other enabled", "b".repeat(64), fixtureChannel, true),
          ],
        },
      }),
    );
    await screen.findByRole("button", { name: /^Open Mine disabled:/ });
    if (extra === "status") await choose("Status", "Enabled");
    else await chooseTrigger("Schedule");
    expect(await screen.findByText("No matching workflows")).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
    expect(screen.queryByText("You don’t have any workflows yet")).toBeNull();
  },
);

it.each([true, false])(
  "clears a filtered empty state with focus handoff when save is %s",
  async (save) => {
    const { fixture, user, choose, chooseChannel, onCreate } =
      filterLanding(save);
    await choose("Owner", "My workflows");
    await choose("Status", "Enabled");
    await chooseChannel();
    expect(screen.getByText("No matching workflows")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
    screen.getByRole("button", { name: "Clear filters" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /^Owner(?::|$)/ })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(3),
    );
    expect(onCreate).not.toHaveBeenCalled();

    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: { items: [], partial: false },
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Workflows" }),
    ).toBeInTheDocument();
    if (save) {
      await user.click(screen.getByRole("button", { name: "New workflow" }));
      expect(onCreate).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
    }
  },
);

it("combines ownership, saved enabled state and channels, and clears every filter", async () => {
  const { user, choose, chooseTrigger, chooseChannel } = filterLanding();
  await screen.findByRole("button", { name: /^Open Mine disabled:/ });
  await choose("Owner", "My workflows");
  expect(
    screen.queryByRole("button", { name: /^Open Other enabled:/ }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Mine disabled:/ }),
    ).toBeVisible(),
  );
  await choose("Status", "Enabled");
  expect(
    screen.getByRole("button", { name: /^Status(?::|$)/ }),
  ).toHaveAccessibleName("Status: Enabled");
  expect(
    screen.queryByRole("button", { name: /^Open Mine disabled:/ }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Mine enabled:/ }),
    ).toBeVisible(),
  );
  await chooseChannel();
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveAccessibleName("Channels: General");
  expect(screen.getByText("No matching workflows")).toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Active workflow filters" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear owner filter" }));
  expect(screen.getByRole("button", { name: /^Owner(?::|$)/ })).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Clear status filter" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Clear channels filter" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Other enabled:/ }),
    ).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: /^Open Mine enabled:/ }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Clear channels filter" }),
  );
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveFocus();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Mine enabled:/ }),
    ).toBeVisible(),
  );
  await user.click(screen.getByRole("button", { name: "Clear status filter" }));
  expect(screen.getByRole("button", { name: /^Status(?::|$)/ })).toHaveFocus();
  expect(
    screen.queryByRole("button", {
      name: /^Clear (owner|status|trigger|channels) filter$/,
    }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Open (Mine|Other)/ }),
    ).toHaveLength(3),
  );
  expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();

  await choose("Owner", "My workflows");
  await choose("Status", "Disabled");
  await chooseTrigger("Message");
  await chooseChannel();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Mine disabled:/ }),
    ).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: /^Open Mine enabled:/ }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.getByRole("button", { name: /^Owner(?::|$)/ })).toHaveFocus();
  expect(
    screen.queryByRole("button", {
      name: /^Clear (owner|status|trigger|channels) filter$/,
    }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Open (Mine|Other)/ }),
    ).toHaveLength(3),
  );
});

it("matches saved trigger types with OR and excludes unreadable status values", async () => {
  const { fixture, user, choose, chooseTrigger, definition } = filterLanding();
  const triggers = [
    ["Message", "message_posted"],
    ["Reaction", "reaction_added"],
    ["Diff", "diff_posted"],
    ["Schedule", "schedule"],
    ["Webhook", "webhook"],
  ] as const;
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: {
        partial: false,
        items: [
          ...triggers.map(([label, on]) => ({
            ...definition(label, fixtureViewer, fixtureChannel, true),
            yaml: fixtureYaml
              .replace("Message helper", label)
              .replace("message_posted", on)
              .replace("enabled: false", ""),
          })),
          {
            ...definition("Unreadable", fixtureViewer, fixtureChannel, false),
            yaml: "name: [",
          },
          {
            ...definition("Unknown", fixtureViewer, fixtureChannel, false),
            yaml: fixtureYaml
              .replace("Message helper", "Unknown")
              .replace("message_posted", "custom_trigger"),
          },
        ],
      },
    }),
  );
  await choose("Status", "Disabled");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Unknown:/ }),
    ).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: /^Open Unnamed/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Open Message:/ })).toBeNull();
  await choose("Status", "Enabled");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Message:/ }),
    ).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: /^Open Unnamed/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Open Unknown:/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(5);
  await choose("Status", "Any status");
  for (const [index, [label]] of triggers.entries()) {
    await chooseTrigger(label);
    if (index === 0)
      expect(
        screen.getByRole("button", { name: /^Trigger(?::|$)/ }),
      ).toHaveAccessibleName("Trigger: Message");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(
        index + 1,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: new RegExp(`^Open ${label}:`) }),
      ).toBeVisible(),
    );
  }
  await chooseTrigger("Webhook");
  expect(
    screen.getByRole("button", { name: /^Trigger(?::|$)/ }),
  ).toHaveAccessibleName("Trigger: 4 triggers");
  expect(screen.getByRole("button", { name: /^Trigger(?::|$)/ })).toHaveFocus();
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(4),
  );
  expect(
    screen.getByRole("button", { name: /^Trigger(?::|$)/ }),
  ).toHaveTextContent("4 triggers");
  await user.click(
    screen.getByRole("button", { name: "Clear trigger filter" }),
  );
  expect(screen.getByRole("button", { name: /^Trigger(?::|$)/ })).toHaveFocus();
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(7),
  );
  await choose("Owner", "My workflows");
  expect(
    screen.getByRole("button", { name: /^Owner(?::|$)/ }),
  ).toHaveAccessibleName("Owner: My workflows");
  expect(
    screen.getByRole("button", { name: /^Owner(?::|$)/ }),
  ).toHaveTextContent("My workflows");
  await user.click(screen.getByRole("button", { name: "Clear owner filter" }));
  expect(
    screen.getByRole("button", { name: /^Owner(?::|$)/ }),
  ).toHaveAccessibleName("Owner: All channel workflows");
  expect(
    screen.getByRole("button", { name: /^Owner(?::|$)/ }),
  ).toHaveTextContent("All channel workflows");
  expect(
    screen.queryByRole("button", { name: "Clear owner filter" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: /^Owner(?::|$)/ })).toHaveFocus();
});

it("sorts across channels by saved recency while retaining filters, details and partial notices", async () => {
  const fixture = createWorkflowFixture();
  const channels = [
    { id: fixtureChannel, name: "General", channelType: "stream" as const },
    { id: "other-channel", name: "Other", channelType: "stream" as const },
  ];
  const definitions = [
    { name: "Oldest", channelId: fixtureChannel, createdAt: 1 },
    { name: "Newest", channelId: "other-channel", createdAt: 3 },
    { name: "Middle", channelId: fixtureChannel, createdAt: 2 },
  ].map(({ name, ...fields }) => ({
    ...fixtureDefinition,
    ...fields,
    id: name,
    yaml: fixtureYaml.replace("Message helper", name),
  }));
  fixture.definitions.update({
    status: "ready",
    data: { partial: true, items: definitions },
  });
  const target = document.createElement("div");
  document.body.append(target);
  function Harness() {
    const [filter, setFilter] = useState<readonly string[]>([]);
    const [selected, setSelected] = useState<string>();
    return (
      <ToastProvider>
        <WorkflowLanding
          capability={fixture.capability}
          channels={channels}
          filter={filter}
          onFilterChange={setFilter}
          refreshRequest={0}
          viewer={fixtureViewer}
          detailTarget={target}
          selected={selected}
          onSelect={setSelected}
          onCreate={() => {}}
          onDelete={() => {}}
          onOpen={() => {}}
        />
      </ToastProvider>
    );
  }
  const rendered = render(<Harness />);
  const user = userEvent.setup();
  const chooseSort = async (option: string) => {
    screen.getByRole("button", { name: "Sort workflows" }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: option }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Sort workflows" })).toBeNull(),
    );
  };
  const rowNames = () =>
    screen
      .getAllByRole("button", { name: /^Open / })
      .map((row) => row.getAttribute("aria-label")?.split(":")[0]);
  try {
    await screen.findByRole("heading", { name: "General" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Other" })).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: /^Open Middle:/ }));
    expect(screen.getByRole("region", { name: "Middle" })).toBeVisible();

    await chooseSort("Recently updated");
    expect(
      screen.getByRole("button", { name: "Sort workflows" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Sort workflows" }),
    ).toHaveAccessibleDescription("Recently updated");
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Other" })).toBeNull();
    expect(rowNames()).toEqual(["Open Newest", "Open Middle", "Open Oldest"]);
    expect(
      screen.getByRole("button", { name: /^Open Newest:/ }),
    ).toHaveTextContent("#Other");
    expect(screen.getByRole("region", { name: "Middle" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Open Middle:/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(
        screen.getByText("#General returned a partial workflow list."),
      ).toBeVisible();
      expect(
        screen.getByText("#Other returned a partial workflow list."),
      ).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: /^Channels(?::|$)/ }));
    await user.click(await screen.findByRole("checkbox", { name: "General" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
    );
    expect(rowNames()).toEqual(["Open Middle", "Open Oldest"]);
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(rowNames()).toEqual(["Open Newest", "Open Middle", "Open Oldest"]);
    expect(
      screen.getByRole("button", { name: "Sort workflows" }),
    ).toHaveAccessibleDescription("Recently updated");

    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: {
          partial: false,
          items: definitions.map((definition) =>
            definition.id === "Oldest"
              ? { ...definition, createdAt: 4 }
              : definition,
          ),
        },
      }),
    );
    expect(rowNames()).toEqual(["Open Oldest", "Open Newest", "Open Middle"]);
    expect(screen.queryByText(/returned a partial workflow list/)).toBeNull();

    await chooseSort("By channel");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Other" })).toBeVisible();
    });
    expect(screen.getByRole("region", { name: "Middle" })).toBeVisible();

    await chooseSort("Recently updated");
    act(() =>
      fixture.definitions.update({
        status: "idle",
        data: { partial: false, items: [] },
      }),
    );
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Middle" })).toBeNull();
  } finally {
    rendered.unmount();
    target.remove();
  }
});

it("orders same-timestamp workflows by coordinate regardless of read order", async () => {
  const { fixture, target } = landing();
  const first = {
    ...fixtureDefinition,
    id: "55555555-5555-4555-8555-555555555501",
    yaml: fixtureYaml.replace("Message helper", "Coordinate first"),
  };
  const second = {
    ...fixtureDefinition,
    id: "55555555-5555-4555-8555-555555555502",
    yaml: fixtureYaml.replace("Message helper", "Coordinate second"),
  };
  const user = userEvent.setup();
  const rowNames = () =>
    screen
      .getAllByRole("button", { name: /^Open Coordinate / })
      .map((row) => row.getAttribute("aria-label")?.split(":")[0]);
  try {
    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: { items: [second, first], partial: false },
      }),
    );
    await screen.findByRole("button", { name: /^Open Coordinate first:/ });
    screen.getByRole("button", { name: "Sort workflows" }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Recently updated" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(rowNames()).toEqual([
      "Open Coordinate first",
      "Open Coordinate second",
    ]);
    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: { items: [first, second], partial: false },
      }),
    );
    expect(rowNames()).toEqual([
      "Open Coordinate first",
      "Open Coordinate second",
    ]);
  } finally {
    target.remove();
  }
});

it.each(["delete", "enable"] as const)(
  "closes the %s confirmation when its row starts a filter exit",
  async (action) => {
    const own: ChannelSummary = {
      id: fixtureChannel,
      name: "General",
      channelType: "stream",
    };
    const other = channel(2);
    const { fixture, target, filterTo } = landing([own, other]);
    const user = userEvent.setup();
    try {
      act(() =>
        fixture.definitions.update({
          status: "ready",
          data: {
            partial: false,
            items: [
              fixtureDefinition,
              {
                ...fixtureDefinition,
                channelId: other.id,
                yaml: fixtureYaml.replace("Message helper", "Other helper"),
              },
            ],
          },
        }),
      );
      const row = await screen.findByRole("button", {
        name: /^Open Message helper:/,
      });
      if (action === "delete") {
        await user.click(
          screen.getByRole("button", { name: "Actions for Message helper" }),
        );
        await user.click(
          await screen.findByRole("menuitem", { name: "Delete workflow" }),
        );
      } else {
        fireEvent.click(
          screen.getByRole("switch", {
            name: "Enabled in configuration: Message helper",
          }),
        );
      }
      const dialog = await screen.findByRole("alertdialog", {
        name:
          action === "delete"
            ? "Delete this workflow?"
            : "This workflow may run often",
      });
      // The host's filter prop changes while the confirmation is open.
      filterTo([other.id]);
      expect(row).toBeInTheDocument();
      expect(row.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(dialog).not.toBeInTheDocument();
      expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull();
    } finally {
      target.remove();
    }
  },
);

it("marks an archived channel's workflows as not runnable and blocks only turning them on", async () => {
  const reason = "This channel is archived, so its workflows can't run.";
  const archived: ChannelSummary = {
    id: fixtureChannel,
    name: "General",
    channelType: "stream",
    archived: true,
  };
  const live: ChannelSummary = {
    id: "live-channel",
    name: "Live",
    channelType: "stream",
  };
  const definitions = [
    { name: "Off helper", channelId: archived.id, createdAt: 1, on: false },
    { name: "On helper", channelId: archived.id, createdAt: 2, on: true },
    { name: "Live helper", channelId: live.id, createdAt: 3, on: false },
  ].map(({ name, on, ...fields }) => ({
    ...fixtureDefinition,
    ...fields,
    id: name,
    yaml: fixtureYaml
      .replace("Message helper", name)
      .replace("enabled: false", `enabled: ${on}`),
  }));
  const { fixture, target } = landing([archived, live]);
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: definitions },
    }),
  );
  const user = userEvent.setup();
  const run = (name: string) =>
    screen.getByRole("button", { name: `Run now: ${name}` });
  const toggle = (name: string) =>
    screen.getByRole("switch", { name: `Enabled in configuration: ${name}` });
  try {
    const group = await screen.findByRole("region", { name: "General" });
    await waitFor(() =>
      expect(within(group).getByText("Archived")).toBeVisible(),
    );
    expect(
      within(screen.getByRole("region", { name: "Live" })).queryByText(
        "Archived",
      ),
    ).toBeNull();
    for (const name of ["Off helper", "On helper"]) {
      // Focusable while disabled, so its reason shows on hover.
      expect(run(name)).toHaveAttribute("aria-disabled", "true");
      expect(run(name)).toHaveAccessibleDescription(reason);
    }
    await user.hover(run("Off helper"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    await user.unhover(run("Off helper"));
    expect(toggle("Off helper")).toHaveAttribute("aria-disabled", "true");
    expect(toggle("Off helper")).toHaveAccessibleDescription(reason);
    await user.hover(toggle("Off helper"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    await user.unhover(toggle("Off helper"));
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    // Like Run now, it stays in the tab order but can't be turned on.
    run("Off helper").focus();
    await user.tab();
    expect(toggle("Off helper")).toHaveFocus();
    // Space doesn't scroll the list either.
    expect(fireEvent.keyDown(toggle("Off helper"), { key: " " })).toBe(false);
    await user.keyboard(" ");
    expect(toggle("Off helper")).not.toBeChecked();
    act(() => toggle("Off helper").blur());
    // Turning a workflow off stays available, so it stops failing.
    expect(toggle("On helper")).toBeChecked();
    expect(toggle("On helper")).not.toHaveAttribute("aria-disabled");
    expect(toggle("On helper")).toHaveAccessibleDescription("");
    expect(run("Live helper")).toBeEnabled();
    expect(run("Live helper")).toHaveAccessibleDescription("");
    expect(toggle("Live helper")).not.toHaveAttribute("aria-disabled");

    await user.click(screen.getByRole("button", { name: /^Open Off helper:/ }));
    const detail = within(target).getByRole("region", { name: "Off helper" });
    expect(within(detail).getByText(/#General · Archived ·/)).toBeVisible();
    const detailRun = within(detail).getByRole("button", { name: "Run now" });
    expect(detailRun).toHaveAttribute("aria-disabled", "true");
    expect(detailRun).toHaveAccessibleDescription(reason);
    const detailToggle = within(detail).getByRole("switch", {
      name: "Enabled in configuration",
    });
    expect(detailToggle).toHaveAttribute("aria-disabled", "true");
    expect(detailToggle).toHaveAccessibleDescription(reason);
    await user.click(detailToggle);
    await user.click(run("Off helper"));
    expect(fixture.calls.save).toBe(0);
    expect(fixture.calls.trigger).toBe(0);

    await user.click(toggle("On helper"));
    expect(fixture.calls.save).toBe(1);
    expect(fixture.input()?.yaml).toContain("enabled: false");

    screen.getByRole("button", { name: "Sort workflows" }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Recently updated" }),
    );
    const recent = await screen.findByRole("region", {
      name: "Recent workflows",
    });
    expect(
      within(recent).getByRole("button", { name: /^Open Off helper:/ }),
    ).toHaveTextContent(/#General·Archived·/);
    expect(
      within(recent).getByRole("button", { name: /^Open Live helper:/ }),
    ).not.toHaveTextContent("Archived");
    expect(run("Off helper")).toHaveAccessibleDescription(reason);
    expect(run("Live helper")).toBeEnabled();
  } finally {
    target.remove();
  }
});

it.each(["card", "detail"] as const)(
  "says why it doesn't turn a workflow on from the %s when its channel is archived during the confirmation",
  async (surface) => {
    const live: ChannelSummary = {
      id: fixtureChannel,
      name: "General",
      channelType: "stream",
    };
    const { fixture, target, changeChannels } = landing([live]);
    const user = userEvent.setup();
    try {
      if (surface === "card") {
        await user.click(
          await screen.findByRole("switch", {
            name: "Enabled in configuration: Message helper",
          }),
        );
      } else {
        await user.click(
          await screen.findByRole("button", { name: /^Open Message helper:/ }),
        );
        await user.click(
          within(
            within(target).getByRole("region", { name: "Message helper" }),
          ).getByRole("switch", { name: "Enabled in configuration" }),
        );
      }
      const confirm = await screen.findByRole("alertdialog", {
        name: "This workflow may run often",
      });
      changeChannels([{ ...live, archived: true }]);
      await user.click(
        within(confirm).getByRole("button", { name: "Turn on" }),
      );
      expect(fixture.calls.save).toBe(0);
      // The card says why nothing changed.
      expect(
        await screen.findByRole("dialog", {
          name: "This channel is archived, so its workflows can't run.",
        }),
      ).toBeVisible();
    } finally {
      target.remove();
    }
  },
);
