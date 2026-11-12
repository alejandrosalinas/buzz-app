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
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentDefaults } from "../agents/AgentDefaults";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Agent } from "../../features/agents/service";
import { fakeSpawn } from "./goose-testing";
import { type Config, DEFAULT_CONFIG, type GooseRuntime } from "./runtime";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";
import { localSessions } from "./sessions";
import {
  PROMPTS_PREFIX,
  sessionPrompts,
} from "../../features/agents/session-prompts";
import { localStore } from "../../features/agents/store";

/** New agent's fields read no sessions. */
const unused = {
  runtime: {} as GooseRuntime,
  history: new GooseHistory(undefined),
};

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async () => null,
}));

beforeEach(() => {
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROVIDERS = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    description: "Claude models",
    defaultModel: "claude-sonnet-5-5",
    visibleInSetup: true,
    configKeys: [{ name: "ANTHROPIC_API_KEY", required: true, secret: true }],
    models: [{ id: "claude-opus-5-5", name: "claude-opus-5-5" }],
  },
  {
    providerId: "databricks",
    providerName: "Databricks",
    configured: true,
    visibleInSetup: true,
    // As goose lists it: both fields entered, the token optional.
    configKeys: [
      { name: "DATABRICKS_HOST", required: true, secret: false },
      { name: "DATABRICKS_TOKEN", required: false, secret: true },
    ],
  },
  // A provider Buzz has no mark for.
  {
    providerId: "openrouter",
    providerName: "OpenRouter",
    visibleInSetup: true,
    configKeys: [],
  },
];

function created(
  options: Readonly<{
    reply?: string;
    spawn?: (fake: ReturnType<typeof fakeSpawn>) => GooseSetup;
    modelAppearance?: "glass-ghost";
    onReadyChange?: (ready: boolean) => void;
    config?: Config;
    /** Fields goose already holds, beyond Databricks' host. */
    saved?: Readonly<Record<string, readonly string[]>>;
    defaults?: Readonly<{ providerId: string; modelId: string }>;
  }> = {},
) {
  const saved = new Map<string, Set<string>>([
    ["databricks", new Set(["DATABRICKS_HOST"])],
    ...Object.entries(options.saved ?? {}).map(
      ([id, keys]) => [id, new Set(keys)] as const,
    ),
  ]);
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: options.defaults ?? {
      providerId: "databricks",
      modelId: "goose-claude",
    },
    saved,
    reply: options.reply ?? "OK",
    thinking: {
      "claude-opus-5-5": {
        current: "medium",
        levels: ["low", "medium", "high"],
      },
    },
  });
  const setup = options.spawn?.(fake) ?? new GooseSetup(fake);
  const { Create, CreateModel } = createTabs({
    setup,
    ...unused,
  });
  if (!CreateModel) throw new Error("no model field");
  const changes: Config[] = [];
  function Harness() {
    const [config, setConfig] = useState<Config>(
      options.config ?? DEFAULT_CONFIG,
    );
    const onChange = (next: Config) => {
      changes.push(next);
      setConfig(next);
    };
    return (
      <>
        <Create config={config} disabled={false} onChange={onChange} />
        <CreateModel
          {...(options.onReadyChange && {
            onReadyChange: options.onReadyChange,
          })}
          config={config}
          disabled={false}
          onChange={onChange}
          {...(options.modelAppearance && {
            modelAppearance: options.modelAppearance,
          })}
        />
      </>
    );
  }
  render(<Harness />);
  return { fake, saved, changes, setup };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  if (label === "Provider") {
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: option }));
  } else {
    await user.click(screen.getByRole("button", { name: label }));
    (await screen.findByRole("menuitem", { name: "Claude" })).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: option }),
    );
  }
}

/** The model field, labeled with goose's default or the agent's choice. */
const modelButton = () => screen.getByRole("button", { name: /^Goose model:/ });

/** Settings' Harness defaults, offering Goose on `setup`. */
function gooseDefaults(setup: GooseSetup) {
  const { DefaultControl, ProviderDialogBody } = createTabs({
    setup,
    ...unused,
  });
  const types = [
    {
      defaults: () => ({ config: DEFAULT_CONFIG }),
      key: "buzz.goose/goose",
      pluginId: "buzz.goose",
      revision: "test",
      id: "goose",
      title: "Goose",
      provider: {
        subscribe: setup.subscribe,
        snapshot: setup.snapshot,
        check: setup.check,
        DefaultControl,
        DialogBody: ProviderDialogBody,
      },
    },
  ] as RegisteredAgentType[];
  return {
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

/** Opens the provider dialog from the model field. */
async function openChoices() {
  await userEvent.setup().click(modelButton());
  await userEvent
    .setup()
    .click(await screen.findByRole("menuitem", { name: "Edit configuration" }));
  return screen.findByRole("dialog", { name: "Edit configuration" });
}

it("keeps New agent's card to instructions; the model field shows goose's default", async () => {
  created();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
});

it("shows the model family icon and keeps provider options text-only", async () => {
  created();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
  expect(
    modelButton().querySelector(".tabler-icon-brand-databricks"),
  ).toBeNull();
  expect(modelButton().querySelectorAll("svg")).toHaveLength(2);
  const dialog = await openChoices();
  await userEvent
    .setup()
    .click(within(dialog).getByRole("combobox", { name: "Provider" }));
  const databricks = await screen.findByRole("option", { name: "Databricks" });
  expect(databricks.querySelector(".tabler-icon-brand-databricks")).toBeNull();
});

it("keeps provider fields visible while saving its key and selecting a model", async () => {
  const { saved, changes } = created();
  const user = userEvent.setup();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("From goose config (Databricks)"),
  );
  expect(within(dialog).getByRole("textbox", { name: /host/i })).toBeVisible();
  expect(within(dialog).queryByRole("button", { name: "Change" })).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Test connection" }),
  ).toBeNull();

  await choose("Provider", "Anthropic");
  expect(within(dialog).queryByRole("button", { name: /^Model:/ })).toBeNull();
  const key = await within(dialog).findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "sk-test");
  expect(
    within(dialog).queryByRole("button", { name: "Save to goose" }),
  ).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(changes).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));
  expect(changes.at(-1)).toMatchObject({ provider: "anthropic", model: "" });
  await user.click(modelButton());
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  (
    await screen.findByRole("menuitemradio", { name: "claude-opus-5-5" })
  ).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Automatic" }),
  );
  expect(changes.at(-1)).toMatchObject({
    model: "claude-opus-5-5",
    effort: "",
  });
  expect(modelButton()).toHaveTextContent("Automatic");
  fireEvent.click(modelButton());
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use Goose default" }),
  );
  expect(changes.at(-1)).toMatchObject({ model: "", effort: "" });
});

