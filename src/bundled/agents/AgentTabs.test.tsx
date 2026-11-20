// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentMemories } from "../../features/agents/memory";
import type {
  Agent,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import { useId, useLayoutEffect, useState } from "react";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentTabs } from "./AgentTabs";
import { useAgentSettingsHost } from "./AgentSettingsHost";

afterEach(cleanup);

function DraftSettings({
  agent,
  save,
  settingsSection,
  settingsHost,
  settingsContent,
}: AgentViewProps<{ reply: string }>) {
  const form = useId();
  const [value, setValue] = useState(agent.config.reply);
  const [saved, setSaved] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      id={form}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await save({ reply: value });
          setSaved(value);
        } catch {
          setError("Save failed");
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        {settingsSection === "runtime" ? "Workspace" : "Instructions"}
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {settingsSection !== "identity" && settingsContent}
      <AgentSaveButton
        form={form}
        disabled={
          value === "Invalid" || (value === saved && !settingsHost?.pendingSave)
        }
        dirty={value !== saved || Boolean(settingsHost?.pendingSave)}
        saving={saving}
      />
    </form>
  );
}

function editingFixture(split: boolean, save = vi.fn(async () => {})) {
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    name: "Ada",
    place: "here",
    type: "test",
    owner: "c".repeat(64),
    relay: "wss://example.com",
    config: { reply: "Saved" },
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: split,
        component: DraftSettings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const props = {
    agents: {
      save,
      subscribe: () => () => {},
      classifier: () => "unavailable",
      memberships: () => [],
      configHistory: () => undefined,
      addedTabs: () => [],
      registerTab: () => {},
      controlAttention: () => {},
    } as unknown as Agents,
    agent,
    type,
    channels: [],
    settingsHost: {},
    memories: undefined,
    settingsContent: <p>Agent settings</p>,
  };
  return { props, save };
}

it.each(["here", "hosted"] as const)(
  "does not duplicate management content as Identity for %s agents without a settings tab",
  async (place) => {
    const { props } = editingFixture(false);
    const view = render(
      <AgentTabs
        {...props}
        agent={{ ...props.agent, place }}
        type={undefined}
      />,
    );
    for (const type of [undefined, { ...props.type, tabs: [] }]) {
      view.rerender(
        <AgentTabs {...props} agent={{ ...props.agent, place }} type={type} />,
      );
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
        "Memory",
        "Settings",
      ]);
      expect(screen.queryByRole("tab", { name: "Identity" })).toBeNull();
    }
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getAllByText("Agent settings")).toHaveLength(1);
  },
);

it("keeps a host-only Identity tab limited to its existing controls", () => {
  const { props } = editingFixture(false);
  render(
    <AgentTabs
      {...props}
      type={undefined}
      settingsHost={{ typeControl: () => <p>Provider control</p> }}
    />,
  );
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Provider control")).toBeVisible();
  expect(screen.queryByText("Agent settings")).toBeNull();
});

it.each([false, true])(
  "confirms before discarding a section draft (split %s)",
  async (split) => {
    const user = userEvent.setup();
    const { props, save } = editingFixture(split);
    const discard = vi.fn();
    render(<AgentTabs {...props} onDiscard={discard} />);
    await user.type(
      screen.getByRole("textbox", { name: "Instructions" }),
      " draft",
    );
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved changes will be lost",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(discard).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved");
    if (split) {
      await user.type(screen.getByRole("textbox"), " again");
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(screen.getByRole("textbox", { name: "Workspace" })).toHaveValue(
        "Saved",
      );
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    }
  },
);

it("warns before discarding edits even when validation disables Save", async () => {
  const user = userEvent.setup();
  const { props } = editingFixture(true);
  render(<AgentTabs {...props} />);
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "Invalid");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox")).toHaveValue("Invalid");
});

it.each([false, true])(
  "guards a version-address tab request without losing a draft (split %s)",
  async (split) => {
    const user = userEvent.setup();
    const { props } = editingFixture(split);
    const discard = vi.fn();
    const view = render(<AgentTabs {...props} onDiscard={discard} />);
    await user.type(screen.getByRole("textbox"), " draft");
    const requested = <AgentTabs {...props} showSettings onDiscard={discard} />;
    view.rerender(requested);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Discard changes?",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    view.rerender(requested);
    await user.type(screen.getByRole("textbox"), " again");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    view.rerender(<AgentTabs {...props} onDiscard={discard} />);
    view.rerender(requested);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(discard).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved");
  },
);

