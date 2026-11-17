// @vitest-environment jsdom
// Agents on Automatic (Recommended) get no model and effort choice in the
// composer, only their session controls where those apply, and a pick saved
// for one before it switched is left out.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents/react";
import { setRuntimeRecommendation } from "../agents/recommended";
import type { Agents } from "../agents/service";
import type { ProfileQueries } from "../relay/profile-directory";
import { ComposerModels, type DraftPicks } from "./ComposerModels";

// Synthetic candidates for each local harness.
beforeEach(() =>
  setRuntimeRecommendation({
    candidates: ["goose", "codex", "claude-code"].map((harness) => ({
      harness,
      ...(harness === "goose" ? { provider: "example" } : {}),
      model: "model-b",
      effort: "high",
      label: "Model B",
    })),
  }),
);
afterEach(() => {
  setRuntimeRecommendation(undefined);
  cleanup();
});

const efforts = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];
const catalog = {
  current: "model-a",
  models: [
    { id: "model-a", label: "Model A", effort: "low", efforts },
    { id: "model-b", label: "Model B", effort: "low", efforts },
  ],
};
const profiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};

function renderFor(
  harness: string,
  config: object,
  options: {
    value?: DraftPicks;
    solo?: boolean;
    /** Its type has thread-scoped session controls. */
    session?: boolean;
    /** A new top-level message, where a thread's session can't be acted on. */
    startsThread?: boolean;
  } = {},
) {
  const pubkey = "a".repeat(64);
  const models = vi.fn(async () => catalog);
  const snapshot = {
    status: "ready",
    agents: [
      { pubkey, key: pubkey, name: "Agent A", type: `test/${harness}`, config },
    ],
  };
  const types = [
    {
      key: `test/${harness}`,
      id: harness,
      models,
      ...(options.session
        ? {
            sessionControls: {
              scope: () => "thread",
              state: () => "idle",
              run: async () => {},
              subscribe: () => () => {},
            },
          }
        : {}),
    },
  ];
  const agents = {
    find: (key: string) =>
      snapshot.agents.find((agent) => agent.pubkey === key),
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const resolved = vi.fn();
  render(
    <AgentsContext.Provider value={agents}>
      <ComposerModels
        pubkeys={[pubkey]}
        profiles={profiles}
        media={() => undefined}
        value={options.value ?? {}}
        disabled={false}
        resettable={!!options.solo}
        explicitOnly={!!options.solo}
        startsThread={!!options.startsThread}
        place={{ channelId: "chat" }}
        onChange={() => {}}
        focusAfterPickerRemoval={() => {}}
        onResolved={resolved}
      />
    </AgentsContext.Provider>,
  );
  return { pubkey, models, resolved };
}
const picker = () =>
  screen.queryByRole("button", { name: /^Model and effort/ });

it.each(["goose", "codex", "claude-code"])(
  "offers a %s agent on Automatic only its session controls, and Manual as today",
  async (harness) => {
    // A new top-level message: no session to act on, so no button at all.
    const topLevel = renderFor(
      harness,
      { preset: "recommended" },
      { session: true, startsThread: true },
    );
    await act(async () => {});
    expect(picker()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Session controls/ }),
    ).not.toBeInTheDocument();
    // It isn't asked for models it would never show.
    expect(topLevel.models).not.toHaveBeenCalled();
    cleanup();
    // In a thread, only its session row.
    const reply = renderFor(
      harness,
      { preset: "recommended" },
      { session: true },
    );
    expect(
      await screen.findByRole("button", { name: "Session controls" }),
    ).toBeVisible();
    expect(picker()).not.toBeInTheDocument();
    expect(reply.models).not.toHaveBeenCalled();
    cleanup();
    // Manual keeps the model and effort picker.
    renderFor(harness, { model: "model-a" }, { session: true });
    expect(
      await screen.findByRole("button", {
        name: "Model, effort, and session controls",
      }),
    ).toBeVisible();
  },
);

it("hides the picker for an agent on Automatic whose type has no session controls", async () => {
  const automatic = renderFor("goose", { preset: "recommended" });
  await act(async () => {});
  expect(picker()).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Session controls/ }),
  ).not.toBeInTheDocument();
  expect(automatic.models).not.toHaveBeenCalled();
});

it("leaves out a Solo chat's pick saved before the agent switched to Automatic", async () => {
  const saved = (pubkey: string): DraftPicks => ({
    [pubkey]: { model: "model-a", effort: "low" },
  });
  const pubkey = "a".repeat(64);
  const automatic = renderFor(
    "goose",
    { preset: "recommended" },
    {
      solo: true,
      value: saved(pubkey),
    },
  );
  await act(async () => {});
  // No picker, not even to reset it, and nothing to send for it.
  expect(picker()).not.toBeInTheDocument();
  expect(automatic.resolved).toHaveBeenLastCalledWith({});
  cleanup();
  // On Manual the same saved pick is sent, as today.
  const manual = renderFor(
    "goose",
    { model: "model-a" },
    {
      solo: true,
      value: saved(pubkey),
    },
  );
  await screen.findByRole("button", { name: /^Model and effort/ });
  // The picker can show before its saved pick is reported.
  await waitFor(() =>
    expect(manual.resolved).toHaveBeenLastCalledWith({
      [pubkey]: { model: "model-a", effort: "low" },
    }),
  );
});

it("keeps the picker for a marked agent in a build that recommends nothing for it", async () => {
  setRuntimeRecommendation({ candidates: [] });
  renderFor("goose", { preset: "recommended" });
  expect(
    await screen.findByRole("button", { name: /^Model and effort/ }),
  ).toBeVisible();
});