it("says a provider is not set up instead of offering its catalog's models", async () => {
  const { fake, saved } = created({
    defaults: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
  });
  expect(
    await screen.findByText(
      "Anthropic isn't set up in goose. Add API key (ANTHROPIC_API_KEY) in Edit configuration, or run goose configure.",
    ),
  ).toHaveAttribute("role", "alert");
  const user = userEvent.setup();
  await user.click(modelButton());
  expect(await screen.findByRole("menu")).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  await user.keyboard("{Escape}");
  // `goose configure` sets it up meanwhile, on another default model.
  saved.set("anthropic", new Set(["ANTHROPIC_API_KEY"]));
  await new GooseSetup(fake).saveDefaults({
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent("claude-opus-5-5"),
  );
});

it("keeps a card's model chip to the model, while its menu shows the level", async () => {
  created({
    saved: { anthropic: ["ANTHROPIC_API_KEY"] },
    modelAppearance: "glass-ghost",
    config: {
      ...DEFAULT_CONFIG,
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
    },
  });
  const user = userEvent.setup();
  await waitFor(() => expect(modelButton()).toBeEnabled());
  expect(modelButton()).toHaveTextContent(/^claude-opus-5-5$/);
  // The Goose mark, the model's family mark and the caret.
  expect(modelButton().querySelectorAll("svg")).toHaveLength(3);
  await user.click(modelButton());
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  (
    await screen.findByRole("menuitemradio", { name: "claude-opus-5-5" })
  ).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "High" }),
  ).toHaveAttribute("aria-checked", "true");
});

it("gives a card's inherited model its name's room, naming Default only in its label", async () => {
  created({ modelAppearance: "glass-ghost" });
  await waitFor(() => expect(modelButton()).toBeEnabled());
  expect(modelButton()).toHaveTextContent(/^Claude$/);
  expect(modelButton()).toHaveAccessibleName("Goose model: Claude · Default");
});

it("saves a key on Enter in Settings, and only an absolute or ~/ workspace", async () => {
  const saved = new Map<string, Set<string>>();
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved,
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const save = vi.fn(async (_config: Config) => undefined);
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={save}
    />,
  );
  const user = userEvent.setup();
  await choose("Provider", "Anthropic");
  await user.type(
    await screen.findByLabelText("API key", {
      selector: "input:not([aria-hidden])",
    }),
    "sk-test{Enter}",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "placeholder",
      "Saved in goose. Enter a new value to replace it.",
    ),
  );
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));
  expect(save).not.toHaveBeenCalled();

  const workspace = screen.getByLabelText("Workspace");
  await user.clear(workspace);
  await user.type(workspace, "projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter an absolute or ~/… workspace path.",
  );
  expect(save).not.toHaveBeenCalled();
  await user.clear(workspace);
  await user.type(workspace, "~/projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        workspace: "~/projects/goose",
      }),
    ),
  );
});

it("saves a thinking level goose lists for the model, and marks one it does not", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    thinking: {
      "": { current: "medium", levels: ["off", "low", "medium", "high"] },
      "plain-model": { current: "off", levels: ["off"] },
      // goose reports "off" when no level is set, yet sends none then.
      "unset-model": { current: "off", levels: ["off", "low", "high"] },
    },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const agent = (config: Config) =>
    ({
      key: "c".repeat(64),
      pubkey: "c".repeat(64),
      name: "Gander",
      type: "buzz.goose/goose",
      owner: "a".repeat(64),
      config,
    }) as Agent<Config>;
  const save = vi.fn(async (_config: Config) => undefined);
  const { rerender } = render(
    <SettingsTab agent={agent(DEFAULT_CONFIG)} save={save} />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toHaveTextContent("Medium"));
  await user.click(thinking);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Medium · Default", "Off", "Low", "Medium", "High"]);
  await user.click(screen.getByRole("option", { name: "High" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "high" }),
    ),
  );

  rerender(
    <SettingsTab
      key="plain"
      agent={agent({ ...DEFAULT_CONFIG, model: "plain-model", effort: "high" })}
      save={save}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("High (unavailable)"),
  );

  // An unset level reads as goose's default, not as thinking turned off.
  rerender(
    <SettingsTab
      key="unset"
      agent={agent({ ...DEFAULT_CONFIG, model: "unset-model" })}
      save={save}
    />,
  );
  const unset = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(unset).toHaveTextContent(/^Default$/));
  await user.click(unset);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Default", "Off", "Low", "High"]);
});