it("guards a version request while the host has a staged harness change", async () => {
  const { props } = editingFixture(false);
  const discard = vi.fn();
  const pending = { ...props, settingsHost: { pendingSave: vi.fn() } };
  const view = render(<AgentTabs {...pending} onDiscard={discard} />);
  view.rerender(<AgentTabs {...pending} showSettings onDiscard={discard} />);
  expect(await screen.findByRole("alertdialog")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(discard).not.toHaveBeenCalled();
});

it("keeps a saving section mounted, then permits discarding after a failed save", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const { props } = editingFixture(
    true,
    vi.fn(() => pending),
  );
  const view = render(<AgentTabs {...props} />);
  await user.type(screen.getByRole("textbox"), " draft");
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    view.rerender(<AgentTabs {...props} showSettings />);
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    await act(async () => {
      reject(new Error("Save failed"));
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
});

it("discards a staged harness change together with the section draft", async () => {
  const user = userEvent.setup();
  const { props } = editingFixture(false);
  const type = { ...props.type, key: "test", title: "Original" };
  // The source form exposes the host's harness selector alongside its draft.
  type.tabs = [
    {
      id: "settings",
      title: "Settings",
      role: "settings",
      component: ({ settingsHost }) => (
        <>{settingsHost?.typeControl?.(false)}</>
      ),
    },
  ];
  const next = { ...type, key: "next", title: "Next" };
  const retype = vi.fn();
  const agents = {
    ...props.agents,
    retype,
    previewRetype: () => ({ config: {}, moved: [], dropped: [], settings: [] }),
  } as unknown as Agents;
  function Host() {
    const settings = useAgentSettingsHost({
      agents,
      agent: props.agent,
      type,
      types: [type, next],
    });
    return (
      <AgentTabs
        {...props}
        agents={agents}
        agent={settings.agent}
        type={settings.type}
        settingsHost={settings.settingsHost}
        onDiscard={settings.discard}
      />
    );
  }
  render(<Host />);
  await user.click(
    screen.getByRole("button", { name: "Change harness from Original" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Next" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Next" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Original" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(retype).not.toHaveBeenCalled();
});

it.each(["here", "hosted"] as const)(
  "unmounts Memory on leaving, shows its kept listing on return and reads fresh memories for agents %s",
  async (place) => {
    const user = userEvent.setup();
    let body = "Original memory";
    let answer: (() => void) | undefined;
    const read = vi.fn(async () => {
      const listing = {
        entries: [
          { slug: "core", body, eventId: "b".repeat(64), createdAt: 1 },
        ],
        partial: false,
      };
      if (read.mock.calls.length > 1)
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
      return listing;
    });
    const owner = createAgentMemories(read, "c".repeat(64), () => true);
    const agent: Agent = {
      key: "a".repeat(64),
      pubkey: "a".repeat(64),
      name: "Ada",
      place,
      type: "test",
      owner: "c".repeat(64),
      relay: "wss://example.com",
      config: {},
      attention: {},
      skipped: {},
      timers: {},
      attentionEnabled: true,
    };
    render(
      <AgentTabs
        agents={
          {
            save: vi.fn(),
            subscribe: () => () => {},
            memberships: () => [],
            configHistory: () => undefined,
            addedTabs: () => [],
            registerTab: () => {},
            controlAttention: () => {},
          } as unknown as Agents
        }
        agent={agent}
        type={undefined}
        channels={[]}
        memories={owner.capability}
        settingsHost={{ typeControl: () => <p>Provider</p> }}
        settingsContent={<p>Agent settings</p>}
      />,
      { wrapper: ToastProvider },
    );
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Attention" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    // A closed memory's body is not rendered; open core to read it.
    await user.click(await screen.findByRole("button", { name: "core" }));
    expect(await screen.findByText("Original memory")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("button", { name: "Memory scope: example.com" }),
    ).toHaveLength(place === "here" ? 0 : 2);
    expect(read).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.queryByText("Original memory")).not.toBeInTheDocument();
    // All four session slots are available again while Memory is inactive.
    const otherViews = [];
    try {
      for (let index = 0; index < 4; index++) {
        otherViews.push(owner.capability.open(agent.pubkey));
      }
      expect(otherViews).toHaveLength(4);
    } finally {
      for (const view of otherViews) view.dispose();
    }
    body = "Updated memory";
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    // Within 30 seconds the kept listing shows before the relay answers,
    // and it is read again.
    await user.click(await screen.findByRole("button", { name: "core" }));
    expect(await screen.findByText("Original memory")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => answer?.());
    expect(await screen.findByText("Updated memory")).toBeInTheDocument();
    expect(screen.queryByText("Original memory")).not.toBeInTheDocument();
  },
);

it("leaves History out of the agent page tabs", () => {
  const agent: Agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    name: "Ada",
    place: "here",
    type: "test",
    owner: "c".repeat(64),
    relay: "wss://example.com",
    config: {},
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  };
  const history = { read: async () => [], sides: [], revise: vi.fn() };
  render(
    <AgentTabs
      agents={
        {
          save: vi.fn(),
          configHistory: () => history,
          addedTabs: () => [],
          registerTab: () => {},
          controlAttention: () => {},
          snapshot: () => ({ agents: [agent] }),
          subscribe: () => () => {},
        } as unknown as Agents
      }
      agent={agent}
      type={undefined}
      channels={[]}
      memories={undefined}
      settingsHost={{ typeControl: () => <p>Provider</p> }}
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    screen.queryByRole("tab", { name: "History" }),
  ).not.toBeInTheDocument();
});

it("places plugin tabs after Activity and before Settings", () => {
  const { props } = editingFixture(true);
  const Page = () => <p />;
  render(
    <AgentTabs
      {...props}
      type={
        {
          tabs: [
            ...(props.type as unknown as { tabs: unknown[] }).tabs,
            {
              id: "activity",
              title: "Activity",
              role: "activity",
              component: Page,
            },
          ],
        } as unknown as RegisteredAgentType
      }
      agents={
        {
          ...props.agents,
          addedTabs: () => [
            {
              id: "watching",
              key: "buzz.watching/watching",
              pluginId: "buzz.watching",
              revision: "1",
              title: "Watching",
              component: Page,
            },
          ],
        } as unknown as Agents
      }
    />,
  );
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Identity",
    "Memory",
    "Activity",
    "Watching",
    "Settings",
  ]);
});

it("restores Settings on the first commit without briefly selecting Identity", () => {
  const { props } = editingFixture(false);
  const selected: string[] = [];
  function Probe() {
    useLayoutEffect(() => {
      selected.push(
        screen
          .getAllByRole("tab")
          .find((tab) => tab.getAttribute("aria-selected") === "true")
          ?.textContent ?? "missing",
      );
    }, []);
    return <AgentTabs {...props} showSettings />;
  }
  render(<Probe />);
  expect(selected).toEqual(["Settings"]);
});

function recoveryFixture(split = false) {
  const { props } = editingFixture(split);
  const expected = {
    channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
    d: "settings",
    type: "buzz.agent.settings" as const,
  };
  const head = {
    kind: 45010,
    id: "broken",
    pubkey: props.agent.pubkey,
    sig: "",
    created_at: 1,
    tags: [
      ["ar", "1"],
      ["h", expected.channel],
      ["d", expected.d],
      ["type", expected.type],
      ["op", "create"],
      ["title", "Agent settings"],
    ],
    content: JSON.stringify({
      version: 1,
      agentType: props.agent.type,
      settings: { scope: "community" },
    }),
  };
  const history = {
    read: async () => [],
    sides: [{ side: "settings", expected, head, version: 1 }],
    settings: {
      agentType: props.agent.type,
      schema: { scope: ["thread", "channel"] },
    },
  };
  return {
    ...props,
    agent: {
      ...props.agent,
      configProblem:
        'These agent settings aren\'t compatible with this version of Buzz: Setting "scope" has an unsupported value',
    },
    agents: {
      ...props.agents,
      configHistory: () => history,
    } as unknown as Agents,
    settingsContent: (
      <button type="button" aria-label="Previous versions">
        History
      </button>
    ),
  };
}

it("forgets a recovery focus request when its navigation is kept", async () => {
  const user = userEvent.setup();
  const recovering = recoveryFixture();
  const view = render(
    <AgentTabs {...recovering} settingsHost={{ pendingSave: vi.fn() }} />,
  );
  await user.click(screen.getByRole("button", { name: "Previous Versions" }));
  await user.click(await screen.findByRole("button", { name: "Keep editing" }));
  view.rerender(<AgentTabs {...recovering} />);
  const settings = screen.getByRole("tab", { name: "Settings" });
  await user.click(settings);
  expect(settings).toHaveAttribute("aria-selected", "true");
  expect(settings).toHaveFocus();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
});

it("focuses previous versions after discarding changes to open recovery", async () => {
  const user = userEvent.setup();
  render(
    <AgentTabs
      {...recoveryFixture()}
      settingsHost={{ pendingSave: vi.fn() }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Previous Versions" }));
  await user.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("button", { name: "Previous versions" }),
  ).toHaveFocus();
});

it.each([false, true])(
  "disables the recovery link until a save finishes (split %s)",
  async (split) => {
    const user = userEvent.setup();
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(
      <AgentTabs
        {...recoveryFixture(split)}
        settingsHost={{ pendingSave: () => saving }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    try {
      expect(
        screen.getByRole("button", { name: "Previous Versions" }),
      ).toBeDisabled();
    } finally {
      await act(async () => finish());
    }
    expect(
      screen.getByRole("button", { name: "Previous Versions" }),
    ).toBeEnabled();
  },
);
