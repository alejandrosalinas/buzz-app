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
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { AgentTabs } from "../agents/AgentTabs";
import { type Config, DEFAULT_CONFIG, type Place } from "./runtime";
import { type Provider, type Providers, PiSetup } from "./setup";
import { PiStopped } from "./pi";
import { createTabs } from "./tabs";
import { piTurns } from "./transcript";

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

const MODELS: Record<
  string,
  { id: string; name: string; thinking: string[] }[]
> = {
  anthropic: [
    { id: "claude-x", name: "Claude X", thinking: ["off", "high"] },
    { id: "claude-o", name: "Claude O", thinking: ["off"] },
  ],
  openai: [{ id: "gpt-x", name: "GPT X", thinking: ["off", "low"] }],
};

/** The Pi host's answers to setup's requests; `fail` makes one throw. */
function fakePi(
  fail: Partial<Record<string, string>> = {},
  defaults: Providers["defaults"] = {
    provider: "anthropic",
    model: "claude-x",
  },
) {
  const providers: Provider[] = [
    {
      id: "anthropic",
      name: "Anthropic",
      key: true,
      signsIn: true,
      configured: "auth.json",
    },
    { id: "openai", name: "OpenAI", key: true, signsIn: false },
    { id: "copilot", name: "GitHub Copilot", key: false, signsIn: true },
  ];
  const request = vi.fn(
    async (method: string, params: Record<string, string> = {}) => {
      const failure = fail[method];
      if (failure) throw new Error(failure);
      if (method === "providers")
        return {
          providers: providers.map((item) => ({ ...item })),
          defaults,
        };
      if (method === "models") return MODELS[params.provider ?? ""] ?? [];
      if (method === "login") {
        const index = providers.findIndex(
          (item) => item.id === params.provider,
        );
        const found = providers[index];
        if (found) providers[index] = { ...found, configured: "auth.json" };
        return {};
      }
      if (method === "test")
        return { ok: true, message: `Connected to ${params.model}` };
      throw new Error(`Unexpected ${method}`);
    },
  );
  type Request = ConstructorParameters<typeof PiSetup>[0]["request"];
  return { request: request as unknown as Request, calls: request };
}

/** The runtime's conversations: a thread Pi works in, in a channel the
 * community lists, and a channel it does not. */
function fakeRuntime() {
  const places: Place[] = [
    {
      key: "chan/root",
      conversation: 1,
      channelId: "chan",
      root: "root",
      at: 2_000,
    },
    { key: "other", conversation: 2, channelId: "other", at: 1_000 },
  ];
  const labels = new Map<string, ChannelLabel>([
    ["chan", { name: "general", channelType: "stream" }],
  ]);
  const listeners = new Set<() => void>();
  const working = [1];
  return {
    places: vi.fn(async () => places),
    working: () => working,
    subscribe: () => () => {},
    channelLabel: (_agent: string, channelId: string) => labels.get(channelId),
    subscribeChannels: (_agent: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The community's channel list changed: these channels read so now. */
    relabel(changes: Readonly<Record<string, ChannelLabel>>) {
      for (const [id, label] of Object.entries(changes)) labels.set(id, label);
      for (const listener of listeners) listener();
    },
    transcript: vi.fn(async (_agent: string, place: Place) => ({
      turns: piTurns(
        [
          {
            id: 1,
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: `Hello from ${place.key}`,
                timestamp: 1,
              },
            ],
          },
          {
            id: 2,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Hi there" }],
                timestamp: 2,
              },
            ],
          },
        ],
        place,
        true,
      ),
      more: false,
    })),
  };
}