it("offers Create agent a Thinking row with goose's levels for the chosen model", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    thinking: {
      "": { current: "medium", levels: ["low", "medium", "high"] },
      "plain-model": { current: "off", levels: ["off"] },
    },
  });
  const { CreateThinking } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  if (!CreateThinking) throw new Error("no Thinking field");
  const changes: Config[] = [];
  const { rerender } = render(
    <CreateThinking
      config={DEFAULT_CONFIG}
      disabled={false}
      onChange={(next) => changes.push(next)}
    />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toHaveTextContent("Medium · Default"));
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  expect(changes.at(-1)).toEqual({ ...DEFAULT_CONFIG, effort: "high" });

  // Another model reads its own levels.
  rerender(
    <CreateThinking
      config={{ ...DEFAULT_CONFIG, model: "plain-model" }}
      disabled={false}
      onChange={(next) => changes.push(next)}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent(/^Default$/),
  );
});

it("says when Create agent's Thinking cannot read goose's levels, and tries again", async () => {
  let fail = true;
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    thinking: { "": { current: "medium", levels: ["low", "medium"] } },
  });
  const setup = new GooseSetup(fake);
  const efforts = setup.efforts.bind(setup);
  vi.spyOn(setup, "efforts").mockImplementation((choice) =>
    fail ? Promise.reject(new Error("goose is busy")) : efforts(choice),
  );
  const { CreateThinking } = createTabs({ setup, ...unused });
  if (!CreateThinking) throw new Error("no Thinking field");
  render(
    <CreateThinking
      config={DEFAULT_CONFIG}
      disabled={false}
      onChange={() => undefined}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read goose's levels: goose is busy",
  );
  fail = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("Medium · Default"),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Try again" }),
  ).not.toBeInTheDocument();
});

it("reads Create agent's Thinking levels again when a setup check recovers", async () => {
  let fail = true;
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    thinking: { "": { current: "medium", levels: ["low", "medium"] } },
  });
  const setup = new GooseSetup(fake);
  const efforts = setup.efforts.bind(setup);
  const reads = vi
    .spyOn(setup, "efforts")
    .mockImplementation((choice) =>
      fail ? Promise.reject(new Error("goose is busy")) : efforts(choice),
    );
  const { CreateThinking } = createTabs({ setup, ...unused });
  if (!CreateThinking) throw new Error("no Thinking field");
  render(
    <CreateThinking
      config={DEFAULT_CONFIG}
      disabled={false}
      onChange={() => undefined}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read goose's levels: goose is busy",
  );
  const failedReads = reads.mock.calls.length;
  fail = false;
  // As the model field's Try again does.
  await act(() => setup.check());
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("Medium · Default"),
  );
  expect(reads.mock.calls.length).toBeGreaterThan(failedReads);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("splits Settings as the profile does: choices under Identity, the rest apart", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Gander",
    type: "buzz.goose/goose",
    owner: "a".repeat(64),
    config: { ...DEFAULT_CONFIG, provider: "anthropic" },
  } as Agent<Config>;
  const save = vi.fn(async (_config: Config) => undefined);
  const { rerender } = render(
    <SettingsTab agent={agent} save={save} settingsSection="identity" />,
  );
  expect(
    await screen.findByText("Set up Anthropic on the Settings tab."),
  ).toBeVisible();
  // The Model row stays, unavailable, and says why.
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  expect(screen.getByText("Available once Anthropic is set up.")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toBeVisible();
  expect(screen.queryByLabelText("Workspace")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Sessions" })).toBeNull();
  expect(screen.queryByLabelText("API key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  // Save shows only once there is something to save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

  rerender(<SettingsTab agent={agent} save={save} settingsSection="runtime" />);
  expect(await screen.findByLabelText("API key")).toBeVisible();
  expect(screen.getByRole("button", { name: "Test connection" })).toBeVisible();
  expect(screen.getByLabelText("Workspace")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Sessions" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  expect(screen.queryByLabelText("Instructions")).toBeNull();
});

it("says in Settings when goose cannot list providers, and tries again", async () => {
  let installed = false;
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup({
      ...fake,
      spawn: async (id, options) => {
        if (id === "goose" && !installed)
          throw new Error("No such file or directory (os error 2)");
        return fake.spawn(id, options);
      },
    }),
    ...unused,
  });
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: { ...DEFAULT_CONFIG, provider: "anthropic" },
        } as Agent<Config>
      }
      save={vi.fn(async (_config: Config) => undefined)}
      settingsSection="runtime"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /goose-acp is missing/,
  );
  expect(screen.queryByLabelText("API key")).toBeNull();
  installed = true;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("API key")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the providers shown when reading them again fails", async () => {
  let setup!: GooseSetup;
  created({
    spawn: (fake) => {
      setup = new GooseSetup(fake);
      return setup;
    },
  });
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toBeEnabled(),
  );
  await choose("Provider", "Anthropic");
  const key = await within(dialog).findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  // Saving reads the providers again, which fails.
  vi.spyOn(setup, "providers").mockRejectedValue(new Error("goose went away"));
  await userEvent.setup().type(key, "sk-test");
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Save" }));
  expect(within(dialog).getByText("goose went away")).toBeVisible();
  const provider = within(dialog).getByRole("combobox", { name: "Provider" });
  expect(provider).toBeEnabled();
  expect(provider).toHaveTextContent("Anthropic");
});

