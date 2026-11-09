// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { MeshHelpers } from "./MeshHelpers";
import { DEFAULT_MESH_AGENT_CONFIG } from "./meshAgent";
import { MESH_AGENT_PRESETS } from "./meshAgentPresets";

afterEach(cleanup);
const type = {
  id: "mesh",
  key: "buzz.mesh-compute/mesh",
  pluginId: "buzz.mesh-compute",
  title: "Mesh",
  revision: "1",
  defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
} as RegisteredAgentType;
function setup(status = "ready", types = [type], initial: Agent[] = []) {
  const listeners = new Set<() => void>();
  let state = { status, agents: initial, running: [], teams: [] };
  const create = vi.fn(async (input) => {
    const agent = { ...input, pubkey: "a".repeat(64) } as Agent;
    state = { ...state, agents: [...state.agents, agent] };
    for (const listener of listeners) listener();
    return agent;
  });
  const agents = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    create,
  } as unknown as Agents;
  render(<MeshHelpers agents={agents} />);
  return {
    create,
    user: userEvent.setup(),
    remove: () => {
      state = { ...state, agents: [] };
      for (const listener of listeners) listener();
    },
  };
}
it("offers the retained prefabs and custom, disclosing tool access before creation", () => {
  const { create } = setup();
  for (const preset of MESH_AGENT_PRESETS)
    expect(
      screen.getByRole("button", { name: `Create ${preset.name}` }),
    ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Create Custom agent" }),
  ).toBeEnabled();
  expect(screen.queryByText("Emoji maker")).not.toBeInTheDocument();
  expect(
    screen.getAllByText(/shell and files on this machine, plus Buzz access/),
  ).toHaveLength(2);
  expect(screen.getAllByText(/Chat: no tools/)).toHaveLength(2);
  expect(
    screen.getByText(/Members serving its model can read/),
  ).toBeInTheDocument();
  expect(
    screen.getAllByText(/Tool output and core memory may be sent/),
  ).toHaveLength(2);
  expect(create).not.toHaveBeenCalled();
});
it.each(MESH_AGENT_PRESETS)(
  "creates $name using the existing service and preset defaults",
  async (preset) => {
    const { create, user } = setup();
    await user.click(
      screen.getByRole("button", { name: `Create ${preset.name}` }),
    );
    expect(create).toHaveBeenCalledExactlyOnceWith({
      type: type.key,
      name: preset.name,
      picture: expect.stringMatching(/^https:/),
      config: {
        ...DEFAULT_MESH_AGENT_CONFIG,
        preset: preset.id,
        prompt: preset.prompt,
        mode: preset.mode,
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      `${preset.name} created`,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);
it("creates a custom agent with defaults for editing in normal Settings", async () => {
  const { create, user } = setup();
  await user.click(screen.getByRole("button", { name: "Create Custom agent" }));
  expect(create).toHaveBeenCalledExactlyOnceWith({
    type: type.key,
    name: "Custom agent",
    picture: expect.stringMatching(/^https:/),
    config: DEFAULT_MESH_AGENT_CONFIG,
  });
});
it("blocks duplicate creation while pending, surfaces failure and permits retry", async () => {
  const { create, user } = setup();
  let reject!: (error: Error) => void;
  create.mockImplementationOnce(
    () =>
      new Promise<Agent>((_, fail) => {
        reject = fail;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Create Translator" }));
  try {
    expect(create).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create Translator" }));
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    reject(new Error("Creation failed"));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Creation failed");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create Translator" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Translator created",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(2);
});
it.each(["loading", "error"])(
  "keeps creation unavailable while agents are %s",
  (status) => {
    setup(status);
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
  },
);
it("keeps creation unavailable when the Mesh type is absent", () => {
  setup("ready", []);
  for (const button of screen.getAllByRole("button"))
    expect(button).toBeDisabled();
});

it("shows saved presets at the action point, including renamed ones, and allows creation after removal", async () => {
  const { create, user, remove } = setup(
    "ready",
    [type],
    [
      {
        type: type.key,
        name: "My translator",
        config: { ...DEFAULT_MESH_AGENT_CONFIG, preset: "translator" },
      } as Agent,
    ],
  );
  const made = screen.getByRole("button", {
    name: "Translator created as My translator",
  });
  expect(made).toHaveTextContent("Created");
  expect(made).toBeDisabled();
  await user.click(made);
  expect(create).not.toHaveBeenCalled();
  act(remove);
  await user.click(screen.getByRole("button", { name: "Create Translator" }));
  expect(
    screen.getByRole("button", { name: "Translator created as Translator" }),
  ).toBeDisabled();
  expect(create).toHaveBeenCalledTimes(1);
});