function created(pi = fakePi(), modelAppearance?: "glass-ghost") {
  const { Create, CreateModel } = createTabs({
    setup: new PiSetup(pi),
    runtime: fakeRuntime(),
  });
  const changes: Config[] = [];
  function Harness() {
    const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
    const onChange = (next: Config) => {
      changes.push(next);
      setConfig(next);
    };
    // As New agent shows them: the Model row, then the type's own choices.
    return (
      <>
        <CreateModel
          config={config}
          disabled={false}
          onChange={onChange}
          {...(modelAppearance && { modelAppearance })}
        />
        <Create config={config} disabled={false} onChange={onChange} />
      </>
    );
  }
  render(<Harness />);
  return { pi, changes };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const modelButton = () =>
  screen.getByRole("button", { name: /^Model: (Pi default|Choose a|GPT X)/ });

/** Opens the provider dialog from the Model field. */
async function openChoices() {
  await userEvent.setup().click(modelButton());
  return screen.findByRole("dialog", { name: "Provider and model" });
}

it.each([undefined, "glass-ghost"] as const)(
  "starts Model on Pi's default with appearance %s, with the provider kept to its dialog",
  async (appearance) => {
    created(fakePi(), appearance);
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
    await waitFor(() =>
      expect(modelButton()).toHaveTextContent(
        "Pi default (Anthropic · Claude X)",
      ),
    );
    // Pi's mark, then the provider's.
    expect(modelButton().querySelectorAll("svg")).toHaveLength(2);
    expect(modelButton()).toHaveAttribute("aria-haspopup", "dialog");
    expect(modelButton()).toHaveAttribute(
      "data-variant",
      appearance ?? "outline",
    );
    expect(screen.getByLabelText("Instructions Optional")).toBeVisible();
  },
);

it("saves a provider's key with Pi's login, needs a model for it, and tests it", async () => {
  const { pi, changes } = created();
  const user = userEvent.setup();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("From Pi settings (Anthropic)"),
  );
  expect(within(dialog).getByText("Anthropic is set up in Pi.")).toBeVisible();

  // Providers Buzz has a mark for show it.
  await user.click(within(dialog).getByRole("combobox", { name: "Provider" }));
  const anthropic = await screen.findByRole("option", { name: /^Anthropic/ });
  expect(anthropic.querySelector("svg")).not.toBeNull();
  const copilot = screen.getByRole("option", { name: "GitHub Copilot" });
  expect(copilot.querySelector("svg")).toBeNull();
  await user.click(screen.getByRole("option", { name: "OpenAI" }));
  const key = await within(dialog).findByLabelText("API key");
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "sk-test");
  await user.click(within(dialog).getByRole("button", { name: "Save to Pi" }));
  await waitFor(() =>
    expect(within(dialog).getByText("OpenAI is set up in Pi.")).toBeVisible(),
  );
  expect(pi.calls).toHaveBeenCalledWith("login", {
    provider: "openai",
    key: "sk-test",
  });

  // Pi's settings give no model for a provider they do not name.
  const use = within(dialog).getByRole("button", { name: "Use" });
  expect(use).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByText(
      "Pi's settings name no model for OpenAI. Choose one.",
    ),
  ).toBeVisible();
  await choose("Model", "GPT X");
  await user.click(
    within(dialog).getByRole("button", { name: "Test connection" }),
  );
  expect(await within(dialog).findByRole("status")).toHaveTextContent(
    "Connected to gpt-x",
  );
  expect(pi.calls).toHaveBeenCalledWith("test", {
    provider: "openai",
    model: "gpt-x",
  });
  // Nothing reaches the agent until the choice is used.
  expect(changes).toEqual([]);
  await user.click(use);
  expect(changes.at(-1)).toMatchObject({ provider: "openai", model: "gpt-x" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(modelButton()).toHaveTextContent("GPT X"));
  expect(modelButton().querySelectorAll("svg")).toHaveLength(2);
});

it("sends a provider that signs in without a key to the pi command", async () => {
  created();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toBeEnabled(),
  );
  await choose("Provider", "GitHub Copilot");
  expect(
    within(dialog).getByText(/GitHub Copilot signs in through Pi/),
  ).toBeVisible();
  expect(within(dialog).queryByLabelText("API key")).toBeNull();
});