it("shows no other provider's models when a provider's models fail to load", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((entry) => ({ ...entry, configured: true })),
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved: new Map(),
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "models").mockImplementation(async (id) => {
    if (id === "databricks")
      return [{ id: "dbx-only-model", label: "dbx-only-model" }];
    throw new Error("Anthropic is down");
  });
  const { SettingsTab } = createTabs({ setup, ...unused });
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={async () => undefined}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Model:/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Other" }));
  expect(
    await screen.findByRole("menuitemradio", { name: "dbx-only-model" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}{Escape}");
  await choose("Provider", "Anthropic");
  expect(
    await screen.findByText("Could not list models: Anthropic is down"),
  ).toBeVisible();
  // The picker keeps its options mounted while closed, so look past hiding.
  expect(
    screen.queryByRole("menuitemradio", {
      name: "dbx-only-model",
      hidden: true,
    }),
  ).not.toBeInTheDocument();
});

it("reads a provider's models again after its fields are saved", async () => {
  const { fake } = created({
    spawn: (fake) => new GooseSetup(fake),
  });
  const user = userEvent.setup();
  const dialog = await openChoices();
  const listed = () =>
    fake.geese
      .flatMap((goose) => goose.received)
      .filter(
        (message) =>
          message.method === "_goose/unstable/providers/supported-models/list",
      ).length;
  await waitFor(() => expect(listed()).toBe(1));
  await user.type(
    within(dialog).getByRole("textbox", { name: /host/i }),
    "https://new.test",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(listed()).toBe(2));
});

it("says when the bundled goose-acp is missing, and tries again", async () => {
  let installed = false;
  created({
    spawn: (fake) =>
      new GooseSetup({
        ...fake,
        spawn: async (id, options) => {
          if (id === "goose" && !installed)
            throw new Error("No such file or directory (os error 2)");
          return fake.spawn(id, options);
        },
      }),
  });
  const dialog = await openChoices();
  expect(
    await within(dialog).findByText(/goose-acp is missing/),
  ).toBeInTheDocument();
  installed = true;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/goose-acp is missing/),
    ).not.toBeInTheDocument(),
  );
});

const ROOT = "1".repeat(64);
const GANDER = "c".repeat(64);

/** goose's history with sessions Gander ran in #general's thread, each
 * sending `Hi from goose` (s1) or `Hi from <id>`. */
function gooseHistory(ids: readonly string[] = ["s1"], page?: number) {
  const context = [
    "<context>",
    "Scope: thread",
    "Session scope: thread",
    "Channel: general (#chan)",
    `Thread root: ${ROOT}`,
    `Agent: ${GANDER}`,
    "</context>",
    "",
    '<buzz-event type="@mention">',
    "Content: @Gander what's up?",
    "</buzz-event>",
  ].join("\n");
  return fakeSpawn({
    home: "/home/test",
    ...(page ? { page } : {}),
    history: ids.map((sessionId) => ({
      sessionId,
      title: `Gander · #general · ${sessionId}`,
      cwd: "/home/test/.buzz",
      updatedAt: "2027-01-15T08:00:00Z",
      tags: { "buzz.agent": GANDER, "buzz.conversation": `chan/${ROOT}` },
      conversation: [
        {
          role: "user",
          created: 1_800_000_000,
          content: [{ type: "text", text: context }],
          metadata: { userVisible: true },
        },
        {
          role: "assistant",
          created: 1_800_000_001,
          content: [
            {
              type: "toolRequest",
              id: "t1",
              toolCall: {
                status: "success",
                value: {
                  name: "buzz__send",
                  arguments: {
                    text: `Hi from ${sessionId === "s1" ? "goose" : sessionId}`,
                    final: true,
                  },
                },
              },
            },
          ],
        },
      ],
    })),
  });
}

/** What the fake runtime holds for Gander; `change` shows its update. */
type World = {
  saved: ReturnType<GooseRuntime["conversations"]>;
  live?: ReturnType<GooseRuntime["sessions"]>;
  /** Every session kept with its prompt, oldest first, and how it started
   * when that was kept. */
  ids?: (
    | string
    | { id: string; at: number; title: string; conversation?: string | null }
  )[];
  names?: Record<string, string>;
  scope?: Config["scope"];
  /** Replaces parts of the fake runtime. */
  runtime?: Partial<Record<keyof GooseRuntime, unknown>>;
};

