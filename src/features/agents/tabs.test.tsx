// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "./service";
import { agentSections } from "./tabs";

afterEach(cleanup);

const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/triage": {
      slug: "interest/triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Triage." },
    },
    "watch/asks": {
      slug: "watch/asks",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
        classifier: {
          questions: { asks: { question: "Is this a question?" } },
        },
      },
    },
  },
} as Agent;

it("leaves the device Attention switch out of Settings", () => {
  const agents = {
    save: async () => {},
    subscribe: () => () => {},
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const sections = agentSections({
    agents,
    agent,
    type: undefined,
    memories: undefined,
    settingsHost: { typeControl: () => <p>Provider</p> },
  });
  expect(sections.some((tab) => tab.value === "agent:attention")).toBe(false);
  const section = sections.find((tab) => tab.value === "agent:settings");
  render(<div>{section?.render()}</div>);
  expect(screen.getByText("Provider")).toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("adds no Settings tab when the host has nothing to set", () => {
  const sections = agentSections({
    agents: {
      save: async () => {},
      subscribe: () => () => {},
      memberships: () => [],
      configHistory: () => undefined,
      addedTabs: () => [],
      registerTab: () => {},
      controlAttention: () => {},
    } as unknown as Agents,
    agent,
    type: undefined,
    memories: undefined,
    settingsHost: {},
  });
  expect(sections.map((tab) => tab.value)).toEqual(["agent:memory"]);
});

it("moves both synced histories into a collapsed Settings disclosure", async () => {
  const side = (name: "settings" | "instructions") => ({
    side: name,
    expected: { channel: "c", d: name, type: `buzz.agent.${name}` },
    head: undefined,
    version: 0,
  });
  const snapshot = {};
  const history = {
    read: async () => [],
    sides: [side("settings"), side("instructions")],
    revise: async () => ({ ok: true }),
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    classifier: () => "available",
    save: async () => {},
    configHistory: () => history,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const sections = agentSections({
    agents,
    agent,
    type: undefined,
    memories: undefined,
  });
  expect(sections.some((tab) => tab.value === "agent:history")).toBe(false);
  const section = sections.find((tab) => tab.value === "agent:settings");
  render(<div>{section?.render()}</div>);
  const disclosure = screen.getByRole("button", { name: "Previous versions" });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("region", { name: "Settings" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByText("0 versions")).toBeInTheDocument();
  await userEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Instructions" }),
  ).toBeInTheDocument();
});

it("adds plugin tabs to each agent shown unless their `when` says otherwise, alongside Settings and Memory", () => {
  const tab = (id: string, when?: (agent: Agent) => boolean) => ({
    id,
    key: `buzz.example/${id}`,
    pluginId: "buzz.example",
    revision: "1",
    title: id,
    component: ({
      agent,
      open,
    }: {
      agent: Agent;
      open?: ((target: string) => boolean) | undefined;
    }) => (
      <button type="button" onClick={() => open?.(`nostr:${id}`)}>
        {id} {agent.name}
      </button>
    ),
    ...(when && { when }),
  });
  const agents = {
    save: async () => {},
    subscribe: () => () => {},
    memberships: () => [],
    configHistory: () => ({
      read: async () => [],
      sides: [],
      revise: async () => ({ ok: true }),
    }),
    addedTabs: () => [
      tab("every"),
      tab("local", (shown) => shown.place === "here"),
    ],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const values = (place: Agent["place"]) =>
    agentSections({
      agents,
      agent: { ...agent, place } as Agent,
      type: undefined,
      memories: undefined,
    }).map((tab) => tab.value);
  expect(values("here")).toEqual([
    "agent:settings",
    "agent:added:buzz.example/every",
    "agent:added:buzz.example/local",
    "agent:memory",
  ]);
  // Settings (version history) stays local; a tab without `when` is for hosted agents too.
  expect(values("hosted")).toEqual([
    "agent:added:buzz.example/every",
    "agent:memory",
  ]);
  expect(values("elsewhere")).toEqual([]);
  // A plugin's tab opens links, such as profiles, where it is shown.
  const opened: string[] = [];
  render(
    agentSections({
      agents,
      agent,
      type: undefined,
      memories: undefined,
      openLink: (target) => opened.push(target) > 0,
    })
      .find((tab) => tab.value === "agent:added:buzz.example/every")
      ?.render(),
  );
  screen.getByText("every Ada").click();
  expect(opened).toEqual(["nostr:every"]);
});

it("adds a plugin tab only to the agents its `when` accepts", () => {
  const tab = (id: string, when?: (agent: Agent) => boolean) => ({
    id,
    key: `example/${id}`,
    pluginId: "example",
    revision: "1",
    title: id,
    component: () => null,
    ...(when && { when }),
  });
  const agents = {
    configHistory: () => undefined,
    addedTabs: () => [
      tab("every"),
      tab("ada", (shown) => shown.name === "Ada"),
      tab("broken", () => {
        throw new Error("broken");
      }),
    ],
  } as unknown as Agents;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const values = (name: string) =>
    agentSections({
      agents,
      agent: { ...agent, name },
      type: undefined,
      memories: undefined,
    }).map((section) => section.value);
  expect(values("Ada")).toEqual([
    "agent:added:example/every",
    "agent:added:example/ada",
    "agent:memory",
  ]);
  // A tab whose `when` throws hides only itself.
  expect(values("Bea")).toEqual(["agent:added:example/every", "agent:memory"]);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it("reopens ordinary editors and their save revisions when config availability changes", async () => {
  let current: Agent<{ model: string }> = {
    ...agent,
    config: { model: "" },
    configBase: { settings: null },
    configProblem: "Unavailable",
  };
  const save = vi.fn(async () => {});
  const agents = {
    save,
    snapshot: () => ({ agents: [current] }),
    configHistory: () => undefined,
    addedTabs: () => [],
  } as unknown as Agents;
  // Goose and Pi initialize their draft on mount; Codex also relies on the
  // host to retain the revision that belongs to the opened editor.
  function Settings({
    agent: shown,
    save: submit,
  }: import("./service").AgentViewProps<{ model: string }>) {
    const [draft, setDraft] = useState(shown.config);
    return (
      <>
        <input
          aria-label="Model"
          value={draft.model}
          onChange={(event) => setDraft({ model: event.target.value })}
        />
        <button
          type="button"
          disabled={draft.model === shown.config.model}
          onClick={() => void submit(draft)}
        >
          Save
        </button>
      </>
    );
  }
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: Settings,
      },
    ],
  } as unknown as import("./service").RegisteredAgentType;
  const shown = () =>
    agentSections({ agents, agent: current, type, memories: undefined })
      .find((section) => section.value === "agent:settings")
      ?.render();
  const view = render(shown());
  current = {
    ...agent,
    config: { model: "opus" },
    configBase: { settings: "recovered" },
  };
  view.rerender(shown());
  expect(screen.getByLabelText("Model")).toHaveValue("opus");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.clear(screen.getByLabelText("Model"));
  await userEvent.type(screen.getByLabelText("Model"), "sonnet");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenLastCalledWith(agent.key, {
    config: { model: "sonnet" },
    base: { settings: "recovered" },
  });
  current = {
    ...current,
    config: { model: "" },
    configBase: { settings: null },
    configProblem: "Unavailable",
  };
  view.rerender(shown());
  expect(screen.getByLabelText("Model")).toHaveValue("");
  current = {
    ...agent,
    config: { model: "latest" },
    configBase: { settings: "recovered-again" },
  };
  view.rerender(shown());
  expect(screen.getByLabelText("Model")).toHaveValue("latest");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Model"), "-edit");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenLastCalledWith(agent.key, {
    config: { model: "latest-edit" },
    base: { settings: "recovered-again" },
  });
});

it("retains opening revisions for ordinary tabs and forwards explicitly reconciled revisions", async () => {
  let current = { ...agent, configBase: { settings: "opened" } };
  const save = vi.fn(async () => {});
  const agents = {
    save,
    snapshot: () => ({ agents: [current] }),
    configHistory: () => undefined,
    addedTabs: () => [],
  } as unknown as Agents;
  const component = ({
    agent: shown,
    save: submit,
  }: import("./service").AgentViewProps) => (
    <>
      <button type="button" onClick={() => void submit({ model: "mine" })}>
        Ordinary save
      </button>
      <button
        type="button"
        onClick={() =>
          void submit({ model: "merged" }, { base: shown.configBase ?? {} })
        }
      >
        Reconciled save
      </button>
    </>
  );
  const type = {
    tabs: [{ id: "settings", title: "Settings", role: "settings", component }],
  } as unknown as import("./service").RegisteredAgentType;
  const shown = () =>
    agentSections({ agents, agent: current, type, memories: undefined })
      .find((section) => section.value === "agent:settings")
      ?.render();
  const view = render(shown());
  current = { ...current, configBase: { settings: "latest" } };
  view.rerender(shown());
  await userEvent.click(screen.getByRole("button", { name: "Ordinary save" }));
  expect(save).toHaveBeenLastCalledWith(agent.key, {
    config: { model: "mine" },
    base: { settings: "opened" },
  });
  current = { ...current, configBase: { settings: "reconciled" } };
  view.rerender(shown());
  await userEvent.click(
    screen.getByRole("button", { name: "Reconciled save" }),
  );
  expect(save).toHaveBeenLastCalledWith(agent.key, {
    config: { model: "merged" },
    base: { settings: "reconciled" },
  });
});