it("says why Pi could not start, and tries again", async () => {
  const fail: Record<string, string> = {
    providers:
      "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
  };
  created(fakePi(fail));
  const dialog = await openChoices();
  expect(
    await within(dialog).findByText(/Pi needs Node\.js 22\.19 or later/),
  ).toBeVisible();
  delete fail.providers;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("From Pi settings (Anthropic)"),
  );
  // The card and its dialog read Pi's providers once, so neither still fails.
  expect(screen.queryByText(/Pi needs Node\.js/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("reads Pi's providers again when the window gets focus, after a change in the pi command", async () => {
  const defaults = { provider: "anthropic", model: "claude-x" };
  created(fakePi({}, defaults));
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent(
      "Pi default (Anthropic · Claude X)",
    ),
  );
  // As /login and /model in the pi command leave Pi's files.
  Object.assign(defaults, { provider: "openai", model: "gpt-x" });
  fireEvent.focus(window);
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent("Pi default (OpenAI · GPT X)"),
  );
});

it("says when Pi has no provider for the choice", async () => {
  created(fakePi({}, { provider: "databricks", model: "databricks-x" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Pi has no provider databricks",
  );
  // Only Pi's mark: Buzz has none for this provider.
  expect(modelButton().querySelectorAll("svg")).toHaveLength(1);
  const dialog = await openChoices();
  const provider = within(dialog).getByRole("combobox", {
    name: "Provider",
  });
  await waitFor(() => expect(provider).toBeEnabled());
  expect(provider).toHaveAccessibleDescription(
    /databricks isn't one of Pi's built-in providers, and no Pi package Buzz loaded adds it/,
  );
  const use = within(dialog).getByRole("button", { name: "Use" });
  expect(use).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();

  await choose("Provider", "Anthropic");
  expect(provider).not.toHaveAccessibleDescription(/built-in providers/);
  await choose("Model", "Claude X");
  expect(use).not.toHaveAttribute("aria-disabled", "true");
});

const AGENT = {
  key: "c".repeat(64),
  pubkey: "c".repeat(64),
  name: "pii",
  type: "buzz.pi/pi",
  owner: "a".repeat(64),
  config: DEFAULT_CONFIG,
} as Agent<Config>;

it("keeps Try again's providers for what the dialog's Use allows", async () => {
  const fail: Record<string, string> = { providers: "Pi stopped" };
  created(fakePi(fail, { provider: "databricks", model: "databricks-x" }));
  const dialog = await openChoices();
  expect(await within(dialog).findByText("Pi stopped")).toBeVisible();
  delete fail.providers;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveAccessibleDescription(/databricks isn't one/),
  );
  expect(within(dialog).getByRole("button", { name: "Use" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("guards an invalid Pi provider draft through an agent tab switch", async () => {
  const user = userEvent.setup();
  const { SettingsTab } = createTabs({
    setup: new PiSetup(fakePi()),
    runtime: fakeRuntime(),
  });
  const save = vi.fn(async () => {});
  const agent: Agent<Config> = {
    ...AGENT,
    place: "here",
    relay: "wss://example.com",
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  };
  const type = {
    key: AGENT.type,
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
    ],
  } as unknown as RegisteredAgentType;
  render(
    <AgentTabs
      agents={
        {
          save,
          subscribe: () => () => {},
          memberships: () => [],
          configHistory: () => undefined,
          addedTabs: () => [],
          registerTab: () => {},
          controlAttention: () => {},
        } as unknown as Agents
      }
      agent={agent}
      type={type}
      channels={[]}
      settingsHost={{}}
      memories={undefined}
      settingsContent={null}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("Anthropic"),
  );
  await choose("Provider", "OpenAI");
  expect(
    await screen.findByText(
      "Pi's settings name no model for OpenAI. Choose one.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent(
    "OpenAI",
  );
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("Anthropic"),
  );
  expect(save).not.toHaveBeenCalled();
});

it("shows the provider, model and thinking level in Identity, and the provider's setup in Settings", async () => {
  const { SettingsTab } = createTabs({
    setup: new PiSetup(fakePi()),
    runtime: fakeRuntime(),
  });
  const save = vi.fn(async () => {});
  // As the agent's profile shows it: one form, a section at a time.
  const { rerender } = render(
    <SettingsTab agent={AGENT} save={save} settingsSection="identity" />,
  );
  const provider = screen.getByRole("combobox", { name: "Provider" });
  await waitFor(() => expect(provider).toHaveTextContent("Anthropic"));
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  // Pi's medium is high on a model without it.
  await waitFor(() => expect(thinking).toHaveTextContent("High"));
  expect(screen.getByLabelText("Instructions")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  expect(screen.queryByText("Anthropic is set up in Pi.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

  await choose("Thinking", "High");
  // A level the new model doesn't have goes back to Pi's.
  await choose("Model", "Claude O");
  expect(thinking).toHaveTextContent("Off");
  await choose("Model", "Claude X");
  await choose("Thinking", "Off");

  rerender(<SettingsTab agent={AGENT} save={save} settingsSection="runtime" />);
  expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
  expect(screen.getByText("Anthropic is set up in Pi.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Test connection" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-x",
    effort: "off",
  });
});

it("saves a key on Enter without saving the agent's settings", async () => {
  const pi = fakePi();
  const { SettingsTab } = createTabs({
    setup: new PiSetup(pi),
    runtime: fakeRuntime(),
  });
  const save = vi.fn();
  render(<SettingsTab agent={AGENT} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeEnabled(),
  );
  await choose("Provider", "OpenAI");
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("API key"), "sk-test{Enter}");
  expect(await screen.findByText("OpenAI is set up in Pi.")).toBeVisible();
  expect(pi.calls).toHaveBeenCalledWith("login", {
    provider: "openai",
    key: "sk-test",
  });
  expect(save).not.toHaveBeenCalled();
});

it("settles a transcript request without opening it once Pi's late listing arrives", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  const done = vi.fn();
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "chan", rootId: "root" }}
      initialTranscript={{ opening: 1, done }}
    />,
  );
  expect(done).toHaveBeenCalled();
  const here = await screen.findByRole("region", { name: "This thread" });
  expect(
    within(here).getByRole("button", { name: /^View transcript/ }),
  ).toBeVisible();
  expect(runtime.transcript).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Hello from chan/root", { selector: "summary span" }),
  ).toBeNull();
});

it("shows a channel's lock as soon as the community makes it private, without reading Pi again", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  render(<ActivityTab agent={AGENT} />);
  const name = await screen.findByTitle("general · thread root");
  expect(name.querySelector("svg")).toHaveClass("tabler-icon-hash");

  act(() => {
    runtime.relabel({
      chan: { name: "general", channelType: "stream", private: true },
    });
  });
  expect(
    screen.getByTitle("general · thread root").querySelector("svg"),
  ).toHaveClass("tabler-icon-lock");
  expect(runtime.places).toHaveBeenCalledTimes(1);
  expect(runtime.transcript).not.toHaveBeenCalled();
});

it("relabels the opened-from channel too when the thread has no Pi conversation of its own", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "other", rootId: "zzz" }}
    />,
  );
  // The thread has no conversation: the channel's stands in for it.
  const here = await screen.findByRole("region", { name: "This thread" });
  await waitFor(() =>
    expect(
      within(here).getByRole("button", { name: "View transcript: other" }),
    ).toBeInTheDocument(),
  );
  expect(here.querySelector("svg")).toBeNull();

  act(() => {
    runtime.relabel({
      other: { name: "secret", channelType: "stream", private: true },
    });
  });
  const name = within(here).getByTitle("secret");
  expect(name.querySelector("svg")).toHaveClass("tabler-icon-lock");
  expect(
    within(here).getByRole("button", { name: "View transcript: secret" }),
  ).toBeInTheDocument();
  expect(runtime.places).toHaveBeenCalledTimes(1);
});