/** Gander's Activity tab over `world`. */
function activity(
  fake: ReturnType<typeof fakeSpawn>,
  world: World,
  history = new GooseHistory(fake),
  props: Partial<
    Parameters<ReturnType<typeof createTabs>["ActivityTab"]>[0]
  > = {},
) {
  const listeners = new Set<() => void>();
  // The runtime keeps one snapshot until its sessions change.
  let live = world.live ?? [];
  const runtime = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessions: () => live,
    conversations: () => world.saved,
    channelLabel: (_: string, id: string) =>
      world.names?.[id] ? { name: world.names[id], kind: "stream" } : undefined,
    prompts: () => ({
      shown: (turns: unknown) => turns,
      sessions: () =>
        (world.ids ?? []).map((id) =>
          typeof id === "string" ? { id } : { conversation: null, ...id },
        ),
    }),
    ...world.runtime,
  } as unknown as GooseRuntime;
  const { ActivityTab } = createTabs({
    setup: new GooseSetup(fake),
    runtime,
    history,
  });
  const rendered = render(
    <ActivityTab
      agent={
        {
          key: GANDER,
          pubkey: GANDER,
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: { ...DEFAULT_CONFIG, scope: world.scope ?? "thread" },
        } as Agent<Config>
      }
      {...props}
    />,
  );
  return {
    ...rendered,
    change(next: Partial<World>) {
      Object.assign(world, next);
      live = [...(world.live ?? [])];
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** The `session/list` requests goose was sent. */
const listings = (fake: ReturnType<typeof fakeSpawn>) =>
  fake.geese
    .flatMap((goose) => goose.received)
    .filter((message) => message.method === "session/list");

it("lists the agent's saved conversations and reads one's transcript by id, without searching goose", async () => {
  const fake = gooseHistory();
  activity(fake, { saved: [{ key: `chan/${ROOT}`, at: 1, sessions: ["s1"] }] });
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: "View transcript: chan · thread 11111111",
    }),
  );
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText(/@Gander what's up\?/).length).toBeGreaterThan(0);
  expect(listings(fake)).toEqual([]);
});

it("finds a conversation with no saved session by its goose tags", async () => {
  const fake = gooseHistory();
  const done = vi.fn();
  activity(fake, { saved: [] }, undefined, {
    conversation: { channelId: "chan", rootId: ROOT },
    initialTranscript: { opening: 1, done },
  });
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
  expect(done).toHaveBeenCalledTimes(1);
  expect(listings(fake).map((message) => message.params)).toEqual([
    {
      cwd: "/home/test/.buzz",
      _meta: {
        types: ["acp"],
        tags: { "buzz.agent": GANDER, "buzz.conversation": `chan/${ROOT}` },
      },
    },
  ]);
});

it("cancels reading goose's history when Activity is left", async () => {
  const fake = gooseHistory();
  const history = new GooseHistory(fake);
  let signal: AbortSignal | undefined;
  const transcript = vi
    .spyOn(history, "transcript")
    .mockImplementation((_, given) => {
      signal = given;
      return new Promise(() => {});
    });
  const { unmount } = activity(
    fake,
    { saved: [{ key: `chan/${ROOT}`, at: 1, sessions: ["s1"] }] },
    history,
  );
  await userEvent.setup().click(
    screen.getByRole("button", {
      name: "View transcript: chan · thread 11111111",
    }),
  );
  await waitFor(() => expect(transcript).toHaveBeenCalled());
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
});

it("lists conversations by channel name, with running and standalone sessions, one row each", async () => {
  const fake = gooseHistory(["s1", "timer"]);
  const old = (key: string, at: number) => ({ key, at, sessions: [] });
  const world: World = {
    saved: [old("a", 3), old("b", 2), old("c", 1)],
    live: [{ key: "running", busy: true, sessionId: "live", at: 4 }],
    ids: [
      // Started for a conversation: never a standalone row.
      { id: "s1", at: 1, title: "Gander · #b", conversation: "b" },
      { id: "timer", at: 1, title: "Gander · timer/t" },
      // Kept before where a session started was: never a standalone row.
      "live",
    ],
    names: { a: "general" },
  };
  activity(fake, world);
  const items = () =>
    screen.getAllByRole("listitem").map((item) => item.textContent);
  await waitFor(() => expect(items()).toHaveLength(5));
  expect(screen.getByText("general · channel")).toBeInTheDocument();
  expect(screen.getByText("running · channel")).toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "View transcript: timer/t" }));
  expect(
    await screen.findByText("Hi from timer", { selector: "summary span" }),
  ).toBeInTheDocument();
  expect(listings(fake)).toEqual([]);
});

it("lists a conversation with more than ten sessions once", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
  activity(gooseHistory(), {
    saved: [{ key: "chan", at: 20, sessions: ids.slice(0, 10) }],
    ids: [
      ...ids.slice(10).map((id, at) => ({
        id,
        at,
        title: "Gander · #chan",
        conversation: "chan",
      })),
      "legacy",
    ],
  });
  expect(
    screen
      .getAllByRole("listitem")
      .map((item) =>
        within(item).getByRole("button").getAttribute("aria-label"),
      ),
  ).toEqual(["View transcript: chan · channel"]);
});
it("follows the open conversation's newest session on Refresh", async () => {
  const fake = gooseHistory(["s1", "s2"]);
  const world: World = {
    saved: [{ key: `chan/${ROOT}`, at: 1, sessions: ["s1"] }],
  };
  const { change } = activity(fake, world);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: "View transcript: chan · thread 11111111",
    }),
  );
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
  change({ saved: [{ key: `chan/${ROOT}`, at: 2, sessions: ["s2", "s1"] }] });
  expect(
    await screen.findByText("Hi from s2", { selector: "summary span" }),
  ).toBeInTheDocument();
  expect(listings(fake)).toEqual([]);
});

it("finds a thread's conversation in its channel's saved session", async () => {
  const fake = gooseHistory();
  activity(
    fake,
    { saved: [{ key: "chan", at: 1, sessions: ["s1"] }] },
    undefined,
    {
      conversation: { channelId: "chan", rootId: ROOT },
      initialTranscript: { opening: 1, done: vi.fn() },
    },
  );
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
  expect(listings(fake)).toEqual([]);
});

