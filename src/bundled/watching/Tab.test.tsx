// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSaveState } from "../../features/agents/AgentSaveButton";
import type { Context } from "../../plugins/author";
import { createTab, describe } from "./Tab";
import { AttentionSonar } from "./AttentionSonar";

afterEach(cleanup);
const viewer = "f".repeat(64);
const origin = "https://example.com";
const scope = `${origin}:${viewer}`;
const community = { origin, viewer, scope };
const channel = "11111111-1111-1111-1111-111111111111";
it("keeps listening channels distinct from destinations and respects rearmed timer usage", () => {
  expect(
    describe(
      {
        type: "timer",
        interest_id: "once",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 1,
        expires_at: null,
      },
      110,
    ).title,
  ).toMatch(/^Once · /);
  expect(
    describe(
      {
        type: "timer",
        interest_id: "task",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 2,
        expires_at: null,
      },
      110,
      2,
    ).spent,
  ).toBe(true);
});
it("shows one agent's watches, reacts to changes and surfaces save errors", async () => {
  const enabled = true;
  const record = () => ({
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: enabled,
    attentionHistory: {
      "watch/check": {
        lastWokeAt: Math.floor(Date.now() / 1000) - 180,
        output: "build succeeded",
      },
    },
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Keep releases moving." },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          interest_id: "task",
          enabled: false,
          provider: "attention/command",
          channel,
          config: { command: ["check"] },
        },
      },
    },
  });
  const snapshot = {
    status: "ready",
    running: [
      record(),
      {
        ...record(),
        name: "Bo",
        key: "membership-b",
        pubkey: "b",
        owner: viewer,
        relay: "wss://example.com",
        attention: {},
      },
    ],
  };
  const disconnected = { status: "disconnected", ...community };
  const save = vi.fn(async () => {
    throw new Error("Save failed");
  });
  const ctx = {
    react: React,
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  const ada = screen.getByRole("region", { name: "Attention" });
  expect(within(ada).getByRole("heading", { name: "task" })).toBeTruthy();
  fireEvent.click(
    within(ada).getByRole("button", { name: "Details for task" }),
  );
  fireEvent.click(screen.getByLabelText("Show activity for task"));
  fireEvent.click(screen.getByLabelText("Watch details for task"));
  expect(
    within(
      screen.getByLabelText("Watch details for task")
        .parentElement as HTMLElement,
    ).getByText("3 minutes ago"),
  ).toBeTruthy();
  expect(within(ada).getByText("build succeeded")).toBeTruthy();
  expect(screen.getByText("Command", { selector: "dt" })).toBeTruthy();
  expect(
    document.querySelector(".attention-configuration code")?.textContent,
  ).toBe("check");
  expect(
    ada.querySelector(
      ".attention-instructions summary .attention-instructions-preview",
    ),
  ).not.toBeNull();
  expect(
    ada.querySelector(".attention-instructions-preview")?.textContent,
  ).toBe("Keep releases moving.");
  expect(
    ada.querySelector("details.attention-instructions")?.hasAttribute("open"),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for task" }),
  );
  expect(screen.getByRole("menuitem", { name: "Resume" })).toBeTruthy();
  expect(within(ada).getByText("Paused")).toBeTruthy();
  expect(
    within(ada).queryByRole("button", {
      name: "Attention status for Ada",
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Save failed"),
  );
  expect(save).toHaveBeenCalledWith("membership-a", {
    watchEnabled: {
      "watch/check": {
        enabled: true,
        expected: record().attention["watch/check"],
      },
    },
  });
  expect(within(ada).getByRole("heading", { name: "task" })).toBeTruthy();
});

it.each(["source", "event", "timer"] as const)(
  "toggles and deletes only the selected %s subscription",
  async (type) => {
    let changed = () => {};
    const watch =
      type === "source"
        ? {
            type,
            provider: "attention/command",
            config: { command: ["check"] },
          }
        : type === "event"
          ? { type, channels: ["listen"] }
          : {
              type,
              prompt: "Check the release",
              interval_secs: 60,
              armed_at: 100,
              max_occurrences: null,
              expires_at: null,
            };
    const value = { ...watch, enabled: true, interest_id: "release", channel };
    let agent = {
      key: "membership-a",
      pubkey: "a",
      owner: viewer,
      relay: "wss://example.com",
      name: "Ada",
      attentionEnabled: true,
      timers: {},
      attention: {
        "interest/release": {
          slug: "interest/release",
          modifiedAt: 1,
          value: { type: "interest", instructions: "Keep releases moving." },
        },
        "watch/check": { slug: "watch/check", modifiedAt: 1, value },
      },
      // Over the limit here; deleting its Interest deletes it too.
      skipped: {
        "watch/over": {
          slug: "watch/over",
          modifiedAt: 1,
          value,
          problem: "Over the limit of 100 watches and timers",
        },
      },
    };
    let snapshot = { status: "ready", running: [agent] };
    let finishSave = () => {};
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    let rejectInterest = true;
    const save = vi.fn(
      async (
        _key: string,
        patch: {
          attention?: Record<string, unknown>;
          watchEnabled?: Record<
            string,
            { enabled: boolean; expected: unknown }
          >;
        },
      ) => {
        if (patch.attention?.["interest/release"] === null && rejectInterest)
          throw new Error("Interest save failed");
        const attention = { ...agent.attention } as Record<string, unknown>;
        for (const [slug, value] of Object.entries(patch.attention ?? {})) {
          if (value === null) delete attention[slug];
          else attention[slug] = { slug, modifiedAt: 2, value };
        }
        for (const [slug, target] of Object.entries(patch.watchEnabled ?? {})) {
          attention[slug] = {
            slug,
            modifiedAt: 2,
            value: { ...value, enabled: target.enabled },
          };
        }
        // Deleting a skipped slug clears it, as the store does.
        const skipped = Object.fromEntries(
          Object.entries(agent.skipped).filter(
            ([slug]) => patch.attention?.[slug] !== null,
          ),
        ) as typeof agent.skipped;
        agent = {
          ...agent,
          attention: attention as typeof agent.attention,
          skipped,
        };
        snapshot = { ...snapshot, running: [agent] };
        changed();
        await saving;
      },
    );
    const disconnected = { status: "disconnected", ...community };
    const ctx = {
      react: React,
      agents: {
        presentWatch: () => undefined,
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
        save,
      },
      relay: { snapshot: () => disconnected, subscribe: () => () => {} },
    } as unknown as Context;
    render(
      React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
    );
    expect(
      screen
        .getByRole("button", { name: "Interest status for release" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Interest status for release" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Interest status for release" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Interest save failed",
      ),
    );
    expect(save).toHaveBeenLastCalledWith("membership-a", {
      attentionExpected: expect.objectContaining({
        "interest/release": expect.objectContaining({
          slug: "interest/release",
        }),
      }),
      attention: {
        "watch/check": null,
        "watch/over": null,
        "interest/release": null,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Watch status for release" }),
    ).toBeTruthy();
    save.mockClear();
    expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Watch status for release" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
    const remove = screen.getByRole("menuitem", { name: "Delete release" });
    try {
      await waitFor(() =>
        expect(
          screen
            .getByRole("menuitem", { name: "Resume" })
            .getAttribute("aria-disabled"),
        ).toBe("true"),
      );
      expect(save).toHaveBeenLastCalledWith("membership-a", {
        watchEnabled: {
          "watch/check": {
            enabled: false,
            expected: { slug: "watch/check", modifiedAt: 1, value },
          },
        },
      });
      expect(remove.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(remove);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finishSave());
    }
    await waitFor(() =>
      expect(remove.getAttribute("aria-disabled")).not.toBe("true"),
    );
    if (type === "timer") {
      expect(
        screen
          .getByRole("menuitem", { name: "Resume" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen.getByText("Ask Ada to set this timer’s next run."),
      ).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete release" }));
    // Deleting a watch asks first, like deleting its Interest does. This watch
    // has no name of its own, so the title names its kind rather than echoing
    // the Interest's "Delete release?".
    const confirm = screen.getByRole("alertdialog", {
      name: type === "timer" ? "Delete this timer?" : "Delete this watch?",
    });
    expect(
      within(confirm).getByText(
        type === "timer"
          ? /^This deletes the timer\./
          : /^This deletes the watch\./,
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole("button", { name: "Cancel" }),
      ),
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    const pill = screen.getByRole("button", {
      name: "Watch status for release",
    });
    await waitFor(() => expect(document.activeElement).toBe(pill));
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete release" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Watch status for release" }),
    ).toBeNull();
    // The dialog deletes the watch as paused above, not as first rendered.
    expect(save).toHaveBeenLastCalledWith("membership-a", {
      attentionExpected: {
        "watch/check": {
          slug: "watch/check",
          modifiedAt: 2,
          value: { ...value, enabled: false },
        },
      },
      attention: { "watch/check": null },
    });
    expect(agent.attention["interest/release"]).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Interest release" }),
    ).toBeTruthy();
    const removeInterest = screen.getByRole("button", {
      name: "Interest status for release",
    });
    fireEvent.click(removeInterest);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    // Its skipped watch is deleted with it, so this still confirms.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Interest save failed",
      ),
    );
    expect(agent.attention["interest/release"]).toBeTruthy();
    rejectInterest = false;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Attention" })).toBeTruthy(),
    );
    expect(save).toHaveBeenLastCalledWith("membership-a", {
      attentionExpected: expect.objectContaining({
        "interest/release": expect.objectContaining({
          slug: "interest/release",
        }),
      }),
      attention: { "watch/over": null, "interest/release": null },
    });
  },
);

it("keeps subscription controls disabled and the tab open while saving, and preserves the row on failure", async () => {
  const record = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          name: "Build",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [record] };
  const disconnected = { status: "disconnected", ...community };
  let reject!: (reason: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const save = vi.fn(() => held);
  const ctx = {
    react: React,
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  const report = vi.fn();
  render(
    React.createElement(
      AgentSaveState,
      { value: report },
      React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Details for Build" }));
  fireEvent.click(screen.getByLabelText("Show activity for Build"));
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  let toggle = screen.getByRole("menuitem", {
    name: "Pause",
  }) as HTMLButtonElement;
  let remove = screen.getByRole("menuitem", {
    name: "Delete Build",
  }) as HTMLButtonElement;
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-disabled")).toBe("true"),
  );
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(report).toHaveBeenLastCalledWith(
    { dirty: false, saving: true },
    expect.any(String),
  );
  fireEvent.click(remove);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(toggle, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull(),
  );
  await act(async () => reject(new Error("Could not save")));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Could not save"),
  );
  expect(report).toHaveBeenLastCalledWith(
    { dirty: false, saving: false },
    expect.any(String),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  toggle = screen.getByRole("menuitem", {
    name: "Pause",
  }) as HTMLButtonElement;
  remove = screen.getByRole("menuitem", {
    name: "Delete Build",
  }) as HTMLButtonElement;
  expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
  expect(remove.getAttribute("aria-disabled")).not.toBe("true");
  expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});

// Ada's Attention tab with one watch, "Build", whose every save is refused.
function renderRefusedSave() {
  const record = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          name: "Build",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [record] };
  const disconnected = { status: "disconnected", ...community };
  const save = vi.fn(async () => {
    throw new Error("Could not save");
  });
  const ctx = {
    react: React,
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  return { save, watch: record.attention["watch/check"] };
}

it("keeps the watch delete dialog open with the error when the save is refused", async () => {
  const { save, watch } = renderRefusedSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Build" }));
  const confirm = screen.getByRole("alertdialog", { name: "Delete Build?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(within(confirm).getByRole("alert").textContent).toBe(
      "Could not save",
    ),
  );
  // The save deletes the watch the dialog showed, not a later revision.
  expect(save).toHaveBeenCalledWith("membership-a", {
    attentionExpected: { "watch/check": watch },
    attention: { "watch/check": null },
  });
  // The modal hides the page from role queries; the row is still there.
  expect(
    screen.getByRole("button", {
      name: "Watch status for Build",
      hidden: true,
    }),
  ).toBeTruthy();
  // The dialog stays open to retry; the row shows no second copy of the error.
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
});

it("opens the watch delete dialog without a stale Pause error", async () => {
  renderRefusedSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
  // The refused Pause reports under the row and leaves the menu open.
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Could not save"),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Build" }));
  const confirm = screen.getByRole("alertdialog", { name: "Delete Build?" });
  // Delete has not been pressed, so the dialog has no error to show.
  expect(within(confirm).queryByRole("alert")).toBeNull();
  expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
});

