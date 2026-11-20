// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentCreateProps,
  Agents,
  AgentUpdateRequest,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import { UpdateReview } from "./UpdateReview";

afterEach(cleanup);

type Config = { reply: string; model: string };
const Create = ({ config, onChange }: AgentCreateProps<Config>) => (
  <textarea
    aria-label="Instructions"
    value={config.reply}
    onChange={(event) => onChange({ ...config, reply: event.target.value })}
  />
);
const kind = (key: string, title: string) => ({
  key,
  title,
  defaults: () => ({ config: { reply: "", model: "default" } }),
  adopt: ({ instructions }: { instructions?: string }, config: Config) => ({
    ...config,
    reply: instructions ?? config.reply,
  }),
  Create,
  tabs: [
    {
      id: "settings",
      title: "Settings",
      role: "settings",
      component: ({ agent, save }: AgentViewProps) => (
        <button type="button" onClick={() => void save(agent.config)}>
          Save
        </button>
      ),
    },
  ],
  settingsProposal: {
    compactAt: "unprotected",
    resolveRecommended: async () => ({
      harness: "goose",
      provider: "example",
      model: "recommended-model",
      effort: "medium",
      label: "Recommended model",
    }),
  },
});

function fixture(
  change: Partial<AgentUpdateRequest>,
  waiting = false,
  agentState?: Partial<Agent>,
) {
  const request: AgentUpdateRequest = {
    id: "draft",
    requester: "a".repeat(64),
    requesterName: "Parent",
    owner: "b".repeat(64),
    community: "https://relay.example",
    agent: "c".repeat(64),
    agentName: "Child",
    agentType: "test/echo",
    ...change,
  };
  // One for an agent in a community that isn't connected now.
  let requests: readonly AgentUpdateRequest[] = waiting
    ? [{ ...request, id: "offline", agent: "d".repeat(64) }, request]
    : [request];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const types = [
    kind("test/echo", "Echo"),
    kind("test/other", "Other"),
  ] as unknown as readonly RegisteredAgentType[];
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Child",
    owner: "b".repeat(64),
    relay: "wss://relay.example",
    picture: "https://example.test/child.png",
    type: "test/echo",
    config: { reply: "Be brief.", model: "large" },
    ...agentState,
  } as unknown as Agent;
  let snapshot = { running: [agent] };
  const agents = {
    /** Sets which agents are connected now. */
    connect: (running: readonly Agent[]) => {
      snapshot = { running: [...running] };
      for (const listener of listeners) listener();
    },
    agent,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    snapshot: () => snapshot,
    updateRequests: () => requests,
    approveUpdate: vi.fn(async () => clear()),
    dismissUpdate: vi.fn(clear),
    previewRetype: vi.fn(() => ({
      config: { reply: "Be brief.", model: "default" },
      moved: ["instructions"],
      dropped: [],
      settings: [],
    })),
  };
  render(<UpdateReview agents={agents as unknown as Agents} />);
  return agents;
}

it("edits the agent's settings with the proposed changes and saves what the owner reviewed", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid", instructions: "Review PRs." });
  const name = await screen.findByDisplayValue("Kid");
  expect(screen.getByText("Edit Child")).toBeVisible();
  expect(screen.getByText(/Parent proposed these changes\./)).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Review PRs.");
  expect(agents.previewRetype).not.toHaveBeenCalled();
  expect(agents.approveUpdate).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewer");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith("draft", {
      type: "test/echo",
      name: "Reviewer",
      picture: "https://example.test/child.png",
      config: { reply: "Review PRs.", model: "large" },
    }),
  );
});

it("starts from a proposed picture and saves it with the review", async () => {
  const user = userEvent.setup();
  const agents = fixture({ picture: "https://example.test/proposed.png" });
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ picture: "https://example.test/proposed.png" }),
    ),
  );
});

it("previews a proposed harness change from the migrated settings", async () => {
  const user = userEvent.setup();
  const agents = fixture({ type: "test/other" });
  await screen.findByDisplayValue("Child");
  expect(agents.previewRetype).toHaveBeenCalledWith(
    "c".repeat(64),
    "test/other",
  );
  expect(screen.getByText(/The provider changes/)).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Be brief.");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        type: "test/other",
        config: { reply: "Be brief.", model: "default" },
      }),
    ),
  );
});

it("reviews the next request while another's agent is not connected", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" }, true);
  await screen.findByDisplayValue("Kid");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft"),
  );
});

it("keeps the owner's edits while agents connect and disconnect", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" }, true);
  const name = await screen.findByDisplayValue("Kid");
  await user.clear(name);
  await user.type(name, "Reviewer");
  const earlier = {
    ...agents.agent,
    key: "d".repeat(64),
    pubkey: "d".repeat(64),
  } as Agent;
  act(() => agents.connect([earlier, agents.agent]));
  act(() => agents.connect([earlier]));
  expect(screen.getByDisplayValue("Reviewer")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ name: "Reviewer" }),
    ),
  );
});

it("discards an unsaved change request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" });
  await screen.findByDisplayValue("Kid");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft"),
  );
  expect(agents.approveUpdate).not.toHaveBeenCalled();
});

it.each([
  {
    agentState: { type: "test/other" },
    settings: { model: "medium" },
    message: "The agent changed harnesses after this proposal",
  },
  {
    agentState: { executionBinding: { provider: "test/remote", config: {} } },
    settings: { workspace: "/work/task" },
    message: "The execution adapter manages apps and workspace",
  },
  {
    agentState: { executionBinding: { provider: "test/remote", config: {} } },
    settings: { model: "local-model" },
    message: "does not support model or thinking proposals",
  },
  {
    agentState: { protection: { provider: "test/protection", policy: {} } },
    settings: { apps: true },
    message: "Protected agents cannot enable Codex apps and plugins",
  },
  {
    agentState: { protection: { provider: "test/protection", policy: {} } },
    settings: { compactAt: "150000" },
    message: "Protected agents cannot set an Auto-compact threshold",
  },
])(
  "explains why a proposal can no longer be saved before review",
  async ({ agentState, message, settings }) => {
    const user = userEvent.setup();
    const agents = fixture({ settings }, false, agentState);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft");
    expect(agents.approveUpdate).not.toHaveBeenCalled();
  },
);

it("saves against the agent revision that opened the settings review", async () => {
  const user = userEvent.setup();
  const agents = fixture(
    { name: "Reviewer", settings: { model: "proposed-model" } },
    false,
    {
      configBase: { settings: "opened-settings" },
    },
  );
  await screen.findByDisplayValue("Reviewer");
  act(() =>
    agents.connect([
      {
        ...agents.agent,
        config: { reply: "Be brief.", model: "new-model" },
        configBase: { settings: "new-settings" },
      },
    ]),
  );
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        config: expect.objectContaining({ model: "proposed-model" }),
      }),
      agents.agent,
    ),
  );
});

it("hides proposed settings when the owner chooses a different harness", async () => {
  const user = userEvent.setup();
  fixture({ settings: { model: "proposed-model" } });
  const summary = await screen.findByRole("region", {
    name: "Proposed settings",
  });
  expect(summary).toHaveTextContent("proposed-model");
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(
    screen.queryByRole("region", { name: "Proposed settings" }),
  ).toBeNull();
});

it("keeps the recommended model when the proposal only changes thinking", async () => {
  fixture({ settings: { effort: "high" } }, false, {
    config: { model: "", effort: "", preset: "recommended" },
  });
  const summary = await screen.findByRole("region", {
    name: "Proposed settings",
  });
  expect(summary).toHaveTextContent("recommended-model");
  expect(summary).toHaveTextContent("high");
});