it("opens a channel-scoped agent's channel from a thread, following its first save", async () => {
  const fake = gooseHistory();
  const { change } = activity(
    fake,
    { saved: [], scope: "channel" },
    undefined,
    {
      conversation: { channelId: "chan", rootId: ROOT },
      initialTranscript: { opening: 1, done: vi.fn() },
    },
  );
  // The thread's session is not the channel's.
  expect(
    await screen.findByText(/goose has no session for this conversation/),
  ).toBeInTheDocument();
  change({ saved: [{ key: "chan", at: 1, sessions: ["s1"] }] });
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
});

it("finds a thread-scoped agent's thread past an empty saved channel record", async () => {
  const fake = gooseHistory();
  activity(fake, { saved: [{ key: "chan", at: 1, sessions: [] }] }, undefined, {
    conversation: { channelId: "chan", rootId: ROOT },
    initialTranscript: { opening: 1, done: vi.fn() },
  });
  expect(
    await screen.findByText("Hi from goose", { selector: "summary span" }),
  ).toBeInTheDocument();
});

it("keeps a standalone run listed past a full page of saved conversations", () => {
  activity(gooseHistory(), {
    saved: Array.from({ length: 30 }, (_, at) => ({
      key: `chan${at}`,
      at,
      sessions: [`c${at}`],
    })),
    ids: [{ id: "timer1", at: 0, title: "Gander · timer/nightly" }],
  });
  expect(
    screen.getByRole("button", { name: "View transcript: timer/nightly" }),
  ).toBeInTheDocument();
});

it("lists the opened conversation's channel first, then every session newest first", () => {
  activity(
    gooseHistory(),
    {
      saved: [
        { key: "a", at: 4, sessions: ["a1"] },
        { key: "here/t1", at: 1, sessions: ["h1"] },
        { key: "b", at: 2, sessions: ["b1"] },
      ],
      ids: [
        { id: "x", at: 3, title: "Gander · timer/x" },
        { id: "y", at: 5, title: "Gander · timer/y" },
      ],
      names: { a: "a", b: "b", here: "here" },
    },
    undefined,
    { conversation: { channelId: "here", rootId: "t2" } },
  );
  expect(
    screen
      .getAllByRole("listitem")
      .map((item) =>
        within(item).getByRole("button").getAttribute("aria-label"),
      ),
  ).toEqual([
    "View transcript: here · thread t1",
    "View transcript: timer/y",
    "View transcript: a · channel",
    "View transcript: timer/x",
    "View transcript: b · channel",
  ]);
});

it("says when goose no longer has a conversation's saved sessions", async () => {
  const fake = gooseHistory([]);
  activity(fake, { saved: [{ key: "chan", at: 1, sessions: ["gone"] }] });
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "View transcript: chan · channel" }),
    );
  expect(
    await screen.findByText(/goose has no session for this conversation/),
  ).toBeInTheDocument();
});

it("edits Goose device defaults without creating an agent override", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((entry) => ({ ...entry, configured: true })),
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const save = await screen.findByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await choose("Provider", "Anthropic");
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  await userEvent.setup().click(save);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect((await setup.providers()).defaults).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
});

it("keeps Goose defaults open with the draft after a failed save", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "saveDefaults").mockRejectedValue(
    new Error("Goose config is read-only"),
  );
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const save = await screen.findByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.setup().click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Goose config is read-only",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(save).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent(
    "Databricks",
  );
});

it("shows and changes the device default from the compact control without stripping its ID", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((provider) =>
      provider.providerId === "databricks"
        ? {
            ...provider,
            providerId: "databricks_v2",
            models: [{ id: "goose-gpt-5-5" }],
          }
        : provider,
    ),
    defaults: { providerId: "databricks_v2", modelId: "goose-gpt-6" },
    supported: ["goose-gpt-6", "databricks-kimi-k2"],
  });
  const setup = new GooseSetup(fake);
  const { DefaultControl } = createTabs({ setup, ...unused });
  const configure = vi.fn();
  render(<DefaultControl onConfigure={configure} />);
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", {
    name: /^Goose default model:/,
  });
  await waitFor(() => expect(trigger).toBeEnabled());
  expect(trigger).toHaveTextContent("GPT-6");
  expect(trigger).not.toHaveTextContent("databricks-");
  await user.click(trigger);
  (await screen.findByRole("menuitem", { name: "Kimi" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Kimi K2" }),
  );
  await waitFor(() => expect(trigger).toHaveTextContent("Kimi K2"));
  expect((await setup.providers()).defaults.model).toBe("databricks-kimi-k2");
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit configuration" }),
  );
  expect(configure).toHaveBeenCalledOnce();
});