it("lists Pi's conversations in the Activity tab, and shows a transcript", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "chan", rootId: "root" }}
    />,
  );
  const user = userEvent.setup();
  const here = await screen.findByRole("region", { name: "This thread" });
  expect(here).toHaveTextContent("general");
  expect(here.querySelector("svg")).toHaveClass("tabler-icon-hash");
  expect(here).toHaveTextContent("Working");
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [expect.stringMatching(/^otherChannel · /)],
  );
  // Unlisted, its kind is unknown: no icon claims one.
  expect(screen.getByTitle("other · channel").querySelector("svg")).toBeNull();

  await user.click(
    within(here).getByRole("button", { name: /^View transcript/ }),
  );
  expect(
    await screen.findByText("Hello from chan/root", {
      selector: "summary span",
    }),
  ).toBeVisible();
  expect(
    screen.getByText("Hi there", { selector: "summary span" }),
  ).toBeVisible();
  expect(runtime.transcript).toHaveBeenLastCalledWith(
    "c".repeat(64),
    expect.objectContaining({ conversation: 1 }),
    true,
    expect.any(AbortSignal),
  );
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(
    within(screen.getByRole("listitem")).getByRole("button", {
      name: "View transcript: other · channel",
    }),
  );
  expect(
    await screen.findByText("Hello from other", { selector: "summary span" }),
  ).toBeVisible();

  // A refresh that fails says so, and keeps the transcript it has.
  runtime.transcript.mockRejectedValueOnce(new Error("Pi stopped"));
  await user.click(screen.getByRole("button", { name: "Refresh transcript" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read the Pi conversation: Pi stopped",
  );
  expect(
    screen.getByText("Hello from other", { selector: "summary span" }),
  ).toBeVisible();
});

it("retries a stopped Pi's transcript read only once the window shows", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "chan", rootId: "root" }}
    />,
  );
  const user = userEvent.setup();
  const here = await screen.findByRole("region", { name: "This thread" });
  await user.click(
    within(here).getByRole("button", { name: /^View transcript/ }),
  );
  await screen.findByText("Hello from chan/root", { selector: "summary span" });
  const reads = runtime.transcript.mock.calls.length;
  runtime.transcript.mockRejectedValueOnce(new PiStopped("Pi stopped"));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Refresh transcript" }));
  // Past the first backoff, hidden: no new read starts another host.
  await act(() => new Promise((resolve) => setTimeout(resolve, 1200)));
  expect(runtime.transcript).toHaveBeenCalledTimes(reads + 1);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() =>
    expect(runtime.transcript).toHaveBeenCalledTimes(reads + 2),
  );
  hidden.mockRestore();
});

it.each([
  [{}, false],
  [{ provider: "anthropic" }, false],
  [{ model: "claude-x" }, false],
  [{ provider: "anthropic", model: "claude-x" }, true],
] as const)(
  "reports Pi connection readiness from resolved defaults %j",
  async (defaults, expected) => {
    const pi = fakePi({}, defaults);
    const setup = new PiSetup(pi);
    const { CreateModel } = createTabs({ setup, runtime: fakeRuntime() });
    const onReadyChange = vi.fn();
    render(
      <CreateModel
        config={DEFAULT_CONFIG}
        onChange={vi.fn()}
        onReadyChange={onReadyChange}
        disabled={false}
      />,
    );
    await act(async () => {
      await setup.providers();
    });
    await waitFor(() =>
      expect(onReadyChange).toHaveBeenLastCalledWith(expected),
    );
  },
);