it("deletes the watch the dialog showed, not one revised while it was open", async () => {
  const watch = {
    slug: "watch/check",
    modifiedAt: 1,
    value: {
      type: "source",
      name: "Build",
      interest_id: "task",
      enabled: true,
      provider: "attention/command",
      config: { command: ["check"] },
    },
  };
  let agent = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": watch,
    } as Record<string, unknown>,
  };
  let snapshot = { status: "ready", running: [agent] };
  let changed = () => {};
  const update = (attention: Record<string, unknown>) => {
    agent = { ...agent, attention };
    snapshot = { status: "ready", running: [agent] };
    changed();
  };
  // Refuses a stale expected object, as the service does.
  const save = vi.fn(
    async (
      _key: string,
      patch: {
        attentionExpected?: Record<string, unknown>;
        attention?: Record<string, unknown>;
      },
    ) => {
      for (const [slug, expected] of Object.entries(
        patch.attentionExpected ?? {},
      ))
        if (JSON.stringify(agent.attention[slug]) !== JSON.stringify(expected))
          throw new Error("Attention changed. Review it and try again.");
      const attention = { ...agent.attention };
      for (const [slug, value] of Object.entries(patch.attention ?? {}))
        if (value === null) delete attention[slug];
      update(attention);
    },
  );
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Build" }));
  const confirm = screen.getByRole("alertdialog", { name: "Delete Build?" });
  // The agent revises the watch while the dialog is open.
  const revised = {
    ...watch,
    modifiedAt: 2,
    value: { ...watch.value, config: { command: ["check", "--all"] } },
  };
  act(() => update({ ...agent.attention, "watch/check": revised }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(within(confirm).getByRole("alert").textContent).toBe(
      "Attention changed. Review it and try again.",
    ),
  );
  expect(save).toHaveBeenCalledWith("membership-a", {
    attentionExpected: { "watch/check": watch },
    attention: { "watch/check": null },
  });
  expect(agent.attention["watch/check"]).toBe(revised);
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  // Reopened, the dialog reviews the revised watch and deletes that one.
  fireEvent.click(
    screen.getByRole("button", { name: "Watch status for Build" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Build" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(save).toHaveBeenLastCalledWith("membership-a", {
    attentionExpected: { "watch/check": revised },
    attention: { "watch/check": null },
  });
  expect(agent.attention["watch/check"]).toBeUndefined();
  expect(
    screen.queryByRole("button", { name: "Watch status for Build" }),
  ).toBeNull();
});