it("saves provider fields with defaults and retains them when saving fails", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  const saveKeys = vi
    .spyOn(setup, "save")
    .mockRejectedValueOnce(new Error("Could not save key"));
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const user = userEvent.setup();
  const host = await screen.findByRole("textbox", { name: "Host" });
  await user.type(host, "https://workspace.example");
  expect(screen.queryByRole("button", { name: "Save to goose" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save defaults" }));
  await screen.findByText("Could not save key");
  expect(host).toHaveValue("https://workspace.example");
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(saveKeys).toHaveBeenLastCalledWith("databricks", {
    DATABRICKS_HOST: "https://workspace.example",
  });
});

it("filters provider names with Search and selects a matching provider", async () => {
  const fake = fakeSpawn({ providers: PROVIDERS });
  const setup = new GooseSetup(fake);
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  render(<ProviderDialogBody onClose={vi.fn()} />);
  const trigger = await screen.findByRole("combobox", { name: "Provider" });
  await waitFor(() => expect(trigger).toBeEnabled());
  const user = userEvent.setup();
  await user.click(trigger);
  const input = await screen.findByRole("combobox", { name: "Search" });
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveValue("");
  await user.type(input, "anth");
  expect(
    await screen.findByRole("option", { name: "Anthropic" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Databricks" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Choose a provider" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Anthropic" }));
  expect(trigger).toHaveTextContent("Anthropic");
  expect(await screen.findByLabelText("API key")).toBeVisible();
});

it("keeps the creation menu open when its provider finishes loading", async () => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  created({
    spawn: (fake) => {
      const setup = new GooseSetup(fake);
      const providers = setup.providers.bind(setup);
      vi.spyOn(setup, "providers").mockImplementation(async () => {
        await ready;
        return providers();
      });
      return setup;
    },
  });
  await userEvent.setup().click(modelButton());
  expect(
    await screen.findByRole("menuitem", { name: "Edit configuration" }),
  ).toBeVisible();
  release();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
  expect(
    screen.getByRole("menuitem", { name: "Edit configuration" }),
  ).toBeVisible();
});

it("retries Goose default model discovery", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "models")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([{ id: "claude", label: "Claude" }]);
  const { DefaultControl } = createTabs({ setup, ...unused });
  render(<DefaultControl onConfigure={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("preserves Goose model inheritance when only thinking changes", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    supported: ["goose-claude"],
    thinking: { "goose-claude": { current: "low", levels: ["low", "high"] } },
  });
  const { CreateModel } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const onChange = vi.fn();
  render(
    <CreateModel
      config={DEFAULT_CONFIG}
      onChange={onChange}
      disabled={false}
    />,
  );
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent("Claude · Default"),
  );
  await waitFor(() => expect(modelButton()).toBeEnabled());
  fireEvent.click(modelButton());
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Claude" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: "", effort: "high" }),
  );
});

it("refreshes the Settings model and thinking after saving provider credentials", async () => {
  const saved = new Map<string, Set<string>>();
  const fake = fakeSpawn({
    providers: PROVIDERS,
    saved,
    thinking: { "": { current: "low", levels: ["low", "high"] } },
  });
  const setup = new GooseSetup(fake);
  const efforts = vi.spyOn(setup, "efforts");
  const { SettingsTab } = createTabs({ setup, ...unused });
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Gander",
    type: "buzz.goose/goose",
    owner: "a".repeat(64),
    config: { ...DEFAULT_CONFIG, provider: "anthropic" },
  } as Agent<Config>;
  render(<SettingsTab agent={agent} save={vi.fn()} />);
  const key = await screen.findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  await waitFor(() => expect(efforts).toHaveBeenCalled());
  const reads = efforts.mock.calls.length;
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  await userEvent.setup().type(key, "test-key");
  fireEvent.click(screen.getByRole("button", { name: "Save to goose" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
      "claude-sonnet-5-5 · Default",
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
  );
  await waitFor(() => expect(efforts.mock.calls.length).toBeGreaterThan(reads));
});

for (const host of ["defaults", "create"] as const) {
  it(`keeps keyboard recovery through Goose ${host} discovery failure and success`, async () => {
    const fake = fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
    });
    const setup = new GooseSetup(fake);
    let settle!: (value: { id: string; label: string }[]) => void;
    let fail!: (reason: Error) => void;
    vi.spyOn(setup, "models")
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = resolve;
            fail = reject;
          }),
      );
    // A recheck that never settles: retry feedback must not wait on it.
    vi.spyOn(setup, "check").mockReturnValue(new Promise(() => {}));
    const { DefaultControl, CreateModel } = createTabs({ setup, ...unused });
    render(
      host === "defaults" ? (
        <DefaultControl onConfigure={vi.fn()} />
      ) : (
        <CreateModel
          config={DEFAULT_CONFIG}
          onChange={vi.fn()}
          disabled={false}
        />
      ),
    );
    await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Try again" });
    const user = userEvent.setup();
    retry.focus();
    await user.keyboard("{Enter}");
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute("disabled");
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await act(async () => fail(new Error("still offline")));
    expect(retry).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("still offline");
    await user.keyboard("{Enter}");
    await act(async () => settle([{ id: "goose-claude", label: "Claude" }]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      screen.getByRole("button", {
        name: host === "defaults" ? /^Goose default model:/ : /^Goose model:/,
      }),
    ).toHaveFocus();
  });
}

it("keeps Goose default recovery focused where a recheck would need attention", async () => {
  const setup = new GooseSetup(
    fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
    }),
  );
  vi.spyOn(setup, "models")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([{ id: "goose-claude", label: "Claude" }]);
  render(<AgentDefaults agents={gooseDefaults(setup)} />);
  const retry = await screen.findByRole("button", { name: "Try again" });
  // A recheck would now settle on attention and replace the control.
  vi.spyOn(setup, "providers").mockRejectedValue(new Error("unreachable"));
  retry.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Goose default model:/ }),
    ).toHaveFocus(),
  );
  expect(setup.snapshot().readiness).toBe("ready");
});