it("explains Attention to a new agent with no switch to turn on", () => {
  const snapshot = {
    status: "ready",
    running: [
      {
        key: "membership-b",
        pubkey: "b",
        owner: viewer,
        relay: "wss://example.com",
        name: "Bo",
        attentionEnabled: true,
        timers: {},
        attention: {},
      },
    ],
  };
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save: vi.fn(),
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-b" } }),
  );
  expect(screen.getByRole("region", { name: "Start watching" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Attention" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Attention status for Bo" }),
  ).toBeNull();
  expect(screen.getByText(/Send Bo a message/)).toBeTruthy();
});

it("says why an agent's watches are not shown", async () => {
  let snapshot = {
    status: "loading",
    running: [] as Record<string, unknown>[],
  };
  let connection: Record<string, unknown> = {
    status: "disconnected",
    ...community,
  };
  let changed = () => {};
  const ctx = {
    agents: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save: vi.fn(),
    },
    relay: {
      snapshot: () => connection,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  expect(screen.getByRole("status").textContent).toBe("Loading watches…");
  snapshot = { status: "ready", running: [] };
  await act(async () => {
    connection = { ...connection };
    changed();
  });
  expect(
    await screen.findByText("This agent isn't running on this device."),
  ).toBeTruthy();
  await act(async () => {
    connection = { status: "disconnected", origin, viewer, scope: "" };
    changed();
  });
  expect(
    await screen.findByText(
      "Choose a community to manage this agent's watches.",
    ),
  ).toBeTruthy();
});

it.each([undefined, "missing"])(
  "shows an orphan watch as a repair state when its Interest is %s",
  (interest_id) => {
    const save = vi.fn();
    const snapshot = {
      status: "ready",
      running: [
        {
          key: "membership-a",
          pubkey: "a",
          owner: viewer,
          relay: "wss://example.com",
          name: "Ada",
          attentionEnabled: true,
          timers: {},
          attention: {
            "watch/check": {
              slug: "watch/check",
              modifiedAt: 1,
              value: {
                type: "source",
                interest_id,
                name: "Release check",
                enabled: false,
                prompt: "Report blockers",
                provider: "attention/command",
                config: { command: ["check"] },
              },
            },
          },
        },
      ],
    };
    const disconnected = { status: "disconnected", ...community };
    const ctx = {
      react: React,
      agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
      relay: { snapshot: () => disconnected, subscribe: () => () => {} },
    } as unknown as Context;
    render(
      React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
    );
    const repair = screen.getByRole("region", { name: "Stray watches" });
    expect(within(repair).getByText("watch/check")).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Watch Release check" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: /^Interest / })).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(
      within(repair).getByRole("button", { name: "Delete watch/check" }),
    );
    expect(save).toHaveBeenCalledWith("membership-a", {
      attention: { "watch/check": null },
    });
  },
);

it("keeps unreadable legacy watches visible and removes only the selected object", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const snapshot = {
    status: "ready",
    running: [
      {
        key: "membership-a",
        pubkey: "a",
        owner: viewer,
        relay: "wss://example.com",
        name: "Ada",
        attentionEnabled: true,
        timers: {},
        attention: {},
        skipped: {
          "watch/old": {
            slug: "watch/old",
            problem: "Legacy filter needs repair",
          },
        },
      },
    ],
  };
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  expect(screen.getByText("Legacy filter needs repair")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove unreadable watch/old" }),
  );
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("membership-a", {
      attention: { "watch/old": null },
    }),
  );
});

it.each([false, true])(
  "scans subscription types and destinations with history accessible (completed: %s)",
  (completed) => {
    let snapshot = {
      classifier: "unavailable",
      status: "ready",
      running: [
        {
          key: "membership-a",
          pubkey: "a",
          owner: viewer,
          relay: "wss://example.com",
          name: "Ada",
          attentionEnabled: true,
          timers: {},
          sourceRuns: {} as Record<string, string>,
          attentionHistory: {
            "watch/pr": { output: "CI completed: all checks passed" },
            "watch/messages": {
              output: "2026-10-27T14:00:00Z · Alex\nThe release is ready.",
            },
          },
          attention: {
            "interest/release": {
              slug: "interest/release",
              modifiedAt: 1,
              value: { type: "interest", instructions: "Watch the release." },
            },
            "watch/pr": {
              slug: "watch/pr",
              modifiedAt: 1,
              value: {
                type: "source",
                name: "Release checks",
                interest_id: "release",
                enabled: true,
                provider: "attention/github-pr",
                config: { pr: "https://github.com/block/buzz-app/pull/1578" },
                channel,
              },
            },
            "watch/messages": {
              slug: "watch/messages",
              modifiedAt: 1,
              value: {
                type: "event",
                name: "Discussion",
                classifier: {
                  questions: { ready: { question: "Is the release ready?" } },
                },
                interest_id: "release",
                enabled: true,
                channels: ["listen"],
                channel: "listen",
              },
            },
          },
        },
      ],
    };
    if (completed)
      for (const agent of snapshot.running)
        agent.sourceRuns["watch/pr"] = JSON.stringify(
          agent.attention["watch/pr"],
        );
    const connection = {
      status: "ready",
      ...community,
      session: {
        channels: {
          ensureList() {},
          subscribeList: () => () => {},
          list: () => channels,
        },
        media: () => "",
      },
    };
    const channels = {
      channels: [
        { id: channel, name: "Berd-call", channelType: "solo" },
        { id: "listen", name: "buzz-github-prs", channelType: "stream" },
      ],
    };
    let changed = () => {};
    const ctx = {
      react: React,
      agents: {
        presentWatch: (watch: { provider: string }) =>
          watch.provider === "attention/github-pr"
            ? {
                type: "GitHub PR",
                target: "buzz-app#1578",
                subtitle: "Release checks",
                link: {
                  href: "https://github.com/block/buzz-app/pull/1578",
                  title: "Open on GitHub",
                },
                details: () => React.createElement("p", null, "Who wakes it"),
              }
            : undefined,
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
      relay: { snapshot: () => connection, subscribe: () => () => {} },
    } as unknown as Context;
    render(
      React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
    );
    const disclosure = screen.getByRole("button", {
      name: "Details for Release checks",
    });
    expect(
      screen.getByRole("button", { name: "Source details for Release checks" })
        .textContent,
    ).toContain("buzz-app#1578");
    expect(disclosure.classList.contains("attention-heading")).toBe(true);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Release checks" }),
    );
    fireEvent.click(screen.getByLabelText("Show activity for Release checks"));
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Discussion" }),
    );
    fireEvent.click(screen.getByLabelText("Show activity for Discussion"));
    fireEvent.click(screen.getByLabelText("Watch details for Discussion"));
    const icon = (name: string) =>
      screen
        .getByRole("button", { name: `Open destination ${name}` })
        .querySelector("path")
        ?.getAttribute("d");
    const discussionIcon = icon("buzz-github-prs");
    expect(discussionIcon).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Watch details for Release checks"));
    expect(
      screen.getByRole("button", { name: "Open destination Berd-call" })
        .textContent,
    ).toBe("Berd-call");
    expect(icon("Berd-call")).toBeTruthy();
    expect(icon("Berd-call")).not.toBe(discussionIcon);
    expect(screen.getByText("GitHub PR")).toBeTruthy();
    expect(screen.getByText("buzz-app#1578")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Watch status for Release checks" })
        .textContent,
    ).toBe(completed ? "Paused" : "Active");
    expect(screen.queryByText("Shared instructions")).toBeNull();
    expect(screen.queryByText("Show raw")).toBeNull();
    expect(screen.queryByRole("button", { name: "New watch" })).toBeNull();
    const sourceRow = disclosure.closest("li");
    if (!sourceRow) throw new Error("Missing source watch");
    expect(
      within(sourceRow).getByRole("list", {
        name: "Activity for Release checks",
      }),
    ).toBeTruthy();
    expect(screen.getByText("CI completed: all checks passed")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Source details for Release checks" }),
    );
    expect(screen.getByText("Who wakes it")).toBeTruthy();
    expect(screen.getByText(/The release is ready/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open buzz-app#1578" });
    expect(disclosure.contains(link)).toBe(false);
    expect(link.getAttribute("href")).toBe(
      "https://github.com/block/buzz-app/pull/1578",
    );
    expect(screen.queryByText("Show raw")).toBeNull();
    expect(screen.getByText(/can't run message filters/)).toBeTruthy();
    act(() => {
      snapshot = { ...snapshot, classifier: "available" };
      changed();
    });
    expect(screen.queryByText(/can't run message filters/)).toBeNull();
  },
);

it("keeps overview and destination navigation in the selected community", async () => {
  const watch = {
    type: "source",
    interest_id: "task",
    name: "Build",
    enabled: true,
    provider: "attention/command",
    config: { command: ["check"] },
    channel,
  };
  const agent = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": { slug: "watch/check", modifiedAt: 1, value: watch },
    },
  };
  let connection = {
    status: "ready",
    ...community,
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => choices,
      },
      media: () => "",
    },
  };
  const choices = { channels: [{ id: channel, name: "Release planning" }] };
  let changed = () => {};
  const snapshot = {
    status: "ready",
    running: [
      agent,
      {
        ...agent,
        key: "membership-b",
        pubkey: "a",
        name: "Bo",
        relay: "wss://other.example",
      },
      {
        ...agent,
        key: "membership-c",
        pubkey: "c",
        name: "Cy",
        owner: "e".repeat(64),
      },
    ],
  };
  const open = vi.fn(),
    save = vi.fn();
  const ctx = {
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save,
    },
    relay: {
      snapshot: () => connection,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
    navigation: { open },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  expect(screen.getByRole("region", { name: "Attention" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details for Build" }));
  fireEvent.click(screen.getByLabelText("Show activity for Build"));
  fireEvent.click(screen.getByLabelText("Watch details for Build"));
  fireEvent.click(
    screen.getByRole("button", { name: "Open destination Release planning" }),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: { communityOrigin: origin, viewer },
      channelId: channel,
    }),
  );
  await act(async () => {
    connection = {
      ...connection,
      origin: "https://other.example",
      scope: `https://other.example:${viewer}`,
    };
    changed();
  });
  expect(
    screen.getByText(
      "This agent belongs to another community. Switch to it to manage its watches.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Open destination Release planning" }),
  ).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("keeps technical data out of message summaries and avoids repeating the destination", () => {
  const author = "a".repeat(64);
  const id = "release-12345678-abcd-1234-abcd-123456789abc";
  const agent = {
    key: "membership-a",
    pubkey: author,
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attentionHistory: {
      "watch/messages": {
        output: `2026-10-27T14:00:00.000Z · ${author}\nRelease is ready.`,
      },
    },
    attention: {
      [`interest/${id}`]: {
        slug: `interest/${id}`,
        value: { type: "interest", instructions: "Follow releases." },
      },
      "watch/messages": {
        slug: "watch/messages",
        value: {
          type: "event",
          name: "Release messages",
          enabled: true,
          interest_id: id,
          channels: [channel],
          channel,
          kinds: [9],
          since: 0,
        },
      },
    },
  };
  const list = { channels: [{ id: channel, name: "Releases" }] };
  const queries = {
    ensureList() {},
    subscribeList: () => () => {},
    list: () => list,
  };
  const snapshot = { status: "ready", running: [agent] };
  const connection = {
    status: "ready",
    ...community,
    session: { channels: queries },
  };
  const ctx = {
    agents: { snapshot: () => snapshot, subscribe: () => () => {} },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  expect(screen.getByRole("heading", { name: "release" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Release messages" }),
  );
  fireEvent.click(screen.getByLabelText("Show activity for Release messages"));

  fireEvent.click(screen.getByLabelText("Watch details for Release messages"));
  expect(
    screen.getByRole("button", { name: "Open destination Releases" }),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("button", {
        name: "Source details for Release messages",
      }),
    ).getAllByText("Releases"),
  ).toHaveLength(1);
  expect(screen.getByText(/Release is ready/).textContent).not.toContain(
    author,
  );
  expect(screen.getByText(/Release is ready/).textContent).not.toContain(
    "2026-10-27T",
  );
  expect(screen.queryByText("No additional filters")).toBeNull();
  expect(screen.queryByText("Event kinds: 9")).toBeNull();
});

it("shows a minimal activity timeline with full message and output previews", () => {
  const author = "b".repeat(64);
  const casey = "c".repeat(64);
  const now = Math.floor(Date.now() / 1000);
  const output = (text: string, at: number) => ({ at, text });
  const agent = {
    key: "membership-a",
    pubkey: "a".repeat(64),
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attentionHistory: {
      "watch/messages": {
        events: [
          {
            id: "1".repeat(64),
            at: now - 120,
            author,
            channel,
            text: "**Release** is ready: [notes](https://example.com/notes).",
          },
          {
            id: "2".repeat(64),
            at: now - 60,
            author,
            channel,
            text: "Tagged `v2`.",
          },
          {
            id: "3".repeat(64),
            at: now - 30,
            author,
            channel,
            text: "Ask @Casey in #Beta.",
            mentions: [casey],
          },
        ],
      },
      "watch/build": {
        events: [output("first", now - 60), output("**second**", now)],
      },
    },
    attention: {
      "interest/release": {
        slug: "interest/release",
        value: { type: "interest", instructions: "Follow releases." },
      },
      "watch/messages": {
        slug: "watch/messages",
        value: {
          type: "event",
          name: "Release messages",
          enabled: true,
          interest_id: "release",
          channels: [channel],
          kinds: [9],
          since: 0,
        },
      },
      "watch/build": {
        slug: "watch/build",
        value: {
          type: "source",
          name: "Build",
          enabled: true,
          interest_id: "release",
          provider: "attention/command",
          config: { command: "make" },
        },
      },
    },
  };
  const list = {
    channels: [
      { id: channel, name: "Releases" },
      { id: "beta", name: "Beta" },
    ],
  };
  const queries = {
    ensureList() {},
    subscribeList: () => () => {},
    list: () => list,
  };
  const profiles = new Map([
    [author, { name: "alex" }],
    [casey, { name: "Casey" }],
  ]);
  // Profile reads fail while the session closes; rows must not leave that
  // unhandled. A plain function, as a mock would observe the rejection itself.
  const reads: unknown[][] = [];
  const ensure = (...args: unknown[]) => {
    reads.push(args);
    return Promise.reject(new Error("closed"));
  };
  const names = {
    resolve: (pubkey: string, fallback?: string) =>
      pubkey === author ? "Alex" : fallback,
    subscribe: () => () => {},
    snapshot: () => 0,
  };
  const connection = {
    status: "ready",
    ...community,
    session: {
      channels: queries,
      names,
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure,
      },
      media: () => undefined,
    },
  };
  let snapshot = { status: "ready", running: [agent] };
  let changed = () => {};
  const ctx = {
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Release messages" }),
  );
  fireEvent.click(screen.getByLabelText("Show activity for Release messages"));
  fireEvent.click(screen.getByRole("button", { name: "Details for Build" }));
  fireEvent.click(screen.getByLabelText("Show activity for Build"));
  const messages = screen.getByRole("list", {
    name: "Activity for Release messages",
  });
  const events = Array.from(messages.querySelectorAll("summary"));
  expect(
    events.map(
      (event) =>
        event.querySelector(".attention-activity-summary")?.textContent,
    ),
  ).toEqual(["Ask @Casey in #Beta.", "Tagged v2.", "Release is ready: notes."]);
  expect(document.querySelector("[data-message-id]")).toBeNull();
  for (const [index, event] of events.entries()) {
    fireEvent.click(event);
    const preview = document.querySelector("[data-message-id]");
    if (!preview) throw new Error("Missing message preview");
    expect(preview.getAttribute("data-message-id")).toBe(
      String(3 - index).repeat(64),
    );
    expect(within(preview as HTMLElement).getByText("Alex").tagName).toBe(
      "STRONG",
    );
    if (index === 0) {
      expect(reads).toContainEqual([[author, casey], "background"]);
      // A chip splits its first character from the rest of the name.
      expect(
        [...document.querySelectorAll("[data-mention-kind]")]
          .find((element) => element.textContent === "Casey")
          ?.getAttribute("data-mention-kind"),
      ).toBe("person");
      expect(
        screen.getByRole("link", { name: "#Beta" }).getAttribute("href"),
      ).toBe("buzz://channel/beta");
    } else if (index === 1) {
      expect(screen.getByText("v2").tagName).toBe("CODE");
    } else {
      expect(screen.getByText("Release").tagName).toBe("STRONG");
      expect(
        screen.getByRole("link", { name: "notes" }).getAttribute("href"),
      ).toBe("https://example.com/notes");
    }
    fireEvent.click(event);
  }
  const build = screen.getByRole("list", { name: "Activity for Build" });
  const outputs = Array.from(build.querySelectorAll("summary"));
  expect(
    outputs.map(
      (item) => item.querySelector(".attention-activity-summary")?.textContent,
    ),
  ).toEqual(["second", "first"]);
  for (const [index, item] of outputs.entries()) {
    fireEvent.click(item);
    expect(
      screen.getByText(index === 0 ? "**second**" : "first", {
        selector: "pre",
      }),
    ).toBeTruthy();
    fireEvent.click(item);
  }
  // Newest-first history must retain the expanded event, not the row position.
  fireEvent.click(outputs[0] as HTMLElement);
  act(() => {
    snapshot = {
      ...snapshot,
      running: [
        {
          ...agent,
          attentionHistory: {
            ...agent.attentionHistory,
            "watch/build": {
              events: [
                ...agent.attentionHistory["watch/build"].events,
                output("third", now + 1),
              ],
            },
          },
        },
      ],
    };
    changed();
  });
  expect(
    within(build).getByText("**second**", { selector: "pre" }),
  ).toBeTruthy();
  expect(within(build).queryByText("third", { selector: "pre" })).toBeNull();
});

it("keeps spoilers hidden in activity summaries", () => {
  const agent = {
    key: "membership-a",
    pubkey: "a".repeat(64),
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attentionHistory: {
      "watch/pr": { events: [{ at: 1, text: "Status: ||private result||" }] },
    },
    attention: {
      "interest/release": {
        slug: "interest/release",
        value: { type: "interest", instructions: "Follow releases." },
      },
      "watch/pr": {
        slug: "watch/pr",
        value: {
          type: "source",
          name: "Release PR",
          enabled: true,
          interest_id: "release",
          provider: "github/pr",
          config: {},
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [agent] };
  const list = { channels: [] };
  const connection = {
    status: "ready",
    ...community,
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => list,
      },
    },
  };
  const ctx = {
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
    },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Release PR" }),
  );
  fireEvent.click(screen.getByLabelText("Show activity for Release PR"));
  const row = within(
    screen.getByRole("list", { name: "Activity for Release PR" }),
  ).getByLabelText(/^Open activity/);
  expect(row.getAttribute("aria-label")).toBe(
    "Open activity: Status: [Spoiler]",
  );
  expect(row.textContent).not.toContain("private");
});

it("shows a fired timer's wake as activity", () => {
  const agent = {
    key: "membership-a",
    pubkey: "a".repeat(64),
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attentionHistory: {
      "watch/tick": {
        lastWokeAt: 1,
        events: [{ at: 1, text: "Check the **release**." }],
      },
    },
    attention: {
      "interest/release": {
        slug: "interest/release",
        value: { type: "interest", instructions: "Follow releases." },
      },
      "watch/tick": {
        slug: "watch/tick",
        value: {
          type: "timer",
          interest_id: "release",
          enabled: true,
          prompt: "Check the **release**.",
          armed_at: 1,
          interval_secs: 3600,
          max_occurrences: null,
          expires_at: null,
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [agent] };
  const list = { channels: [] };
  const connection = {
    status: "ready",
    ...community,
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => list,
      },
    },
  };
  const ctx = {
    agents: { snapshot: () => snapshot, subscribe: () => () => {} },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Details for release" }));
  const activity = screen.getByLabelText("Show activity for release");
  expect(activity.querySelector(".attention-detail-preview")?.textContent).toBe(
    "1 event",
  );
  fireEvent.click(activity);
  expect(
    within(
      screen.getByRole("list", { name: "Activity for release" }),
    ).getByLabelText("Open activity: Check the release."),
  ).toBeTruthy();
});

it("shows an Interest's title and summary, and no summary when it has none", () => {
  const agent = {
    key: "membership-a",
    pubkey: "a".repeat(64),
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/release": {
        slug: "interest/release",
        value: {
          type: "interest",
          title: "Release checks",
          summary: "Wakes when CI finishes and reports failures to John.",
          instructions: "# Old heading\nFollow releases.",
        },
      },
      "interest/builds": {
        slug: "interest/builds",
        value: { type: "interest", instructions: "Follow builds." },
      },
    },
  };
  const snapshot = { status: "ready", running: [agent] };
  const list = { channels: [] };
  const connection = {
    status: "ready",
    ...community,
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => list,
      },
    },
  };
  const ctx = {
    agents: { snapshot: () => snapshot, subscribe: () => () => {} },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  const titled = screen.getByRole("region", {
    name: "Interest Release checks",
  });
  expect(titled.querySelector(".attention-interest-summary")?.textContent).toBe(
    "Wakes when CI finishes and reports failures to John.",
  );
  const untitled = screen.getByRole("region", { name: "Interest builds" });
  expect(untitled.querySelector(".attention-interest-summary")).toBeNull();
});

it("does not repeat consecutive sonar messages across sweeps", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
  try {
    const { container } = render(
      <AttentionSonar name="Ada" size="large" hints />,
    );
    const signals = [
      ...container.querySelectorAll(".attention-sonar-signal"),
    ].filter((signal) => signal.querySelector(".attention-sonar-hint"));
    expect(signals).toHaveLength(3);
    const seen = signals.map(
      (signal) => signal.querySelector(".attention-sonar-hint")?.textContent,
    );
    for (let turn = 0; turn < 12; turn++) {
      const signal = signals[turn % signals.length];
      const dot = signal?.querySelector(".attention-sonar-dot");
      if (!dot) throw new Error("Missing message signal");
      fireEvent.animationIteration(dot);
      seen.push(signal?.querySelector(".attention-sonar-hint")?.textContent);
    }
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index]).not.toBe(seen[index - 1]);
    }
  } finally {
    random.mockRestore();
  }
});

it("confirms deleting an Interest whose only watch was skipped", () => {
  const agent = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/release": {
        slug: "interest/release",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Keep releases moving." },
      },
    },
    skipped: {
      "watch/over": {
        slug: "watch/over",
        modifiedAt: 1,
        value: { type: "event", interest_id: "release", enabled: true },
        problem: "Over the limit of 100 watches and timers",
      },
    },
  };
  const save = vi.fn(async () => {});
  const snapshot = { status: "ready", running: [agent] };
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: {
      presentWatch: () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => {},
      save,
    },
    relay: {
      snapshot: () => disconnected,
      subscribe: () => () => {},
    },
  } as unknown as Context;
  render(
    React.createElement(createTab(ctx), { agent: { key: "membership-a" } }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Interest status for release" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});