it.each([false, true])(
  "preserves return focus through pending discovery (move focus: %s)",
  async (moveFocus) => {
    const supported = ["goose-claude", "goose-kimi-k2"];
    const fake = fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
      supported,
    });
    const setup = new GooseSetup(fake);
    const saveDefaults = setup.saveDefaults.bind(setup);
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const pendingSave = vi
      .spyOn(setup, "saveDefaults")
      .mockImplementationOnce(async (value) => {
        await saveGate;
        return saveDefaults(value);
      });
    render(
      <>
        <AgentDefaults agents={gooseDefaults(setup)} />
        <button type="button">Another setting</button>
      </>,
    );
    const trigger = await screen.findByRole("button", {
      name: /^Goose default model:/,
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    const user = userEvent.setup();
    await user.click(trigger);
    (await screen.findByRole("menuitem", { name: "Kimi" })).focus();
    await user.keyboard("{ArrowRight}");
    try {
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Kimi K2" }),
      );
      await waitFor(() => expect(pendingSave).toHaveBeenCalledOnce());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(trigger).toHaveAccessibleName("Goose default model: Claude");
      expect(trigger).not.toHaveAttribute("disabled");
      expect(trigger).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("menu")).toBeNull();
      if (moveFocus)
        await user.click(
          screen.getByRole("button", { name: "Another setting" }),
        );
    } finally {
      await act(async () => releaseSave());
    }
    await waitFor(() => expect(trigger).toHaveTextContent("Kimi K2"));
    expect(trigger).toBeInTheDocument();
    await waitFor(() =>
      expect(
        moveFocus
          ? screen.getByRole("button", { name: "Another setting" })
          : trigger,
      ).toHaveFocus(),
    );
    await user.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit configuration" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Goose" });
    await user.type(
      await within(dialog).findByRole("textbox", { name: "Host" }),
      "https://new-workspace.example",
    );
    supported.splice(0, supported.length, "goose-gpt-6");
    const discover = setup.models.bind(setup);
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discovery = vi
      .spyOn(setup, "models")
      .mockImplementation(async (provider) => {
        await discoveryGate;
        return discover(provider);
      });
    const save = within(dialog).getByRole("button", { name: "Save defaults" });
    await waitFor(() => expect(save).toBeEnabled());
    const transitions: string[] = [];
    const unsubscribe = setup.subscribe(() =>
      transitions.push(setup.snapshot().readiness),
    );
    try {
      await userEvent.setup().click(save);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(transitions).toContain("checking");
      expect(transitions).toContain("ready");
      expect(trigger).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^Goose default model:/ }),
        ).toHaveFocus(),
      );
      expect(discovery).toHaveBeenCalled();
      expect(trigger).not.toHaveAttribute("disabled");
      expect(trigger).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("menu")).toBeNull();
      if (moveFocus)
        await user.click(
          screen.getByRole("button", { name: "Another setting" }),
        );
    } finally {
      unsubscribe();
      await act(async () => releaseDiscovery());
    }
    await waitFor(() =>
      expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(
      moveFocus
        ? screen.getByRole("button", { name: "Another setting" })
        : trigger,
    ).toHaveFocus();
    await user.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "OpenAI" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  },
);

it("shows the good saved records when others are damaged", () => {
  const data = new Map<string, string>([
    [
      "buzz.goose.sessions.v1",
      JSON.stringify({
        [GANDER]: {
          chan: { at: 2, sessions: ["s1", 7, "s1"] },
          broken: { at: 3, sessions: { not: "a list" } },
          nulled: null,
          stringy: { at: 4, sessions: "s9" },
          other: { at: "soon" },
          far: { at: 1e20, sessions: ["s8"] },
        },
      }),
    ],
  ]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const items = new Map<string, string>([
    [
      `${PROMPTS_PREFIX}goose:${GANDER}`,
      JSON.stringify({
        version: 1,
        texts: [],
        sessions: [
          [
            "timer1",
            [],
            { at: 5, title: "Gander · timer/nightly", conversation: null },
          ],
          ["bad", [], { at: 6, title: 42 }],
          [
            "far",
            [],
            { at: 1e20, title: "Gander · timer/far", conversation: null },
          ],
          [null, []],
          "junk",
        ],
      }),
    ],
  ]);
  const prompts = sessionPrompts(
    localStore({
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
    }),
    "goose",
    GANDER,
  );
  activity(gooseHistory(), {
    saved: [],
    runtime: {
      conversations: () =>
        localSessions(storage, GANDER)
          .list()
          .map(([key, { at, sessions = [] }]) => ({ key, at, sessions })),
      prompts: () => prompts,
    },
  });
  expect(
    screen
      .getAllByRole("listitem")
      .map((item) =>
        within(item).getByRole("button").getAttribute("aria-label"),
      ),
  ).toEqual([
    "View transcript: timer/nightly",
    "View transcript: chan · channel",
  ]);
});

it.each([
  [{ providerId: "", modelId: "" }, false],
  [{ providerId: "databricks", modelId: "" }, false],
  [{ providerId: "", modelId: "goose-claude" }, false],
  [{ providerId: "databricks", modelId: "goose-claude" }, true],
] as const)(
  "reports Goose connection readiness from resolved defaults %j",
  async (defaults, expected) => {
    const onReadyChange = vi.fn();
    const { setup } = created({ defaults, onReadyChange });
    await act(async () => {
      await setup.providers();
    });
    await waitFor(() =>
      expect(onReadyChange).toHaveBeenLastCalledWith(expected),
    );
  },
);
